// Who may open a client quality dashboard, and how they prove it.
//
// The dashboard link (/pub/quality/:token) used to be the whole credential:
// anyone holding it could read the project's QITP progress. Now the link only
// says WHICH dashboard; the reader also has to be on that project's viewer
// list (quality_dashboard_viewers, managed by superadmins) and prove they own
// the address with a one-time code sent to it.
//
// This lives in the worker, not in Cloudflare Access, because the people on
// the list are clients — outside the Access policy that fronts the app — and
// /pub/* is Access-bypassed so the operative token pages keep working.
//
// The pages are plain server-rendered HTML forms with no script at all, so
// they work in any phone browser, including iPhone Safari.

import type { Env } from "./env";
import { PGP_LOGO } from "./routes/pgp-logo";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
/** Codes one address may request for one dashboard per hour. Stops the form
 *  being used to flood someone's inbox. */
export const MAX_CODES_PER_HOUR = 5;
export const SESSION_COOKIE = "pgp_qd";

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

/** Lower-cased, trimmed address, or null if it isn't one. */
export function normalizeEmail(raw: unknown): string | null {
  const e = String(raw ?? "").trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

/** A six-digit code, uniformly drawn (rejection sampling avoids modulo bias). */
export function newCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(6, "0");
  }
}

export function newSessionToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The code is bound to the project and address it was issued for, so a code
 *  leaked from one inbox can't open another dashboard. */
export function codeHash(projectId: string, email: string, code: string): Promise<string> {
  return sha256Hex(`${projectId}:${email}:${code}`);
}

/** Digits only — people paste "123 456" or "123-456" from the email. */
export function cleanCode(raw: unknown): string {
  return String(raw ?? "").replace(/\D/g, "").slice(0, 6);
}

export async function isViewer(env: Env, projectId: string, email: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM quality_dashboard_viewers WHERE project_id = ? AND email = ?",
  ).bind(projectId, email.toLowerCase()).first<{ ok: number }>();
  return !!row;
}

/** The signed-in viewer for this dashboard, or null. A session only counts
 *  while its address is still on the list — removal takes effect at once. */
export async function sessionViewer(env: Env, projectId: string, token: string | undefined): Promise<string | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT s.email FROM quality_dashboard_sessions s
       JOIN quality_dashboard_viewers v ON v.project_id = s.project_id AND v.email = s.email
      WHERE s.token_hash = ? AND s.project_id = ? AND s.expires_at > ?`,
  ).bind(await sha256Hex(token), projectId, new Date().toISOString()).first<{ email: string }>();
  return row?.email ?? null;
}

/**
 * Issue and email a code — but only to a listed address, and only within the
 * hourly allowance. Always resolves the same way so the form can't be used to
 * discover who is on the list.
 */
export async function requestCode(
  env: Env, projectId: string, email: string, dashboardLabel: string,
  send: (to: string, subject: string, html: string) => Promise<void>,
): Promise<void> {
  if (!(await isViewer(env, projectId, email))) return;
  const now = Date.now();
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM quality_dashboard_codes WHERE project_id = ? AND email = ? AND created_at > ?",
  ).bind(projectId, email, new Date(now - 60 * 60 * 1000).toISOString()).first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR) return;

  const code = newCode();
  await env.DB.prepare(
    `INSERT INTO quality_dashboard_codes (project_id, email, code_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(projectId, email, await codeHash(projectId, email, code),
    new Date(now + CODE_TTL_MS).toISOString(), new Date(now).toISOString()).run();

  await send(email, `${code} is your PGP quality dashboard code`, `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f1130;max-width:480px">
      <p>Your code to open the <b>${escapeHtml(dashboardLabel)}</b> quality dashboard is:</p>
      <p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:18px 0">${code}</p>
      <p>It works once and expires in 10 minutes.</p>
      <p style="color:#6a6d8a;font-size:12px">If you didn't ask for this, you can ignore this email.</p>
    </div>`);
}

export type VerifyResult = { ok: true; sessionToken: string } | { ok: false; reason: "invalid" | "expired" };

/** Check a code against the newest live one for this address. A wrong guess
 *  burns an attempt; the fifth kills the code. Success opens a session. */
