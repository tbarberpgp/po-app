// Microsoft Graph mailbox PULL.
//
// Microsoft 365 blocks automatic EXTERNAL forwarding (550 5.7.520), which breaks
// the mailbox rules that used to forward supplier invoices / subbie applications
// from company mailboxes (…@powergridprojects.net) to the app's ingest addresses
// (…@pgpprojects.com). Instead of the mailbox pushing mail out, the app reaches
// IN and reads it on a schedule — nothing is forwarded, so the policy is moot.
//
// Each run: for every configured mailbox, list new (unread, with-attachment)
// messages, fetch each one's raw MIME, and feed it into the SAME inbound-email
// pipeline (handleInboundEmail) as if it had arrived at the mapped app address —
// with replies suppressed (we must never email a supplier "got your invoice").
// Processed messages are marked read + recorded so they're never ingested twice.
//
// Dormant until configured: needs MS_GRAPH_TENANT_ID / _CLIENT_ID /
// _CLIENT_SECRET (an Entra app registration with Mail.Read application
// permission, scoped to the shared mailboxes) and MS_GRAPH_MAILBOXES.

import type { Env } from "./env";
import { handleInboundEmail } from "./email";

const GRAPH = "https://graph.microsoft.com/v1.0";

type MailboxConfig = { mailbox: string; as: string; folder: string };

/** Parse MS_GRAPH_MAILBOXES — a JSON array mapping each source mailbox to the
 *  app address it should be ingested as (which drives handleInboundEmail's
 *  recipient routing). `folder` defaults to the Inbox. */
function parseMailboxes(env: Env): MailboxConfig[] {
  if (!env.MS_GRAPH_MAILBOXES) return [];
  try {
    const arr = JSON.parse(env.MS_GRAPH_MAILBOXES);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((m) => ({
        mailbox: String(m?.mailbox ?? "").trim(),
        as: String(m?.as ?? "").trim(),
        folder: String(m?.folder ?? "inbox").trim() || "inbox",
      }))
      .filter((m) => m.mailbox && m.as);
  } catch {
    return [];
  }
}

/** The configured mailbox→app-address mappings (no secrets) — for the Admin
 *  status card so it's clear what's wired up. */
export function configuredMailboxes(env: Env): MailboxConfig[] {
  return parseMailboxes(env);
}

export function graphConfigured(env: Env): boolean {
  return !!(
    env.MS_GRAPH_TENANT_ID &&
    env.MS_GRAPH_CLIENT_ID &&
    env.MS_GRAPH_CLIENT_SECRET &&
    parseMailboxes(env).length > 0
  );
}

/** The app-address local-part → ingest kind. Certificate mailboxes are skipped
 *  for now — their reply paths aren't yet reply-suppressed (phase 2). */
function kindFromAs(as: string): "invoice" | "labour" | "client" | "cert" | "other" {
  const local = (as.split("@")[0] || "").toLowerCase();
  if (/^invoices?$/.test(local)) return "invoice";
  if (/cert/.test(local)) return "cert";
  if (/client/.test(local)) return "client";
  if (/(labour|application|apps?)/.test(local)) return "labour";
  return "other";
}

/** App-only (client-credentials) access token for Graph. Short-lived; fetched
 *  fresh per run (hourly), so no caching needed. */
async function getToken(env: Env): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.MS_GRAPH_CLIENT_ID!,
    client_secret: env.MS_GRAPH_CLIENT_SECRET!,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(env.MS_GRAPH_TENANT_ID!)}/oauth2/v2.0/token`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
  );
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) throw new Error("token: no access_token in response");
  return j.access_token;
}

type GraphMsg = { id: string; subject: string; from: string; internetMessageId: string };

async function listMessages(token: string, mailbox: string, folder: string): Promise<GraphMsg[]> {
  const filter = encodeURIComponent("hasAttachments eq true and isRead eq false");
  const url =
    `${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders/${encodeURIComponent(folder)}/messages` +
    `?$filter=${filter}&$select=id,subject,from,internetMessageId&$top=20&$orderby=receivedDateTime asc`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`list ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { value?: Array<Record<string, unknown>> };
  return (j.value ?? []).map((m) => ({
    id: String(m.id ?? ""),
    subject: String(m.subject ?? ""),
    from: String((m.from as { emailAddress?: { address?: string } })?.emailAddress?.address ?? ""),
    internetMessageId: String(m.internetMessageId ?? m.id ?? ""),
  }));
}

