// Client-side PDF of a project's purchase-order register — the Purchase orders
// tab printed, not a document in its own right: same columns, same order, same
// headline figures, so what lands in someone's inbox is the screen they were
// told to look at.
//
// A4 landscape (the register is a wide table — the same call hs-pack-pdf makes
// for the sign-in register), PGP monochrome house style.
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ PURCHASE ORDERS                                     [LOGO]   │
//   │ 26004 — Blyth · Power Grid Projects Ltd                      │
//   │ POs raised 6   Committed £2,793.08   In Xero 0   Total £…    │
//   │ PO · SUPPLIER · VALUE · STATUS · XERO · RAISED · BY          │
//   │ …rows…                                                       │
//   │                                          Total  £2,793.08    │
//   └──────────────────────────────────────────────────────────────┘

import { PDFDocument, StandardFonts, rgb, PDFFont, PDFImage, PDFPage } from "pdf-lib";
import { COMPANY } from "../../shared/company";
import type { PurchaseOrder } from "../../shared/types";
import { poStatusLabel, poXeroLabel, summarisePoRegister } from "./po-register";

export { downloadPdf } from "./po-pdf";

const PAGE_W = 841.89; // A4 landscape
const PAGE_H = 595.28;
const MARGIN = 40;
const RIGHT = PAGE_W - MARGIN;

const INK = rgb(0.059, 0.067, 0.188);   // PGP navy
const GREY = rgb(0.416, 0.427, 0.541);
const RULE = rgb(0.886, 0.871, 0.835);
const RULE_DARK = rgb(0.25, 0.26, 0.28);

// Column left edges; VALUE is right-aligned to `valueR`.
const C = {
  po: MARGIN,
  supplier: MARGIN + 92,
  valueR: MARGIN + 346,
  status: MARGIN + 360,
  xero: MARGIN + 450,
  raised: MARGIN + 552,
  by: MARGIN + 622,
};
const W = {
  po: 86,
  // Stops ~30pt short of `valueR` so a seven-figure value right-aligning into
  // the gap can never collide with a long supplier name.
  supplier: 180,
  status: 84,
  xero: 96,
  raised: 64,
  by: RIGHT - C.by,
};
const ROW_H = 19;
const BODY_BOTTOM = 52;   // rows stop here; footer sits at y=22

type Ctx = {
  pdf: PDFDocument; page: PDFPage; reg: PDFFont; bold: PDFFont;
  logo: PDFImage | null; y: number; pageNo: number;
  code: string; name: string;
};

export async function generatePoListPdf(pos: PurchaseOrder[], projectCode: string, projectName: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logo = await loadLogo(pdf).catch(() => null);

  const t = summarisePoRegister(pos);
  const ctx: Ctx = { pdf, page: null as unknown as PDFPage, reg, bold, logo, y: 0, pageNo: 0, code: projectCode, name: projectName };

  newPage(ctx, [
    `POs raised ${pos.length}`,
    `Committed ${money(t.committed)}  (approved + issued + pending)`,
    `In Xero ${t.inXero}${t.xeroFailed > 0 ? ` (${t.xeroFailed} push failed)` : ""}`,
    `Total value ${money(t.all)}`,
  ]);
  tableHeader(ctx);

  for (const po of pos) {
    if (ctx.y - ROW_H < BODY_BOTTOM) {
      newPage(ctx, null);
      tableHeader(ctx);
    }
    drawRow(ctx, po);
  }

  drawTotal(ctx, t.all);
  return await pdf.save();
}