export async function verifyCode(env: Env, projectId: string, email: string, code: string): Promise<VerifyResult> {
  const nowIso = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT id, code_hash, attempts FROM quality_dashboard_codes
      WHERE project_id = ? AND email = ? AND used_at IS NULL AND expires_at > ?
      ORDER BY id DESC LIMIT 1`,
  ).bind(projectId, email, nowIso).first<{ id: number; code_hash: string; attempts: number }>();
  if (!row || row.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: "expired" };

  if (code.length !== 6 || (await codeHash(projectId, email, code)) !== row.code_hash) {
    await env.DB.prepare("UPDATE quality_dashboard_codes SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
    return { ok: false, reason: row.attempts + 1 >= MAX_CODE_ATTEMPTS ? "expired" : "invalid" };
  }
  // Someone removed from the list between asking and typing gets nothing.
  if (!(await isViewer(env, projectId, email))) return { ok: false, reason: "expired" };

  const token = newSessionToken();
  await env.DB.batch([
    env.DB.prepare("UPDATE quality_dashboard_codes SET used_at = ? WHERE id = ?").bind(nowIso, row.id),
    env.DB.prepare(
      `INSERT INTO quality_dashboard_sessions (token_hash, project_id, email, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(await sha256Hex(token), projectId, email, new Date(Date.now() + SESSION_TTL_MS).toISOString(), nowIso),
  ]);
  return { ok: true, sessionToken: token };
}

export async function endSession(env: Env, token: string | undefined): Promise<void> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return;
  await env.DB.prepare("DELETE FROM quality_dashboard_sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
}

// ── Pages ───────────────────────────────────────────────────────────────────

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
:root{--ink:#0f1130;--muted:#6a6d8a;--line:#e6e3da;--cream:#fbfaf7;--card:#fff;--orange:#ee5d2c;--fail:#b8331f}
@media (prefers-color-scheme:dark){:root{--ink:#f5f3ec;--muted:#8b89a0;--line:#232545;--cream:#080a1c;--card:#11142b;--orange:#ff8a5a;--fail:#f4907a}}
*{box-sizing:border-box}
body{margin:0;background:var(--cream);color:var(--ink);font:16px/1.45 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif}
main{max-width:420px;margin:0 auto;padding:40px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
img{height:30px;display:block;margin-bottom:18px}
h1{font-size:21px;margin:0 0 6px}
p{margin:0 0 16px;color:var(--muted)}
label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}
input{width:100%;font-size:17px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--cream);color:var(--ink)}
input.code{letter-spacing:8px;font-size:24px;text-align:center}
button{width:100%;margin-top:14px;font-size:16px;font-weight:600;padding:13px;border:0;border-radius:10px;background:var(--orange);color:#fff}
.err{color:var(--fail);font-weight:600}
.alt{margin-top:18px;font-size:14px;text-align:center}
.alt a{color:var(--muted)}
</style>
</head><body><main><div class="card"><img src="${PGP_LOGO}" alt="PGP">${body}</div></main></body></html>`;
}

/** Step 1: ask for an address. */
export function emailPage(label: string, action: string, error?: string): string {
  return shell("Quality Dashboard — sign in", `
<h1>${escapeHtml(label)} quality dashboard</h1>
<p>Enter your email address and we'll send you a one-time code.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${escapeHtml(action)}">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" required autofocus>
  <button type="submit">Send code</button>
</form>`);
}

/** Step 2: ask for the code. Worded so it never confirms whether the address
 *  is on the list. */
export function codePage(label: string, action: string, backHref: string, email: string, error?: string): string {
  return shell("Quality Dashboard — enter code", `
<h1>Check your email</h1>
<p>If <b>${escapeHtml(email)}</b> has access to the ${escapeHtml(label)} dashboard, a 6-digit code is on its way. It expires in 10 minutes.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${escapeHtml(action)}">
  <input type="hidden" name="email" value="${escapeHtml(email)}">
  <label for="code">Code</label>
  <input id="code" class="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 -]*" maxlength="9" required autofocus>
  <button type="submit">Open dashboard</button>
</form>
<p class="alt">No email? Check junk, or ask your PGP contact to add your address.<br><a href="${escapeHtml(backHref)}">Use a different email</a></p>`);
}