/** The message's raw RFC822 MIME — fed straight into postal-mime downstream. */
async function fetchMime(token: string, mailbox: string, id: string): Promise<ArrayBuffer> {
  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(id)}/$value`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`mime ${res.status}`);
  return await res.arrayBuffer();
}

async function markRead(token: string, mailbox: string, id: string): Promise<void> {
  await fetch(`${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ isRead: true }),
  }).catch(() => {});
}

function streamFrom(buf: ArrayBuffer): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

export type PullResult = { ran: boolean; mailboxes: number; fetched: number; ingested: number; errors: string[] };

/** One pull pass across all configured mailboxes. Best-effort: individual
 *  failures are collected, never thrown, so one bad message can't stop the rest.
 *  A no-op (ran:false) when Graph isn't configured. */
export async function runMailboxPull(env: Env): Promise<PullResult> {
  const out: PullResult = { ran: false, mailboxes: 0, fetched: 0, ingested: 0, errors: [] };
  if (!graphConfigured(env)) return out;
  const cfgs = parseMailboxes(env);
  out.ran = true;
  out.mailboxes = cfgs.length;

  let token: string;
  try {
    token = await getToken(env);
  } catch (e) {
    out.errors.push(`auth: ${e instanceof Error ? e.message : String(e)}`);
    await logRun(env, out);
    return out;
  }

  for (const cfg of cfgs) {
    const kind = kindFromAs(cfg.as);
    if (kind === "cert") {
      out.errors.push(`${cfg.mailbox}: certificate mailboxes aren't pulled yet`);
      continue;
    }
    let msgs: GraphMsg[] = [];
    try {
      msgs = await listMessages(token, cfg.mailbox, cfg.folder);
    } catch (e) {
      out.errors.push(`${cfg.mailbox} list: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const m of msgs) {
      out.fetched++;
      const key = m.internetMessageId || m.id;
      // Already ingested? mark read (so it drops off the unread list) and skip.
      const seen = await env.DB.prepare("SELECT 1 FROM graph_pulled_messages WHERE message_id = ?")
        .bind(key).first().catch(() => null);
      if (seen) { await markRead(token, cfg.mailbox, m.id); continue; }
      try {
        const mime = await fetchMime(token, cfg.mailbox, m.id);
        // Synthesize a Cloudflare-style inbound message: `to` = the app address
        // so routing picks the right pipeline; `from` = the real sender so labour
        // supplier-by-domain matching still works. noReply: never email out.
        const pseudo = {
          from: m.from || cfg.mailbox,
          to: cfg.as,
          raw: streamFrom(mime),
          rawSize: mime.byteLength,
          headers: new Headers(),
          setReject() {},
        };
        await handleInboundEmail(pseudo as unknown as Parameters<typeof handleInboundEmail>[0], env, { noReply: true });
        await env.DB.prepare(
          "INSERT OR IGNORE INTO graph_pulled_messages (message_id, mailbox, kind, subject, from_addr, processed_at) VALUES (?,?,?,?,?,?)",
        ).bind(key, cfg.mailbox, kind, m.subject.slice(0, 300), m.from, new Date().toISOString()).run().catch(() => {});
        await markRead(token, cfg.mailbox, m.id);
        out.ingested++;
      } catch (e) {
        out.errors.push(`${cfg.mailbox} "${m.subject.slice(0, 40)}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  await logRun(env, out);
  return out;
}

async function logRun(env: Env, out: PullResult): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO graph_pull_runs (ran_at, ok, mailboxes, fetched, ingested, error) VALUES (?,?,?,?,?,?)",
  ).bind(
    new Date().toISOString(),
    out.errors.length ? 0 : 1,
    out.mailboxes,
    out.fetched,
    out.ingested,
    out.errors.length ? out.errors.join(" | ").slice(0, 800) : null,
  ).run().catch(() => {});
}
