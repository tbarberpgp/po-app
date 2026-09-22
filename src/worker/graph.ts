// Microsoft Graph mailbox PULL.
//
// Microsoft 365 blocks automatic EXTERNAL forwarding (550 5.7.520), which breaks
// the mailbox rules that used to forward supplier invoices / subbie applications
// from company mailboxes (…@powergridprojects.net) to the app's ingest addresses
// (…@pgpprojects.com). Instead of the mailbox pushing mail out, the app reaches
// IN and reads it on a schedule — nothing is forwarded, so the policy is moot.
//
// Each run: for every configured mailbox, list the messages (with attachments)
// that have ARRIVED SINCE that mailbox's watermark, fetch each one's raw MIME,
// and feed it into the SAME inbound-email pipeline (handleInboundEmail) as if it
// had arrived at the mapped app address — with replies suppressed (we must never
// email a supplier "got your invoice"). What has already been done is decided by
// graph_pulled_messages, keyed on internetMessageId.
//
// Eligibility is deliberately NOT the unread flag. It was once, and that handed
// the queue to Outlook: Accounts reads its own mail within minutes, so anything
// opened before the top of the hour was never pulled, never retried and never
// logged — it simply never reached the app. A watermark is the app's own clock,
// and nothing anyone does in Outlook can move it.
//
// Dormant until configured: needs MS_GRAPH_TENANT_ID / _CLIENT_ID /
// _CLIENT_SECRET (an Entra app registration with Mail.Read application
// permission, scoped to the shared mailboxes) and MS_GRAPH_MAILBOXES.

import type { Env } from "./env";
import { handleInboundEmail } from "./email";

const GRAPH = "https://graph.microsoft.com/v1.0";

/** How far back a mailbox is read when it has no watermark yet — a new mailbox,
 *  or the first run after this landed. Deliberately short: the app can't know
 *  which older mail Accounts already handled by hand, and every PDF it pulls is
 *  a document read. To backfill further, set that mailbox's watermark back by
 *  hand (one UPDATE on graph_pull_state) and let the next run catch up. */
const BOOTSTRAP_HOURS = 24;

/** The watermark is set back from the run's START by this much. receivedDateTime
 *  is Exchange's clock rather than ours, and mail lands while a run is already in
 *  flight, so the window overlaps on purpose. Re-listing a message costs one row
 *  read — dedupe is exact — which makes the overlap free insurance. */
const OVERLAP_MINUTES = 15;

/** A message whose ingest throws is retried on later runs: the watermark is held
 *  back so the window keeps covering it. After this many attempts it is left
 *  behind (and stays visible on the Admin card, with its error) so that one
 *  unreadable attachment can't pin the window open for ever. */
const MAX_ATTEMPTS = 5;

/** Floor on how far a held-back watermark can drag the window. */
const WINDOW_MAX_DAYS = 30;

/** Exchange caps $top; the window is walked with @odata.nextLink up to this many
 *  pages, which bounds one mailbox's run at PAGE_SIZE × MAX_PAGES messages. */
const PAGE_SIZE = 50;
const MAX_PAGES = 10;

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

type GraphMsg = {
  id: string; subject: string; from: string; internetMessageId: string; receivedDateTime: string;
};

/** Graph wants a bare OData DateTimeOffset — quoted, or carrying milliseconds,
 *  and Exchange answers 400 InvalidFilterClause. */
function odataTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Everything with an attachment that arrived at or after `since`, oldest first.
 *
 *  Exchange rejects $filter combined with $orderby on a mail folder
 *  ("InefficientFilter", 400), so the server can't be asked for an order — which
 *  means one page of $top is an ARBITRARY slice of the window, and sorting it
 *  afterwards wouldn't recover what Graph left out. The whole window is walked
 *  via @odata.nextLink and sorted here, oldest first, so the longest-waiting
 *  invoices go in first when a backlog is bigger than a page. */
async function listMessages(token: string, mailbox: string, folder: string, since: Date): Promise<GraphMsg[]> {
  const filter = encodeURIComponent(`hasAttachments eq true and receivedDateTime ge ${odataTime(since)}`);
  let url: string =
    `${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders/${encodeURIComponent(folder)}/messages` +
    `?$filter=${filter}&$select=id,subject,from,internetMessageId,receivedDateTime&$top=${PAGE_SIZE}`;
  const out: GraphMsg[] = [];
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`list ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { value?: Array<Record<string, unknown>>; "@odata.nextLink"?: string };
    for (const m of j.value ?? []) {
      out.push({
        id: String(m.id ?? ""),
        subject: String(m.subject ?? ""),
        from: String((m.from as { emailAddress?: { address?: string } })?.emailAddress?.address ?? ""),
        internetMessageId: String(m.internetMessageId ?? m.id ?? ""),
        receivedDateTime: String(m.receivedDateTime ?? ""),
      });
    }
    url = String(j["@odata.nextLink"] ?? "");
  }
  // ISO timestamps sort lexicographically.
  return out.sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime));
}

/** The message's raw RFC822 MIME — fed straight into postal-mime downstream. */
async function fetchMime(token: string, mailbox: string, id: string): Promise<ArrayBuffer> {
  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(id)}/$value`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`mime ${res.status}`);
  return await res.arrayBuffer();
}

