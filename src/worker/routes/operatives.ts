import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";
import { siteScope } from "./operations";
import { classifyOperativeRows, normalisePhone, type OperativeImportRow } from "../../shared/operatives-import";

// Operative register (org-level). Managers create operatives, record company
// induction, upload qualification cards, and assign RAMS for them to sign from
// their personal profile link (/operative/:token, served by publicOps).
export const operatives = new Hono<{ Bindings: Env; Variables: Variables }>();

const MAX_FILE_BYTES = 20 * 1024 * 1024;

// Phone normalisation for sign-in matching lives in shared/operatives-import.ts
// (so the bulk-upload client and this Worker use identical rules). Re-export so
// operations.ts / publicOps.ts can keep importing it from here.
export { normalisePhone };

// emergency_contact (migration 0059) is optional. Detect it once per isolate so
// the Worker can deploy safely BEFORE the remote migration is applied: creates
// and imports simply omit the field until the column lands, then pick it up with
// no redeploy. Removes the deploy-before-migrate footgun.
// Only memoise the POSITIVE result: until the column exists we re-check (a cheap
// PRAGMA, and only on writes), so the moment migration 0059 is applied the next
// request picks it up with no redeploy and no stale-isolate window.
let emergencyContactColumn = false;
async function hasEmergencyContact(env: Env): Promise<boolean> {
  if (emergencyContactColumn) return true;
  try {
    const r = await env.DB.prepare("SELECT 1 AS x FROM pragma_table_info('operatives') WHERE name = 'emergency_contact'").first<{ x: number }>();
    emergencyContactColumn = !!r;
  } catch { /* leave false; re-check next write */ }
  return emergencyContactColumn;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

/** pending (unverified self-upload) | valid | expiring (≤30 days) | expired | none */
function qualStatus(expiry: string | null, verifiedAt: string | null): "pending" | "valid" | "expiring" | "expired" | "none" {
  if (!verifiedAt) return "pending"; // self-uploaded, awaiting manager verification
  if (!expiry) return "none";
  const exp = new Date(expiry + "T00:00:00").getTime();
  if (Number.isNaN(exp)) return "none";
  const now = Date.now();
  if (exp < now) return "expired";
  if (exp < now + 30 * 86_400_000) return "expiring";
  return "valid";
}

// ── Register list ─────────────────────────────────────────────────────────
operatives.get("/", async (c) => {
  const denied = requirePermission(c, "masterdata.read");
  if (denied) return denied;
  const rows = await c.env.DB.prepare(
    `SELECT o.*,
            (SELECT code FROM projects WHERE id = o.assigned_project_id) AS assigned_project_code,
            (SELECT COUNT(*) FROM operative_quals q WHERE q.operative_id = o.id) AS qual_count,
            (SELECT COUNT(*) FROM operative_rams_signs r WHERE r.operative_id = o.id AND r.signed_at IS NULL) AS rams_pending
       FROM operatives o
      WHERE o.archived_at IS NULL
      ORDER BY o.name`,
  ).all();
  // Worst qual status (verified cards only) + count of self-uploads awaiting
  // verification, for the list badges. Fetch every operative's cards in ONE
  // query and group in memory — avoids an N+1 round-trip per operative.
  const grouped = await groupQualsByOperative(c.env, "WHERE o.archived_at IS NULL");
  const out = (rows.results as Array<Record<string, unknown>>).map((o) => {
    const { worst, pending } = summariseQuals(grouped.get(o.id as string) ?? []);
    return { ...o, qual_worst: worst, quals_pending: pending };
  });
  return c.json(out);
});

/** All quals for the operatives matched by `whereClause` (on alias `o`), keyed
 *  by operative id — one query instead of one-per-operative. */
type GroupedQual = { qual_type: string; expiry_date: string | null; verified_at: string | null };
async function groupQualsByOperative(
  env: Env, whereClause: string, ...binds: unknown[]
): Promise<Map<string, GroupedQual[]>> {
  const rows = await env.DB.prepare(
    `SELECT q.operative_id AS oid, q.qual_type, q.expiry_date, q.verified_at
       FROM operative_quals q JOIN operatives o ON o.id = q.operative_id
      ${whereClause}`,
  ).bind(...binds).all<{ oid: string } & GroupedQual>();
  const map = new Map<string, GroupedQual[]>();
  for (const q of rows.results) {
    const arr = map.get(q.oid) ?? [];
    arr.push({ qual_type: q.qual_type, expiry_date: q.expiry_date, verified_at: q.verified_at });
    map.set(q.oid, arr);
  }
  return map;
}

/** Worst verified-card status + count of cards still awaiting verification. */
function summariseQuals(quals: Array<{ expiry_date: string | null; verified_at: string | null }>): { worst: "valid" | "expiring" | "expired" | "none"; pending: number } {
  const verified = quals.filter((q) => q.verified_at);
  let worst: "valid" | "expiring" | "expired" | "none" = verified.length ? "valid" : "none";
  for (const q of verified) {
    const s = qualStatus(q.expiry_date, q.verified_at);
    if (s === "expired") worst = "expired";
    else if (s === "expiring" && worst !== "expired") worst = "expiring";
  }
  return { worst, pending: quals.filter((q) => !q.verified_at).length };
}

// ── Create ────────────────────────────────────────────────────────────────
operatives.post("/", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const body = await c.req.json<{ name?: string; phone?: string; company?: string; trade?: string; email?: string; emergency_contact?: string; induction_done?: boolean }>();
  if (!body.name?.trim()) return c.json({ error: "Name is required" }, 400);
  // Email is mandatory — every operative is emailed their profile link to
  // upload cards & sign RAMS before going on site.
  const email = body.email?.trim() || "";
  if (!email) return c.json({ error: "Email is required — operatives are emailed their profile link to upload cards & sign RAMS." }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: "That doesn't look like a valid email address." }, 400);
  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const now = new Date().toISOString();
  const name = body.name.trim();
  const phone = body.phone?.trim() || null;
  const actor = c.get("userEmail");
  const inducted = !!body.induction_done;
  const emg = await hasEmergencyContact(c.env);
  const cols = ["id", "token", "name", "phone", "phone_norm", "company", "trade", "email",
    ...(emg ? ["emergency_contact"] : []), "induction_done", "induction_at", "induction_by", "created_at", "created_by"];
  const vals = [id, token, name, phone, normalisePhone(phone),
    body.company?.trim() || null, body.trade?.trim() || null, email,
    ...(emg ? [body.emergency_contact?.trim() || null] : []),
    inducted ? 1 : 0, inducted ? now : null, inducted ? actor : null, now, actor];
  await c.env.DB.prepare(
    `INSERT INTO operatives (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).bind(...vals).run();
  // Automatically send them their profile link so they can upload cards & sign
  // RAMS — to whatever contact details we were given (email and/or SMS).
  const invited = await inviteOperative(c.env, { id, name, email, phone, token });
  return c.json({ id, token, invited });
});

// Bulk import operatives from a CSV/xlsx (parsed + previewed in the browser →
// JSON rows here). The server re-runs the SAME validation the user saw, so it's
// authoritative: rows are matched/deduped on MOBILE, company must be an approved
// supplier, all fields required. New rows are created; rows whose mobile matches
// an existing operative are updated ONLY when `overwrite` is set; error rows are
// skipped. No invites are sent — use /bulk-invite afterwards if wanted.
operatives.post("/bulk-import", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const body = await c.req.json<{ rows?: OperativeImportRow[]; overwrite?: boolean }>().catch(() => ({ rows: [] as OperativeImportRow[], overwrite: false }));
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const overwrite = !!body.overwrite;
  if (rows.length === 0) return c.json({ error: "No rows to import." }, 400);
  if (rows.length > 500) return c.json({ error: "Too many rows — import 500 or fewer at a time." }, 400);

  // Approved-supplier names (the suppliers register IS the approved list).
  const companies = new Set<string>();
  try {
    const sup = await c.env.DB.prepare("SELECT lower(name) AS n FROM suppliers").all<{ n: string }>();
    for (const s of sup.results) if (s.n) companies.add(s.n);
  } catch { /* none yet */ }
  // Existing operatives keyed by normalised mobile, for match/dedupe + update.
  const existingByMobile = new Map<string, { id: string; name: string }>();
  try {
    const ex = await c.env.DB.prepare("SELECT id, name, phone_norm FROM operatives WHERE phone_norm IS NOT NULL AND archived_at IS NULL").all<{ id: string; name: string; phone_norm: string }>();
    for (const r of ex.results) if (r.phone_norm && !existingByMobile.has(r.phone_norm)) existingByMobile.set(r.phone_norm, { id: r.id, name: r.name });
  } catch { /* none yet */ }

  const classified = classifyOperativeRows(rows, { companies, existingByMobile });
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  const emg = await hasEmergencyContact(c.env); // omit the column until migration 0059 lands
  const stmts: D1PreparedStatement[] = [];
  const newIds: string[] = [];
  let added = 0, updated = 0, skipped = 0;
  for (const r of classified) {
    if (r.status === "error") { skipped++; continue; }
    if (r.status === "update") {
      if (!overwrite || !r.match_id) { skipped++; continue; }
      const sets = ["name = ?", "phone = ?", "phone_norm = ?", "company = ?", "trade = ?", "email = ?", ...(emg ? ["emergency_contact = ?"] : [])];
      const binds = [r.name, r.mobile.trim(), r.phone_norm, r.company.trim(), r.trade.trim(), r.email.trim(), ...(emg ? [r.emergency_contact.trim()] : []), r.match_id];
      stmts.push(c.env.DB.prepare(`UPDATE operatives SET ${sets.join(", ")} WHERE id = ?`).bind(...binds));
      updated++;
      continue;
    }
    // new
    const id = crypto.randomUUID();
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const cols = ["id", "token", "name", "phone", "phone_norm", "company", "trade", "email", ...(emg ? ["emergency_contact"] : []), "induction_done", "created_at", "created_by"];
    const vals = [id, token, r.name, r.mobile.trim(), r.phone_norm, r.company.trim(), r.trade.trim(), r.email.trim(), ...(emg ? [r.emergency_contact.trim()] : []), 0, now, actor];
    stmts.push(c.env.DB.prepare(`INSERT INTO operatives (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...vals));
    newIds.push(id);
    added++;
  }
  // D1 batches are capped; chunk to stay well under the limit on a 500-row file.
  for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50));
  return c.json({ added, updated, skipped, new_ids: newIds });
});

