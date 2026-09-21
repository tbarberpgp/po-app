// Client-side PDF of a purchase-order register — a PO list printed, not a
// document in its own right: same columns, same order, same headline figures,
// so what lands in someone's inbox is the screen they were told to look at.
//
// A4 landscape (the register is a wide table — the same call hs-pack-pdf makes
// for the sign-in register), PGP monochrome house style.
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ PURCHASE ORDERS                                     [LOGO]   │
//   │ 26004 — Blyth · Power Grid Projects Ltd                      │
//   │ Approved · search "fixfast" · 4 of 27 orders                 │
//   │ POs listed 6   Committed £2,793.08   In Xero 0   Total £…    │
//   │ PO · SUPPLIER · VALUE · STATUS · XERO · RAISED · BY          │
//   │ …rows…                                                       │
//   │                                          Total  £2,793.08    │
//   └──────────────────────────────────────────────────────────────┘
//
// Columns are laid out per view rather than fixed: the workspace register adds
// project and delivery, and its Deleted view trades Xero and delivery — which
// nobody reads a cancelled order for — for when it went, who deleted it and why.

import { PDFDocument, StandardFonts, rgb, PDFFont, PDFImage, PDFPage } from "pdf-lib";
import { COMPANY } from "../../shared/company";
import {
  poDeliveryStateLabel, poStatusLabel, poXeroLabel, summarisePoRegister,
  type PoListExport, type PoRegisterRow,
} from "./po-register";

export { downloadPdf } from "./po-pdf";

const PAGE_W = 841.89; // A4 landscape
const PAGE_H = 595.28;
const MARGIN = 40;
const RIGHT = PAGE_W - MARGIN;
const CONTENT_W = RIGHT - MARGIN;
const GAP = 6;            // between columns

const INK = rgb(0.059, 0.067, 0.188);   // PGP navy
const GREY = rgb(0.416, 0.427, 0.541);
const RULE = rgb(0.886, 0.871, 0.835);
const RULE_DARK = rgb(0.25, 0.26, 0.28);

const ROW_H = 19;
const BODY_BOTTOM = 52;   // rows stop here; the footer sits at y=22

type Col = {
  label: string;
  /** Points. Exactly one column is `flex`, and it absorbs whatever is left. */
  w: number;
  flex?: boolean;
  align?: "right";
  bold?: boolean;
  muted?: boolean;
  get: (po: PoRegisterRow) => string;
};

// Widths are measured against the longest real value each column holds (a
// seven-figure total, "Pending approval", a full @powergridprojects.net
// address) plus its heading. Supplier — the one column with no natural
// ceiling — takes whatever is left over, so it's widest on the project
// register and gives ground as the workspace view adds columns.
function columns(o: PoListExport): Col[] {
  const cols: Col[] = [{ label: "PO", w: 70, bold: true, get: (p) => p.po_number }];
  if (o.showProject) cols.push({ label: "PROJECT", w: 40, get: (p) => p.project_code ?? "" });
  const supplier: Col = { label: "SUPPLIER", w: 130, get: (p) => p.supplier };
  cols.push(
    supplier,
    { label: "VALUE", w: 62, align: "right", get: (p) => money(p.total_value) },
    { label: "STATUS", w: 70, get: (p) => poStatusLabel(p.status) },
  );
  if (o.showDeleted) {
    // Nobody reads a cancelled order for its Xero or delivery state — those
    // columns give way to the account of the deletion, and the reason (free
    // text, and the only record of WHY) takes the slack instead of supplier.
    cols.push(
      { label: "DELETED", w: 54, muted: true, get: (p) => formatDate(p.deleted_at ?? null) },
      { label: "DELETED BY", w: 128, muted: true, get: (p) => p.deleted_by ?? "" },
      { label: "REASON", w: 0, flex: true, get: (p) => p.deletion_reason ?? "" },
    );
    return cols;
  }
  supplier.w = 0; supplier.flex = true;
  if (o.showProject) cols.push({ label: "DELIVERY", w: 70, get: (p) => poDeliveryStateLabel(p.delivery_state) });
  cols.push(
    { label: "XERO", w: 82, get: (p) => poXeroLabel(p) },
    { label: "RAISED", w: 54, muted: true, get: (p) => formatDate(p.created_at) },
    { label: "BY", w: 128, muted: true, get: (p) => p.created_by },
  );
  return cols;
}

/** Left edge of each column; the flex column takes the remaining width. */
function layout(cols: Col[]): { x: number[]; w: number[] } {
  const fixed = cols.reduce((s, c) => s + (c.flex ? 0 : c.w), 0) + GAP * (cols.length - 1);
  const w = cols.map((c) => (c.flex ? Math.max(40, CONTENT_W - fixed) : c.w));
  const x: number[] = [];
  let cur = MARGIN;
  for (const cw of w) { x.push(cur); cur += cw + GAP; }
  return { x, w };
}

