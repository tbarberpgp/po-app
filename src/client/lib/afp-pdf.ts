// Client-side PDF generator for an Application for Payment. Matches the
// PowerGrid letterhead style used by the PO PDF (same logo, palette,
// typography). Layout:
//
//   ┌────────────────────────────────────────────────────────┐
//   │ APPLICATION FOR PAYMENT                       [LOGO]   │
//   │ Project · Client · AfP # · Period ending                │
//   │                                                         │
//   │ [Headline totals box: 8 numbers in 2 rows of 4]         │
//   │                                                         │
//   │─────────────────────────────────────────────────────── │
//   │ Item | Qty | Unit £ | Contract £ | % | Cumulative £     │
//   │ ─ section header ─                                      │
//   │ ...lines...                                             │
//   │ Section subtotal                                        │
//   │                                                         │
//   │─────────────────────────────────────────────────────── │
//   │ Signature block                                         │
//   │ Footer: company details                                 │
//   └────────────────────────────────────────────────────────┘

import { PDFDocument, StandardFonts, rgb, PDFFont, PDFImage, PDFPage } from "pdf-lib";
import { COMPANY } from "../../shared/company";
import type { AfpDetail } from "../../shared/types";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - 2 * MARGIN;

const BLACK = rgb(0.06, 0.07, 0.19);
const GREY = rgb(0.42, 0.43, 0.54);
const RULE = rgb(0.90, 0.89, 0.85);
const ACCENT = rgb(0.93, 0.36, 0.17);  // PGP orange

export async function generateAfpPdf(detail: AfpDetail): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logo = await loadLogo(pdf).catch(() => null);

  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const ctx: Ctx = { pdf, page, regular, bold, logo };

  const headerBottom = drawHeader(ctx, detail);
  const totalsBottom = drawTotalsBox(ctx, detail, headerBottom - 18);
  const tableBottom = drawLinesTable(ctx, detail, totalsBottom - 24);
  drawFooter(ctx, tableBottom);

  return await pdf.save();
}

async function loadLogo(pdf: PDFDocument): Promise<PDFImage | null> {
  try {
    const res = await fetch("/logo.png");
    if (!res.ok) return null;
    return await pdf.embedPng(new Uint8Array(await res.arrayBuffer()));
  } catch { return null; }
}

type Ctx = { pdf: PDFDocument; page: PDFPage; regular: PDFFont; bold: PDFFont; logo: PDFImage | null };

/* ── Header ──────────────────────────────────────────────────────────── */

function drawHeader(ctx: Ctx, d: AfpDetail): number {
  const { page, regular, bold, logo } = ctx;
  const top = PAGE_H - MARGIN;
  const afp = d.afp;

  // Logo top-right
  let logoBottom = top;
  if (logo) {
    const scale = Math.min(160 / logo.width, 44 / logo.height);
    const w = logo.width * scale;
    const h = logo.height * scale;
    page.drawImage(logo, { x: PAGE_W - MARGIN - w, y: top - h, width: w, height: h });
    logoBottom = top - h;
  }

  // Title
  page.drawText("APPLICATION FOR PAYMENT", { x: MARGIN, y: top - 22, font: bold, size: 20, color: BLACK });

  // Subtitle line: Project · Client
  const subtitle = `${afp.project_code ?? ""} — ${afp.project_name ?? ""}${afp.project_client ? `   ·   ${afp.project_client}` : ""}`;
  page.drawText(truncate(subtitle, 90), { x: MARGIN, y: top - 40, font: regular, size: 10.5, color: BLACK });

  // Field block on right (below logo)
  const fieldsTop = Math.min(top - 60, logoBottom - 14);
  const labelX = MARGIN + 320;
  const fields: Array<[string, string]> = [
    ["Application No.", `#${afp.app_number}`],
    ["Period ending", formatDate(afp.period_end)],
    ["Date raised", formatDate(afp.created_at)],
    ["Status", afp.status.toUpperCase()],
    ["VAT Number", COMPANY.vat_number],
  ];
  let y = fieldsTop;
  for (const [label, value] of fields) {
    page.drawText(label, { x: labelX, y, font: regular, size: 9, color: GREY });
    drawRightAligned(page, value, PAGE_W - MARGIN, y, bold, 10, BLACK);
    y -= 14;
  }

  // Hairline divider
  hairline(page, MARGIN, y - 8, PAGE_W - MARGIN);
  return y - 8;
}

/* ── Totals box (the headline figures the recipient cares about) ─────── */