// Send the profile-link invite to a set of operatives (used after a bulk import).
operatives.post("/bulk-invite", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const body = await c.req.json<{ ids?: string[] }>().catch(() => ({ ids: [] as string[] }));
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, 1000) : [];
  if (ids.length === 0) return c.json({ error: "No operatives to invite." }, 400);
  let sent = 0;
  // Track exactly who didn't get invited (name + email + why) so a bulk upload
  // can report the specific operatives that failed, not just a count.
  const failures: Array<{ id: string; name: string; email: string | null; reason: string }> = [];
  for (const id of ids) {
    const op = await c.env.DB.prepare(
      "SELECT id, name, email, phone, token FROM operatives WHERE id = ? AND archived_at IS NULL",
    ).bind(id).first<{ id: string; name: string; email: string | null; phone: string | null; token: string }>().catch(() => null);
    if (!op) { failures.push({ id, name: "(unknown)", email: null, reason: "Operative not found" }); continue; }
    if (!op.email) { failures.push({ id: op.id, name: op.name, email: null, reason: "No email address on record" }); continue; }
    try {
      const r = await inviteOperative(c.env, { id: op.id, name: op.name, email: op.email, phone: op.phone, token: op.token });
      if (r.email || r.sms) sent++;
      else failures.push({ id: op.id, name: op.name, email: op.email, reason: "Email failed to send (rejected by provider, or email not configured)" });
    } catch (e) {
      failures.push({ id: op.id, name: op.name, email: op.email, reason: e instanceof Error ? e.message : "Unexpected error" });
    }
  }
  return c.json({ sent, failed: failures.length, failures });
});

