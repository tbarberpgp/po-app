// Client-side PDF generator for a purchase order — "PO app rev 1" house style.
//
// Layout (top → bottom):
//   ┌────────────────────────────────────────────────────────┐
//   │ Purchase Order (serif)                       [LOGO]     │
//   │ <supplier>                                              │
//   │ [order-type chip]                                       │
//   │ ════════════════════ thick navy rule ═════════════════ │
//   │ ORDER DETAILS            │ BUYER & DELIVER TO            │
//   │ label …………… value        │ company / VAT / deliver-to    │
//   │ # · ITEM · QTY · UNIT · UNIT PRICE · VAT · NET AMOUNT   │
//   │ …rows…                                                  │
//   │ <notes>                          Subtotal / VAT / Total │
//   │ ORDER TERMS                                             │
//   │ PO no · company                  Generated … · domain   │
//   └────────────────────────────────────────────────────────┘

import { PDFDocument, StandardFonts, rgb, PDFFont, PDFImage, PDFPage } from "pdf-lib";
import { COMPANY } from "../../shared/company";
import type { Project, PurchaseOrder } from "../../shared/types";

type Input = PurchaseOrder & {
  project_code: string;
  project_name: string;
  project_delivery_address?: string | null;
  project_site_contact_name?: string | null;
  project_site_contact_phone?: string | null;
  project_delivery_instructions?: string | null;
  /** Framework PO number this call-off draws against (when order_type === 'call_off'). */
  parent_po_number?: string | null;
};

// A4 portrait, points.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const RIGHT = PAGE_W - MARGIN;

const INK = rgb(0.059, 0.067, 0.188);   // PGP navy
const GREY = rgb(0.416, 0.427, 0.541);  // muted labels
const FAINT = rgb(0.62, 0.63, 0.70);    // row numbers
const RULE = rgb(0.886, 0.871, 0.835);  // hairlines
const ACCENT = rgb(0.933, 0.365, 0.169);// orange
const ACCENT_SOFT = rgb(0.992, 0.898, 0.843); // chip background

// Line-table geometry (right edge of right-aligned cols; left edge of unit).
const T = {
  numL: MARGIN,
  itemL: MARGIN + 22,
  qtyR: MARGIN + 312,
  unitL: MARGIN + 324,
  upR: MARGIN + 418,
  amtR: RIGHT,
};
const ITEM_W = T.qtyR - T.itemL - 14;
const FOOTER_TOP = 64;       // body must stay above this; footer text sits ~38

type Ctx = {
  pdf: PDFDocument;
  page: PDFPage;
  reg: PDFFont;
  bold: PDFFont;
  serif: PDFFont;
  logo: PDFImage | null;
  y: number;
};

