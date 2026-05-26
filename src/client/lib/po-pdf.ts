// Client-side PDF generator for a purchase order — matches the Power Grid
// Projects template (see Purchase Order PO0102.pdf).
//
// Layout zones (top → bottom):
//   ┌────────────────────────────────────────────────────────┐
//   │ PURCHASE ORDER                              [LOGO]     │  ← header band
//   │ <supplier>                                              │
//   │                                                         │
//   │   [Field labels + values]   [Company trading address]  │
//   │                                                         │
//   │─────────────────────────────────────────────────────── │
//   │ Description | Qty | Unit £ | Disc. | VAT | Amount £   │  ← line table
//   │ ...                                                     │
//   │                          Subtotal / VAT 20% / TOTAL    │
//   │─────────────────────────────────────────────────────── │
//   │ DELIVERY DETAILS                                        │
//   │ Address | Attention/Telephone | Instructions            │
//   │─────────────────────────────────────────────────────── │
//   │ Company Registration No / Registered Office (footer)    │
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
};

// A4 portrait dimensions in points
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - 2 * MARGIN;

const BLACK = rgb(0.06, 0.07, 0.19); // PGP ink navy
const GREY = rgb(0.42, 0.43, 0.54);
const RULE = rgb(0.90, 0.89, 0.85);

export async function generatePoPdf(po: Input, project?: Project | null): Promise<Uint8Array> {
  const delivery = {
    address: project?.delivery_address ?? po.project_delivery_address ?? null,
    contact_name: project?.site_contact_name ?? po.project_site_contact_name ?? null,
    contact_phone: project?.site_contact_phone ?? po.project_site_contact_phone ?? null,
    instructions: project?.delivery_instructions ?? po.project_delivery_instructions ?? null,
  };

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logo = await loadLogo(pdf).catch(() => null);

  const ctx = { page, regular, bold, logo };

  const headerBottom = drawHeader(ctx, po);
  const tableBottom = drawLineTable(ctx, po, headerBottom - 24);
  drawDeliveryDetails(ctx, po, Math.min(tableBottom - 30, 220), delivery);
  drawFooter(ctx);

  return await pdf.save();
}

async function loadLogo(pdf: PDFDocument): Promise<PDFImage | null> {
  try {
    const res = await fetch("/logo.png");
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return await pdf.embedPng(bytes);
  } catch {
    return null;
  }
}

type Ctx = { page: PDFPage; regular: PDFFont; bold: PDFFont; logo: PDFImage | null };

/* ── Header ──────────────────────────────────────────────────────────── */

function drawHeader(ctx: Ctx, po: Input): number {
  const { page, regular, bold, logo } = ctx;
  const top = PAGE_H - MARGIN;

  // Logo top-right, scale to ~140pt wide max, 40pt tall max — whichever hits first.
  let logoBottom = top;
  if (logo) {
    const maxW = 160;
    const maxH = 44;
    const scale = Math.min(maxW / logo.width, maxH / logo.height);
    const w = logo.width * scale;
    const h = logo.height * scale;
    page.drawImage(logo, { x: PAGE_W - MARGIN - w, y: top - h, width: w, height: h });
    logoBottom = top - h;
  }

  // "PURCHASE ORDER" heading + supplier line, on the left.
  // Cap heading width so it never bleeds into the field column.
  const headingMaxW = 250;
  let headingSize = 26;
  while (bold.widthOfTextAtSize("PURCHASE ORDER", headingSize) > headingMaxW && headingSize > 18) {
    headingSize -= 1;
  }
  page.drawText("PURCHASE ORDER", { x: MARGIN, y: top - headingSize, font: bold, size: headingSize, color: BLACK });
  const supplierY = top - headingSize - 18;
  page.drawText(truncate(po.supplier, 50), { x: MARGIN, y: supplierY, font: regular, size: 11, color: BLACK });

  // Labelled fields — middle column, starts well clear of the heading.
  const labelX = MARGIN + 290;
  const fields: Array<[string, string]> = [
    ["Purchase Order Date", formatDate(po.created_at)],
    ["Delivery Date", po.delivery_date ? formatDate(po.delivery_date) : "—"],
    ["Purchase Order Number", po.po_number],
    ["Reference", po.notes?.trim() ? truncate(po.notes.trim().split(/\r?\n/)[0], 36) : ""],
    ["VAT Number", COMPANY.vat_number],
  ];
  let y = top - 6;
  for (const [label, value] of fields) {
    page.drawText(label, { x: labelX, y, font: bold, size: 9, color: BLACK });
    if (value) page.drawText(value, { x: labelX, y: y - 11, font: regular, size: 10, color: BLACK });
    y -= 26;
  }
  const fieldsBottom = y;

  // Company trading address — right-aligned to the page right margin so the
  // longest line never bleeds past the edge.
  const addressRightX = PAGE_W - MARGIN;
  let ry = logoBottom - 14;
  drawRightAligned(page, COMPANY.name, addressRightX, ry, bold, 10, BLACK);
  for (const line of COMPANY.trading_address_lines) {
    ry -= 12;
    drawRightAligned(page, line, addressRightX, ry, regular, 10, BLACK);
  }

  return Math.min(fieldsBottom, ry, supplierY) - 4;
}