// Serve a qual-card / RAMS file to a manager (authed). MUST be registered before
// the "/:id" detail route below, or "/file" gets captured as an operative id.
operatives.get("/file", async (c) => {
  const denied = requirePermission(c, "masterdata.read");
  if (denied) return denied;
  const key = c.req.query("key");
  if (!key) return c.json({ error: "key required" }, 400);
  const obj = await c.env.R2.get(key);
  if (!obj) return c.json({ error: "not found" }, 404);
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  return new Response(obj.body, { headers: h });
});

// ── Detail (operative + quals + RAMS) ───────────────────────────────────────
operatives.get("/:id", async (c) => {
  const denied = requirePermission(c, "masterdata.read");
  if (denied) return denied;
  const id = c.req.param("id");
  const op = await c.env.DB.prepare("SELECT * FROM operatives WHERE id = ?").bind(id).first();
  if (!op) return c.json({ error: "not found" }, 404);
  const quals = await c.env.DB.prepare(
    "SELECT id, qual_type, card_no, file_key, file_type, expiry_date, created_at, source, verified_at FROM operative_quals WHERE operative_id = ? ORDER BY verified_at IS NOT NULL, qual_type",
  ).bind(id).all<{ id: string; qual_type: string; card_no: string | null; file_key: string | null; file_type: string | null; expiry_date: string | null; created_at: string; source: string; verified_at: string | null }>();
  const rams = await c.env.DB.prepare(
    `SELECT s.id, s.rams_id, s.project_id, s.signed_at, s.requested_at,
            d.title AS rams_title, p.code AS project_code
       FROM operative_rams_signs s
       JOIN rams_documents d ON d.id = s.rams_id
       JOIN projects p ON p.id = s.project_id
      WHERE s.operative_id = ? ORDER BY s.requested_at DESC`,
  ).bind(id).all();
  return c.json({
    operative: op,
    quals: quals.results.map((q) => ({ ...q, status: qualStatus(q.expiry_date, q.verified_at) })),
    rams: rams.results,
  });
});

// ── Update (fields + induction) ─────────────────────────────────────────────
operatives.put("/:id", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string; phone?: string; company?: string; trade?: string; email?: string;
    emergency_contact?: string; notes?: string; induction_done?: boolean;
  }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name != null) { sets.push("name = ?"); binds.push(body.name.trim()); }
  if ("phone" in body) {
    sets.push("phone = ?"); binds.push(body.phone?.trim() || null);
    sets.push("phone_norm = ?"); binds.push(normalisePhone(body.phone));
  }
  if ("company" in body) { sets.push("company = ?"); binds.push(body.company?.trim() || null); }
  if ("trade" in body) { sets.push("trade = ?"); binds.push(body.trade?.trim() || null); }
  if ("email" in body) { sets.push("email = ?"); binds.push(body.email?.trim() || null); }
  if ("emergency_contact" in body && await hasEmergencyContact(c.env)) { sets.push("emergency_contact = ?"); binds.push(body.emergency_contact?.trim() || null); }
  if ("notes" in body) { sets.push("notes = ?"); binds.push(body.notes?.trim() || null); }
  if ("induction_done" in body) {
    sets.push("induction_done = ?"); binds.push(body.induction_done ? 1 : 0);
    sets.push("induction_at = ?"); binds.push(body.induction_done ? new Date().toISOString() : null);
    sets.push("induction_by = ?"); binds.push(body.induction_done ? c.get("userEmail") : null);
  }
  if (sets.length === 0) return c.json({ error: "nothing to update" }, 400);
  binds.push(id);
  await c.env.DB.prepare(`UPDATE operatives SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  return c.json({ ok: true });
});

operatives.post("/:id/archive", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  await c.env.DB.prepare("UPDATE operatives SET archived_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), c.req.param("id")).run();
  return c.json({ ok: true });
});

/** Email the operative their personal profile link (+ any RAMS awaiting their
 *  signature). Best-effort via Resend; returns sent=false if email isn't set up
 *  on the worker (RESEND_API_KEY). */
async function emailOperativeProfile(
  env: Env,
  args: {
    to: string; name: string; url: string;
    pending: Array<{ title: string; code: string }>;
    /** Toolbox talks waiting to be read & signed. Without these the mail only
     *  ever said "RAMS", so an operative sent a talk got a generic profile
     *  email that never mentioned the thing they were being asked to do. */
    talks: Array<{ title: string; code: string }>;
  },
): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — would have emailed operative link to", args.to);
    return false;
  }
  const from = env.RESEND_FROM || "PowerGrid Apps <apps@notifications.powergridprojects.co.uk>";
  const listOf = (items: Array<{ title: string; code: string }>) =>
    `<ul>${items.map((r) => `<li>${escapeHtmlOp(r.code)} — ${escapeHtmlOp(r.title)}</li>`).join("")}</ul>`;
  const ramsList = args.pending.length
    ? `<p>You have <b>${args.pending.length}</b> RAMS to read &amp; sign:</p>${listOf(args.pending)}`
    : "";
  const talkList = args.talks.length
    ? `<p>You have <b>${args.talks.length}</b> toolbox talk${args.talks.length === 1 ? "" : "s"} to read &amp; sign:</p>${listOf(args.talks)}`
    : "";
  // Name what's actually waiting, so the subject line tells the operative why
  // they've been mailed rather than looking like a generic profile nudge.
  const subject = args.talks.length && args.pending.length ? "Your PowerGrid toolbox talk & RAMS to sign"
    : args.talks.length ? `Toolbox talk to read & sign${args.talks.length === 1 ? `: ${args.talks[0].title}` : ""}`
    : args.pending.length ? "RAMS to read & sign — PowerGrid"
    : "Your PowerGrid site profile";
  const html = `
    <p>Hi ${escapeHtmlOp(args.name)},</p>
    <p>Here's your PowerGrid operative profile — open it to view your induction status, upload your
       qualification cards, and read &amp; sign anything waiting for you.</p>
    ${talkList}
    ${ramsList}
    <p><a href="${args.url}" style="display:inline-block;background:#ee5d2b;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open my profile</a></p>
    <p style="color:#666;font-size:12px">Or paste this link into your browser: ${args.url}</p>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({ from, to: [args.to], subject, html }),
    });
    if (!res.ok) { console.error("operative email failed", res.status, await res.text().catch(() => "")); return false; }
    // Log Resend's message id. A 2xx only means Resend ACCEPTED it — whether the
    // recipient's mail server took it is a separate story, and without the id
    // there's nothing to look up when someone says "I never got it".
    const id = await res.json<{ id?: string }>().then((j) => j?.id).catch(() => undefined);
    console.log(`operative email accepted by Resend · to=${args.to} · id=${id ?? "unknown"} · subject="${subject}"`);
    return true;
  } catch (e) { console.error("operative email error", e); return false; }
}

