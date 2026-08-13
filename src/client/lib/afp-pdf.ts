// Client-side PDF generator for an Application for Payment — styled to match
// the Xero invoice template (clean sans-serif, monochrome, thin rules):
//
//   ┌────────────────────────────────────────────────────────┐
//   │                                             [LOGO]      │
//   │ APPLICATION FOR PAYMENT   Application Date   PGP Ltd    │
//   │   <client>                Application No.    address…   │
//   │   <project>               Reference                     │
//   │                           Period Ending                 │
//   │                           VAT Number                    │
//   │ DESCRIPTION      QTY   RATE   CONTRACT   %   CUMULATIVE │
//   │ ───────────────────────────────────────────────────────│
//   │ …lines (sectioned, hairline separators)…                │
//   │                       Cumulative works …        …       │
//   │                       TOTAL GBP              26,731.08  │
//   │ Account Name / Sort Code / Account Number               │
//   │        Company Registration No … Registered Office …    │
//   └────────────────────────────────────────────────────────┘
//
// The measured-works columns stay — they're what the QS checks — but all the
// old chrome (serif masthead, status chip, orange section headers, boxed info
// rows, signature block) is gone.

import { PDFDocument, StandardFonts, rgb, PDFFont, PDFImage, PDFPage } from "pdf-lib";
import { COMPANY } from "../../shared/company";
import { afpDocLabel } from "../../shared/types";
import type { AfpDetail } from "../../shared/types";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 44;
const RIGHT = PAGE_W - MARGIN;

const INK = rgb(0.08, 0.09, 0.11);
const GREY = rgb(0.42, 0.43, 0.47);
const RULE = rgb(0.85, 0.85, 0.86);      // hairline row separators
const RULE_DARK = rgb(0.25, 0.26, 0.28); // header / totals rules

// Line-table geometry (right edge of right-aligned cols; left edges otherwise).
const T = {
  itemL: MARGIN,
  qtyR: MARGIN + 300,
  rateR: MARGIN + 372,
  pctR: MARGIN + 432,
  cumR: RIGHT,
};
const ITEM_W = 244;
const FOOTER_TOP = 58;

type Ctx = {
  pdf: PDFDocument;
  page: PDFPage;
  reg: PDFFont;
  bold: PDFFont;
  logo: PDFImage | null;
  y: number;
};

export async function generateAfpPdf(detail: AfpDetail): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logo = await loadLogo(pdf).catch(() => null);

  const ctx: Ctx = { pdf, page: pdf.addPage([PAGE_W, PAGE_H]), reg, bold, logo, y: PAGE_H - MARGIN };

  drawHeader(ctx, detail);
  drawLinesTable(ctx, detail);
  drawTotals(ctx, detail);
  drawPaymentDetails(ctx, detail);
  drawFooters(ctx);

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

/* ── Header — Xero's three columns ──────────────────────────────────────
 *  Left: document title with the bill-to under it. Centre: date / number /
 *  reference / period / VAT. Right: logo above our address block.        */

function drawHeader(ctx: Ctx, d: AfpDetail): void {
  const { page, reg, bold, logo } = ctx;
  const top = PAGE_H - MARGIN;
  const afp = d.afp;
  const metaX = MARGIN + 306;
  const coX = MARGIN + 414;

  if (logo) {
    const scale = Math.min(120 / logo.width, 38 / logo.height);
    const w = logo.width * scale, h = logo.height * scale;
    page.drawImage(logo, { x: RIGHT - w, y: top - h + 6, width: w, height: h });
  }

  // Title + bill-to (left).
  const titleY = top - 78;
  page.drawText(afpDocLabel(afp.direction, afp.status).toUpperCase(), { x: MARGIN, y: titleY, font: reg, size: 19, color: INK });
  let by = titleY - 24;
  const billTo: string[] = afp.direction === "outgoing"
    ? [afp.project_client ?? "", [afp.project_code, afp.project_name].filter(Boolean).join(" — ")].filter(Boolean)
    : [COMPANY.name, [afp.project_code, afp.project_name].filter(Boolean).join(" — ")].filter(Boolean);
  for (const lineText of billTo) {
    page.drawText(truncate(lineText, 52), { x: MARGIN + 26, y: by, font: reg, size: 10, color: INK });
    by -= 14;
  }

  // Meta pairs (centre) — bold label, value beneath.
  const pairs: Array<[string, string]> = [
    ["Application Date", formatDate(afp.created_at)],
    ["Application Number", `#${afp.app_number}`],
    ["Reference", `${afp.project_code ?? ""} Application #${afp.app_number}`.trim()],
    ["Period Ending", formatDate(afp.period_end)],
    ["VAT Number", COMPANY.vat_number],
  ];
  let my = top - 76;
  for (const [label, value] of pairs) {
    page.drawText(label, { x: metaX, y: my, font: bold, size: 9, color: INK });
    page.drawText(truncate(value, 30), { x: metaX, y: my - 12, font: reg, size: 9, color: INK });
    my -= 30;
  }

  // Our address block (right).
  let cy = top - 76;
  page.drawText(COMPANY.name, { x: coX, y: cy, font: reg, size: 9, color: INK }); cy -= 12;
  for (const lineText of COMPANY.trading_address_lines) {
    page.drawText(lineText, { x: coX, y: cy, font: reg, size: 9, color: INK });
    cy -= 12;
  }

  ctx.y = Math.min(by, my, cy) - 34;
}