/* ── Line items table ───────────────────────────────────────────────── */

function drawLineTable(ctx: Ctx, po: Input, startY: number): number {
  const { page, regular, bold } = ctx;

  // Right edges (x positions where each column's right-aligned content sits).
  // Generously spaced so headers + worst-case 8-digit numbers don't collide.
  const right = {
    quantity:   MARGIN + 300,
    unit_price: MARGIN + 360,
    discount:   MARGIN + 415,
    vat:        MARGIN + 450,
    amount:     MARGIN + CONTENT_W,
  };
  const descriptionLeft = MARGIN;
  const descriptionWidth = right.quantity - descriptionLeft - 50; // leave 50pt gap before Qty

  // Header
  let y = startY;
  page.drawText("Description", { x: descriptionLeft, y, font: bold, size: 9, color: GREY });
  drawRightAligned(page, "Quantity",   right.quantity,   y, bold, 9, GREY);
  drawRightAligned(page, "Unit Price", right.unit_price, y, bold, 9, GREY);
  drawRightAligned(page, "Discount",   right.discount,   y, bold, 9, GREY);
  drawRightAligned(page, "VAT",        right.vat,        y, bold, 9, GREY);
  drawRightAligned(page, "Amount GBP", right.amount,     y, bold, 9, GREY);
  y -= 6;
  hairline(page, MARGIN, y, PAGE_W - MARGIN);
  y -= 14;

  const vatRate = COMPANY.default_vat_rate;
  let subtotal = 0;

  for (const ln of po.lines) {
    const description = describe(ln);
    const sublines = wrapText(description, regular, 10, descriptionWidth);
    const lineHeight = 12;
    const codeHeight = ln.cost_code ? 11 : 0;
    const rowH = Math.max(sublines.length * lineHeight + codeHeight, lineHeight + 4);

    let dy = y;
    for (const t of sublines) {
      page.drawText(t, { x: descriptionLeft, y: dy, font: regular, size: 10, color: BLACK });
      dy -= lineHeight;
    }
    if (ln.cost_code) {
      page.drawText(ln.cost_code, { x: descriptionLeft, y: dy, font: regular, size: 9, color: GREY });
      dy -= codeHeight;
    }
    drawRightAligned(page, formatNumber(ln.qty),       right.quantity,   y, regular, 10);
    drawRightAligned(page, formatNumber(ln.unit_cost), right.unit_price, y, regular, 10);
    drawRightAligned(page, "0.00%",                    right.discount,   y, regular, 10);
    drawRightAligned(page, pctLabel(vatRate),          right.vat,        y, regular, 10);
    drawRightAligned(page, formatNumber(ln.line_total),right.amount,     y, regular, 10);

    subtotal += ln.line_total;
    y = (sublines.length > 1 || ln.cost_code ? dy : y - rowH) - 4;
    hairline(page, MARGIN, y + 4, PAGE_W - MARGIN);
    y -= 8;
  }

  const vatTotal = round2(subtotal * vatRate);
  const grand = round2(subtotal + vatTotal);

  // Totals — right-aligned labels in a fixed column, values in the Amount column.
  // Plenty of horizontal gap between label-right and value-right edges.
  const labelRightX = right.vat - 10;   // labels end well to the left of values
  const valueRightX = right.amount;

  y -= 12;
  drawRightAligned(page, "Subtotal", labelRightX, y, regular, 10, GREY);
  drawRightAligned(page, formatNumber(subtotal), valueRightX, y, regular, 10);
  y -= 16;
  drawRightAligned(page, `TOTAL VAT  ${pctLabel(vatRate)}`, labelRightX, y, regular, 10, GREY);
  drawRightAligned(page, formatNumber(vatTotal), valueRightX, y, regular, 10);
  y -= 8;
  page.drawLine({ start: { x: labelRightX + 20, y }, end: { x: valueRightX, y }, thickness: 0.5, color: BLACK });
  y -= 16;
  drawRightAligned(page, "TOTAL GBP", labelRightX, y, bold, 12, BLACK);
  drawRightAligned(page, formatNumber(grand), valueRightX, y, bold, 12, BLACK);

  return y - 20;
}

