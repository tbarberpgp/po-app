// Server-side PDF of a site report — renders the rich report HTML with Cloudflare
// Browser Rendering (puppeteer) so the emailed/attached PDF matches the on-screen
// report, with the period's site photos embedded. Used by the auto-distribute
// cron and the "send test" endpoint. Falls back to null when Browser Rendering
// isn't bound, so callers keep the inline-HTML email.
import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "../env";
import type { ReportSections } from "../../client/lib/report-pdf";
import { PGP_LOGO } from "./pgp-logo";

export type ReportForPdf = {
  id: number;
  project_id: string | null;
  project_code?: string | null;
  project_name?: string | null;
  period_type: "daily" | "weekly";
  period_start: string;
  period_end: string;
  data_json: string | null;
  update_count: number;
  generated_by?: string | null;
};

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const fmtDate = (iso: string) => { const d = new Date((iso || "") + (iso?.length === 10 ? "T00:00:00" : "")); return isNaN(d.getTime()) ? (iso || "") : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); };

/** Bytes → base64 (chunked, to avoid arg-count limits on large images). */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

/** Downscale + re-encode a photo so the embedded PDF stays emailable. Site
 *  photos come off phones at 3–8 MB each; embedded raw that's a 40–50 MB PDF.
 *  Resizing to ~1600px JPEG q80 brings each to a few hundred KB with no visible
 *  loss at report scale. Uses the Images binding; if it's unavailable (binding
 *  not provisioned / account not entitled) we fall back to the original bytes so
 *  the report still generates — just larger.
 *
 *  `maxPx` is the ceiling on the longest edge. It matters more than JPEG quality:
 *  Chrome's print-to-PDF decodes embedded JPEGs and re-encodes them losslessly
 *  (FlateDecode), so the quality setting buys nothing in the final PDF and file
 *  size tracks pixel count alone. Callers embedding many photos should lower it
 *  to what their print slot actually needs. */
export async function shrinkPhoto(env: Env, bytes: ArrayBuffer, maxPx = 1600): Promise<{ data: Uint8Array; mime: string }> {
  if (env.IMAGES) {
    try {
      const result = await env.IMAGES
        .input(new Response(bytes).body as ReadableStream<Uint8Array>)
        .transform({ width: maxPx, height: maxPx, fit: "scale-down" })
        .output({ format: "image/jpeg", quality: 80 });
      const buf = await result.response().arrayBuffer();
      if (buf.byteLength > 0) return { data: new Uint8Array(buf), mime: "image/jpeg" };
    } catch (e) {
      console.warn("report photo resize failed — embedding original:", e instanceof Error ? e.message : e);
    }
  }
  return { data: new Uint8Array(bytes), mime: "" };
}

/** Pull the report's photos out of R2, downscale them, and inline them as data
 *  URIs (Browser Rendering can't reach the Access-gated /api/operations/file URLs). */
async function inlinePhotos(env: Env, sections: ReportSections): Promise<Array<{ src: string; caption: string }>> {
  const out: Array<{ src: string; caption: string }> = [];
  for (const p of (sections.photos ?? []).slice(0, 24)) {
    try {
      const key = new URL(p.url, "http://x").searchParams.get("key");
      if (!key) continue;
      const obj = await env.R2.get(key);
      if (!obj) continue;
      const original = await obj.arrayBuffer();
      const shrunk = await shrinkPhoto(env, original);
      const mime = shrunk.mime || obj.httpMetadata?.contentType || "image/jpeg";
      out.push({ src: `data:${mime};base64,${toBase64(shrunk.data)}`, caption: p.caption || "" });
    } catch { /* skip a photo that won't load */ }
  }
  return out;
}

/** Render the report HTML to PDF bytes. Returns null when Browser Rendering is
 *  not available (binding unset / launch fails) so the caller keeps the email. */