/** Where this mailbox has been read up to. Missing (or unreadable, if the
 *  migration hasn't run yet) falls back to the bootstrap window rather than to
 *  the beginning of time — dedupe then keeps the repeat work to one row read. */
async function watermarkFor(env: Env, mailbox: string, runStart: Date): Promise<Date> {
  const row = await env.DB.prepare("SELECT watermark FROM graph_pull_state WHERE mailbox = ?")
    .bind(mailbox).first<{ watermark: string }>().catch(() => null);
  const t = row?.watermark ? new Date(row.watermark) : null;
  if (t && !Number.isNaN(t.getTime())) return t;
  return new Date(runStart.getTime() - BOOTSTRAP_HOURS * 3_600_000);
}

/** Move the mailbox on, but only as far as it has actually been read.
 *
 *  Called only when the LIST succeeded — a run that couldn't reach Graph (an
 *  expired client secret, say) must leave the watermark where it is, or the mail
 *  that arrived during the outage is skipped the moment service returns.
 *  A message still owed a retry drags the watermark back to its arrival time, so
 *  the next run's window still covers it. */
async function advanceWatermark(env: Env, mailbox: string, runStart: Date): Promise<void> {
  let next = new Date(runStart.getTime() - OVERLAP_MINUTES * 60_000);
  const owed = await env.DB.prepare(
    "SELECT MIN(received_at) AS oldest FROM graph_pulled_messages WHERE mailbox = ? AND status = 'failed' AND attempts < ?",
  ).bind(mailbox, MAX_ATTEMPTS).first<{ oldest: string | null }>().catch(() => null);
  const oldest = owed?.oldest ? new Date(owed.oldest) : null;
  if (oldest && !Number.isNaN(oldest.getTime()) && oldest < next) next = oldest;
  const floor = new Date(runStart.getTime() - WINDOW_MAX_DAYS * 86_400_000);
  if (next < floor) next = floor;
  await env.DB.prepare(
    "INSERT INTO graph_pull_state (mailbox, watermark, updated_at) VALUES (?,?,?) " +
    "ON CONFLICT(mailbox) DO UPDATE SET watermark = excluded.watermark, updated_at = excluded.updated_at",
  ).bind(mailbox, next.toISOString(), new Date().toISOString()).run().catch(() => {});
}

/** Record what became of a message. `attempts` counts up on every retry so a
 *  message that can never be read eventually stops holding the window open. */
async function recordOutcome(
  env: Env,
  m: GraphMsg,
  cfg: MailboxConfig,
  kind: string,
  status: "ingested" | "failed",
  error: string | null,
): Promise<void> {
  const key = m.internetMessageId || m.id;
  await env.DB.prepare(
    "INSERT INTO graph_pulled_messages (message_id, mailbox, kind, subject, from_addr, processed_at, status, attempts, last_error, received_at) " +
    "VALUES (?,?,?,?,?,?,?,1,?,?) " +
    "ON CONFLICT(message_id) DO UPDATE SET status = excluded.status, attempts = graph_pulled_messages.attempts + 1, " +
    "last_error = excluded.last_error, processed_at = excluded.processed_at",
  ).bind(
    key, cfg.mailbox, kind, m.subject.slice(0, 300), m.from, new Date().toISOString(),
    status, error ? error.slice(0, 300) : null, m.receivedDateTime || null,
  ).run().catch(() => {});
}

function streamFrom(buf: ArrayBuffer): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

export type PullResult = {
  ran: boolean; mailboxes: number; fetched: number; ingested: number; skipped: number; errors: string[];
};

/** One pull pass across all configured mailboxes. Best-effort: individual
 *  failures are collected, never thrown, so one bad message can't stop the rest.
 *  A no-op (ran:false) when Graph isn't configured. */
export async function runMailboxPull(env: Env): Promise<PullResult> {
  const out: PullResult = { ran: false, mailboxes: 0, fetched: 0, ingested: 0, skipped: 0, errors: [] };
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
    // Captured BEFORE the list, so mail that lands mid-run falls inside the next
    // window rather than between the two.
    const runStart = new Date();
    const since = await watermarkFor(env, cfg.mailbox, runStart);
    let msgs: GraphMsg[] = [];
    try {
      msgs = await listMessages(token, cfg.mailbox, cfg.folder, since);
    } catch (e) {
      out.errors.push(`${cfg.mailbox} list: ${e instanceof Error ? e.message : String(e)}`);
      continue; // watermark stays put — this window is retried next run
    }
    for (const m of msgs) {
      out.fetched++;
      const key = m.internetMessageId || m.id;
      // Already dealt with, or out of retries? Leave it alone. The window
      // re-lists what it has covered before, so this is the common path.
      const prior = await env.DB.prepare(
        "SELECT status, attempts FROM graph_pulled_messages WHERE message_id = ?",
      ).bind(key).first<{ status: string; attempts: number }>().catch(() => null);
      if (prior && (prior.status === "ingested" || prior.attempts >= MAX_ATTEMPTS)) { out.skipped++; continue; }
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
        await recordOutcome(env, m, cfg, kind, "ingested", null);
        out.ingested++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await recordOutcome(env, m, cfg, kind, "failed", msg);
        out.errors.push(`${cfg.mailbox} "${m.subject.slice(0, 40)}": ${msg}`);
      }
    }
    await advanceWatermark(env, cfg.mailbox, runStart);
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
