import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { normalisePhone } from "../../shared/operatives-import";
import { extractQualCard } from "./operatives";
import { computeQualityRollup, qualityDashboardHtml } from "./quality-dashboard";
import { isSafeMediaUrl } from "../safe-url";

// Public, operative-facing site sign-in. Mounted at /pub (NOT /api) so the
// auth middleware does not gate it — operatives are not app users. The
// per-site token (from the QR link) is the capability. Reached via the
// standalone /site/:token React page.
//
// NB: in production the whole hostname sits behind Cloudflare Access, so a
// Bypass policy must be added for /site/*, /pub/* and /assets/* for these to
// be reachable by an un-authenticated operative. See ops docs.
export const publicOps = new Hono<{ Bindings: Env; Variables: Variables }>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Constant-time string compare — avoids leaking the ingest token via response
 *  timing on this unauthenticated endpoint. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Resolve an image MIME from the response content-type, falling back to the URL
 *  extension (S3/Wasabi links often serve images as application/octet-stream).
 *  Returns null when it isn't an image. */
function imgMime(url: string, ct: string | null): string | null {
  if (ct && /^image\//i.test(ct)) return ct.split(";")[0].trim();
  const m = url.split("?")[0].match(/\.(jpe?g|png|gif|webp)$/i);
  if (!m) return null;
  const e = m[1].toLowerCase();
  return e === "jpg" || e === "jpeg" ? "image/jpeg" : `image/${e}`;
}

/**
 * Site-report ingest webhook. A WhatsApp connector (hosted API, self-hosted
 * Baileys, or anything) POSTs field updates here; they're stored per project for
 * the daily/weekly report engine. Mounted under /pub (already Access-bypassed)
 * and guarded by a bearer token (SITE_REPORT_INGEST_TOKEN secret). Accepts a
 * single message or { messages: [...] }. Each message resolves to a project by
 * an explicit project_code, or a project code found in the group name.
 */
// Webhook providers (Whapi included) verify a webhook by probing the URL with a
// non-POST method (GET / HEAD / OPTIONS) before they'll save it — answer any of
// those with a 200 so verification passes. Echoes a `challenge`/`hub.challenge`
// query param back if present (some providers require it). Only POST below does
// the real, token-guarded ingest.
// Note the optional `:event?` segment — Whapi (and some others) append the event
// name to the URL, e.g. POST /pub/site-report-ingest/messages. We accept both the
// bare path and a one-segment suffix so it doesn't 404/405 into the website handler.
publicOps.on(["GET", "HEAD", "OPTIONS", "PUT", "PATCH"], "/site-report-ingest/:event?", (c) => {
  const challenge = c.req.query("challenge") ?? c.req.query("hub.challenge");
  if (challenge) return c.text(challenge);
  return c.json({ ok: true, service: "site-report-ingest" });
});

publicOps.post("/site-report-ingest/:event?", async (c) => {
  const token = c.env.SITE_REPORT_INGEST_TOKEN;
  if (!token) return c.json({ error: "ingest not configured" }, 503);
  const provided = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim() || c.req.query("token") || "";
  if (!provided || !constantTimeEqual(provided, token)) return c.json({ error: "unauthorized" }, 401);

  // Shape covers Whapi.cloud's native webhook (text.body, chat_name, timestamp,
  // from_name, media sub-objects, from_me) AND a simpler generic form, so the
  // recommended provider works with no transform — and so do Maytapi/manual posts.
  type Media = { link?: string };
  type MsgLike = {
    // text can be a string (generic) or { body } (Whapi)
    text?: string | { body?: string }; body?: string; caption?: string;
    // group naming
    chat_name?: string; group_name?: string; group?: string; chat?: string; chat_id?: string;
    project_code?: string;
    // sender
    from_name?: string; sender?: string; from?: string;
    from_me?: boolean;
    // media
    media_url?: string; image?: Media; document?: Media; video?: Media; voice?: Media; audio?: Media;
    // meta
    type?: string; source?: string; id?: string; external_id?: string;
    occurred_at?: string; ts?: number | string; timestamp?: number | string;
  };
  const payload = await c.req.json<{ messages?: MsgLike[] } & MsgLike>().catch(() => null);
  if (!payload) return c.json({ error: "invalid JSON" }, 400);
  const msgs: MsgLike[] = Array.isArray(payload.messages) ? payload.messages : [payload];

  const projects = (await c.env.DB.prepare(
    "SELECT id, code FROM projects WHERE deleted_at IS NULL",
  ).all<{ id: string; code: string }>()).results;
  // Explicit group→project links (set via Reports "Connect a group") take
  // priority over chat-name code matching, so a group named without the code
  // (or inside a Community) still routes to the right project.
  const links = new Map<string, string>();
  try {
    const lr = await c.env.DB.prepare("SELECT chat_id, project_id FROM whatsapp_group_links").all<{ chat_id: string; project_id: string }>();
    for (const r of lr.results) links.set(r.chat_id, r.project_id);
  } catch { /* table absent pre-0057 */ }
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const resolve = (hay: string): string | null => {
    const lc = hay.toLowerCase();
    for (const p of projects) {
      const code = String(p.code).toLowerCase().trim();
      if (code && new RegExp(`(^|[^a-z0-9])${esc(code)}([^a-z0-9]|$)`).test(lc)) return p.id;
    }
    return null;
  };
  const epoch = (v: number | string): string => { const n = typeof v === "number" ? v : +v; return new Date(n < 1e12 ? n * 1000 : n).toISOString(); };
  const toIso = (m: MsgLike): string => {
    if (m.occurred_at) { const t = Date.parse(m.occurred_at); if (!isNaN(t)) return new Date(t).toISOString(); }
    if (m.timestamp != null && /^\d+$/.test(String(m.timestamp))) return epoch(m.timestamp);
    if (m.ts != null && /^\d+$/.test(String(m.ts))) return epoch(m.ts);
    return new Date().toISOString();
  };

  const now = new Date().toISOString();
  let stored = 0, unresolved = 0, skipped = 0;
  for (const m of msgs) {
    if (m.from_me === true) { skipped++; continue; } // our own sends — ignore
    const groupName = (m.chat_name ?? m.group_name ?? m.group ?? m.chat ?? "").toString();
    const pid = (m.chat_id ? links.get(String(m.chat_id)) : undefined)
      ?? resolve(`${m.project_code ?? ""} ${groupName} ${m.chat_id ?? ""}`);
    if (!pid) { unresolved++; continue; }
    const text = (typeof m.text === "string" ? m.text : (m.text?.body ?? "")) || m.body || m.caption || "";
    const media = m.media_url ?? m.image?.link ?? m.document?.link ?? m.video?.link ?? m.voice?.link ?? m.audio?.link ?? null;
    // Only images go to the project's Site Photos; an explicit image sub-object,
    // or a bare media_url on a message typed as an image / with no other type.
    const imageLink = m.image?.link ?? (m.type === "image" || (!m.type && !m.document && !m.video && !m.voice && !m.audio && m.media_url) ? m.media_url ?? null : null);
    if (!text.trim() && !media) { skipped++; continue; }
    const occurredAt = toIso(m);
    try {
      const ins = await c.env.DB.prepare(
        `INSERT OR IGNORE INTO project_updates
           (project_id, source, external_id, group_name, sender, body, media_url, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        pid, (m.source ?? "whatsapp").toString(), (m.id ?? m.external_id ?? null) as string | null,
        groupName || null, (m.from_name ?? m.sender ?? m.from ?? null) as string | null,
        text.trim() || null, media, occurredAt, now,
      ).run();
      // Only act on a genuinely new row (external_id de-dupes webhook retries).
      if ((ins.meta?.changes ?? 1) === 0) { skipped++; continue; }
      stored++;
      // Mirror photos into the project's Site Photos (progress_photos) so they're
      // browsable on the project and can be appended to the report.
      if (imageLink && isSafeMediaUrl(imageLink)) {
        try {
          const resp = await fetch(imageLink);
          // Wasabi/Whapi links often serve as application/octet-stream — fall back
          // to the URL extension so genuine images aren't rejected.
          const mime = imgMime(imageLink, resp.headers.get("content-type"));
          if (resp.ok && mime) {
            // The update id in the key lets the report backfill de-dupe (wa<id>).
            const upId = ins.meta?.last_row_id ?? 0;
            const key = `progress/${pid}/wa${upId}-${crypto.randomUUID()}.jpg`;
            await c.env.R2.put(key, await resp.arrayBuffer(), { httpMetadata: { contentType: mime } });
            await c.env.DB.prepare(
              `INSERT INTO progress_photos (project_id, file_key, file_type, caption, taken_on, created_at, created_by)
               VALUES (?,?,?,?,?,?,?)`,
            ).bind(pid, key, mime, text.trim() || null, occurredAt.slice(0, 10), now, `whatsapp:${(m.from_name ?? m.from ?? "site").toString()}`).run();
          }
        } catch (e) { console.warn("photo store failed:", e instanceof Error ? e.message : e); }
      }
    } catch (e) { console.warn("ingest insert failed:", e instanceof Error ? e.message : e); }
  }
  return c.json({ ok: true, stored, unresolved, skipped });
});

/** Best-effort email to the project owner that an operative signed in (or tried
 *  to) without having signed the site RAMS. Never throws. */
async function alertManagerNoRams(env: Env, projectId: string, opName: string, projectCode: string) {
  try {
    if (!env.RESEND_API_KEY) return;
    const owner = await env.DB.prepare("SELECT site_manager_email, created_by FROM projects WHERE id = ?")
      .bind(projectId).first<{ site_manager_email: string | null; created_by: string }>();
    const recipient = owner?.site_manager_email?.trim() || owner?.created_by;
    if (!recipient) return;
    const from = env.RESEND_FROM || "PowerGrid Apps <apps@notifications.powergridprojects.co.uk>";
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from, to: [recipient],
        subject: `⚠️ RAMS not signed — ${opName} at ${projectCode}`,
        html: `<p><b>${opName}</b> attempted to sign in at <b>${projectCode}</b> without having signed the current site RAMS.</p>
               <p>The RAMS have been added to their profile to sign; they were blocked from signing in until they do.</p>`,
      }),
    });
  } catch (e) {
    console.warn("RAMS alert email failed:", e instanceof Error ? e.message : e);
  }
}

type SignerOperative = { id: string; token: string; name: string; phone: string | null; company: string | null; trade: string | null; assigned_project_id: string | null };

/** The project ids that make up the site `projectId` belongs to. Ungrouped →
 *  just itself; grouped → every contract in the site group. Used to gate sign-in
 *  by assignment. Fails open to [projectId]. */
async function siteMemberIds(env: Env, projectId: string): Promise<string[]> {
  try {
    const row = await env.DB.prepare("SELECT site_group_id FROM projects WHERE id = ?")
      .bind(projectId).first<{ site_group_id: string | null }>();
    if (!row?.site_group_id) return [projectId];
    const members = await env.DB.prepare(
      "SELECT id FROM projects WHERE site_group_id = ? AND deleted_at IS NULL",
    ).bind(row.site_group_id).all<{ id: string }>();
    const ids = members.results.map((m) => m.id);
    return ids.length ? ids : [projectId];
  } catch { return [projectId]; }
}

/** Resolve the signing operative (by the id they picked, falling back to a
 *  phone match for older clients) and gate the sign-in:
 *   • block "unregistered" — no matching registered operative (everyone must be
 *     registered before they start).
 *   • block "unassigned" — the operative isn't assigned to this site. Operatives
 *     are transferred to the site they're working, and sign-in is limited to
 *     those assigned here (or to any contract in the site's group).
 *   • block "rams" — assigned, but hasn't signed the site's active RAMS;
 *     auto-assign the unsigned RAMS to their profile, email the manager, block.
 *   • block null — allowed.
 *  Also returns the resolved operative so the caller can fill the sign-in row
 *  from the register rather than trusting typed input.
 *  The whole thing is wrapped so a missing operatives table (before the 0039
 *  migration runs) fails OPEN and never breaks sign-in. */
async function operativeGate(
  env: Env, projectId: string, projectCode: string,
  operativeId: string | null, phone: string | null, name: string,
): Promise<{ block: { type: "unregistered" } | { type: "unassigned" } | { type: "rams"; token: string } | null; op: SignerOperative | null }> {
  try {
    let op: SignerOperative | null = null;
    if (operativeId) {
      op = await env.DB.prepare(
        "SELECT id, token, name, phone, company, trade, assigned_project_id FROM operatives WHERE id = ? AND archived_at IS NULL",
      ).bind(operativeId).first<SignerOperative>();
    } else {
      const norm = normalisePhone(phone);
      if (norm) {
        op = await env.DB.prepare(
          "SELECT id, token, name, phone, company, trade, assigned_project_id FROM operatives WHERE phone_norm = ? AND archived_at IS NULL LIMIT 1",
        ).bind(norm).first<SignerOperative>();
      }
    }
    if (!op) return { block: { type: "unregistered" }, op: null }; // must be registered before starting

    // Must be assigned to this site (or any contract in its group) to sign in.
    const memberIds = await siteMemberIds(env, projectId);
    if (!op.assigned_project_id || !memberIds.includes(op.assigned_project_id)) {
      return { block: { type: "unassigned" }, op };
    }

    const activeRams = await env.DB.prepare(
      "SELECT id FROM rams_documents WHERE project_id = ? AND active = 1",
    ).bind(projectId).all<{ id: number }>();
    if (activeRams.results.length === 0) return { block: null, op }; // no RAMS on this site
    const signed = await env.DB.prepare(
      "SELECT rams_id FROM operative_rams_signs WHERE operative_id = ? AND signed_at IS NOT NULL",
    ).bind(op.id).all<{ rams_id: number }>();
    const signedSet = new Set(signed.results.map((r) => r.rams_id));
    const unsigned = activeRams.results.filter((r) => !signedSet.has(r.id));
    if (unsigned.length === 0) return { block: null, op }; // all signed → fine

    // Auto-assign the unsigned RAMS to their profile so they can sign them.
    const now = new Date().toISOString();
    await env.DB.batch(
      unsigned.map((r) =>
        env.DB.prepare(
          `INSERT INTO operative_rams_signs (id, operative_id, rams_id, project_id, requested_at, requested_by)
           VALUES (?,?,?,?,?,'site sign-in') ON CONFLICT(operative_id, rams_id) DO NOTHING`,
        ).bind(crypto.randomUUID(), op.id, r.id, projectId, now),
      ),
    );
    await alertManagerNoRams(env, projectId, op.name || name, projectCode);
    return { block: { type: "rams", token: op.token }, op };
  } catch (e) {
    // operatives tables not present yet (pre-migration) — don't block sign-in.
    console.warn("operative gate skipped:", e instanceof Error ? e.message : e);
    return { block: null, op: null };
  }
}

async function resolveToken(c: { env: Env }, token: string) {
  return c.env.DB.prepare(
    `SELECT t.token, t.project_id, p.code, p.name
       FROM site_tokens t JOIN projects p ON p.id = t.project_id
      WHERE t.token = ? AND t.active = 1 AND p.deleted_at IS NULL`,
  ).bind(token).first<{ token: string; project_id: string; code: string; name: string }>();
}

/** Read a site's standing daily briefing (settings-backed), if set. */
async function loadStandingBriefing(c: { env: Env }, projectId: string): Promise<{ title: string; content: string } | null> {
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(`site_briefing:${projectId}`).first<{ value: string }>();
  if (!row?.value) return null;
  try {
    const b = JSON.parse(row.value) as { title?: string; content?: string };
    return { title: b.title ?? "Daily briefing", content: b.content ?? "" };
  } catch { return null; }
}

// Resolve a site + the standing daily briefing + today's active notices.
publicOps.get("/site/:token", async (c) => {
  const site = await resolveToken(c, c.req.param("token"));
  if (!site) return c.json({ error: "This sign-in link is no longer valid." }, 404);
  const notices = await c.env.DB.prepare(
    `SELECT id, type, title, content, notice_date
       FROM site_notices
      WHERE project_id = ? AND active = 1 AND notice_date = ?
      ORDER BY type, created_at`,
  ).bind(site.project_id, today()).all();
  // Operatives for the sign-in picker — only those ASSIGNED to this site (or any
  // contract in its group). Minimal fields only (no phone / email / token).
  // Fails open to [] if the operatives table isn't present yet.
  let operatives: Array<{ id: string; name: string; company: string | null; trade: string | null }> = [];
  try {
    const memberIds = await siteMemberIds(c.env, site.project_id);
    const ph = memberIds.map(() => "?").join(",");
    const ops = await c.env.DB.prepare(
      `SELECT id, name, company, trade FROM operatives
        WHERE archived_at IS NULL AND assigned_project_id IN (${ph})
        ORDER BY name COLLATE NOCASE`,
    ).bind(...memberIds).all<{ id: string; name: string; company: string | null; trade: string | null }>();
    operatives = ops.results;
  } catch (e) {
    console.warn("operatives list skipped:", e instanceof Error ? e.message : e);
  }
  // If this contract is part of a site group, show the site name so operatives
  // know they're signing into the whole site, not one contract.
  let siteGroupName: string | null = null;
  try {
    const g = await c.env.DB.prepare(
      "SELECT g.name FROM projects p JOIN site_groups g ON g.id = p.site_group_id WHERE p.id = ?",
    ).bind(site.project_id).first<{ name: string }>();
    siteGroupName = g?.name ?? null;
  } catch { /* pre-0046 — no site_groups table */ }
  return c.json({
    project: { code: site.code, name: site.name },
    site_group_name: siteGroupName,
    briefing: await loadStandingBriefing(c, site.project_id),
    notices: notices.results,
    operatives,
  });
});

// Operative signs in: name + optional company/trade/phone, a drawn signature
// (PNG data-URL), geolocation, and acknowledgements of today's notices.
publicOps.post("/site/:token/signin", async (c) => {
  const site = await resolveToken(c, c.req.param("token"));
  if (!site) return c.json({ error: "This sign-in link is no longer valid." }, 404);
  const body = await c.req.json<{
    operative_id?: string;
    name?: string; company?: string; trade?: string; phone?: string;
    signature?: string; lat?: number; lng?: number; accuracy?: number;
    ack_notice_ids?: number[]; briefing_ack?: boolean;
  }>();
  if (body.signature && body.signature.length > 400_000) {
    return c.json({ error: "Signature image too large." }, 400);
  }
  // If a standing daily briefing is set, it must be acknowledged to sign in.
  const briefing = await loadStandingBriefing(c, site.project_id);
  if (briefing && !body.briefing_ack) {
    return c.json({ error: "Please acknowledge the daily briefing before signing in." }, 400);
  }
  // Resolve + gate the operative: they pick themselves from the register
  // (operative_id); a phone match is kept as a fallback for older clients.
  // Identity for the sign-in row comes from the register, not typed input.
  const { block, op } = await operativeGate(
    c.env, site.project_id, site.code, body.operative_id ?? null, body.phone ?? null, (body.name ?? "").trim(),
  );
  if (block?.type === "unregistered") {
    return c.json({
      error: "You're not set up as a site operative yet. Ask your site manager to register you and complete "
        + "your induction before signing in.",
      unregistered: true,
    }, 403);
  }
  if (block?.type === "unassigned") {
    return c.json({
      error: "You're not assigned to this site. Ask your site manager to assign you to this site before signing in.",
      unassigned: true,
    }, 403);
  }
  if (block?.type === "rams") {
    return c.json({
      error: "You haven't signed the site RAMS yet. Open your operative profile to read & sign them, then sign in.",
      rams_required: true,
      profile_url: `/operative/${block.token}`,
    }, 403);
  }
  // Prefer the registered operative's details; fall back to typed values (only
  // reachable pre-migration, when the gate fails open with no operative).
  const name = (op?.name ?? body.name ?? "").trim();
  if (!name) return c.json({ error: "Please select your name." }, 400);
  const company = op ? op.company : (body.company?.trim() || null);
  const trade = op ? op.trade : (body.trade?.trim() || null);
  const phone = op ? op.phone : (body.phone?.trim() || null);
  const now = new Date().toISOString();
  const res = await c.env.DB.prepare(
    `INSERT INTO site_signins
       (project_id, name, company, trade, phone, signature, lat, lng, accuracy, signed_in_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).bind(
    site.project_id, name, company, trade, phone, body.signature || null,
    body.lat ?? null, body.lng ?? null, body.accuracy ?? null, now, now,
  ).first<{ id: number }>();
  const signinId = res!.id;

  // Record acknowledgements — only for notices that genuinely belong to this
  // project and are active today (defends against tampered ids).
  const ackIds = Array.isArray(body.ack_notice_ids)
    ? [...new Set(body.ack_notice_ids.filter((n) => Number.isInteger(n)))]
    : [];
  if (ackIds.length) {
    const valid = await c.env.DB.prepare(
      `SELECT id FROM site_notices
        WHERE project_id = ? AND active = 1 AND notice_date = ?
          AND id IN (${ackIds.map(() => "?").join(",")})`,
    ).bind(site.project_id, today(), ...ackIds).all<{ id: number }>();
    if (valid.results.length) {
      await c.env.DB.batch(
        valid.results.map((r) =>
          c.env.DB.prepare(
            `INSERT INTO site_notice_acks (notice_id, signin_id, name, lat, lng, acked_at)
             VALUES (?,?,?,?,?,?)`,
          ).bind(r.id, signinId, name, body.lat ?? null, body.lng ?? null, now),
        ),
      );
    }
  }
  return c.json({ id: signinId });
});

// Operative signs out (end of shift). The device remembers its own signin id.
publicOps.post("/site/:token/signout", async (c) => {
  const site = await resolveToken(c, c.req.param("token"));
  if (!site) return c.json({ error: "This sign-in link is no longer valid." }, 404);
  const body = await c.req.json<{ signin_id?: number }>();
  if (!body.signin_id) return c.json({ error: "signin_id required" }, 400);
  await c.env.DB.prepare(
    `UPDATE site_signins SET signed_out_at = ?
      WHERE id = ? AND project_id = ? AND signed_out_at IS NULL`,
  ).bind(new Date().toISOString(), body.signin_id, site.project_id).run();
  return c.json({ ok: true });
});

// ── Operative self-service profile (reached via personal token link) ────────
async function resolveOperative(env: Env, token: string) {
  return env.DB.prepare(
    "SELECT id, token, name, company, trade, phone, email, induction_done, induction_at, assigned_project_id FROM operatives WHERE token = ? AND archived_at IS NULL",
  ).bind(token).first<{ id: string; token: string; name: string; company: string | null; trade: string | null; phone: string | null; email: string | null; induction_done: number; induction_at: string | null; assigned_project_id: string | null }>();
}

/** Company induction document set in Admin (settings-backed). HTML = Word converted
 *  for inline phone reading; file_key = the original upload (e.g. a PDF) in R2. */
async function companyInduction(env: Env): Promise<{ filename: string; has_html: boolean; file_type: string | null; updated_at: string | null } | null> {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('company_induction_filename','company_induction_html','company_induction_file_key','company_induction_file_type','company_induction_updated_at')",
  ).all<{ key: string; value: string }>();
  const m = new Map(rows.results.map((r) => [r.key, r.value]));
  const filename = m.get("company_induction_filename");
  if (!filename) return null;
  return { filename, has_html: !!m.get("company_induction_html"), file_type: m.get("company_induction_file_type") ?? null, updated_at: m.get("company_induction_updated_at") ?? null };
}

function qualStatusPub(expiry: string | null, verifiedAt: string | null): "pending" | "valid" | "expiring" | "expired" | "none" {
  if (!verifiedAt) return "pending";
  if (!expiry) return "none";
  const exp = new Date(expiry + "T00:00:00").getTime();
  if (Number.isNaN(exp)) return "none";
  const now = Date.now();
  if (exp < now) return "expired";
  if (exp < now + 30 * 86_400_000) return "expiring";
  return "valid";
}

publicOps.get("/operative/:token", async (c) => {
  const token = c.req.param("token");
  const op = await resolveOperative(c.env, token);
  if (!op) return c.json({ error: "This profile link is no longer valid." }, 404);
  const quals = await c.env.DB.prepare(
    "SELECT id, qual_type, card_no, file_key, expiry_date, verified_at FROM operative_quals WHERE operative_id = ? ORDER BY verified_at IS NOT NULL, qual_type",
  ).bind(op.id).all<{ id: string; qual_type: string; card_no: string | null; file_key: string | null; expiry_date: string | null; verified_at: string | null }>();
  // `has_html` = the RAMS has a phone-readable converted version (so it's
  // signable). Wrapped so a pre-0047 DB (no html_content column) still loads.
  let ramsRows: Array<{ id: string; signed_at: string | null; rams_title: string; project_code: string; has_html: number }> = [];
  try {
    const r = await c.env.DB.prepare(
      `SELECT s.id, s.signed_at, d.title AS rams_title, p.code AS project_code,
              (d.html_content IS NOT NULL) AS has_html
         FROM operative_rams_signs s
         JOIN rams_documents d ON d.id = s.rams_id
         JOIN projects p ON p.id = s.project_id
        WHERE s.operative_id = ? ORDER BY s.signed_at IS NOT NULL, s.requested_at DESC`,
    ).bind(op.id).all<{ id: string; signed_at: string | null; rams_title: string; project_code: string; has_html: number }>();
    ramsRows = r.results;
  } catch (e) {
    console.warn("rams html flag skipped (pre-0047):", e instanceof Error ? e.message : e);
    const r = await c.env.DB.prepare(
      `SELECT s.id, s.signed_at, d.title AS rams_title, p.code AS project_code
         FROM operative_rams_signs s JOIN rams_documents d ON d.id = s.rams_id JOIN projects p ON p.id = s.project_id
        WHERE s.operative_id = ? ORDER BY s.signed_at IS NOT NULL, s.requested_at DESC`,
    ).bind(op.id).all<{ id: string; signed_at: string | null; rams_title: string; project_code: string }>();
    ramsRows = r.results.map((x) => ({ ...x, has_html: 0 }));
  }
  // Site induction status for the site they're currently assigned to (separate
  // from the company induction). Best-effort — pre-0056 DBs have no table.
  let siteInduction: { project_code: string; inducted_at: string | null } | null = null;
  if (op.assigned_project_id) {
    try {
      const si = await c.env.DB.prepare(
        `SELECT p.code AS project_code, i.inducted_at AS inducted_at
           FROM projects p LEFT JOIN site_inductions i ON i.project_id = p.id AND i.operative_id = ?
          WHERE p.id = ?`,
      ).bind(op.id, op.assigned_project_id).first<{ project_code: string; inducted_at: string | null }>();
      if (si) siteInduction = { project_code: si.project_code, inducted_at: si.inducted_at };
    } catch { /* pre-0056 */ }
  }
  const ci = await companyInduction(c.env).catch(() => null);
  // Toolbox talks pushed to this operative. Same shape as RAMS so the profile
  // renders them the same way — but acknowledged, never signed. Best-effort:
  // a pre-0107 DB just shows no talks.
  let talkRows: Array<{ id: string; acked_at: string | null; title: string; notice_date: string; project_code: string; has_doc: number }> = [];
  try {
    const t = await c.env.DB.prepare(
      `SELECT a.id, a.acked_at, n.title, n.notice_date, p.code AS project_code,
              (n.sections_json IS NOT NULL OR n.html_content IS NOT NULL) AS has_doc
         FROM operative_notice_acks a
         JOIN site_notices n ON n.id = a.notice_id
         JOIN projects p ON p.id = a.project_id
        WHERE a.operative_id = ? AND n.active = 1
        ORDER BY a.acked_at IS NOT NULL, a.requested_at DESC`,
    ).bind(op.id).all<{ id: string; acked_at: string | null; title: string; notice_date: string; project_code: string; has_doc: number }>();
    talkRows = t.results;
  } catch (e) { console.warn("toolbox talks skipped (pre-0107):", e instanceof Error ? e.message : e); }

  return c.json({
    operative: {
      name: op.name, company: op.company, trade: op.trade,
      phone: op.phone, email: op.email,
      induction_done: !!op.induction_done, induction_at: op.induction_at,
    },
    site_induction: siteInduction,
    company_induction: { available: !!ci, has_html: ci?.has_html ?? false, filename: ci?.filename ?? null },
    quals: quals.results.map((q) => ({
      id: q.id, qual_type: q.qual_type, card_no: q.card_no, expiry_date: q.expiry_date,
      status: qualStatusPub(q.expiry_date, q.verified_at),
      file_url: q.file_key ? `/pub/operative/${token}/qual-file/${q.id}` : null,
    })),
    rams: ramsRows.map((r) => ({
      id: r.id, title: r.rams_title, project_code: r.project_code, signed_at: r.signed_at,
      has_html: !!r.has_html,
      doc_url: `/pub/operative/${token}/rams-file/${r.id}`,
      content_url: `/pub/operative/${token}/rams-content/${r.id}`,
    })),
    toolbox_talks: talkRows.map((t) => ({
      id: t.id, title: t.title, project_code: t.project_code,
      notice_date: t.notice_date, acked_at: t.acked_at, has_doc: !!t.has_doc,
      content_url: `/pub/operative/${token}/toolbox-content/${t.id}`,
    })),
  });
});

// The talk itself — structured sections drive the same gated reader as RAMS;
// html is the fallback when the doc didn't parse into sections.
publicOps.get("/operative/:token/toolbox-content/:id", async (c) => {
  const op = await resolveOperative(c.env, c.req.param("token"));
  if (!op) return c.json({ error: "This profile link is no longer valid." }, 404);
  const row = await c.env.DB.prepare(
    `SELECT n.title, n.content, n.html_content, n.sections_json, n.notice_date, a.acked_at, p.code AS project_code
       FROM operative_notice_acks a
       JOIN site_notices n ON n.id = a.notice_id
       JOIN projects p ON p.id = a.project_id
      WHERE a.id = ? AND a.operative_id = ?`,
  ).bind(c.req.param("id"), op.id).first<{
    title: string; content: string | null; html_content: string | null;
    sections_json: string | null; notice_date: string; acked_at: string | null; project_code: string;
  }>();
  if (!row) return c.json({ error: "not found" }, 404);
  let doc: unknown = null;
  if (row.sections_json) { try { doc = JSON.parse(row.sections_json); } catch { doc = null; } }
  return c.json({
    title: row.title, project_code: row.project_code, notice_date: row.notice_date,
    acked_at: row.acked_at, doc, html: row.html_content, text: row.content,
  });
});

// Operative acknowledges a talk after reading it through. No signature — the
// acknowledgement (who, when) IS the record, and it feeds the H&S pack.
publicOps.post("/operative/:token/toolbox-ack/:id", async (c) => {
  const op = await resolveOperative(c.env, c.req.param("token"));
  if (!op) return c.json({ error: "This profile link is no longer valid." }, 404);
  const row = await c.env.DB.prepare(
    "SELECT id, notice_id, acked_at FROM operative_notice_acks WHERE id = ? AND operative_id = ?",
  ).bind(c.req.param("id"), op.id).first<{ id: string; notice_id: number; acked_at: string | null }>();
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.acked_at) return c.json({ ok: true, acked_at: row.acked_at }); // idempotent
  const body = await c.req.json<{
    signature?: string; lat?: number | null; lng?: number | null;
    accuracy?: number | null; geo_status?: string | null;
  }>().catch(() => ({} as Record<string, never>));
  // The signature IS the record — a talk can't be completed without one.
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  if (!signature) return c.json({ error: "A signature is required to complete a toolbox talk." }, 400);
  // Location is best-effort: a refused permission or no fix records the sign-off
  // anyway, with the reason, rather than stranding an operative on site.
  const geoStatus = ["ok", "denied", "unavailable"].includes(String(body.geo_status)) ? String(body.geo_status) : "unavailable";
  const lat = typeof body.lat === "number" ? body.lat : null;
  const lng = typeof body.lng === "number" ? body.lng : null;
  const accuracy = typeof body.accuracy === "number" ? body.accuracy : null;
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE operative_notice_acks
        SET acked_at = ?, signature = ?, lat = ?, lng = ?, accuracy = ?, geo_status = ?
      WHERE id = ?`,
  ).bind(now, signature, lat, lng, accuracy, geoStatus, row.id).run();
  // Mirror into site_notice_acks so the H&S pack, the attendance export and the
  // talk's acknowledged count see it exactly like a sign-in acknowledgement.
  //
  // Attach it to the operative's sign-in for the day the talk was given. The
  // pack's register drops any ack with a null signin_id, so leaving it null put
  // the signature in the database but printed "—" against every name — the talk
  // looked undelivered on the one document that has to prove it wasn't. Matched
  // on normalised phone, the same key the sign-in gate uses.
  let signinId: number | null = null;
  try {
    const notice = await c.env.DB.prepare(
      "SELECT project_id, notice_date FROM site_notices WHERE id = ?",
    ).bind(row.notice_id).first<{ project_id: string; notice_date: string }>();
    const phone = normalisePhone(op.phone);
    if (notice && phone) {
      // site_signins stores the raw phone, so normalise both sides in JS rather
      // than in SQL. The day's rows are a handful — cheaper than a LIKE scan.
      const day = (await c.env.DB.prepare(
        `SELECT id, phone FROM site_signins
          WHERE project_id = ? AND substr(signed_in_at,1,10) = ?
          ORDER BY signed_in_at DESC`,
      ).bind(notice.project_id, notice.notice_date).all<{ id: number; phone: string | null }>()).results;
      signinId = day.find((s) => normalisePhone(s.phone) === phone)?.id ?? null;
    }
  } catch (e) { console.warn("signin link skipped:", e instanceof Error ? e.message : e); }
  await c.env.DB.prepare(
    `INSERT INTO site_notice_acks (notice_id, signin_id, name, lat, lng, acked_at) VALUES (?,?,?,?,?,?)`,
  ).bind(row.notice_id, signinId, op.name, lat, lng, now).run()
    .catch((e) => console.warn("notice ack mirror skipped:", e instanceof Error ? e.message : e));
  return c.json({ ok: true, acked_at: now });
});

// Company induction document (set in Admin) — public so the operative can read it
// on their profile before confirming.
publicOps.get("/company-induction", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('company_induction_filename','company_induction_html','company_induction_file_key')",
  ).all<{ key: string; value: string }>();
  const m = new Map(rows.results.map((r) => [r.key, r.value]));
  if (!m.get("company_induction_filename")) return c.json({ available: false });
  return c.json({
    available: true,
    filename: m.get("company_induction_filename"),
    html: m.get("company_induction_html") ?? null,
    file_url: m.get("company_induction_file_key") ? "/pub/company-induction/file" : null,
  });
});

publicOps.get("/company-induction/file", async (c) => {
  const key = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'company_induction_file_key'").first<{ value: string }>();
  if (!key?.value) return c.json({ error: "not found" }, 404);
  const obj = await c.env.R2.get(key.value);
  if (!obj) return c.json({ error: "not found" }, 404);
  const type = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'company_induction_file_type'").first<{ value: string }>();
  return new Response(obj.body, { headers: { "content-type": type?.value || "application/octet-stream" } });
});

// Operative self-confirms they've completed the company induction.
publicOps.post("/operative/:token/confirm-induction", async (c) => {
  const op = await resolveOperative(c.env, c.req.param("token"));
  if (!op) return c.json({ error: "This profile link is no longer valid." }, 404);
  if (op.induction_done) return c.json({ ok: true, already: true });
  const ci = await companyInduction(c.env);
  if (!ci) return c.json({ error: "No company induction has been set yet." }, 400);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE operatives SET induction_done = 1, induction_at = ?, induction_by = 'self · company induction' WHERE id = ?",
  ).bind(now, op.id).run();
  return c.json({ ok: true, inducted_at: now });
});

publicOps.post("/operative/:token/sign-rams", async (c) => {
  const op = await resolveOperative(c.env, c.req.param("token"));
  if (!op) return c.json({ error: "This profile link is no longer valid." }, 404);
  const body = await c.req.json<{ sign_id?: string; signature?: string }>();
  if (!body.sign_id || !body.signature) return c.json({ error: "Signature required." }, 400);
  if (body.signature.length > 400_000) return c.json({ error: "Signature image too large." }, 400);
  const row = await c.env.DB.prepare(
    "SELECT id FROM operative_rams_signs WHERE id = ? AND operative_id = ?",
  ).bind(body.sign_id, op.id).first<{ id: string }>();
  if (!row) return c.json({ error: "Not found." }, 404);
  await c.env.DB.prepare(
    "UPDATE operative_rams_signs SET signature = ?, signed_at = ? WHERE id = ?",
  ).bind(body.signature, new Date().toISOString(), body.sign_id).run();
  return c.json({ ok: true });
});

// Operative uploads their own qualification card. Lands as PENDING (verified_at
// NULL, source 'self') — it doesn't count as valid until a manager verifies it.
// The card photo is read so type / number / expiry come off the card itself.
publicOps.post("/operative/:token/quals", async (c) => {
  const op = await resolveOperative(c.env, c.req.param("token"));
  if (!op) return c.json({ error: "This profile link is no longer valid." }, 404);
  const form = await c.req.formData();
  const qualType = String(form.get("qual_type") ?? "").trim() || "Other";
  const typeManual = String(form.get("qual_type_manual") ?? "") === "1";
  const cardNo = String(form.get("card_no") ?? "").trim() || null;
  const expiry = String(form.get("expiry_date") ?? "").trim() || null;
  const file = form.get("file");
  let fileKey: string | null = null;
  let fileType: string | null = null;
  let extracted: Awaited<ReturnType<typeof extractQualCard>> = null;
  if (file instanceof File && file.size > 0) {
    if (file.size > 20 * 1024 * 1024) return c.json({ error: "File too large (max 20MB)." }, 400);
    const okType = /^(image\/|application\/pdf)/.test(file.type);
    if (!okType) return c.json({ error: "Please upload a photo or PDF of the card." }, 400);
    fileType = file.type || "application/octet-stream";
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    fileKey = `quals/${op.id}/${crypto.randomUUID()}-${safe}`;
    const buf = await file.arrayBuffer();
    await c.env.R2.put(fileKey, buf, { httpMetadata: { contentType: fileType } });
    extracted = await extractQualCard(c.env, buf, fileType);
  }
  const finalType = !typeManual && extracted?.qual_type ? extracted.qual_type : qualType;
  const finalCardNo = cardNo ?? extracted?.card_no ?? null;
  const finalExpiry = expiry ?? extracted?.expiry_date ?? null;
  await c.env.DB.prepare(
    `INSERT INTO operative_quals (id, operative_id, qual_type, card_no, file_key, file_type, expiry_date, created_at, created_by, source, verified_at)
     VALUES (?,?,?,?,?,?,?,?, 'operative', 'self', NULL)`,
  ).bind(crypto.randomUUID(), op.id, finalType, finalCardNo, fileKey, fileType, finalExpiry, new Date().toISOString()).run();
  return c.json({ ok: true, qual_type: finalType, card_no: finalCardNo, expiry_date: finalExpiry, read_from_card: !!extracted });
});

async function serveKey(env: Env, key: string | null): Promise<Response> {
  if (!key) return new Response("not found", { status: 404 });
  const obj = await env.R2.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  return new Response(obj.body, { headers: h });
}

publicOps.get("/operative/:token/qual-file/:qid", async (c) => {
  const op = await resolveOperative(c.env, c.req.param("token"));
  if (!op) return c.json({ error: "invalid" }, 404);
  const q = await c.env.DB.prepare("SELECT file_key FROM operative_quals WHERE id = ? AND operative_id = ?")
    .bind(c.req.param("qid"), op.id).first<{ file_key: string | null }>();
  return serveKey(c.env, q?.file_key ?? null);
});

publicOps.get("/operative/:token/rams-file/:signId", async (c) => {
  const op = await resolveOperative(c.env, c.req.param("token"));
  if (!op) return c.json({ error: "invalid" }, 404);
  const row = await c.env.DB.prepare(
    `SELECT d.file_key FROM operative_rams_signs s JOIN rams_documents d ON d.id = s.rams_id
      WHERE s.id = ? AND s.operative_id = ?`,
  ).bind(c.req.param("signId"), op.id).first<{ file_key: string | null }>();
  return serveKey(c.env, row?.file_key ?? null);
});

// Phone-readable RAMS content for the inline reader. Returns the structured
// `sections` (parsed RamsDoc) when available — the operative reads it one
// section at a time, gated, then signs — and the converted `html` as a fallback
// for documents uploaded before structured parsing existed.
publicOps.get("/operative/:token/rams-content/:signId", async (c) => {
  const op = await resolveOperative(c.env, c.req.param("token"));
  if (!op) return c.json({ error: "invalid" }, 404);
  const token = c.req.param("token");
  const signId = c.req.param("signId");
  let row: { title: string; html: string | null; project_code: string; rams_id: number } | null = null;
  try {
    row = await c.env.DB.prepare(
      `SELECT d.title AS title, d.html_content AS html, p.code AS project_code, d.id AS rams_id
         FROM operative_rams_signs s JOIN rams_documents d ON d.id = s.rams_id
         JOIN projects p ON p.id = s.project_id
        WHERE s.id = ? AND s.operative_id = ?`,
    ).bind(signId, op.id).first<{ title: string; html: string | null; project_code: string; rams_id: number }>();
  } catch {
    return c.json({ title: "", project_code: "", html: null, sections: null });
  }
  if (!row) return c.json({ error: "not found" }, 404);

  // Structured content (added in 0061) — guarded so a pre-0061 DB still serves html.
  let sections: { sections?: Array<{ blocks?: Array<{ type: string; src?: string; blocks?: unknown[] }> }> } | null = null;
  try {
    const sj = await c.env.DB.prepare("SELECT sections_json FROM rams_documents WHERE id = ?")
      .bind(row.rams_id).first<{ sections_json: string | null }>();
    if (sj?.sections_json) {
      sections = JSON.parse(sj.sections_json);
      // Rewrite embedded image src (a stored leaf name) to a served URL.
      const rw = (blocks: Array<{ type: string; src?: string; blocks?: unknown[] }>) => {
        for (const b of blocks) {
          if (b && b.type === "image" && b.src && !/^(https?:|\/)/.test(b.src)) {
            b.src = `/pub/operative/${token}/rams-media/${signId}/${encodeURIComponent(b.src)}`;
          } else if (b && b.type === "rawPage" && Array.isArray(b.blocks)) {
            rw(b.blocks as Array<{ type: string; src?: string; blocks?: unknown[] }>);
          }
        }
      };
      for (const s of sections?.sections ?? []) rw((s.blocks ?? []) as Array<{ type: string; src?: string; blocks?: unknown[] }>);
    }
  } catch (e) { console.warn("rams sections fetch skipped (pre-0061):", e instanceof Error ? e.message : e); }

  return c.json({ title: row.title, project_code: row.project_code, html: row.html, sections });
});

// Serve an embedded RAMS image to the operative reader (resolved per sign row).
publicOps.get("/operative/:token/rams-media/:signId/:name", async (c) => {
  const op = await resolveOperative(c.env, c.req.param("token"));
  if (!op) return new Response("not found", { status: 404 });
  const row = await c.env.DB.prepare(
    `SELECT d.id AS rams_id, d.project_id AS project_id
       FROM operative_rams_signs s JOIN rams_documents d ON d.id = s.rams_id
      WHERE s.id = ? AND s.operative_id = ?`,
  ).bind(c.req.param("signId"), op.id).first<{ rams_id: number; project_id: string }>();
  if (!row) return new Response("not found", { status: 404 });
  const name = c.req.param("name").replace(/[^a-zA-Z0-9._-]/g, "_");
  return serveKey(c.env, `rams/${row.project_id}/media/${row.rams_id}/${name}`);
});

/* ── Cabin QITP (public, QR-token) ──────────────────────────────────────────
 *  Reached by scanning a cabin's QR. The token grants inspect + sign-off on
 *  that one cabin. Hold-point gating is enforced in the client (mirrors RAMS). */
type CabinRow = { id: number; project_id: string; number: string; floor: string; elevation: string | null; wing: string | null; dismantle_day: number | null; reinstall_date: string | null };
async function resolveCabin(env: Env, token: string) {
  return env.DB.prepare(
    "SELECT id, project_id, number, floor, elevation, wing, dismantle_day, reinstall_date FROM qitp_cabins WHERE token = ?",
  ).bind(token).first<CabinRow>();
}
const QITP_STATUSES = new Set(["not_started", "pass", "in_progress", "fail", "na"]);

publicOps.get("/cabin/:token", async (c) => {
  const cab = await resolveCabin(c.env, c.req.param("token"));
  if (!cab) return c.json({ error: "This cabin link is no longer valid." }, 404);
  const project = await c.env.DB.prepare("SELECT code, name FROM projects WHERE id = ?").bind(cab.project_id).first<{ code: string; name: string }>();
  const secRows = (await c.env.DB.prepare(
    "SELECT id, seq, title, point_type, responsible, items FROM qitp_sections WHERE project_id = ? ORDER BY seq",
  ).bind(cab.project_id).all<{ id: number; seq: number; title: string; point_type: string | null; responsible: string | null; items: string | null }>()).results;
  const sections = secRows.map((s) => ({ id: s.id, seq: s.seq, title: s.title, point_type: s.point_type, responsible: parseJsonArr(s.responsible) as string[], items: parseJsonArr(s.items) }));
  const recRows = (await c.env.DB.prepare(
    "SELECT section_id, status, checks, entries, inspector, company, notes, photo_ref FROM qitp_records WHERE cabin_id = ?",
  ).bind(cab.id).all<{ section_id: number; status: string; checks: string | null; entries: string | null; inspector: string | null; company: string | null; notes: string | null; photo_ref: string | null }>()).results;
  const records = recRows.map((r) => ({
    ...r,
    checks: parseJsonArr(r.checks) as boolean[],
    entries: (parseJsonArr(r.entries) as unknown[]).map((v) => (v == null ? "" : String(v))),
  }));
  const signoffs = (await c.env.DB.prepare(
    "SELECT section_id, party, signed_name, signed_at FROM qitp_signoffs WHERE cabin_id = ?",
  ).bind(cab.id).all<{ section_id: number; party: string; signed_name: string; signed_at: string }>()).results;
  const photos = (await c.env.DB.prepare(
    "SELECT id, section_id, item_index, caption FROM qitp_photos WHERE cabin_id = ? ORDER BY id",
  ).bind(cab.id).all<{ id: number; section_id: number; item_index: number | null; caption: string | null }>()).results;
  return c.json({ cabin: cab, project, sections, records, signoffs, photos });
});
function parseJsonArr(s: string | null): unknown[] { if (!s) return []; try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } }

// Set a section's status / notes / photo-ref (client sends the full current state).
publicOps.post("/cabin/:token/section/:sectionId", async (c) => {
  const cab = await resolveCabin(c.env, c.req.param("token"));
  if (!cab) return c.json({ error: "invalid" }, 404);
  const sectionId = Number(c.req.param("sectionId"));
  const sec = await c.env.DB.prepare("SELECT id FROM qitp_sections WHERE id = ? AND project_id = ?").bind(sectionId, cab.project_id).first();
  if (!sec) return c.json({ error: "section not found" }, 404);
  const body = await c.req.json<{ status?: string; notes?: string; photo_ref?: string; inspector?: string; company?: string; checks?: boolean[]; entries?: string[] }>();
  const status = body.status && QITP_STATUSES.has(body.status) ? body.status : "not_started";
  const checks = Array.isArray(body.checks) ? JSON.stringify(body.checks.map(Boolean)) : null;
  // Typed per-item readings (paint QA). Capped per value so a stray paste can't
  // bloat the row; absent entries stay NULL, which is every pre-paint record.
  const entries = Array.isArray(body.entries)
    ? JSON.stringify(body.entries.map((v) => (v == null ? "" : String(v).slice(0, 120))))
    : null;
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO qitp_records (cabin_id, section_id, status, checks, entries, inspector, company, notes, photo_ref, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(cabin_id, section_id) DO UPDATE SET status=excluded.status, checks=excluded.checks,
       -- COALESCE, not overwrite: a save that omits the entries field (an older
       -- cached client bundle mid-deploy, or any caller that doesn't know about
       -- readings) must not wipe recorded readings. Clearing one sends "" in
       -- the array, never a null column.
       entries=COALESCE(excluded.entries, qitp_records.entries),
       inspector=excluded.inspector, company=excluded.company, notes=excluded.notes, photo_ref=excluded.photo_ref, updated_at=excluded.updated_at`,
  ).bind(cab.id, sectionId, status, checks, entries, body.inspector ?? null, body.company ?? null, body.notes ?? null, body.photo_ref ?? null, now).run();
  return c.json({ ok: true });
});

// Sign off a section on behalf of one responsible party (name + drawn signature).
// A section is "released" once every responsible party has a sign-off.
publicOps.post("/cabin/:token/section/:sectionId/sign", async (c) => {
  const cab = await resolveCabin(c.env, c.req.param("token"));
  if (!cab) return c.json({ error: "invalid" }, 404);
  const sectionId = Number(c.req.param("sectionId"));
  const sec = await c.env.DB.prepare("SELECT responsible FROM qitp_sections WHERE id = ? AND project_id = ?")
    .bind(sectionId, cab.project_id).first<{ responsible: string | null }>();
  if (!sec) return c.json({ error: "section not found" }, 404);
  const body = await c.req.json<{ party?: string; name?: string; signature?: string }>();
  if (!body.party?.trim() || !body.name?.trim() || !body.signature) return c.json({ error: "Party, name and signature required." }, 400);
  if (body.signature.length > 400_000) return c.json({ error: "Signature image too large." }, 400);
  const parties = parseJsonArr(sec.responsible) as string[];
  if (parties.length && !parties.includes(body.party)) return c.json({ error: "Not a responsible party for this section." }, 400);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO qitp_signoffs (cabin_id, section_id, party, signed_name, signature, signed_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(cabin_id, section_id, party) DO UPDATE SET signed_name=excluded.signed_name, signature=excluded.signature, signed_at=excluded.signed_at`,
  ).bind(cab.id, sectionId, body.party.trim(), body.name.trim(), body.signature, now).run();
  return c.json({ ok: true, signed_at: now });
});

// Upload evidence photos (camera or library, multi).
publicOps.post("/cabin/:token/section/:sectionId/photo", async (c) => {
  const cab = await resolveCabin(c.env, c.req.param("token"));
  if (!cab) return c.json({ error: "invalid" }, 404);
  const sectionId = Number(c.req.param("sectionId"));
  const sec = await c.env.DB.prepare("SELECT id FROM qitp_sections WHERE id = ? AND project_id = ?").bind(sectionId, cab.project_id).first();
  if (!sec) return c.json({ error: "section not found" }, 404);
  const form = await c.req.formData();
  const itemRaw = form.get("item_index");
  const itemIndex = itemRaw === null || itemRaw === "" ? null : Number(itemRaw);
  const files = [...form.getAll("photo"), ...form.getAll("file")].filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return c.json({ error: "No photo provided." }, 400);
  const now = new Date().toISOString();
  const added: Array<{ id: number; section_id: number; item_index: number | null; caption: string | null }> = [];
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) return c.json({ error: "Photo too large (max 20MB)." }, 400);
    if (!/^image\//.test(f.type)) return c.json({ error: "Photos only." }, 400);
    const safe = (f.name || "photo.jpg").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60);
    const key = `qitp/${cab.project_id}/${cab.id}/${sectionId}/${crypto.randomUUID()}-${safe}`;
    await c.env.R2.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type || "image/jpeg" } });
    const res = await c.env.DB.prepare(
      "INSERT INTO qitp_photos (cabin_id, section_id, item_index, file_key, file_type, created_at) VALUES (?,?,?,?,?,?) RETURNING id",
    ).bind(cab.id, sectionId, itemIndex, key, f.type || "image/jpeg", now).first<{ id: number }>();
    added.push({ id: res!.id, section_id: sectionId, item_index: itemIndex, caption: null });
  }
  return c.json({ ok: true, photos: added });
});

// Caption one evidence photo — typed under its thumbnail, saved on blur.
// Scoped by cabin_id as well as photo id, so a cabin's QR token can only
// label that cabin's own photos.
publicOps.post("/cabin/:token/photo/:photoId/caption", async (c) => {
  const cab = await resolveCabin(c.env, c.req.param("token"));
  if (!cab) return c.json({ error: "invalid" }, 404);
  const body = await c.req.json<{ caption?: string }>();
  // Cleared captions store as NULL, not "", so "no caption" has one meaning.
  const caption = (typeof body.caption === "string" ? body.caption.trim().slice(0, 200) : "") || null;
  const res = await c.env.DB.prepare(
    "UPDATE qitp_photos SET caption = ? WHERE id = ? AND cabin_id = ?",
  ).bind(caption, c.req.param("photoId"), cab.id).run();
  if (!res.meta.changes) return c.json({ error: "Photo not found." }, 404);
  return c.json({ ok: true, caption });
});

publicOps.get("/cabin/:token/photo/:photoId", async (c) => {
  const cab = await resolveCabin(c.env, c.req.param("token"));
  if (!cab) return new Response("not found", { status: 404 });
  const p = await c.env.DB.prepare("SELECT file_key FROM qitp_photos WHERE id = ? AND cabin_id = ?")
    .bind(c.req.param("photoId"), cab.id).first<{ file_key: string }>();
  return serveKey(c.env, p?.file_key ?? null);
});

publicOps.delete("/cabin/:token/photo/:photoId", async (c) => {
  const cab = await resolveCabin(c.env, c.req.param("token"));
  if (!cab) return c.json({ error: "invalid" }, 404);
  const p = await c.env.DB.prepare("SELECT id, file_key FROM qitp_photos WHERE id = ? AND cabin_id = ?")
    .bind(c.req.param("photoId"), cab.id).first<{ id: number; file_key: string }>();
  if (!p) return c.json({ error: "not found" }, 404);
  try { await c.env.R2.delete(p.file_key); } catch { /* best effort */ }
  await c.env.DB.prepare("DELETE FROM qitp_photos WHERE id = ?").bind(p.id).run();
  return c.json({ ok: true });
});

/* ── Client Quality Dashboard (public, share-token) ─────────────────────────
 *  A read-only, client-facing QITP progress summary. The share token (minted by
 *  a PM+ from the internal QITP dashboard) maps to a project via settings; the
 *  page is server-rendered HTML wired to live inspection data. Under /pub so
 *  the Access bypass already applies — anyone with the link can view it. */
publicOps.get("/quality/:token", async (c) => {
  const token = c.req.param("token");
  const map = await c.env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(`quality_share:${token}`).first<{ value: string }>();
  if (!map?.value) return c.html("<!doctype html><meta charset=utf-8><title>Not found</title><body style=\"font-family:system-ui;padding:48px;color:#0f1130\"><h1>Dashboard not found</h1><p>This quality dashboard link is no longer valid.</p></body>", 404);
  const rollup = await computeQualityRollup(c.env, map.value);
  if (!rollup) return c.html("<!doctype html><meta charset=utf-8><title>Not available</title><body style=\"font-family:system-ui;padding:48px;color:#0f1130\"><h1>Not available</h1><p>This quality dashboard isn't available yet.</p></body>", 404);
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex, nofollow");
  return c.html(qualityDashboardHtml(rollup));
});