function escapeHtmlOp(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch] as string));
}

/** Best-effort UK-centric E.164 for SMS. Accepts "07700 900111", "+447700900111",
 *  "447700900111", "7700900111", "00447700900111". Returns null if implausible. */
function toE164(phone: string): string | null {
  const trimmed = phone.trim();
  if (/^\+\d{8,15}$/.test(trimmed.replace(/[\s()-]/g, ""))) return trimmed.replace(/[\s()-]/g, "");
  let d = trimmed.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);          // intl prefix → drop
  if (d.startsWith("44")) return "+" + d;           // already UK country code
  if (d.startsWith("0")) return "+44" + d.slice(1); // national, leading 0
  if (d.length === 10 && d.startsWith("7")) return "+44" + d; // bare UK mobile
  return d.length >= 8 ? "+" + d : null;            // fall back to whatever we have
}

/** Text the operative their profile link via Twilio. Best-effort; returns false
 *  (and logs) when Twilio isn't configured or the number isn't SMS-able. */
async function sendOperativeSms(env: Env, args: { to: string; name: string; url: string; talks?: number }): Promise<boolean> {
  const sid = env.TWILIO_ACCOUNT_SID, auth = env.TWILIO_AUTH_TOKEN, from = env.TWILIO_FROM;
  if (!sid || !auth || !from) {
    // Loud: the UI promises "email & text", so a half-configured Twilio silently
    // drops every text and nobody finds out until an operative says they never
    // got one. Names the missing piece rather than a generic "not configured".
    const missing = [!sid && "TWILIO_ACCOUNT_SID", !auth && "TWILIO_AUTH_TOKEN", !from && "TWILIO_FROM"].filter(Boolean).join(", ");
    console.error(`SMS NOT SENT to ${args.to} — Twilio is missing: ${missing}. Set it with 'wrangler secret put'.`);
    return false;
  }
  const to = toE164(args.to);
  if (!to) { console.warn("operative phone not SMS-able:", args.to); return false; }
  const first = args.name.trim().split(/\s+/)[0] || args.name;
  const body = args.talks
    ? `Hi ${first}, you have ${args.talks} toolbox talk${args.talks === 1 ? "" : "s"} to read & sign on your PowerGrid profile: ${args.url}`
    : `Hi ${first}, here's your PowerGrid site profile — upload your cards & sign any RAMS before you start on site: ${args.url}`;
  const params = new URLSearchParams({ To: to, Body: body });
  // A Messaging Service SID (starts with "MG") goes in MessagingServiceSid; a
  // plain number goes in From.
  if (from.startsWith("MG")) params.set("MessagingServiceSid", from); else params.set("From", from);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${sid}:${auth}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) { console.error("operative SMS failed", res.status, await res.text().catch(() => "")); return false; }
    return true;
  } catch (e) { console.error("operative SMS error", e); return false; }
}

/** Notify the manager of the site an operative has just been moved OFF, so an
 *  operative never silently disappears from a roster. Best-effort via Resend. */