async function loadLogo(pdf: PDFDocument): Promise<PDFImage | null> {
  try {
    const res = await fetch("/logo.png");
    if (!res.ok) return null;
    return await pdf.embedPng(new Uint8Array(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

/** Page 1 carries the headline figures; continuation pages just re-title. */
function newPage(ctx: Ctx, kpis: string[] | null): void {
  ctx.page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  ctx.pageNo += 1;
  const { page, reg, bold, logo } = ctx;
  let y = PAGE_H - MARGIN;

  if (logo) {
    const dims = logo.scale(30 / logo.height);
    page.drawImage(logo, { x: RIGHT - dims.width, y: y - 26, width: dims.width, height: dims.height });
  }

  page.drawText("PURCHASE ORDERS", { x: MARGIN, y: y - 14, font: bold, size: 15, color: INK });
  y -= 32;
  const sub = [[ctx.code, ctx.name].filter(Boolean).join(" — "), COMPANY.name].filter(Boolean).join("   ·   ");
  page.drawText(clean(sub), { x: MARGIN, y, font: reg, size: 9, color: GREY });
  y -= 16;

  if (kpis) {
    let x = MARGIN;
    for (const k of kpis) {
      const text = clean(k);
      page.drawText(text, { x, y, font: bold, size: 9, color: INK });
      x += bold.widthOfTextAtSize(text, 9) + 26;
    }
    y -= 14;
  }

  ctx.y = y - 10;
  footer(ctx);
}

function footer(ctx: Ctx): void {
  const { page, reg } = ctx;
  const left = `Generated ${formatDate(new Date().toISOString())} · ${COMPANY.name}`;
  page.drawText(clean(left), { x: MARGIN, y: 22, font: reg, size: 7, color: GREY });
  const pn = `Page ${ctx.pageNo}`;
  page.drawText(pn, { x: RIGHT - reg.widthOfTextAtSize(pn, 7), y: 22, font: reg, size: 7, color: GREY });
}

function tableHeader(ctx: Ctx): void {
  const { page, bold } = ctx;
  const y = ctx.y;
  const h = (x: number, label: string) => page.drawText(label, { x, y, font: bold, size: 8, color: GREY });
  h(C.po, "PO");
  h(C.supplier, "SUPPLIER");
  right(page, "VALUE", C.valueR, y, bold, 8, GREY);
  h(C.status, "STATUS");
  h(C.xero, "XERO");
  h(C.raised, "RAISED");
  h(C.by, "BY");
  page.drawLine({ start: { x: MARGIN, y: y - 5 }, end: { x: RIGHT, y: y - 5 }, thickness: 0.8, color: RULE_DARK });
  ctx.y = y - 5 - ROW_H;
}

function drawRow(ctx: Ctx, po: PurchaseOrder): void {
  const { page, reg, bold } = ctx;
  const y = ctx.y + ROW_H / 2 - 3;
  const cell = (x: number, text: string, maxW: number, font = reg, color = INK) =>
    page.drawText(truncate(font, clean(text), 8.5, maxW), { x, y, font, size: 8.5, color });

  cell(C.po, po.po_number, W.po, bold);
  cell(C.supplier, po.supplier, W.supplier);
  right(page, money(po.total_value), C.valueR, y, reg, 8.5, INK);
  cell(C.status, poStatusLabel(po.status), W.status, reg, po.status === "rejected" ? GREY : INK);
  const xero = poXeroLabel(po);
  cell(C.xero, xero || "—", W.xero, reg, xero ? INK : GREY);
  cell(C.raised, formatDate(po.created_at), W.raised, reg, GREY);
  cell(C.by, po.created_by, W.by, reg, GREY);

  page.drawLine({ start: { x: MARGIN, y: ctx.y - 4 }, end: { x: RIGHT, y: ctx.y - 4 }, thickness: 0.5, color: RULE });
  ctx.y -= ROW_H;
}

function drawTotal(ctx: Ctx, total: number): void {
  if (ctx.y - 26 < BODY_BOTTOM) newPage(ctx, null);
  const { page, bold } = ctx;
  const y = ctx.y - 6;
  page.drawLine({ start: { x: C.supplier, y: y + 13 }, end: { x: C.valueR, y: y + 13 }, thickness: 0.8, color: RULE_DARK });
  right(page, "Total value", C.valueR - 90, y, bold, 10, GREY);
  right(page, money(total), C.valueR, y, bold, 11, INK);
  ctx.y = y - 14;
}

/* ── helpers ────────────────────────────────────────────────────────── */

function right(page: PDFPage, text: string, rightX: number, y: number, font: PDFFont, size: number, color = INK) {
  page.drawText(text, { x: rightX - font.widthOfTextAtSize(text, size), y, font, size, color });
}

// pdf-lib's standard fonts are WinAnsi — drop anything they can't encode
// rather than letting one stray glyph throw the whole download away.
const clean = (s: string) => (s ?? "").replace(/[^\x20-\x7E£éèêàâçüö’‘“”–—•·°±]/g, "");

function truncate(f: PDFFont, text: string, size: number, maxW: number): string {
  const t0 = text.replace(/\s+/g, " ").trim();
  if (f.widthOfTextAtSize(t0, size) <= maxW) return t0;
  let t = t0;
  while (t.length > 1 && f.widthOfTextAtSize(`${t}…`, size) > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

function money(n: number): string {
  return `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
