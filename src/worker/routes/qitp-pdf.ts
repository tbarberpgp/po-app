// Per-cabin QITP record as a PDF — the deliverable handed to the client at the
// end of a cabin's journey. Rendered with Cloudflare Browser Rendering, same as
// the site-report PDF, and reachable by whoever can already open the cabin (the
// QR token today; a named person once access is restricted).
//
// Deliberately NOT in this document: the audit trail. Anyone who can open the
// cabin can generate this, and the audit is superadmin-only.
import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "../env";
import { PGP_LOGO } from "./pgp-logo";
import { shrinkPhoto, toBase64 } from "./report-pdf";

type Cabin = {
  id: number; project_id: string; number: string; floor: string;
  elevation: string | null; wing: string | null;
  dismantle_day: number | null; reinstall_date: string | null; storage_bay: string | null;
};
type Item = { text: string; hold?: boolean; photo?: string; entry?: string };
type Section = { id: number; seq: number; title: string; point_type: string | null; responsible: string[]; items: Item[] };
type Rec = { section_id: number; status: string; checks: boolean[]; entries: string[]; inspector: string | null; company: string | null; notes: string | null };
type Sign = { section_id: number; party: string; signed_name: string; signature: string | null; signed_at: string };
type Pic = { id: number; section_id: number; item_index: number | null; caption: string | null; src: string };

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const parseArr = (s: string | null): unknown[] => { if (!s) return []; try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
const fmtDT = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? iso : d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); };
const fmtD = (iso: string | null) => { if (!iso) return "—"; const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : "")); return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); };

const STATUS_LABEL: Record<string, string> = {
  pass: "Pass", fail: "Fail", in_progress: "In progress", na: "N/A", not_started: "Not started",
};

/** A section is released once every responsible party has signed — the same
 *  rule the dashboard and the hold-point gating use. */
function isReleased(sec: Section, signs: Sign[]): boolean {
  if (!sec.responsible.length) return false;
  const got = new Set(signs.filter((s) => s.section_id === sec.id).map((s) => s.party));
  return sec.responsible.every((p) => got.has(p));
}

/** Longest edge for an embedded photo. The gallery slot is about 58mm x 31mm,
 *  which needs ~685px at 300dpi — so 1000px prints cleanly and still allows a
 *  reader to zoom in on screen. It is deliberately well below the 1600px the
 *  site report uses: Chrome re-encodes embedded images losslessly, so a cabin's
 *  49 photos at 1600px produced a 24MB file that no one could email. At 1000px
 *  the same record is roughly a third of that. */
const PHOTO_MAX_PX = 1000;

/** Pull a cabin's photos from R2, downscale them and inline as data URIs —
 *  Browser Rendering can't reach the /pub photo URLs from inside the render.
 *  Every photo is included by design; cabins run 3–56 photos, so the ceiling is
 *  known. Fetched in small batches so a 56-photo cabin doesn't open 56 R2
 *  connections at once. */
async function inlineCabinPhotos(
  env: Env,
  rows: Array<{ id: number; section_id: number; item_index: number | null; caption: string | null; file_key: string; file_type: string | null }>,
): Promise<Pic[]> {
  const out: Pic[] = [];
  const BATCH = 6;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = await Promise.all(rows.slice(i, i + BATCH).map(async (r) => {
      try {
        const obj = await env.R2.get(r.file_key);
        if (!obj) return null;
        const shrunk = await shrinkPhoto(env, await obj.arrayBuffer(), PHOTO_MAX_PX);
        const mime = shrunk.mime || obj.httpMetadata?.contentType || "image/jpeg";
        return { id: r.id, section_id: r.section_id, item_index: r.item_index, caption: r.caption, src: `data:${mime};base64,${toBase64(shrunk.data)}` };
      } catch { return null; }        // a photo that won't load must not lose the whole record
    }));
    for (const p of batch) if (p) out.push(p);
  }
  return out;
}

export type CabinPdf = { body: ArrayBuffer; filename: string };

