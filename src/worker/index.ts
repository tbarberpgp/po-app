import { Hono } from "hono";
import type { Env, Variables } from "./env";
import { authMiddleware, loadCurrentUser, requirePermission } from "./auth";
import { sanitizeUserHtml } from "./sanitize-html";
import { handleInboundEmail } from "./email";
import { resetSandbox } from "./sandbox";
import { projects } from "./routes/projects";
import { materials } from "./routes/materials";
import { pos } from "./routes/pos";
import { approvers } from "./routes/approvers";
import { users } from "./routes/users";
import { products } from "./routes/products";
import { suppliers } from "./routes/suppliers";
import { quotes } from "./routes/quotes";
import { applications } from "./routes/applications";
import { valuations } from "./routes/valuations";
import { elements, resourceTypes } from "./routes/taxonomy";
import { xero } from "./routes/xero";
import { variations } from "./routes/variations";
import { operations, runAutoSignouts, runHsPackReleases, runWhatsappTicketScans } from "./routes/operations";
import { qitp } from "./routes/qitp";
import { invoices } from "./routes/invoices";
import { mailboxPull } from "./routes/mailboxPull";
import { runMailboxPull } from "./graph";
import { operatives } from "./routes/operatives";
import { ownedPlant } from "./routes/ownedPlant";
import { reports } from "./routes/reports";
import { programme } from "./routes/programme";
import { siteReports, runDailyReports, runWeeklyReports, runDueDistributions, londonHour, londonWeekday } from "./routes/site-reports";
import { publicOps } from "./routes/publicOps";
import { xeroWebhook } from "./routes/xeroWebhook";
import { loadSettings } from "./approval";
import { runOffHireReminders } from "./cron";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("/api/*", authMiddleware);

app.get("/api/me", async (c) => c.json(await loadCurrentUser(c)));
app.get("/api/settings", async (c) => c.json(await loadSettings(c.env.DB)));

// Create / re-seed the walled-off demo project on demand (also runs nightly).
app.post("/api/sandbox/reset", async (c) => {
  const denied = requirePermission(c, "projects.delete");
  if (denied) return denied;
  await resetSandbox(c.env);
  return c.json({ ok: true });
});

// Standard company induction (one company-wide document). Stored in settings;
// Word docs arrive pre-converted to HTML for phone reading, PDFs land in R2.
// Operatives read it on their profile and self-confirm (see /pub/company-induction).
app.get("/api/company-induction", async (c) => {
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;
  const rows = await c.env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'company_induction_%'").all<{ key: string; value: string }>();
  const m = new Map(rows.results.map((r) => [r.key, r.value]));
  return c.json({
    filename: m.get("company_induction_filename") ?? null,
    has_html: !!m.get("company_induction_html"),
    has_file: !!m.get("company_induction_file_key"),
    file_type: m.get("company_induction_file_type") ?? null,
    updated_at: m.get("company_induction_updated_at") ?? null,
    updated_by: m.get("company_induction_updated_by") ?? null,
  });
});

app.post("/api/company-induction", async (c) => {
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;
  const form = await c.req.formData();
  const filename = String(form.get("filename") || "").trim();
  if (!filename) return c.json({ error: "A document name is required." }, 400);
  const html = form.get("html_content");
  const file = form.get("file");
  const now = new Date().toISOString();
  const set = async (k: string, v: string | null) => {
    if (v == null) await c.env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(k).run();
    else await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, v).run();
  };
  // Replace any previous file in R2.
  const prev = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'company_induction_file_key'").first<{ value: string }>();
  if (prev?.value) { try { await c.env.R2.delete(prev.value); } catch { /* */ } }
  let fileKey: string | null = null, fileType: string | null = null;
  if (file && typeof file !== "string") {
    fileKey = `company-induction/${crypto.randomUUID()}`;
    fileType = file.type || "application/octet-stream";
    await c.env.R2.put(fileKey, await file.arrayBuffer(), { httpMetadata: { contentType: fileType } });
  }
  if (!fileKey && !(typeof html === "string" && html.trim())) {
    return c.json({ error: "Upload a Word document or PDF." }, 400);
  }
  await set("company_induction_filename", filename);
  // Sanitize — this HTML is served on the public operative induction page via
  // dangerouslySetInnerHTML, so store only the allow-listed safe subset.
  await set("company_induction_html", typeof html === "string" && html.trim() ? sanitizeUserHtml(html) : null);
  await set("company_induction_file_key", fileKey);
  await set("company_induction_file_type", fileType);
  await set("company_induction_updated_at", now);
  await set("company_induction_updated_by", c.get("userEmail"));
  return c.json({ ok: true });
});