async function emailReassignmentAlert(
  env: Env,
  args: { to: string; opName: string; fromCode: string; fromName: string; toCode: string; toName: string; actor: string },
): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — would have alerted", args.to, "of reassignment of", args.opName);
    return false;
  }
  const from = env.RESEND_FROM || "PowerGrid Apps <apps@notifications.powergridprojects.co.uk>";
  const html = `
    <p><b>${escapeHtmlOp(args.opName)}</b> has been reassigned off your site.</p>
    <p>Moved from <b>${escapeHtmlOp(args.fromCode)} — ${escapeHtmlOp(args.fromName)}</b>
       to <b>${escapeHtmlOp(args.toCode)} — ${escapeHtmlOp(args.toName)}</b>${args.actor ? ` by ${escapeHtmlOp(args.actor)}` : ""}.</p>
    <p style="color:#666;font-size:12px">They're no longer on your site's operative roster. If this is wrong, reassign them back from the site's Operations → Operatives tab.</p>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({ from, to: [args.to], subject: `${args.opName} reassigned from ${args.fromCode}`, html }),
    });
    if (!res.ok) { console.error("reassignment alert failed", res.status, await res.text().catch(() => "")); return false; }
    return true;
  } catch (e) { console.error("reassignment alert error", e); return false; }
}

/** Send an operative their personal profile link on every channel we have a
 *  detail for (email + SMS). Returns which channels actually went out. */
const INVITE_COOLDOWN_MS = 3 * 60_000; // suppress duplicate invites within 3 min

async function inviteOperative(
  env: Env,
  op: { id: string; name: string; email: string | null; phone: string | null; token: string },
): Promise<{ email: boolean; sms: boolean; skipped?: boolean }> {
  // De-dupe: several actions can fire an invite for the same operative in quick
  // succession (create, then assign-to-a-site-with-RAMS, then a bulk invite),
  // which lands as multiple identical emails "at once". Skip if we invited this
  // operative within the cooldown. An on-demand re-send after the window still works.
  try {
    const last = await env.DB.prepare("SELECT last_invited_at FROM operatives WHERE id = ?")
      .bind(op.id).first<{ last_invited_at: string | null }>();
    if (last?.last_invited_at) {
      const since = Date.now() - new Date(last.last_invited_at).getTime();
      if (since >= 0 && since < INVITE_COOLDOWN_MS) return { email: false, sms: false, skipped: true };
    }
  } catch { /* column missing pre-0071 — fall through and send */ }
  const base = (env.APP_BASE_URL ?? "").replace(/\/$/, "");
  const url = `${base}/operative/${op.token}`;
  const pending = await env.DB.prepare(
    `SELECT d.title AS title, p.code AS code
       FROM operative_rams_signs s
       JOIN rams_documents d ON d.id = s.rams_id
       JOIN projects p ON p.id = s.project_id
      WHERE s.operative_id = ? AND s.signed_at IS NULL`,
  ).bind(op.id).all<{ title: string; code: string }>();
  // Talks waiting, same shape as RAMS. Wrapped: a pre-0107 DB has no acks table,
  // and a missing talk list must never stop the RAMS invite going out.
  let talks: Array<{ title: string; code: string }> = [];
  try {
    talks = (await env.DB.prepare(
      `SELECT n.title AS title, p.code AS code
         FROM operative_notice_acks a
         JOIN site_notices n ON n.id = a.notice_id
         JOIN projects p ON p.id = a.project_id
        WHERE a.operative_id = ? AND a.acked_at IS NULL AND n.active = 1`,
    ).bind(op.id).all<{ title: string; code: string }>()).results;
  } catch (e) { console.warn("pending talks skipped:", e instanceof Error ? e.message : e); }
  let email = false, sms = false;
  if (op.email?.trim()) email = await emailOperativeProfile(env, { to: op.email.trim(), name: op.name, url, pending: pending.results, talks });
  if (op.phone?.trim()) sms = await sendOperativeSms(env, { to: op.phone.trim(), name: op.name, url, talks: talks.length });
  if (email || sms) {
    try {
      await env.DB.prepare("UPDATE operatives SET last_invited_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), op.id).run();
    } catch { /* column missing pre-0071 — cooldown just won't apply */ }
  }
  return { email, sms };
}

// Re-send the profile link on demand. Goes to every channel we have a detail
// for (email + SMS); kept at the historical /email-link path.
operatives.post("/:id/email-link", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const op = await c.env.DB.prepare(
    "SELECT id, name, email, phone, token FROM operatives WHERE id = ? AND archived_at IS NULL",
  ).bind(id).first<{ id: string; name: string; email: string | null; phone: string | null; token: string }>();
  if (!op) return c.json({ error: "not found" }, 404);
  if (!op.email?.trim() && !op.phone?.trim()) {
    return c.json({ error: "This operative has no email or phone — add one first." }, 400);
  }
  const invited = await inviteOperative(c.env, op);
  return c.json({ ok: true, ...invited });
});

// ── Site assignment (one site per operative — like a PO on a project) ───────
// Operatives currently assigned to a given site, with card/RAMS status + who's
// actually signed in on site right now.
operatives.get("/by-project/:projectId", async (c) => {
  const denied = requirePermission(c, "masterdata.read");
  if (denied) return denied;
  const pid = c.req.param("projectId");
  const today = new Date().toISOString().slice(0, 10);
  // A grouped site is ONE site: the crew is everyone assigned to any contract in
  // the group, and the shared records (RAMS, inductions, sign-ins) live on the
  // base. Without this, opening a non-base block shows an empty crew — so RAMS
  // and toolbox distribution had nobody to send to. Ungrouped → itself.
  const scope = await siteScope(c.env, pid);
  const memberPh = scope.memberIds.map(() => "?").join(",");
  // RAMS must be (re)signed for the CURRENT site within the last month. So
  // "pending" = active RAMS docs on this project that this operative hasn't
  // freshly signed — which means a newly-assigned operative shows everything
  // outstanding until they re-sign, and stale signatures (>1 month) re-open.
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const selectCore = `SELECT o.id, o.name, o.company, o.trade, o.phone, o.phone_norm, o.email,
            o.induction_done, o.assigned_at,
            (SELECT COUNT(*) FROM operative_quals q WHERE q.operative_id = o.id) AS qual_count,
            (SELECT COUNT(*) FROM rams_documents d
              WHERE d.project_id = ? AND d.active = 1
                AND NOT EXISTS (
                  SELECT 1 FROM operative_rams_signs s
                   WHERE s.operative_id = o.id AND s.rams_id = d.id
                     AND s.signed_at IS NOT NULL AND s.signed_at >= ?
                )) AS rams_pending`;
  const fromWhere = `FROM operatives o WHERE o.archived_at IS NULL AND o.assigned_project_id IN (${memberPh}) ORDER BY o.name`;
  let rows: { results: Record<string, unknown>[] };
  try {
    rows = await c.env.DB.prepare(
      `${selectCore},
            EXISTS(SELECT 1 FROM site_inductions si WHERE si.project_id = ? AND si.operative_id = o.id) AS site_inducted,
            (SELECT si2.inducted_at FROM site_inductions si2 WHERE si2.project_id = ? AND si2.operative_id = o.id) AS site_inducted_at
       ${fromWhere}`,
    ).bind(scope.baseId, monthAgo, scope.baseId, scope.baseId, ...scope.memberIds).all<Record<string, unknown>>();
  } catch {
    // site_inductions migration not yet applied on this DB — serve without it.
    rows = await c.env.DB.prepare(`${selectCore} ${fromWhere}`)
      .bind(scope.baseId, monthAgo, ...scope.memberIds).all<Record<string, unknown>>();
  }
  // Today's sign-ins, matched to the operative by normalised phone (the same way
  // the sign-in gate matches). Two distinct questions, one query:
  //   on_site         — signed in and not signed out = here RIGHT NOW.
  //   signed_in_today — signed in at all today, even if they've since left. This
  //                     is who a toolbox talk is delivered to: a talk covers the
  //                     crew who were on site that day, not whoever is still here.
  const signins = await c.env.DB.prepare(
    `SELECT phone, signed_out_at FROM site_signins WHERE project_id = ? AND substr(signed_in_at,1,10) = ?`,
  ).bind(scope.baseId, today).all<{ phone: string | null; signed_out_at: string | null }>();
  const hereToday = new Set(signins.results.map((s) => normalisePhone(s.phone)).filter(Boolean));
  const onSite = new Set(signins.results.filter((s) => !s.signed_out_at).map((s) => normalisePhone(s.phone)).filter(Boolean));
  // One grouped quals query for everyone on this site (no N+1 per operative).
  const grouped = await groupQualsByOperative(
    c.env, `WHERE o.archived_at IS NULL AND o.assigned_project_id IN (${memberPh})`, ...scope.memberIds);
  const out = rows.results.map((o) => {
    const { worst, pending } = summariseQuals(grouped.get(o.id as string) ?? []);
    const quals = (grouped.get(o.id as string) ?? []).map((q) => ({ type: q.qual_type, status: qualStatus(q.expiry_date, q.verified_at) }));
    return {
      ...o, qual_worst: worst, quals_pending: pending, quals,
      on_site: o.phone_norm ? onSite.has(o.phone_norm as string) : false,
      signed_in_today: o.phone_norm ? hereToday.has(o.phone_norm as string) : false,
    };
  });
  return c.json(out);
});

// Confirm (or clear) an operative's SITE induction for a specific project. This
// is per-site, separate from the operative-level company induction.
operatives.post("/:id/site-induction", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const body = await c.req.json<{ project_id?: string; done?: boolean }>().catch(() => ({} as { project_id?: string; done?: boolean }));
  const projectId = (body.project_id ?? "").trim();
  if (!projectId) return c.json({ error: "project_id required" }, 400);
  if (body.done === false) {
    await c.env.DB.prepare("DELETE FROM site_inductions WHERE project_id = ? AND operative_id = ?").bind(projectId, id).run();
    return c.json({ ok: true, site_inducted: false });
  }
  await c.env.DB.prepare(
    `INSERT INTO site_inductions (project_id, operative_id, inducted_at, inducted_by) VALUES (?,?,?,?)
     ON CONFLICT(project_id, operative_id) DO UPDATE SET inducted_at = excluded.inducted_at, inducted_by = excluded.inducted_by`,
  ).bind(projectId, id, new Date().toISOString(), c.get("userEmail")).run();
  return c.json({ ok: true, site_inducted: true });
});

// Assign (or reassign) an operative to a single site. Reassigning off another
// site notifies that site's manager.
operatives.post("/:id/assign", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const body = await c.req.json<{ project_id?: string }>();
  if (!body.project_id) return c.json({ error: "project_id required" }, 400);
  const op = await c.env.DB.prepare(
    "SELECT id, name, assigned_project_id FROM operatives WHERE id = ? AND archived_at IS NULL",
  ).bind(id).first<{ id: string; name: string; assigned_project_id: string | null }>();
  if (!op) return c.json({ error: "not found" }, 404);
  const toP = await c.env.DB.prepare(
    "SELECT id, code, name FROM projects WHERE id = ? AND deleted_at IS NULL",
  ).bind(body.project_id).first<{ id: string; code: string; name: string }>();
  if (!toP) return c.json({ error: "project not found" }, 400);
  const prev = op.assigned_project_id;
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  await c.env.DB.prepare(
    "UPDATE operatives SET assigned_project_id = ?, assigned_at = ?, assigned_by = ? WHERE id = ?",
  ).bind(toP.id, now, actor, id).run();

  // RAMS must be (re)signed for the site they're now on. Open a pending request
  // for every active RAMS doc on the new site, and re-open any signature older
  // than a month so it has to be signed again.
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const docs = await c.env.DB.prepare(
    "SELECT id FROM rams_documents WHERE project_id = ? AND active = 1",
  ).bind(toP.id).all<{ id: number }>();
  if (docs.results.length) {
    const stmts = docs.results.map((d) =>
      c.env.DB.prepare(
        `INSERT INTO operative_rams_signs (id, operative_id, rams_id, project_id, requested_at, requested_by)
         VALUES (?,?,?,?,?,?) ON CONFLICT(operative_id, rams_id) DO NOTHING`,
      ).bind(crypto.randomUUID(), id, d.id, toP.id, now, actor),
    );
    // Re-open stale/unsigned requests for this site so they must sign afresh.
    stmts.push(
      c.env.DB.prepare(
        `UPDATE operative_rams_signs SET signed_at = NULL, signature = NULL, requested_at = ?, requested_by = ?
          WHERE operative_id = ? AND project_id = ? AND (signed_at IS NULL OR signed_at < ?)`,
      ).bind(now, actor, id, toP.id, monthAgo),
    );
    await c.env.DB.batch(stmts);
  }

  // Email/SMS the operative their profile link so they actually receive the new
  // site's RAMS to sign (only worth it when the site has RAMS).
  if (docs.results.length) {
    try {
      const full = await c.env.DB.prepare(
        "SELECT id, name, email, phone, token FROM operatives WHERE id = ?",
      ).bind(id).first<{ id: string; name: string; email: string | null; phone: string | null; token: string }>();
      if (full) await inviteOperative(c.env, full);
    } catch (e) { console.error("assign RAMS notify failed:", e instanceof Error ? e.message : e); }
  }

  const reassigned = !!(prev && prev !== toP.id);
  let notified = false;
  if (reassigned) {
    const fromP = await c.env.DB.prepare(
      "SELECT code, name, site_manager_email, created_by FROM projects WHERE id = ?",
    ).bind(prev).first<{ code: string; name: string; site_manager_email: string | null; created_by: string }>();
    const recipient = fromP?.site_manager_email?.trim() || fromP?.created_by;
    if (fromP && recipient) {
      notified = await emailReassignmentAlert(c.env, {
        to: recipient, opName: op.name,
        fromCode: fromP.code, fromName: fromP.name,
        toCode: toP.code, toName: toP.name, actor,
      });
    }
  }
  return c.json({ ok: true, reassigned, notified });
});

// Remove an operative from their current site (no longer on any roster).
operatives.post("/:id/unassign", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  await c.env.DB.prepare(
    "UPDATE operatives SET assigned_project_id = NULL, assigned_at = NULL, assigned_by = NULL WHERE id = ?",
  ).bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ── Qualification cards ─────────────────────────────────────────────────────

const QUAL_CARD_TOOL = {
  name: "record_card",
  description: "Record the details read off a UK construction qualification / competency card.",
  input_schema: {
    type: "object" as const,
    properties: {
      scheme: { type: "string", description: "The card scheme as shown, e.g. CSCS, ECS, IPAF (PAL), PASMA, First aid, SSSTS, SMSTS, Asbestos awareness, CPCS, NPORS." },
      card_no: { type: "string", description: "Card / licence / registration number as printed." },
      holder_name: { type: "string", description: "The card holder's name as printed." },
      expiry_date: { type: "string", description: "Expiry date as YYYY-MM-DD. Omit if the card shows no expiry." },
      categories: { type: "string", description: "Category / machine endorsements if shown, e.g. '3a 3b'." },
    },
    required: [],
  },
};

function qualBufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const QUAL_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

/** Read a qualification card photo/PDF with Claude. Best-effort: any failure
 *  (unsupported format, oversize, API error) returns null and the upload
 *  proceeds with whatever was typed. */
export async function extractQualCard(env: Env, buf: ArrayBuffer, mime: string): Promise<{ qual_type: string | null; card_no: string | null; expiry_date: string | null; holder_name: string | null } | null> {
  try {
    if (!env.ANTHROPIC_API_KEY) return null;
    if (!QUAL_MEDIA_TYPES.includes(mime)) return null;       // e.g. HEIC — API can't read it
    if (buf.byteLength > 4.5 * 1024 * 1024) return null;     // API media cap
    const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const data = qualBufToBase64(buf);
    const media = mime === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : { type: "image", source: { type: "base64", media_type: mime, data } };
    const res = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 300,
      tools: [QUAL_CARD_TOOL as never],
      tool_choice: { type: "tool", name: "record_card" },
      messages: [{
        role: "user",
        content: [media as never, { type: "text", text: "Read this UK construction qualification card and record its details." }],
      }],
    });
    const use = res.content.find((b) => b.type === "tool_use");
    if (!use || use.type !== "tool_use") return null;
    const x = use.input as Record<string, string | undefined>;
    const scheme = (x.scheme ?? "").trim();
    const norm = scheme.toUpperCase();
    let qualType: string | null = null;
    if (norm) {
      if (norm.includes("CSCS")) qualType = "CSCS";
      else if (norm.includes("ECS")) qualType = "ECS";
      else if (norm.includes("IPAF") || norm.includes("PAL") || norm.includes("POWERED ACCESS")) qualType = "IPAF";
      else if (norm.includes("PASMA")) qualType = "PASMA";
      else if (norm.includes("FIRST AID")) qualType = "First aid";
      else if (norm.includes("SSSTS") || norm.includes("SMSTS")) qualType = "SSSTS / SMSTS";
      else if (norm.includes("ASBESTOS")) qualType = "Asbestos awareness";
      else qualType = scheme;                                 // free-text type (matrix appends it)
    }
    const cardNo = (x.card_no ?? "").trim();
    const cats = (x.categories ?? "").trim();
    const expiry = /^\d{4}-\d{2}-\d{2}$/.test((x.expiry_date ?? "").trim()) ? (x.expiry_date ?? "").trim() : null;
    return {
      qual_type: qualType,
      card_no: cardNo ? (cats ? `${cardNo} (${cats})` : cardNo) : null,
      expiry_date: expiry,
      holder_name: (x.holder_name ?? "").trim() || null,
    };
  } catch (e) {
    console.warn("qual card extraction skipped:", e instanceof Error ? e.message : e);
    return null;
  }
}

operatives.post("/:id/quals", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const form = await c.req.formData();
  const qualType = String(form.get("qual_type") ?? "").trim() || "Other";
  // "1" = the uploader deliberately chose the type; otherwise the card wins.
  const typeManual = String(form.get("qual_type_manual") ?? "") === "1";
  const cardNo = String(form.get("card_no") ?? "").trim() || null;
  const expiry = String(form.get("expiry_date") ?? "").trim() || null;
  const file = form.get("file");
  let fileKey: string | null = null;
  let fileType: string | null = null;
  let extracted: Awaited<ReturnType<typeof extractQualCard>> = null;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_FILE_BYTES) return c.json({ error: "File too large (max 20MB)" }, 400);
    fileType = file.type || "application/octet-stream";
    fileKey = `quals/${id}/${crypto.randomUUID()}-${sanitizeName(file.name)}`;
    const buf = await file.arrayBuffer();
    await c.env.R2.put(fileKey, buf, { httpMetadata: { contentType: fileType } });
    // Read the card so a photo alone fills type / number / expiry correctly.
    extracted = await extractQualCard(c.env, buf, fileType);
  }
  const finalType = !typeManual && extracted?.qual_type ? extracted.qual_type : qualType;
  const finalCardNo = cardNo ?? extracted?.card_no ?? null;
  const finalExpiry = expiry ?? extracted?.expiry_date ?? null;
  const qid = crypto.randomUUID();
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  // A manager-entered card is trusted → verified on creation.
  await c.env.DB.prepare(
    `INSERT INTO operative_quals (id, operative_id, qual_type, card_no, file_key, file_type, expiry_date, created_at, created_by, source, verified_at, verified_by)
     VALUES (?,?,?,?,?,?,?,?,?, 'manager', ?, ?)`,
  ).bind(qid, id, finalType, finalCardNo, fileKey, fileType, finalExpiry, now, actor, now, actor).run();
  return c.json({ id: qid, qual_type: finalType, card_no: finalCardNo, expiry_date: finalExpiry, read_from_card: !!extracted });
});

/** Verify a self-uploaded qualification card (manager confirms it). */
operatives.post("/quals/:qid/verify", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  await c.env.DB.prepare(
    "UPDATE operative_quals SET verified_at = ?, verified_by = ? WHERE id = ?",
  ).bind(new Date().toISOString(), c.get("userEmail"), c.req.param("qid")).run();
  return c.json({ ok: true });
});

operatives.delete("/quals/:qid", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const row = await c.env.DB.prepare("SELECT file_key FROM operative_quals WHERE id = ?")
    .bind(c.req.param("qid")).first<{ file_key: string | null }>();
  if (row?.file_key) await c.env.R2.delete(row.file_key);
  await c.env.DB.prepare("DELETE FROM operative_quals WHERE id = ?").bind(c.req.param("qid")).run();
  return c.json({ ok: true });
});

// ── RAMS: list assignable docs + assign to an operative ─────────────────────
operatives.get("/rams/options", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const rows = await c.env.DB.prepare(
    `SELECT d.id AS rams_id, d.title, d.project_id, p.code AS project_code
       FROM rams_documents d JOIN projects p ON p.id = d.project_id
      WHERE d.active = 1 AND p.deleted_at IS NULL
      ORDER BY p.code, d.title`,
  ).all();
  return c.json(rows.results);
});

operatives.post("/:id/rams", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const body = await c.req.json<{ rams_id?: number; project_id?: string }>();
  if (!body.rams_id || !body.project_id) return c.json({ error: "rams_id and project_id required" }, 400);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO operative_rams_signs (id, operative_id, rams_id, project_id, requested_at, requested_by)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(operative_id, rams_id) DO NOTHING`,
  ).bind(crypto.randomUUID(), id, body.rams_id, body.project_id, now, c.get("userEmail")).run();
  // Notify the operative so they actually receive the RAMS to read & sign.
  try {
    const op = await c.env.DB.prepare(
      "SELECT id, name, email, phone, token FROM operatives WHERE id = ? AND archived_at IS NULL",
    ).bind(id).first<{ id: string; name: string; email: string | null; phone: string | null; token: string }>();
    if (op) await inviteOperative(c.env, op);
  } catch (e) { console.error("RAMS assign notify failed:", e instanceof Error ? e.message : e); }
  return c.json({ ok: true });
});