type Ctx = {
  pdf: PDFDocument; page: PDFPage; reg: PDFFont; bold: PDFFont;
  logo: PDFImage | null; y: number; pageNo: number;
  o: PoListExport; cols: Col[]; x: number[]; w: number[];
};

export async function generatePoListPdf(pos: PoRegisterRow[], o: PoListExport): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logo = await loadLogo(pdf).catch(() => null);

  const cols = columns(o);
  const { x, w } = layout(cols);
  const t = summarisePoRegister(pos);
  const ctx: Ctx = { pdf, page: null as unknown as PDFPage, reg, bold, logo, y: 0, pageNo: 0, o, cols, x, w };

  newPage(ctx, [
    `POs listed ${pos.length}`,
    `Committed ${money(t.committed)}  (approved + issued + pending)`,
    `In Xero ${t.inXero}${t.xeroFailed > 0 ? ` (${t.xeroFailed} push failed)` : ""}`,
    `Total value ${money(t.all)}`,
  ]);
  tableHeader(ctx);

  for (const po of pos) {
    if (ctx.y - ROW_H < BODY_BOTTOM) { newPage(ctx, null); tableHeader(ctx); }
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
  const { page, reg, bold, logo, o } = ctx;
  let y = PAGE_H - MARGIN;

  if (logo) {
    const dims = logo.scale(30 / logo.height);
    page.drawImage(logo, { x: RIGHT - dims.width, y: y - 26, width: dims.width, height: dims.height });
  }

  page.drawText("PURCHASE ORDERS", { x: MARGIN, y: y - 14, font: bold, size: 15, color: INK });
  y -= 32;
  page.drawText(clean([o.subject, COMPANY.name].filter(Boolean).join("   ·   ")), { x: MARGIN, y, font: reg, size: 9, color: GREY });
  y -= 14;
  if (o.scope) {
    page.drawText(truncate(reg, clean(o.scope), 9, CONTENT_W), { x: MARGIN, y, font: reg, size: 9, color: GREY });
    y -= 14;
  }

  if (kpis) {
    let kx = MARGIN;
    for (const k of kpis) {
      const text = clean(k);
      page.drawText(text, { x: kx, y, font: bold, size: 9, color: INK });
      kx += bold.widthOfTextAtSize(text, 9) + 26;
    }
    y -= 14;
  }

  ctx.y = y - 8;
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
  const { page, bold, cols, x, w } = ctx;
  const y = ctx.y;
  cols.forEach((c, i) => {
    if (c.align === "right") right(page, c.label, x[i] + w[i], y, bold, 8, GREY);
    else page.drawText(c.label, { x: x[i], y, font: bold, size: 8, color: GREY });
  });
  page.drawLine({ start: { x: MARGIN, y: y - 5 }, end: { x: RIGHT, y: y - 5 }, thickness: 0.8, color: RULE_DARK });
  ctx.y = y - 5 - ROW_H;
}

function drawRow(ctx: Ctx, po: PoRegisterRow): void {
  const { page, reg, bold, cols, x, w } = ctx;
  const y = ctx.y + ROW_H / 2 - 3;
  cols.forEach((c, i) => {
    const raw = clean(c.get(po));
    const text = raw || "—";
    const font = c.bold ? bold : reg;
    const color = !raw || c.muted ? GREY : INK;
    if (c.align === "right") right(page, truncate(font, text, 8.5, w[i]), x[i] + w[i], y, font, 8.5, color);
    else page.drawText(truncate(font, text, 8.5, w[i]), { x: x[i], y, font, size: 8.5, color });
  });
  page.drawLine({ start: { x: MARGIN, y: ctx.y - 4 }, end: { x: RIGHT, y: ctx.y - 4 }, thickness: 0.5, color: RULE });
  ctx.y -= ROW_H;
}

function drawTotal(ctx: Ctx, total: number): void {
  if (ctx.y - 26 < BODY_BOTTOM) newPage(ctx, null);
  const { page, bold, cols, x, w } = ctx;
  const vi = cols.findIndex((c) => c.align === "right");
  if (vi < 0) return;
  const valueR = x[vi] + w[vi];
  const y = ctx.y - 6;
  page.drawLine({ start: { x: valueR - 150, y: y + 13 }, end: { x: valueR, y: y + 13 }, thickness: 0.8, color: RULE_DARK });
  right(page, "Total value", valueR - 90, y, bold, 10, GREY);
  right(page, money(total), valueR, y, bold, 11, INK);
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
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