/* ── Delivery details ───────────────────────────────────────────────── */

function drawDeliveryDetails(
  ctx: Ctx,
  po: Input,
  y: number,
  delivery: { address: string | null; contact_name: string | null; contact_phone: string | null; instructions: string | null },
) {
  const { page, regular, bold } = ctx;
  hairline(page, MARGIN, y + 22, PAGE_W - MARGIN);
  page.drawText("DELIVERY DETAILS", { x: MARGIN, y, font: bold, size: 14, color: BLACK });

  const headerY = y - 28;
  const colW = CONTENT_W / 3;
  const colXs = [MARGIN, MARGIN + colW, MARGIN + 2 * colW];

  page.drawText("Delivery Address",     { x: colXs[0], y: headerY, font: bold, size: 9, color: BLACK });
  page.drawText("Attention",            { x: colXs[1], y: headerY, font: bold, size: 9, color: BLACK });
  page.drawText("Delivery Instructions",{ x: colXs[2], y: headerY, font: bold, size: 9, color: BLACK });

  const addressBody = delivery.address?.trim() ?? po.project_name;
  drawMultiline(page, regular, 10, addressBody, colXs[0], headerY - 14, colW - 12);

  let ay = headerY - 14;
  if (delivery.contact_name) {
    page.drawText(delivery.contact_name, { x: colXs[1], y: ay, font: regular, size: 10, color: BLACK });
    ay -= 14;
  }
  ay -= 6;
  page.drawText("Telephone", { x: colXs[1], y: ay, font: bold, size: 9, color: BLACK });
  if (delivery.contact_phone) {
    page.drawText(delivery.contact_phone, { x: colXs[1], y: ay - 12, font: regular, size: 10, color: BLACK });
  }

  if (delivery.instructions) {
    drawMultiline(page, regular, 10, delivery.instructions, colXs[2], headerY - 14, colW - 12);
  }
}

function drawFooter(ctx: Ctx) {
  const { page, regular } = ctx;
  const text = `Company Registration No: ${COMPANY.company_number}.  Registered Office: ${COMPANY.registered_office}.`;
  page.drawText(text, { x: MARGIN, y: 28, font: regular, size: 8, color: GREY });
}

/* ── helpers ────────────────────────────────────────────────────────── */

function drawRightAligned(
  page: PDFPage,
  text: string,
  rightX: number,
  y: number,
  font: PDFFont,
  size: number,
  color = BLACK,
) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: rightX - w, y, font, size, color });
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
    } else {
      line = trial;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function drawMultiline(
  page: PDFPage,
  font: PDFFont,
  size: number,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
) {
  const lines = text.split(/\r?\n/).flatMap((line) => wrapText(line, font, size, maxWidth));
  let cy = y;
  for (const ln of lines) {
    page.drawText(ln, { x, y: cy, font, size, color: BLACK });
    cy -= 12;
  }
}

function describe(ln: { item: string; manufacturer: string | null }): string {
  return ln.manufacturer ? `${ln.item} — ${ln.manufacturer}` : ln.item;
}

function pctLabel(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function formatNumber(n: number): string {
  return n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function downloadPdf(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