// Bulk-distribute one TOOLBOX TALK to many operatives — the talk equivalent of
// /rams/distribute. Same push (email + SMS of their profile link) and the same
// idempotency, but the operative ACKNOWLEDGES the talk rather than signing it.
operatives.post("/toolbox/distribute", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const body = await c.req.json<{ notice_id?: number; project_id?: string; operative_ids?: string[] }>();
  const ids = Array.isArray(body.operative_ids) ? body.operative_ids.filter((x) => typeof x === "string" && x) : [];
  if (!body.notice_id || !body.project_id || ids.length === 0) {
    return c.json({ error: "notice_id, project_id and at least one operative are required" }, 400);
  }
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  // Stamp the base — the talk itself is recorded there on a grouped site, so the
  // ack must agree with it or the operative's profile shows a mismatched block.
  const siteId = (await siteScope(c.env, body.project_id)).baseId;
  const stmt = c.env.DB.prepare(
    `INSERT INTO operative_notice_acks (id, operative_id, notice_id, project_id, requested_at, requested_by)
     VALUES (?,?,?,?,?,?) ON CONFLICT(operative_id, notice_id) DO NOTHING`,
  );
  await c.env.DB.batch(ids.map((oid) => stmt.bind(crypto.randomUUID(), oid, body.notice_id, siteId, now, actor)));
  // Push it: their profile link lists whatever is awaiting them (RAMS to sign,
  // talks to acknowledge), so the same invite covers both.
  let emailed = 0, texted = 0, cooldown = 0;
  try {
    const ph = ids.map(() => "?").join(",");
    const ops = await c.env.DB.prepare(
      `SELECT id, name, email, phone, token FROM operatives WHERE id IN (${ph}) AND archived_at IS NULL`,
    ).bind(...ids).all<{ id: string; name: string; email: string | null; phone: string | null; token: string }>();
    const results = await Promise.all(ops.results.map((op) => inviteOperative(c.env, op)));
    emailed = results.filter((r) => r.email).length;
    texted = results.filter((r) => r.sms).length;
    // Invites de-dupe within 3 minutes. Silently reporting "0 emailed" for a
    // suppressed re-send reads as a broken send — say it was suppressed.
    cooldown = results.filter((r) => r.skipped).length;
  } catch (e) { console.error("toolbox distribute notify failed:", e instanceof Error ? e.message : e); }
  return c.json({ ok: true, sent: ids.length, emailed, texted, cooldown });
});