app.route("/api/projects", projects);
app.route("/api/materials", materials);
app.route("/api/pos", pos);
app.route("/api/approvers", approvers);
app.route("/api/users", users);
app.route("/api/products", products);
app.route("/api/suppliers", suppliers);
app.route("/api/quotes", quotes);
app.route("/api/applications", applications);
app.route("/api/valuations", valuations);
app.route("/api/elements", elements);
app.route("/api/resource-types", resourceTypes);
app.route("/api/xero", xero);
app.route("/api/variations", variations);
app.route("/api/operations", operations);
app.route("/api/operatives", operatives);
app.route("/api/owned-plant", ownedPlant);
app.route("/api/reports", reports);
app.route("/api/programme", programme);
app.route("/api/site-reports", siteReports);
app.route("/api/qitp", qitp);
app.route("/api/invoices", invoices);
app.route("/api/mailbox-pull", mailboxPull);

// Public, un-authenticated operative sign-in API. Mounted OUTSIDE /api so the
// auth middleware (scoped to /api/*) does not gate it. Requires a Cloudflare
// Access bypass on /pub/* (and /site/*, /assets/*) in production.
app.route("/pub", publicOps);

// Xero webhook receiver (paid-status sync). OUTSIDE /api — Xero calls it
// unauthenticated; it's secured by the x-xero-signature HMAC instead. Also
// needs a Cloudflare Access bypass on /webhooks/* in production.
app.route("/webhooks", xeroWebhook);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

// Any non-API route falls back to the SPA shell so React Router can take
// over (e.g. /admin, /admin?xero=connected, /pos/abc, /projects/xyz).
// Without this, server-side requests to client-side routes return Hono's
// default 404 text — which is what was happening after the OAuth redirect.
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

// Long-form Worker default export: the HTTP handler (Hono) + an inbound-email
// handler. Cloudflare Email Routing invokes email() when mail forwarded to
// apps@<domain> arrives. See src/worker/email.ts for the labour-app flow.
export default {
  fetch: app.fetch,
  email: handleInboundEmail,
  // Hourly cron (see wrangler.toml [triggers]), evaluated in UK local time so the
  // hours below mean what the clock says (BST/GMT aware). 02:00 generates the day's
  // reports silently (distribution to managers/clients is driven by the rules);
  // 07:00 runs the plant off-hire reminder; every hour fires any auto-distribute
  // rules whose chosen send time is that hour. Best-effort.
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const now = new Date();
    const hour = londonHour(now);
    if (hour === 2) {
      ctx.waitUntil(resetSandbox(env).catch((e) => console.error("sandbox reset failed:", e)));
      ctx.waitUntil((async () => {
        await runDailyReports(env);
        if (londonWeekday(now) === 1) await runWeeklyReports(env); // Monday (UK)
      })());
    }
    if (hour === 7) ctx.waitUntil(runOffHireReminders(env));
    ctx.waitUntil(runDueDistributions(env, hour));
    // Close forgotten sign-ins at 19:00 UK time (each run re-checks; only rows
    // whose cutoff has passed are stamped, so this is idempotent).
    ctx.waitUntil(runAutoSignouts(env).catch((e) => console.error("auto sign-out failed:", e)));
    // Release any scheduled H&S packs due this hour (weekly/monthly, UK time).
    ctx.waitUntil(runHsPackReleases(env, now).catch((e) => console.error("H&S pack release failed:", e)));
    // Pull inbound invoice/labour/client emails from the M365 mailboxes (no-op
    // until MS_GRAPH_* is configured). Reads mail in place, sidestepping M365's
    // external auto-forwarding block. Best-effort.
    ctx.waitUntil(runMailboxPull(env).catch((e) => console.error("mailbox pull failed:", e)));
    // Scan a batch of new site/WhatsApp photos for delivery tickets each hour,
    // so tickets surface as pending check-ins without anyone pressing Scan.
    ctx.waitUntil(runWhatsappTicketScans(env).catch((e) => console.error("ticket scan failed:", e)));
  },
};