export async function generatePoPdf(po: Input, project?: Project | null): Promise<Uint8Array> {
  const delivery = {
    address: project?.delivery_address ?? po.project_delivery_address ?? null,
    contact_name: project?.site_contact_name ?? po.project_site_contact_name ?? null,
    contact_phone: project?.site_contact_phone ?? po.project_site_contact_phone ?? null,
    instructions: project?.delivery_instructions ?? po.project_delivery_instructions ?? null,
  };

  const pdf = await PDFDocument.create();
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const serif = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const logo = await loadLogo(pdf).catch(() => null);

  const ctx: Ctx = { pdf, page: pdf.addPage([PAGE_W, PAGE_H]), reg, bold, serif, logo, y: PAGE_H - MARGIN };

  drawHeader(ctx, po);
  drawInfoBlock(ctx, po, delivery);
  const subtotal = drawLineTable(ctx, po);
  drawTotalsAndNotes(ctx, po, subtotal);
  drawOrderTerms(ctx);
  drawFooters(ctx, po);

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

/* ── Header ──────────────────────────────────────────────────────────── */

function drawHeader(ctx: Ctx, po: Input): void {
  const { page, bold, serif, logo } = ctx;
  const top = PAGE_H - MARGIN;

  // Logo top-right.
  if (logo) {
    const scale = Math.min(150 / logo.width, 46 / logo.height);
    const w = logo.width * scale, h = logo.height * scale;
    page.drawImage(logo, { x: RIGHT - w, y: top - h + 4, width: w, height: h });
  }

  page.drawText("Purchase Order", { x: MARGIN, y: top - 26, font: serif, size: 30, color: INK });
  page.drawText(truncate(po.supplier, 56), { x: MARGIN, y: top - 48, font: bold, size: 13, color: INK });

  let ruleY = top - 70;
  const chip = po.order_type === "call_off" ? "CALL-OFF ORDER"
    : po.order_type === "framework" ? "FRAMEWORK / BLANKET ORDER" : null;
  if (chip) {
    const cy = top - 64;
    const tw = bold.widthOfTextAtSize(chip, 8.5);
    page.drawRectangle({ x: MARGIN, y: cy - 4, width: tw + 16, height: 17, color: ACCENT_SOFT });
    page.drawText(chip, { x: MARGIN + 8, y: cy, font: bold, size: 8.5, color: ACCENT });
    ruleY = cy - 18;
  }

  page.drawLine({ start: { x: MARGIN, y: ruleY }, end: { x: RIGHT, y: ruleY }, thickness: 2, color: INK });
  ctx.y = ruleY - 28;
}

/* ── Order details / Buyer & deliver-to ─────────────────────────────── */

function drawInfoBlock(ctx: Ctx, po: Input, d: { address: string | null; contact_name: string | null; contact_phone: string | null }): void {
  const { page, reg, bold } = ctx;
  const top = ctx.y;
  const colR = MARGIN + 230;        // right edge of the left column's values
  const rightX = MARGIN + 290;      // left edge of the right column

  // Left: ORDER DETAILS
  page.drawText("ORDER DETAILS", { x: MARGIN, y: top, font: bold, size: 8.5, color: GREY });
  const rows: Array<[string, string]> = [
    ["PO number", po.po_number],
    ["Order date", formatDate(po.created_at)],
    ["Delivery date", po.delivery_date ? formatDate(po.delivery_date) : "—"],
    ["Project", truncate([po.project_code, po.project_name].filter(Boolean).join(" · "), 34)],
    ["Raised / approved by", personName(po.approved_by)],
  ];
  let ly = top - 20;
  for (const [label, value] of rows) {
    page.drawText(label, { x: MARGIN, y: ly, font: reg, size: 10, color: GREY });
    drawRightAligned(page, value, colR, ly, bold, 10, INK);
    hairline(page, MARGIN, ly - 8, colR);
    ly -= 26;
  }

  // Right: BUYER & DELIVER TO
  page.drawText("BUYER & DELIVER TO", { x: rightX, y: top, font: bold, size: 8.5, color: GREY });
  let ry = top - 20;
  page.drawText(COMPANY.name, { x: rightX, y: ry, font: bold, size: 11, color: INK }); ry -= 15;
  page.drawText(truncate(COMPANY.trading_address_lines.join(", "), 46), { x: rightX, y: ry, font: reg, size: 10, color: INK }); ry -= 14;
  page.drawText(`VAT ${COMPANY.vat_number} · Co. ${COMPANY.company_number}`, { x: rightX, y: ry, font: reg, size: 10, color: INK }); ry -= 26;

  page.drawText("Deliver to — site", { x: rightX, y: ry, font: bold, size: 11, color: INK }); ry -= 15;
  const addr = (d.address?.trim() || po.project_name);
  for (const line of wrapText(addr, reg, 10, CONTENT_W - 290)) { page.drawText(line, { x: rightX, y: ry, font: reg, size: 10, color: INK }); ry -= 14; }
  if (d.contact_name || d.contact_phone) {
    const c = ["Site contact:", d.contact_name, d.contact_phone && `· ${d.contact_phone}`].filter(Boolean).join(" ");
    page.drawText(truncate(c, 46), { x: rightX, y: ry, font: reg, size: 10, color: GREY }); ry -= 14;
  }

  ctx.y = Math.min(ly, ry) - 16;
}

/* ── Line items ─────────────────────────────────────────────────────── */

function drawTableHeader(ctx: Ctx): void {
  const { page, bold } = ctx;
  const y = ctx.y;
  page.drawText("#", { x: T.numL, y, font: bold, size: 8, color: GREY });
  page.drawText("ITEM", { x: T.itemL, y, font: bold, size: 8, color: GREY });
  drawRightAligned(page, "QTY", T.qtyR, y, bold, 8, GREY);
  page.drawText("UNIT", { x: T.unitL, y, font: bold, size: 8, color: GREY });
  drawRightAligned(page, "UNIT", T.upR, y, bold, 8, GREY);
  drawRightAligned(page, "PRICE", T.upR, y - 9, bold, 8, GREY);
  drawRightAligned(page, "NET", T.amtR, y, bold, 8, GREY);
  drawRightAligned(page, "AMOUNT", T.amtR, y - 9, bold, 8, GREY);
  const ry = y - 16;
  hairline(page, MARGIN, ry, RIGHT);
  ctx.y = ry - 16;
}

function drawLineTable(ctx: Ctx, po: Input): number {
  const { reg, bold } = ctx;
  drawTableHeader(ctx);
  let subtotal = 0;

  po.lines.forEach((ln, i) => {
    const itemLines = wrapText(ln.item, bold, 10, ITEM_W);
    const sub = [ln.manufacturer, ln.cost_code].filter(Boolean).join("   ·   ");
    const rowH = itemLines.length * 12 + (sub ? 11 : 0) + 24;

    if (ctx.y - rowH < FOOTER_TOP) { newPage(ctx); drawTableHeader(ctx); }

    const page = ctx.page;
    const topY = ctx.y;
    page.drawText(String(i + 1), { x: T.numL, y: topY, font: reg, size: 9, color: FAINT });
    let dy = topY;
    for (const l of itemLines) { page.drawText(l, { x: T.itemL, y: dy, font: bold, size: 10, color: INK }); dy -= 12; }
    if (sub) { page.drawText(truncate(sub, 60), { x: T.itemL, y: dy, font: reg, size: 8.5, color: GREY }); dy -= 11; }

    drawRightAligned(page, formatQty(ln.qty), T.qtyR, topY, reg, 10, INK);
    page.drawText(truncate(ln.unit ?? "", 8), { x: T.unitL, y: topY, font: reg, size: 10, color: INK });
    drawRightAligned(page, formatNumber(ln.unit_cost), T.upR, topY, reg, 10, INK);
    drawRightAligned(page, formatNumber(ln.line_total), T.amtR, topY, reg, 10, INK);

    subtotal += ln.line_total;
    const rowBottom = dy - 8;
    hairline(page, MARGIN, rowBottom, RIGHT);
    ctx.y = rowBottom - 12;   // gap below the rule so the next row's figures clear it
  });

  return subtotal;
}

/* ── Totals (right) + notes (left) ──────────────────────────────────── */

function drawTotalsAndNotes(ctx: Ctx, po: Input, subtotal: number): void {
  const vatRate = COMPANY.default_vat_rate;
  const vat = round2(subtotal * vatRate);
  const grand = round2(subtotal + vat);

  // Keep the whole block on one page.
  if (ctx.y - 130 < FOOTER_TOP) newPage(ctx);
  const { page, reg, bold, serif } = ctx;
  const startY = ctx.y - 14;

  // Totals — right half.
  const labelL = MARGIN + 250;
  let y = startY;
  page.drawText("Subtotal (ex VAT)", { x: labelL, y, font: reg, size: 10.5, color: GREY });
  drawRightAligned(page, money(subtotal), T.amtR, y, bold, 10.5, INK);
  y -= 22;
  page.drawText(`VAT @ ${pctLabel(vatRate)}`, { x: labelL, y, font: reg, size: 10.5, color: GREY });
  drawRightAligned(page, money(vat), T.amtR, y, bold, 10.5, INK);
  y -= 12;
  page.drawLine({ start: { x: labelL, y }, end: { x: T.amtR, y }, thickness: 0.7, color: RULE });
  y -= 24;
  page.drawText("Total GBP", { x: labelL, y, font: serif, size: 14, color: INK });
  drawRightAligned(page, money(grand), T.amtR, y, serif, 17, INK);
  const totalsBottom = y - 6;

  // Notes — left half, aligned to the totals' top.
  const noteW = labelL - MARGIN - 24;
  let ny = startY;
  const lead = po.order_type === "call_off" ? "Call-off order."
    : po.order_type === "framework" ? "Framework / blanket order." : null;
  const bodyBits = [
    po.order_type === "call_off" && po.parent_po_number ? `Drawn down against framework order ${po.parent_po_number}.` : "",
    po.notes?.trim() ?? "",
  ].filter(Boolean);
  if (lead) { page.drawText(lead, { x: MARGIN, y: ny, font: bold, size: 9.5, color: INK }); ny -= 14; }
  for (const line of wrapText(bodyBits.join(" "), reg, 9.5, noteW)) {
    if (!line) break;
    page.drawText(line, { x: MARGIN, y: ny, font: reg, size: 9.5, color: GREY }); ny -= 13;
  }
  if (lead || bodyBits.length) ny -= 6;
  page.drawText("VAT — all lines standard-rated (20%).", { x: MARGIN, y: ny, font: reg, size: 9.5, color: GREY });
  ny -= 13;

  ctx.y = Math.min(totalsBottom, ny) - 10;
}

/* ── Order terms ────────────────────────────────────────────────────── */

const ORDER_TERMS =
  "Goods supplied against PGP standard purchase terms. Substitutions or price changes " +
  "must be agreed in writing before delivery. Invoices not quoting this PO number may be returned.";

function drawOrderTerms(ctx: Ctx): void {
  if (ctx.y - 50 < FOOTER_TOP) newPage(ctx);
  const { page, reg, bold } = ctx;
  let y = ctx.y;
  hairline(page, MARGIN, y + 8, RIGHT);
  page.drawText("ORDER TERMS", { x: MARGIN, y, font: bold, size: 8.5, color: GREY });
  y -= 16;
  for (const line of wrapText(ORDER_TERMS, reg, 9.5, CONTENT_W)) {
    page.drawText(line, { x: MARGIN, y, font: reg, size: 9.5, color: GREY }); y -= 13;
  }
  ctx.y = y;
}

/* ── Footer (every page) ────────────────────────────────────────────── */

function drawFooters(ctx: Ctx, po: Input): void {
  const pages = ctx.pdf.getPages();
  const left = `${po.po_number} · ${COMPANY.name}`;
  const right = `Generated ${formatDate(new Date().toISOString())} · pgpprojects.com`;
  pages.forEach((page) => {
    page.drawText(left, { x: MARGIN, y: 38, font: ctx.reg, size: 8, color: GREY });
    drawRightAligned(page, right, RIGHT, 38, ctx.reg, 8, GREY);
  });
}

/* ── helpers ────────────────────────────────────────────────────────── */

function newPage(ctx: Ctx): void {
  ctx.page = ctx.pdf.addPage([PAGE_W, PAGE_H]);
  ctx.y = PAGE_H - MARGIN;
}

function drawRightAligned(page: PDFPage, text: string, rightX: number, y: number, font: PDFFont, size: number, color = INK) {
  page.drawText(text, { x: rightX - font.widthOfTextAtSize(text, size), y, font, size, color });
}

function hairline(page: PDFPage, x1: number, y: number, x2: number) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.5, color: RULE });
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [""];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const trial = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(trial, size) > maxWidth) {
      if (line) lines.push(line);
      line = w;
    } else line = trial;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function pctLabel(rate: number): string { return `${(rate * 100).toFixed(0)}%`; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
function formatNumber(n: number): string {
  return n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function money(n: number): string { return `£${formatNumber(n)}`; }
/** Quantities show their true value with no trailing ".00" (e.g. 561, 1,259.2). */
function formatQty(n: number): string {
  return n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
}
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
/** "t.barber@…" / "Tom Barber" → "T. Barber"; "auto"/empty → "—". */
function personName(s: string | null): string {
  const v = (s ?? "").trim();
  if (!v || v.toLowerCase() === "auto") return "—";
  const local = v.includes("@") ? v.split("@")[0] : v;
  const parts = local.split(/[._\s]+/).filter(Boolean);
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  if (parts.length >= 2) return `${parts[0].charAt(0).toUpperCase()}. ${cap(parts[parts.length - 1])}`;
  return cap(local);
}

export function downloadPdf(bytes: Uint8Array, filename: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