/* ── Single-line table, exactly like the Xero invoice ───────────────────
 * The measured-works breakdown stays in the app and the Excel export; the
 * PDF is the clean invoice: one line, Quantity 1 × the amount due.        */

function drawLinesTable(ctx: Ctx, d: AfpDetail): void {
  const { page, reg, bold } = ctx;
  const afp = d.afp;

  const y = ctx.y;
  page.drawText("Description", { x: T.itemL, y, font: bold, size: 9, color: INK });
  drawRightAligned(page, "Quantity", T.qtyR, y, bold, 9, INK);
  drawRightAligned(page, "Unit Price", T.rateR, y, bold, 9, INK);
  drawRightAligned(page, "VAT", T.pctR, y, bold, 9, INK);
  drawRightAligned(page, "Amount GBP", T.cumR, y, bold, 9, INK);
  page.drawLine({ start: { x: MARGIN, y: y - 8 }, end: { x: RIGHT, y: y - 8 }, thickness: 0.9, color: RULE_DARK });
  ctx.y = y - 24;

  const desc = `${afpDocLabel(afp.direction, afp.status)} #${afp.app_number} — ` +
    `${[afp.project_code, afp.project_name].filter(Boolean).join(" ")} — period ending ${formatDate(afp.period_end)}`;
  const lines = wrap(desc, reg, 9.5, ITEM_W);
  let dy = ctx.y;
  for (const t of lines) { page.drawText(t, { x: T.itemL, y: dy, font: reg, size: 9.5, color: INK }); dy -= 12; }
  const due = afp.amount_due ?? 0;
  drawRightAligned(page, "1.00", T.qtyR, ctx.y, reg, 9.5, INK);
  drawRightAligned(page, num(due), T.rateR, ctx.y, reg, 9.5, INK);
  drawRightAligned(page, `${afp.vat_pct}%`, T.pctR, ctx.y, reg, 9.5, INK);
  drawRightAligned(page, num(due), T.cumR, ctx.y, reg, 9.5, INK);
  ctx.y = dy - 8;
}

/* ── Totals — Xero's Subtotal / TOTAL VAT / TOTAL GBP block. The application
 * arithmetic (cumulative, previously certified, retention) appears only when
 * it actually shapes the figure. ─────────────────────────────────────── */

function drawTotals(ctx: Ctx, d: AfpDetail): void {
  const afp = d.afp;
  if (ctx.y - 150 < FOOTER_TOP) newPage(ctx);
  const { page, reg, bold } = ctx;
  const blockL = MARGIN + 260;
  let y = ctx.y - 6;

  page.drawLine({ start: { x: blockL, y: y + 12 }, end: { x: RIGHT, y: y + 12 }, thickness: 0.5, color: RULE });

  const line = (label: string, value: string) => {
    drawRightAligned(page, label, T.cumR - 110, y, reg, 10, INK);
    drawRightAligned(page, value, T.cumR, y, reg, 10, INK);
    y -= 19;
  };
  const prev = afp.previous_certified ?? 0;
  const ret = afp.retention_amount ?? 0;
  if (prev > 0.005) {
    line("Cumulative works", num(afp.cumulative_value ?? 0));
    line("Previously certified", `-${num(prev)}`);
  }
  if (ret > 0.005) {
    if (prev <= 0.005) line("Cumulative works", num(afp.cumulative_value ?? 0));
    line(`Retention @ ${afp.retention_pct}%`, `-${num(ret)}`);
  }
  line("Subtotal", num(afp.amount_due ?? 0));
  line(`TOTAL VAT ${afp.vat_pct}%`, num(afp.vat_amount ?? 0));

  page.drawLine({ start: { x: blockL, y: y + 12 }, end: { x: RIGHT, y: y + 12 }, thickness: 0.9, color: RULE_DARK });
  y -= 4;
  drawRightAligned(page, "TOTAL GBP", T.cumR - 110, y, bold, 11, INK);
  drawRightAligned(page, num(afp.total_invoice ?? 0), T.cumR, y, bold, 11, INK);
  ctx.y = y - 34;
}

/* ── Payment details (outgoing only — our receiving account) ────────── */

function drawPaymentDetails(ctx: Ctx, d: AfpDetail): void {
  if (d.afp.direction !== "outgoing") return;
  if (ctx.y - 54 < FOOTER_TOP) newPage(ctx);
  const { page, reg, bold } = ctx;
  let y = ctx.y;
  const row = (label: string, value: string) => {
    page.drawText(label, { x: MARGIN, y, font: bold, size: 9.5, color: INK });
    page.drawText(value, { x: MARGIN + bold.widthOfTextAtSize(label, 9.5) + 4, y, font: reg, size: 9.5, color: INK });
    y -= 14;
  };
  row("Account Name:", COMPANY.bank.account_name);
  row("Sort Code:", COMPANY.bank.sort_code);
  row("Account Number:", COMPANY.bank.account_number);
  ctx.y = y - 10;
}

/* ── Footer (every page) — single centred registration line ────────── */

function drawFooters(ctx: Ctx): void {
  const text = `Company Registration No: ${COMPANY.company_number}.  Registered Office: ${COMPANY.registered_office}.`;
  const w = ctx.reg.widthOfTextAtSize(text, 7.5);
  ctx.pdf.getPages().forEach((page) => {
    page.drawText(text, { x: (PAGE_W - w) / 2, y: 34, font: ctx.reg, size: 7.5, color: GREY });
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

function num(n: number): string {
  return n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