function drawTotalsBox(ctx: Ctx, d: AfpDetail, startY: number): number {
  const { page, regular, bold } = ctx;
  const afp = d.afp;

  // Two rows of four boxes
  const rowH = 56;
  const cellW = CONTENT_W / 4;
  const top = startY;

  const cells: Array<Array<[string, string, "default" | "accent"]>> = [
    [
      ["Contract sum", money(afp.contract_sum ?? 0), "default"],
      ["Cumulative works", money(afp.cumulative_value ?? 0), "default"],
      ["Previously certified", money(afp.previous_certified ?? 0), "default"],
      ["This period (net)", money(afp.this_period_net ?? 0), "default"],
    ],
    [
      [`Retention (${afp.retention_pct}%)`, `-${money(afp.retention_amount ?? 0)}`, "default"],
      ["Amount due (ex VAT)", money(afp.amount_due ?? 0), "default"],
      [`VAT (${afp.vat_pct}%)`, money(afp.vat_amount ?? 0), "default"],
      ["TOTAL INVOICE", money(afp.total_invoice ?? 0), "accent"],
    ],
  ];

  for (let r = 0; r < cells.length; r++) {
    const rowTop = top - r * rowH;
    for (let c = 0; c < cells[r].length; c++) {
      const x = MARGIN + c * cellW;
      const [label, value, style] = cells[r][c];
      const isAccent = style === "accent";
      if (isAccent) {
        page.drawRectangle({ x, y: rowTop - rowH, width: cellW, height: rowH, color: rgb(1.0, 0.94, 0.91) });
      }
      page.drawText(label, { x: x + 8, y: rowTop - 16, font: regular, size: 8.5, color: GREY });
      page.drawText(value, {
        x: x + 8,
        y: rowTop - 40,
        font: bold,
        size: isAccent ? 14 : 12,
        color: isAccent ? ACCENT : BLACK,
      });
    }
    // Row divider
    if (r < cells.length - 1) hairline(page, MARGIN, rowTop - rowH, PAGE_W - MARGIN);
  }
  const boxBottom = top - cells.length * rowH;
  // Outer box outline
  page.drawRectangle({
    x: MARGIN, y: boxBottom, width: CONTENT_W, height: cells.length * rowH,
    borderColor: RULE, borderWidth: 0.5,
  });
  return boxBottom;
}

/* ── Works claimed table ────────────────────────────────────────────── */

function drawLinesTable(ctx: Ctx, d: AfpDetail, startY: number): number {
  const { page, regular, bold, pdf } = ctx;
  let y = startY;
  const cols = [
    { x: MARGIN,                      w: 240, label: "Item",         align: "left"  as const, font: bold },
    { x: MARGIN + 240,                w: 50,  label: "Qty",          align: "right" as const, font: bold },
    { x: MARGIN + 290,                w: 60,  label: "Rate £",       align: "right" as const, font: bold },
    { x: MARGIN + 350,                w: 70,  label: "Contract £",   align: "right" as const, font: bold },
    { x: MARGIN + 420,                w: 35,  label: "%",            align: "right" as const, font: bold },
    { x: MARGIN + 455,                w: PAGE_W - MARGIN - (MARGIN + 455), label: "Cumulative £", align: "right" as const, font: bold },
  ];

  // Header row
  page.drawRectangle({ x: MARGIN, y: y - 18, width: CONTENT_W, height: 18, color: rgb(0.97, 0.96, 0.94) });
  for (const c of cols) {
    const tx = c.align === "right" ? c.x + c.w - 4 : c.x + 6;
    if (c.align === "right") {
      drawRightAligned(page, c.label, tx, y - 13, bold, 8.5, BLACK);
    } else {
      page.drawText(c.label, { x: tx, y: y - 13, font: bold, size: 8.5, color: BLACK });
    }
  }
  y -= 18;

  // Page break helper
  function ensurePage(needed: number): PDFPage {
    if (y - needed > MARGIN + 30) return ctx.page;
    // new page
    const fresh = pdf.addPage([PAGE_W, PAGE_H]);
    ctx.page = fresh;
    y = PAGE_H - MARGIN;
    return fresh;
  }

  // Group lines by section (preserve document order)
  type Grp = { section: string; lines: AfpDetail["lines"] };
  const groups: Grp[] = [];
  for (const l of d.lines) {
    const sec = l.section ?? "—";
    const last = groups[groups.length - 1];
    if (!last || last.section !== sec) groups.push({ section: sec, lines: [l] });
    else last.lines.push(l);
  }

  for (const g of groups) {
    ensurePage(30);
    // Section header
    page.drawRectangle({ x: MARGIN, y: y - 16, width: CONTENT_W, height: 16, color: rgb(0.99, 0.98, 0.96) });
    ctx.page.drawText(g.section.toUpperCase(), { x: MARGIN + 6, y: y - 12, font: bold, size: 8.5, color: GREY });
    y -= 16;

    let sectionTotal = 0;
    let sectionCum = 0;
    for (const l of g.lines) {
      const desc = wrap(l.description, regular, 9, cols[0].w - 12);
      const rowH = Math.max(14, desc.length * 11 + 4);
      ensurePage(rowH);
      for (let i = 0; i < desc.length; i++) {
        ctx.page.drawText(desc[i], { x: cols[0].x + 6, y: y - 10 - i * 11, font: regular, size: 9, color: BLACK });
      }
      const rowY = y - 10;
      drawRightAligned(ctx.page, l.qty != null ? numShort(l.qty) : "—", cols[1].x + cols[1].w - 4, rowY, regular, 9, BLACK);
      drawRightAligned(ctx.page, numShort(l.rate), cols[2].x + cols[2].w - 4, rowY, regular, 9, BLACK);
      drawRightAligned(ctx.page, numShort(l.contract_value), cols[3].x + cols[3].w - 4, rowY, regular, 9, BLACK);
      drawRightAligned(ctx.page, `${l.percent_complete.toFixed(0)}`, cols[4].x + cols[4].w - 4, rowY, regular, 9, BLACK);
      drawRightAligned(ctx.page, numShort(l.cumulative_value), cols[5].x + cols[5].w - 4, rowY, l.cumulative_value > 0 ? bold : regular, 9, BLACK);
      sectionTotal += l.contract_value;
      sectionCum += l.cumulative_value;
      y -= rowH;
    }

    // Section subtotal
    ensurePage(14);
    page.drawLine({ start: { x: MARGIN + 240, y: y - 1 }, end: { x: PAGE_W - MARGIN, y: y - 1 }, thickness: 0.5, color: RULE });
    drawRightAligned(ctx.page, "Section subtotal", cols[3].x + cols[3].w - 4, y - 12, bold, 8.5, GREY);
    drawRightAligned(ctx.page, numShort(sectionTotal), cols[3].x + cols[3].w - 4, y - 12, regular, 9, BLACK);
    // Wait — that overlaps. Put the label spanning over Item/Qty/Rate.
    // Re-do: clear, then draw the label spanning cols[0..2], and totals in cols[3] and cols[5].
    // To keep simple, redraw with empty cells:
    page.drawRectangle({ x: MARGIN, y: y - 16, width: CONTENT_W, height: 16, color: rgb(1, 1, 1) });
    page.drawLine({ start: { x: MARGIN + 240, y: y - 1 }, end: { x: PAGE_W - MARGIN, y: y - 1 }, thickness: 0.5, color: RULE });
    ctx.page.drawText("Section subtotal", { x: MARGIN + 6, y: y - 12, font: bold, size: 8.5, color: GREY });
    drawRightAligned(ctx.page, numShort(sectionTotal), cols[3].x + cols[3].w - 4, y - 12, bold, 9, BLACK);
    drawRightAligned(ctx.page, numShort(sectionCum), cols[5].x + cols[5].w - 4, y - 12, bold, 9, BLACK);
    y -= 16;
  }

  // Grand total row
  const afp = d.afp;
  ensurePage(20);
  page.drawRectangle({ x: MARGIN, y: y - 20, width: CONTENT_W, height: 20, color: rgb(0.97, 0.96, 0.94) });
  ctx.page.drawText("TOTAL", { x: MARGIN + 6, y: y - 14, font: bold, size: 10, color: BLACK });
  drawRightAligned(ctx.page, money(afp.contract_sum ?? 0), cols[3].x + cols[3].w - 4, y - 14, bold, 10, BLACK);
  drawRightAligned(ctx.page, money(afp.cumulative_value ?? 0), cols[5].x + cols[5].w - 4, y - 14, bold, 10, BLACK);
  y -= 20;

  return y;
}