/** Build the cabin's QITP record and render it. Returns null when Browser
 *  Rendering isn't available, so the caller can say so rather than 500. */
export async function renderCabinQitpPdf(env: Env, cab: Cabin): Promise<CabinPdf | null> {
  if (!env.BROWSER) return null;

  const project = await env.DB.prepare("SELECT code, name FROM projects WHERE id = ?")
    .bind(cab.project_id).first<{ code: string; name: string }>();

  const secRows = (await env.DB.prepare(
    "SELECT id, seq, title, point_type, responsible, items FROM qitp_sections WHERE project_id = ? ORDER BY seq",
  ).bind(cab.project_id).all<{ id: number; seq: number; title: string; point_type: string | null; responsible: string | null; items: string | null }>()).results;
  const sections: Section[] = secRows.map((s) => ({
    id: s.id, seq: s.seq, title: s.title, point_type: s.point_type,
    responsible: parseArr(s.responsible) as string[],
    items: (parseArr(s.items) as unknown[]).map((it) => typeof it === "string" ? { text: it } : it as Item),
  }));

  const recRows = (await env.DB.prepare(
    "SELECT section_id, status, checks, entries, inspector, company, notes FROM qitp_records WHERE cabin_id = ?",
  ).bind(cab.id).all<{ section_id: number; status: string; checks: string | null; entries: string | null; inspector: string | null; company: string | null; notes: string | null }>()).results;
  const recs: Rec[] = recRows.map((r) => ({
    ...r,
    checks: parseArr(r.checks) as boolean[],
    entries: (parseArr(r.entries) as unknown[]).map((v) => (v == null ? "" : String(v))),
  }));

  const signs = (await env.DB.prepare(
    "SELECT section_id, party, signed_name, signature, signed_at FROM qitp_signoffs WHERE cabin_id = ? ORDER BY signed_at",
  ).bind(cab.id).all<Sign>()).results;

  const picRows = (await env.DB.prepare(
    "SELECT id, section_id, item_index, caption, file_key, file_type FROM qitp_photos WHERE cabin_id = ? ORDER BY section_id, item_index, id",
  ).bind(cab.id).all<{ id: number; section_id: number; item_index: number | null; caption: string | null; file_key: string; file_type: string | null }>()).results;
  const pics = await inlineCabinPhotos(env, picRows);

  const releasedCount = sections.filter((s) => isReleased(s, signs)).length;
  const complete = sections.length > 0 && releasedCount === sections.length;
  const generatedAt = new Date();

  const html = cabinPdfHtml({ cab, project, sections, recs, signs, pics, releasedCount, complete, generatedAt });

  // "IN PROGRESS" has to appear on every page, not just the first — a partial
  // record must never be mistakable for a completed handover certificate.
  const marker = complete ? "" : "IN PROGRESS — NOT A COMPLETED RECORD";
  const headerTemplate = `<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:8px;padding:0 12mm;color:#b45309;-webkit-print-color-adjust:exact;text-align:right;letter-spacing:.08em;font-weight:700;">${esc(marker)}</div>`;
  const footerTemplate = `<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:8px;padding:0 12mm;color:#6b7280;-webkit-print-color-adjust:exact;display:flex;justify-content:space-between;">
      <span>${esc(project?.code ?? "")} · Cabin ${esc(cab.number)} · generated ${esc(generatedAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))}</span>
      <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
    </div>`;

  for (let attempt = 0; attempt < 3; attempt++) {
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
    try {
      browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "load" });
      const pdf = await page.pdf({
        format: "A4", printBackground: true,
        displayHeaderFooter: true, headerTemplate, footerTemplate,
        margin: { top: "16mm", right: "12mm", bottom: "14mm", left: "12mm" },
      });
      const stamp = generatedAt.toISOString().slice(0, 10);
      // Copy into a fresh Uint8Array so its backing buffer is exactly the PDF —
      // then it can be handed straight to Response as the body.
      const bytes = new Uint8Array(pdf);
      return {
        body: bytes.buffer as ArrayBuffer,
        filename: `${project?.code ?? "QITP"}-${cab.number}-QITP-${stamp}.pdf`.replace(/[\\/\s]+/g, "-"),
      };
    } catch (e) {
      console.error(`renderCabinQitpPdf attempt ${attempt + 1} failed:`, e instanceof Error ? e.message : e);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
  return null;
}