// Bulk-distribute one RAMS doc to many operatives at once (the Operations →
// RAMS "Distribute" picker — scales to large crews). Idempotent per operative.
operatives.post("/rams/distribute", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const body = await c.req.json<{ rams_id?: number; project_id?: string; operative_ids?: string[] }>();
  const ids = Array.isArray(body.operative_ids) ? body.operative_ids.filter((x) => typeof x === "string" && x) : [];
  if (!body.rams_id || !body.project_id || ids.length === 0) {
    return c.json({ error: "rams_id, project_id and at least one operative are required" }, 400);
  }
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  // Base, for the same reason as toolbox distribution: the RAMS doc lives there.
  const siteId = (await siteScope(c.env, body.project_id)).baseId;
  const stmt = c.env.DB.prepare(
    `INSERT INTO operative_rams_signs (id, operative_id, rams_id, project_id, requested_at, requested_by)
     VALUES (?,?,?,?,?,?) ON CONFLICT(operative_id, rams_id) DO NOTHING`,
  );
  await c.env.DB.batch(ids.map((oid) => stmt.bind(crypto.randomUUID(), oid, body.rams_id, siteId, now, actor)));
  // Actually notify each operative — email + SMS their profile link (with the
  // full list of RAMS awaiting their signature). Without this the RAMS were only
  // recorded as "to sign" and nothing was ever sent.
  let emailed = 0, texted = 0;
  try {
    const ph = ids.map(() => "?").join(",");
    const ops = await c.env.DB.prepare(
      `SELECT id, name, email, phone, token FROM operatives WHERE id IN (${ph}) AND archived_at IS NULL`,
    ).bind(...ids).all<{ id: string; name: string; email: string | null; phone: string | null; token: string }>();
    const results = await Promise.all(ops.results.map((op) => inviteOperative(c.env, op)));
    emailed = results.filter((r) => r.email).length;
    texted = results.filter((r) => r.sms).length;
  } catch (e) { console.error("RAMS distribute notify failed:", e instanceof Error ? e.message : e); }
  return c.json({ ok: true, sent: ids.length, emailed, texted });
});