/* ── Footer ─────────────────────────────────────────────────────────── */

function drawFooter(ctx: Ctx, lastY: number) {
  const { page, regular, bold } = ctx;
  // Place a signature block at least 80pt above the page bottom; if there's
  // less than that left we let it ride above the bottom edge.
  const sigY = Math.max(lastY - 30, MARGIN + 110);

  hairline(page, MARGIN, sigY, PAGE_W - MARGIN);
  page.drawText("Signed (PowerGrid Projects Ltd)", { x: MARGIN, y: sigY - 14, font: regular, size: 9, color: GREY });
  page.drawText("Date", { x: MARGIN + (CONTENT_W / 2), y: sigY - 14, font: regular, size: 9, color: GREY });
  page.drawLine({ start: { x: MARGIN, y: sigY - 50 }, end: { x: MARGIN + (CONTENT_W / 2) - 20, y: sigY - 50 }, thickness: 0.5, color: BLACK });
  page.drawLine({ start: { x: MARGIN + (CONTENT_W / 2), y: sigY - 50 }, end: { x: PAGE_W - MARGIN, y: sigY - 50 }, thickness: 0.5, color: BLACK });

  // Company details footer
  const footerY = MARGIN + 18;
  hairline(page, MARGIN, footerY + 14, PAGE_W - MARGIN);
  page.drawText(
    `${COMPANY.name}  ·  Company No. ${COMPANY.company_number}  ·  VAT ${COMPANY.vat_number}`,
    { x: MARGIN, y: footerY, font: regular, size: 8, color: GREY },
  );
  page.drawText(
    `Registered office: ${COMPANY.registered_office}`,
    { x: MARGIN, y: footerY - 10, font: regular, size: 8, color: GREY },
  );

  // Bold is referenced to keep typescript happy if we later want a bold footer line.
  void bold;
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function drawRightAligned(page: PDFPage, text: string, xRight: number, y: number, font: PDFFont, size: number, color: ReturnType<typeof rgb>) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: xRight - w, y, font, size, color });
}
function hairline(page: PDFPage, x1: number, y: number, x2: number) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.5, color: RULE });
}
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else cur = candidate;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}
function money(n: number): string {
  return `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function numShort(n: number): string {
  return n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