function cabinPdfHtml(d: {
  cab: Cabin; project: { code: string; name: string } | null;
  sections: Section[]; recs: Rec[]; signs: Sign[]; pics: Pic[];
  releasedCount: number; complete: boolean; generatedAt: Date;
}): string {
  const { cab, project, sections, recs, signs, pics, releasedCount, complete } = d;
  const recOf = (id: number) => recs.find((r) => r.section_id === id);
  const subtitle = [cab.elevation, cab.wing].filter(Boolean).join(" · ");

  const summaryRows = sections.map((s) => {
    const rel = isReleased(s, signs);
    const r = recOf(s.id);
    const when = signs.filter((x) => x.section_id === s.id).map((x) => x.signed_at).sort().pop();
    return `<tr>
      <td class="c">${s.seq}</td>
      <td>${esc(s.title)}${s.point_type ? ` <span class="hold">${esc(s.point_type)}</span>` : ""}</td>
      <td class="sm">${s.responsible.map(esc).join(", ") || "—"}</td>
      <td class="c"><span class="pill ${rel ? "ok" : (r?.status === "fail" ? "bad" : "wait")}">${rel ? "Released" : STATUS_LABEL[r?.status ?? "not_started"] ?? "—"}</span></td>
      <td class="sm">${rel && when ? esc(fmtDT(when)) : "—"}</td>
    </tr>`;
  }).join("");

  const sectionBlocks = sections.map((s) => {
    const r = recOf(s.id);
    const rel = isReleased(s, signs);
    const mySigns = signs.filter((x) => x.section_id === s.id);
    const myPics = pics.filter((p) => p.section_id === s.id);

    const items = s.items.length ? `<table class="items">
      <thead><tr><th class="c w28">✓</th><th>Item</th><th class="w110">Reading</th></tr></thead>
      <tbody>${s.items.map((it, i) => `<tr>
        <td class="c">${r?.checks?.[i] ? "<b>✓</b>" : "<span class='dim'>—</span>"}</td>
        <td>${esc(it.text)}${it.hold ? ' <span class="hold sm">HOLD</span>' : ""}</td>
        <td class="mono">${esc(r?.entries?.[i] || "")}</td>
      </tr>`).join("")}</tbody></table>` : "";

    const meta = `<div class="meta">
      <span><b>Status</b> ${esc(STATUS_LABEL[r?.status ?? "not_started"] ?? "—")}</span>
      ${r?.inspector ? `<span><b>Inspector</b> ${esc(r.inspector)}</span>` : ""}
      ${r?.company ? `<span><b>Company</b> ${esc(r.company)}</span>` : ""}
    </div>`;

    const notes = r?.notes ? `<div class="notes"><b>Notes</b><br>${esc(r.notes)}</div>` : "";

    const signoffs = s.responsible.length ? `<div class="signs">
      ${s.responsible.map((party) => {
        const so = mySigns.find((x) => x.party === party);
        return `<div class="sign">
          <div class="sign-party">${esc(party)}</div>
          ${so
            ? `${so.signature ? `<img class="sig" src="${esc(so.signature)}" alt=""/>` : '<div class="sig blank"></div>'}
               <div class="sign-name">${esc(so.signed_name)}</div>
               <div class="sign-when">${esc(fmtDT(so.signed_at))}</div>`
            : `<div class="sig blank"></div><div class="sign-none">Not signed</div>`}
        </div>`;
      }).join("")}
    </div>` : "";

    const gallery = myPics.length ? `<div class="gal-h">Evidence photos (${myPics.length})</div>
      <div class="gal">${myPics.map((p) => {
        const label = p.item_index != null && s.items[p.item_index]
          ? `${p.item_index + 1}. ${s.items[p.item_index].text}` : "Section evidence";
        return `<figure>
          <img src="${p.src}" alt=""/>
          <figcaption><b>${esc(label)}</b>${p.caption ? `<br>${esc(p.caption)}` : ""}</figcaption>
        </figure>`;
      }).join("")}</div>` : "";

    return `<section class="sec">
      <h2><span class="seq">${s.seq}</span>${esc(s.title)}
        ${s.point_type ? `<span class="hold">${esc(s.point_type)}</span>` : ""}
        <span class="pill ${rel ? "ok" : "wait"} right">${rel ? "Released" : "Not released"}</span>
      </h2>
      <div class="parties">${s.responsible.map((p) => `<span class="chip">${esc(p)}</span>`).join("") || '<span class="dim">No responsible party set</span>'}</div>
      ${meta}${items}${notes}${signoffs}${gallery}
    </section>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>QITP</title><style>
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: #14161f; font-size: 11.5px; line-height: 1.45; margin: 0; }
  .mast { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid #14161f; padding-bottom: 11px; margin-bottom: 14px; }
  .logo { width: 148px; height: auto; }
  .eyebrow { font-size: 9px; letter-spacing: .1em; text-transform: uppercase; font-weight: 700; color: #6b7280; }
  h1 { font-size: 23px; margin: 3px 0 2px; letter-spacing: -.01em; }
  .sub { color: #4b5563; font-size: 11.5px; }
  .facts { display: flex; flex-wrap: wrap; gap: 0 26px; margin: 12px 0 16px; padding: 10px 12px; background: #f3f5f8; border: 1px solid #e2e6ec; border-radius: 6px; }
  .facts div { font-size: 11px; }
  .facts .l { font-size: 8.5px; letter-spacing: .07em; text-transform: uppercase; font-weight: 700; color: #6b7280; display: block; }
  .banner { background: #fef3c7; border: 1px solid #f0d488; color: #92660a; border-radius: 6px; padding: 9px 12px; margin-bottom: 15px; font-size: 11px; }
  .banner b { display: block; font-size: 12px; margin-bottom: 1px; }
  .banner.done { background: #e6f4ec; border-color: #b8ddc8; color: #1f6141; }
  h3.sh { font-size: 13px; margin: 0 0 7px; }
  table { width: 100%; border-collapse: collapse; }
  table.sum { margin-bottom: 6px; }
  table.sum th { text-align: left; font-size: 8.5px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; padding: 5px 6px; border-bottom: 1px solid #d6dae2; }
  table.sum td { padding: 5px 6px; border-bottom: 1px solid #eef0f4; font-size: 11px; vertical-align: top; }
  .sec { break-inside: auto; page-break-inside: auto; margin-top: 20px; padding-top: 13px; border-top: 1px solid #d6dae2; }
  .sec h2 { font-size: 14px; margin: 0 0 6px; display: flex; align-items: center; gap: 8px; break-after: avoid; page-break-after: avoid; }
  .seq { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 5px; background: #14161f; color: #fff; font-size: 10.5px; -webkit-print-color-adjust: exact; }
  .right { margin-left: auto; }
  .hold { font-size: 8.5px; font-weight: 700; letter-spacing: .06em; background: #fde2dd; color: #a63f2a; border-radius: 3px; padding: 1px 5px; -webkit-print-color-adjust: exact; }
  .pill { font-size: 9px; font-weight: 700; border-radius: 999px; padding: 2px 8px; -webkit-print-color-adjust: exact; white-space: nowrap; }
  .pill.ok { background: #e0efe6; color: #1f6141; }
  .pill.wait { background: #eceef2; color: #5a6474; }
  .pill.bad { background: #fbe2dc; color: #a63f2a; }
  .parties { margin-bottom: 7px; }
  .chip { display: inline-block; font-size: 9.5px; background: #eef1f6; border: 1px solid #dde2ea; border-radius: 999px; padding: 1px 8px; margin-right: 5px; -webkit-print-color-adjust: exact; }
  .meta { display: flex; flex-wrap: wrap; gap: 0 18px; font-size: 10.5px; color: #4b5563; margin-bottom: 8px; }
  .meta b { color: #14161f; }
  table.items { margin-bottom: 9px; }
  table.items th { text-align: left; font-size: 8.5px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; padding: 4px 6px; border-bottom: 1px solid #d6dae2; }
  table.items td { padding: 4px 6px; border-bottom: 1px solid #f0f2f5; vertical-align: top; break-inside: avoid; page-break-inside: avoid; }
  .c { text-align: center; } .w28 { width: 28px; } .w110 { width: 110px; }
  .mono { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 11px; }
  .dim { color: #9aa1ad; }
  .sm { font-size: 10px; color: #4b5563; }
  .notes { background: #f6f7f9; border-left: 3px solid #c9ced8; border-radius: 0 5px 5px 0; padding: 7px 10px; font-size: 10.5px; margin-bottom: 10px; break-inside: avoid; }
  .signs { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 11px; }
  .sign { border: 1px solid #dde2ea; border-radius: 6px; padding: 7px 10px; min-width: 150px; break-inside: avoid; page-break-inside: avoid; }
  .sign-party { font-size: 8.5px; text-transform: uppercase; letter-spacing: .06em; font-weight: 700; color: #6b7280; margin-bottom: 3px; }
  .sig { height: 34px; width: auto; max-width: 190px; display: block; }
  .sig.blank { height: 34px; border-bottom: 1px dashed #c9ced8; }
  .sign-name { font-weight: 700; font-size: 11px; margin-top: 2px; }
  .sign-when { font-size: 9.5px; color: #6b7280; }
  .sign-none { font-size: 9.5px; color: #9aa1ad; margin-top: 2px; }
  .gal-h { font-size: 9px; letter-spacing: .07em; text-transform: uppercase; font-weight: 700; color: #6b7280; margin-bottom: 5px; }
  .gal { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .gal figure { margin: 0; break-inside: avoid; page-break-inside: avoid; }
  .gal img { width: 100%; height: 118px; object-fit: cover; border-radius: 5px; border: 1px solid #dde2ea; display: block; }
  .gal figcaption { font-size: 8.5px; color: #4b5563; margin-top: 2px; line-height: 1.3; }
  </style></head><body>

  <div class="mast">
    <div>
      <div class="eyebrow">${esc(project?.code ?? "")} · ${esc(project?.name ?? "")}</div>
      <h1>Cabin ${esc(cab.number)} — Quality Record</h1>
      <div class="sub">${esc(cab.floor)} floor${subtitle ? ` · ${esc(subtitle)}` : ""}</div>
    </div>
    <img class="logo" src="${PGP_LOGO}" alt="PowerGrid Projects"/>
  </div>

  <div class="banner ${complete ? "done" : ""}">
    <b>${complete ? "Complete" : "In progress — not a completed record"}</b>
    ${releasedCount} of ${sections.length} sections released${complete ? "." : ". Sections still open are shown below with their current state."}
  </div>

  <div class="facts">
    <div><span class="l">Cabin</span>${esc(cab.number)}</div>
    <div><span class="l">Floor</span>${esc(cab.floor)}</div>
    <div><span class="l">Elevation</span>${esc(cab.elevation || "—")}</div>
    <div><span class="l">Wing</span>${esc(cab.wing || "—")}</div>
    <div><span class="l">Dismantle day</span>${cab.dismantle_day ?? "—"}</div>
    <div><span class="l">Reinstall</span>${esc(fmtD(cab.reinstall_date))}</div>
    <div><span class="l">Storage bay</span>${esc(cab.storage_bay || "—")}</div>
    <div><span class="l">Photos</span>${pics.length}</div>
  </div>

  <h3 class="sh">Section summary</h3>
  <table class="sum">
    <thead><tr><th class="c">#</th><th>Section</th><th>Responsible</th><th class="c">State</th><th>Released</th></tr></thead>
    <tbody>${summaryRows}</tbody>
  </table>

  ${sectionBlocks}
  </body></html>`;
}
