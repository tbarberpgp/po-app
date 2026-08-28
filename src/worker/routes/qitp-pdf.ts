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

/** Longest edge for an embedded photo. The gallery is two across, so a slot is
 *  about 92mm wide — 1000px lands near 280dpi there, which prints cleanly and
 *  still leaves something to zoom into on screen. Deliberately well below the
 *  1600px the site report uses: Chrome re-encodes embedded images losslessly
 *  (FlateDecode), so file size tracks pixel count alone and a 49-photo cabin at
 *  1600px produced a 24MB file no one could email. */
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
  const docRef = `${project?.code ?? "QITP"}-QITP-${cab.number}`;
  const issued = generatedAt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  // A running header and footer on every sheet, as a controlled document has:
  // the reference on the left, the record's standing on the right. The
  // in-progress legend is the one thing allowed colour, because it is the one
  // thing a reader must not miss.
  const standing = complete
    ? '<span style="letter-spacing:.08em;">COMPLETE RECORD</span>'
    : '<span style="color:#8a1c1c;letter-spacing:.08em;font-weight:700;">IN PROGRESS — NOT A COMPLETED RECORD</span>';
  const headerTemplate = `<div style="width:100%;font-family:Arial,Helvetica,sans-serif;font-size:7pt;padding:0 12mm;color:#000;-webkit-print-color-adjust:exact;display:flex;justify-content:space-between;border-bottom:0.5pt solid #000;padding-bottom:2pt;">
      <span style="letter-spacing:.06em;">${esc(docRef)}</span>${standing}
    </div>`;
  const footerTemplate = `<div style="width:100%;font-family:Arial,Helvetica,sans-serif;font-size:7pt;padding:0 12mm;color:#000;-webkit-print-color-adjust:exact;display:flex;justify-content:space-between;border-top:0.5pt solid #000;padding-top:2pt;">
      <span>${esc(project?.code ?? "")} — ${esc(project?.name ?? "")} · Cabin ${esc(cab.number)} · Issued ${esc(issued)}</span>
      <span>Sheet <span class="pageNumber"></span> of <span class="totalPages"></span></span>
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
        filename: `${docRef}-${stamp}.pdf`.replace(/[\\/\s]+/g, "-"),
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
  const { cab, project, sections, recs, signs, pics, releasedCount, complete, generatedAt } = d;
  const recOf = (id: number) => recs.find((r) => r.section_id === id);
  const docRef = `${project?.code ?? "QITP"}-QITP-${cab.number}`;
  const issued = generatedAt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  const lv = (label: string, value: string) => `<tr><th>${esc(label)}</th><td>${value}</td></tr>`;

  const summaryRows = sections.map((s) => {
    const rel = isReleased(s, signs);
    const r = recOf(s.id);
    const when = signs.filter((x) => x.section_id === s.id).map((x) => x.signed_at).sort().pop();
    return `<tr>
      <td class="c">${s.seq}</td>
      <td>${esc(s.title)}</td>
      <td class="c">${s.point_type ? esc(s.point_type) : "—"}</td>
      <td>${s.responsible.map(esc).join(", ") || "—"}</td>
      <td>${esc(STATUS_LABEL[r?.status ?? "not_started"] ?? "—")}</td>
      <td class="c strong">${rel ? "RELEASED" : "OPEN"}</td>
      <td>${rel && when ? esc(fmtDT(when)) : "—"}</td>
    </tr>`;
  }).join("");

  // Photos are numbered continuously across the whole record, so a plate can be
  // cited on its own ("see Photo 9") the way a report figure would be.
  let plate = 0;

  const sectionBlocks = sections.map((s) => {
    const r = recOf(s.id);
    const rel = isReleased(s, signs);
    const mySigns = signs.filter((x) => x.section_id === s.id);
    const myPics = pics.filter((p) => p.section_id === s.id);

    const particulars = `<table class="grid kv">
      ${lv("Responsible parties", s.responsible.map(esc).join(", ") || "—")}
      ${lv("Record status", esc(STATUS_LABEL[r?.status ?? "not_started"] ?? "—"))}
      ${lv("Release state", rel ? "Released — all responsible parties signed" : "Open — awaiting signature")}
      ${lv("Inspector", esc(r?.inspector || "—"))}
      ${lv("Company", esc(r?.company || "—"))}
    </table>`;

    const items = s.items.length ? `<table class="grid items">
      <thead><tr><th class="c w34">No.</th><th>Inspection item</th><th class="c w52">Hold</th><th class="c w52">Check</th><th class="w96">Record</th></tr></thead>
      <tbody>${s.items.map((it, i) => `<tr>
        <td class="c">${i + 1}</td>
        <td>${esc(it.text)}</td>
        <td class="c">${it.hold ? "H" : "—"}</td>
        <td class="c strong">${r?.checks?.[i] ? "✓" : "—"}</td>
        <td>${esc(r?.entries?.[i] || "—")}</td>
      </tr>`).join("")}</tbody></table>` : "";

    const notes = r?.notes
      ? `<table class="grid note"><tr><th>Notes</th><td>${esc(r.notes)}</td></tr></table>` : "";

    const signoffs = s.responsible.length ? `<table class="grid sign">
      <thead><tr><th class="w120">Responsible party</th><th class="w150">Name</th><th>Signature</th><th class="w120">Date &amp; time</th></tr></thead>
      <tbody>${s.responsible.map((party) => {
        const so = mySigns.find((x) => x.party === party);
        return `<tr>
          <td>${esc(party)}</td>
          <td>${so ? esc(so.signed_name) : "<span class='muted'>Not signed</span>"}</td>
          <td class="sigcell">${so?.signature ? `<img class="sig" src="${esc(so.signature)}" alt=""/>` : ""}</td>
          <td>${so ? esc(fmtDT(so.signed_at)) : "—"}</td>
        </tr>`;
      }).join("")}</tbody></table>` : "";

    const gallery = myPics.length ? `<div class="platehead">Photographic evidence — ${myPics.length} photograph${myPics.length === 1 ? "" : "s"}</div>
      <div class="plates">${myPics.map((p) => {
        plate += 1;
        const where = p.item_index != null && s.items[p.item_index]
          ? `Item ${p.item_index + 1} — ${s.items[p.item_index].text}` : "General section evidence";
        return `<figure class="plate">
          <img src="${p.src}" alt=""/>
          <figcaption><span class="pno">Photo ${plate}</span>${esc(where)}${p.caption ? ` — ${esc(p.caption)}` : ""}</figcaption>
        </figure>`;
      }).join("")}</div>` : "";

    return `<div class="sec">
      <table class="secbar"><tr>
        <td class="sn">Section ${s.seq}</td>
        <td class="st">${esc(s.title)}</td>
        <td class="sp">${s.point_type ? esc(s.point_type) + " POINT" : ""}</td>
      </tr></table>
      ${particulars}${items}${notes}${signoffs}${gallery}
    </div>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(docRef)}</title><style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, "Liberation Sans", sans-serif; color: #000; font-size: 9.4pt; line-height: 1.34; margin: 0; }

  /* Every block is a ruled table — the vernacular of an issued QA form, not a
     web card. No rounded corners, no tinted status chips, no shadow. */
  table.grid { width: 100%; border-collapse: collapse; margin: 0 0 9px; }
  table.grid th, table.grid td { border: 0.6pt solid #000; padding: 3.4pt 5pt; vertical-align: top; text-align: left; }
  table.grid thead th { background: #dcdcdc; -webkit-print-color-adjust: exact; font-size: 7.6pt; text-transform: uppercase; letter-spacing: .055em; font-weight: bold; }
  table.grid.kv th { width: 130px; background: #f0f0f0; -webkit-print-color-adjust: exact; font-size: 8.2pt; font-weight: bold; }
  .c { text-align: center; } .strong { font-weight: bold; }
  .muted { color: #666; }
  .w34 { width: 34px; } .w52 { width: 52px; } .w96 { width: 96px; }
  .w120 { width: 120px; } .w150 { width: 150px; }

  /* Document control block */
  table.ctrl { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  table.ctrl > tbody > tr > td { border: 0.9pt solid #000; padding: 7pt 9pt; vertical-align: middle; }
  td.brand { width: 178px; text-align: center; }
  td.brand img { width: 140px; height: auto; display: block; margin: 0 auto 4px; }
  td.brand .org { font-size: 7pt; text-transform: uppercase; letter-spacing: .07em; }
  td.title { text-align: center; }
  td.title .doctype { font-size: 8pt; text-transform: uppercase; letter-spacing: .16em; margin-bottom: 3px; }
  td.title .docname { font-size: 15pt; font-weight: bold; text-transform: uppercase; letter-spacing: .04em; line-height: 1.15; }
  td.title .cabin { font-size: 10.5pt; margin-top: 3px; }
  td.refs { width: 214px; padding: 0 !important; }
  table.reftab { width: 100%; border-collapse: collapse; }
  table.reftab th, table.reftab td { border: 0.5pt solid #000; padding: 2.6pt 5pt; font-size: 8pt; text-align: left; }
  table.reftab th { width: 92px; background: #f0f0f0; -webkit-print-color-adjust: exact; font-weight: bold; text-transform: uppercase; font-size: 7.2pt; letter-spacing: .04em; }

  /* Status legend — the one place colour is allowed, because it carries the
     meaning "this is not an approved record". */
  .legend { border: 1.1pt solid #8a1c1c; color: #8a1c1c; -webkit-print-color-adjust: exact;
            padding: 5pt 8pt; margin: 6px 0 11px; font-size: 8.6pt; font-weight: bold;
            text-transform: uppercase; letter-spacing: .07em; text-align: center; }
  .legend.done { border-color: #000; color: #000; }
  .legend span { font-weight: normal; letter-spacing: .03em; text-transform: none; display: block; margin-top: 2px; font-size: 8.2pt; }

  h2.part { font-size: 9.6pt; text-transform: uppercase; letter-spacing: .1em; margin: 16px 0 5px;
            padding-bottom: 3px; border-bottom: 1.1pt solid #000; break-after: avoid; page-break-after: avoid; }

  /* Section banner */
  .sec { margin-top: 13px; break-inside: auto; page-break-inside: auto; }
  table.secbar { width: 100%; border-collapse: collapse; margin-bottom: 0; break-after: avoid; page-break-after: avoid; }
  table.secbar td { border: 0.9pt solid #000; background: #000; color: #fff; -webkit-print-color-adjust: exact; padding: 4pt 6pt; }
  td.sn { width: 92px; white-space: nowrap; font-size: 8pt; text-transform: uppercase; letter-spacing: .08em; }
  td.st { font-size: 10.5pt; font-weight: bold; text-transform: uppercase; letter-spacing: .02em; }
  td.sp { width: 108px; text-align: right; font-size: 7.6pt; letter-spacing: .09em; }

  table.note th { width: 130px; background: #f0f0f0; -webkit-print-color-adjust: exact; font-size: 8.2pt; }
  table.sign td { height: 34pt; }
  table.sign td.sigcell { padding: 1pt 5pt; }
  img.sig { height: 30pt; width: auto; max-width: 100%; display: block; }

  /* Photographic plates — numbered continuously and framed like figures. */
  .platehead { font-size: 7.6pt; text-transform: uppercase; letter-spacing: .07em; font-weight: bold;
               border-bottom: 0.6pt solid #000; padding-bottom: 2px; margin: 4px 0 6px; }
  .plates { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-bottom: 10px; }
  .plate { margin: 0; border: 0.6pt solid #000; background: #fff; -webkit-print-color-adjust: exact; break-inside: avoid; page-break-inside: avoid; }
  .plate img { width: 100%; height: 232px; object-fit: contain; display: block; }
  .plate figcaption { font-size: 7.8pt; padding: 3pt 5pt; line-height: 1.3; border-top: 0.6pt solid #000; }
  .pno { font-weight: bold; text-transform: uppercase; letter-spacing: .05em; margin-right: 5px; }
  </style></head><body>

  <table class="ctrl"><tbody><tr>
    <td class="brand">
      <img src="${PGP_LOGO}" alt="PowerGrid Projects"/>
      <div class="org">PowerGrid Projects Ltd</div>
    </td>
    <td class="title">
      <div class="doctype">Quality Inspection &amp; Test Plan</div>
      <div class="docname">Cabin Inspection Record</div>
      <div class="cabin">Cabin ${esc(cab.number)}</div>
    </td>
    <td class="refs">
      <table class="reftab"><tbody>
        <tr><th>Document ref</th><td>${esc(docRef)}</td></tr>
        <tr><th>Project</th><td>${esc(project?.code ?? "")} — ${esc(project?.name ?? "")}</td></tr>
        <tr><th>Date issued</th><td>${esc(issued)}</td></tr>
        <tr><th>Status</th><td>${complete ? "Complete" : "In progress"}</td></tr>
        <tr><th>Sections</th><td>${releasedCount} of ${sections.length} released</td></tr>
      </tbody></table>
    </td>
  </tr></tbody></table>

  <div class="legend ${complete ? "done" : ""}">
    ${complete
      ? `Complete record — all ${sections.length} sections released`
      : `In progress — not a completed record<span>${releasedCount} of ${sections.length} sections released. Sections still open are listed below with their current state.</span>`}
  </div>

  <h2 class="part">1 — Cabin particulars</h2>
  <table class="grid kv">
    ${lv("Cabin", esc(cab.number))}
    ${lv("Floor", esc(cab.floor))}
    ${lv("Elevation / wing", `${esc(cab.elevation || "—")} / ${esc(cab.wing || "—")}`)}
    ${lv("Dismantle day", String(cab.dismantle_day ?? "—"))}
    ${lv("Reinstall date", esc(fmtD(cab.reinstall_date)))}
    ${lv("Storage bay", esc(cab.storage_bay || "—"))}
    ${lv("Photographs on record", String(pics.length))}
  </table>

  <h2 class="part">2 — Section summary</h2>
  <table class="grid">
    <thead><tr><th class="c w34">No.</th><th>Section</th><th class="c w52">Point</th><th>Responsible parties</th><th>Record status</th><th class="c w96">Release</th><th class="w120">Released</th></tr></thead>
    <tbody>${summaryRows}</tbody>
  </table>

  <h2 class="part">3 — Inspection detail</h2>
  ${sectionBlocks}
  </body></html>`;
}