export async function renderReportPdf(env: Env, report: ReportForPdf): Promise<Uint8Array | null> {
  if (!env.BROWSER) return null;
  let sections: ReportSections;
  try { sections = JSON.parse(report.data_json || "{}") as ReportSections; } catch { sections = {} as ReportSections; }
  const photos = await inlinePhotos(env, sections);
  const html = reportPdfHtml(report, sections, photos);
  // Browser Rendering has a concurrent-session limit, so launch() can fail
  // transiently (returns a 503 to the caller). Retry a few times with a short
  // backoff so a busy moment doesn't drop the whole PDF.
  for (let attempt = 0; attempt < 3; attempt++) {
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
    try {
      browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "load" });
      const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "14mm", right: "12mm", bottom: "14mm", left: "12mm" } });
      return new Uint8Array(pdf);
    } catch (e) {
      console.error(`renderReportPdf attempt ${attempt + 1} failed:`, e instanceof Error ? e.message : e);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
  return null;
}

/** Render + package as a Resend attachment ({filename, base64 content}); null
 *  when Browser Rendering produced no PDF (caller then sends inline-HTML only). */
export async function reportPdfAttachment(env: Env, report: ReportForPdf, filename: string): Promise<{ filename: string; content: string } | null> {
  const pdf = await renderReportPdf(env, report);
  if (!pdf) return null;
  return { filename: filename.replace(/[\\/]+/g, "-"), content: toBase64(pdf) };
}

/** Standalone, print-ready HTML of the report (PGP house style, inline CSS). */
export function reportPdfHtml(report: ReportForPdf, s: ReportSections, photos: Array<{ src: string; caption: string }>): string {
  const daily = report.period_type === "daily";
  const projName = report.project_id ? (report.project_name || report.project_code || "Project") : "Portfolio roll-up";
  const dateStr = daily ? fmtDate(report.period_start) : `${fmtDate(report.period_start)} – ${fmtDate(report.period_end)}`;
  const reporter = report.generated_by && report.generated_by !== "cron" ? `Reported by ${esc(report.generated_by)}` : null;
  const metaBits = [report.project_id ? esc(report.project_code) : null, s.programme ? `Day ${s.programme.day} of ${s.programme.total_days}` : null, reporter].filter(Boolean).join("  ·  ");

  const blockers = s.blockers ?? [];
  const stat = (l: string, v: string, sub: string, tone = "") => `<div class="sc"><div class="l">${l}</div><div class="v ${tone}">${v}</div><div class="s">${esc(sub)}</div></div>`;
  const strip = [
    stat("Weather", s.weather_days?.[0] ? `${s.weather_days[0].max}°` : "—", s.weather || "No data"),
    stat("On site", String(s.attendance?.on_site ?? s.labour_count ?? "—"), s.attendance ? `${s.attendance.companies} ${s.attendance.companies === 1 ? "company" : "companies"}` : "on site"),
    stat("Progress", s.programme ? `${s.programme.pct_overall}%` : String((s.progress ?? []).length), s.programme ? "complete overall" : "notes logged", s.programme ? "ok" : ""),
    stat("Delays", String(blockers.length), blockers.length ? "to resolve" : "none", blockers.length ? "warn" : "ok"),
  ].join("");

  const list = (items: string[], tick = false) => items.length ? `<ul class="li">${items.map((i) => `<li>${tick ? '<span class="tk">✓</span>' : ""}${esc(i)}</li>`).join("")}</ul>` : "";
  // Each section is a table so its header (in <thead>) repeats at the top of every
  // page the section spills onto — a "continued" heading — and content flows across
  // the page break instead of leaving a big gap.
  const card = (icon: string, title: string, body: string, meta = "") => body ? `<table class="card"><thead><tr><td><div class="ch"><span class="ic">${icon}</span><span class="ct">${esc(title)}</span>${meta ? `<span class="cmeta">${esc(meta)}</span>` : ""}<span class="cont">cont.</span></div></td></tr></thead><tbody><tr><td class="cb">${body}</td></tr></tbody></table>` : "";

  const labourBody = (s.labour_table?.length)
    ? `<table class="lt"><thead><tr><th>Company</th><th>Trade</th><th class="n">No.</th><th class="n">Hours</th></tr></thead><tbody>${
        s.labour_table.map((r) => `<tr><td>${esc(r.company)}</td><td class="mut">${esc(r.trade || "—")}</td><td class="n">${r.count}</td><td class="n">${r.hours > 0 ? r.hours.toFixed(1) : "—"}</td></tr>`).join("")
      }<tr class="tot"><td><b>Total</b></td><td></td><td class="n"><b>${s.labour_table.reduce((a, r) => a + r.count, 0)}</b></td><td class="n"><b>${(() => { const h = s.labour_table!.reduce((a, r) => a + r.hours, 0); return h > 0 ? h.toFixed(1) : "—"; })()}</b></td></tr></tbody></table>`
    : list(s.labour ?? []);

  const deliveriesBody = (s.deliveries_detail?.length)
    ? `<ul class="li">${s.deliveries_detail.map((d) => `<li><b>${esc(d.supplier || "Delivery")}</b>${d.description ? ` — ${esc(d.description)}` : ""}${d.status ? ` <span class="tag ${d.status === "received" ? "ok" : "warn"}">${esc(d.status)}</span>` : ""}</li>`).join("")}</ul>`
    : list(s.deliveries ?? []);

  const sf = s.safety;
  const safetyBody = sf
    ? `<div class="sgrid"><div class="sb"><span class="n ${sf.incidents ? "bad" : "ok"}">${sf.incidents}</span><span>Incidents</span></div><div class="sb"><span class="n ${sf.near_misses ? "warn" : "ok"}">${sf.near_misses}</span><span>Near misses</span></div><div class="sb"><span class="n ok">${sf.toolbox_talks}</span><span>Toolbox talks</span></div></div>${list(s.hse ?? [])}`
    : list(s.hse ?? []);

  const photosBody = photos.length
    ? `<div class="gal">${photos.map((p) => `<figure><img src="${p.src}"/>${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ""}</figure>`).join("")}</div>`
    : "";

  // Sections hidden via "Edit for client" are dropped; free-form sections the
  // editor added are rendered after the standard ones (before the look-ahead).
  const hide = new Set(s.hidden_sections ?? []);
  const customCards = (s.custom_sections ?? [])
    .filter((cs) => cs && cs.title?.trim() && (cs.items ?? []).some((i) => (i ?? "").trim()))
    .map((cs) => card("•", cs.title.trim(), list((cs.items ?? []).filter((i) => (i ?? "").trim()))))
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"/><style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1c2e; margin: 0; font-size: 12.5px; line-height: 1.5; }
  .eyebrow { font-size: 9.5px; letter-spacing: .09em; text-transform: uppercase; font-weight: 700; color: #6a6d8a; }
  h1 { font-size: 22px; margin: 5px 0 3px; color: #0f1130; }
  .sub { color: #6a6d8a; font-size: 12px; }
  .wa { display: inline-block; margin-top: 8px; font-size: 10.5px; font-weight: 600; color: #1f9d55; background: #e7f6ec; padding: 3px 9px; border-radius: 20px; }
  .mast { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; border-bottom: 2.5px solid #0f1130; padding-bottom: 12px; margin-bottom: 4px; }
  .mast-l { flex: 1; } .logo { width: 148px; height: auto; flex-shrink: 0; }
  .strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 14px 0; }
  .sc { border: 1px solid #e6e3da; border-radius: 10px; padding: 9px 11px; }
  .sc .l { font-size: 9px; letter-spacing: .06em; text-transform: uppercase; font-weight: 700; color: #6a6d8a; }
  .sc .v { font-size: 19px; font-weight: 700; color: #0f1130; margin-top: 2px; }
  .sc .v.ok { color: #1f9d55; } .sc .v.warn { color: #c47d1a; }
  .sc .s { font-size: 10.5px; color: #6a6d8a; }
  .headline { font-size: 13.5px; font-weight: 600; margin: 4px 0 12px; }
  table.card { width: 100%; border-collapse: collapse; margin: 0 0 13px; }
  table.card thead { display: table-header-group; } table.card thead td { padding: 0; }
  .ch { display: flex; align-items: center; gap: 8px; padding: 9px 13px; background: #faf9f6; border: 1px solid #e6e3da; border-bottom: 1px solid #efece4; }
  .ch .ct { font-size: 13.5px; font-weight: 700; color: #0f1130; }
  .ch .ic { font-size: 14px; } .cmeta { margin-left: auto; font-size: 11px; color: #6a6d8a; } .ch .cont { display: none; }
  td.cb { padding: 11px 13px; border: 1px solid #e6e3da; border-top: 0; }
  ul.li li, .sb, table.lt tr, .gal figure { break-inside: avoid; }
  ul.li { margin: 0; padding-left: 18px; } ul.li li { margin-bottom: 3px; } .tk { color: #1f9d55; font-weight: 700; margin-left: -14px; margin-right: 6px; }
  .mut { color: #6a6d8a; }
  table.lt { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.lt th { text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: .05em; color: #6a6d8a; padding: 4px 6px; border-bottom: 1px solid #e6e3da; }
  table.lt td { padding: 5px 6px; border-bottom: 1px solid #f0eee7; } table.lt td.n, table.lt th.n { text-align: right; } table.lt tr.tot td { border-top: 2px solid #e6e3da; border-bottom: 0; }
  .tag { font-size: 10px; padding: 1px 7px; border-radius: 12px; } .tag.ok { background: #e7f6ec; color: #1f9d55; } .tag.warn { background: #fdecd2; color: #b8731a; }
  .sgrid { display: flex; gap: 10px; margin-bottom: 6px; } .sb { border: 1px solid #e6e3da; border-radius: 9px; padding: 7px 14px; text-align: center; } .sb .n { display: block; font-size: 18px; font-weight: 700; } .sb .n.ok { color: #1f9d55; } .sb .n.warn { color: #c47d1a; } .sb .n.bad { color: #c0392b; } .sb span:last-child { font-size: 10px; color: #6a6d8a; }
  .gal { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; } .gal figure { margin: 0; } .gal img { width: 100%; height: 130px; object-fit: cover; border-radius: 8px; border: 1px solid #e6e3da; } .gal figcaption { font-size: 10px; color: #6a6d8a; margin-top: 3px; }
  .foot { margin-top: 16px; padding-top: 8px; border-top: 1px solid #e6e3da; font-size: 10px; color: #9a9cb0; }
  </style></head><body>
    <div class="mast">
      <div class="mast-l">
        <div class="eyebrow">${daily ? "Daily report" : "Weekly report"} · ${esc(dateStr)}</div>
        <h1>${esc(projName)}</h1>
        ${metaBits ? `<div class="sub">${metaBits}</div>` : ""}
        <div class="wa">● Auto-generated from WhatsApp</div>
      </div>
      <img class="logo" src="${PGP_LOGO}" alt="PowerGrid Projects"/>
    </div>
    <div class="strip">${strip}</div>
    ${s.headline ? `<p class="headline">${esc(s.headline)}</p>` : ""}
    ${hide.has("weather") ? "" : card("⛅", "Weather", s.weather ? `<p style="margin:0">${esc(s.weather)}</p>` : "")}
    ${hide.has("labour") ? "" : card("👷", "Labour & plant on site", labourBody, s.attendance ? `${s.attendance.on_site} on site · ${s.attendance.companies} ${s.attendance.companies === 1 ? "company" : "companies"}` : "")}
    ${hide.has("progress") ? "" : card("🛠", daily ? "Progress today" : "Progress this week", list(s.progress ?? [], true))}
    ${hide.has("blockers") ? "" : card("⚠", "Delays & blockers", list(blockers))}
    ${hide.has("deliveries") ? "" : card("📦", "Deliveries & materials", deliveriesBody)}
    ${hide.has("hse") ? "" : card("🦺", "Safety & compliance", safetyBody)}
    ${hide.has("photos") ? "" : card("📷", "Photos", photosBody, photos.length ? `${photos.length}` : "")}
    ${customCards}
    ${hide.has("look") ? "" : card("→", daily ? "Tomorrow" : "Next week", list(s.lookahead ?? []))}
    <div class="foot">PowerGrid Projects Ltd · auto-generated from site WhatsApp updates${s.weather ? " · weather via Open-Meteo" : ""}</div>
  </body></html>`;
}
