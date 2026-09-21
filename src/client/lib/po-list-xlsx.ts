// Client-side .xlsx export of a purchase-order register — the rows a PO list is
// showing, plus the columns that only start to matter once you're filtering in
// Excel (order type, cost category, approval, delivery and payment state). The
// headline figures are repeated above the table so a forwarded copy still
// carries the committed total it was taken from.
//
// Used by both registers: a project's Purchase orders tab, and the workspace
// list, which adds a project column and — on its Deleted view — when each order
// went, who deleted it and why.
//
// Dates go in as real dates, not text, so the register sorts and filters by
// them; `dd mmm yyyy` keeps them readable in UK Excel.

import * as XLSX from "xlsx";
import {
  poDeliveryStateLabel, poOrderTypeLabel, poStatusLabel, poXeroStatusLabel, summarisePoRegister,
  type PoListExport, type PoRegisterRow,
} from "./po-register";

type Cell = string | number | Date | null;
type Fmt = "date" | "money";
type Col = { label: string; wch: number; fmt?: Fmt; get: (po: PoRegisterRow) => Cell };

const DATE_FMT = "dd mmm yyyy";
const MONEY_FMT = "#,##0.00";

function columns(o: PoListExport): Col[] {
  const cols: Col[] = [{ label: "PO", wch: 17, get: (p) => p.po_number }];
  if (o.showProject) {
    cols.push(
      { label: "Project", wch: 10, get: (p) => p.project_code ?? "" },
      { label: "Project name", wch: 24, get: (p) => p.project_name ?? "" },
    );
  }
  cols.push(
    { label: "Supplier", wch: 30, get: (p) => p.supplier },
    { label: "Status", wch: 17, get: (p) => poStatusLabel(p.status) },
    { label: "Order type", wch: 11, get: (p) => poOrderTypeLabel(p.order_type) },
    { label: "Category", wch: 10, get: (p) => (p.category === "prelims" ? "Prelims" : "Materials") },
    { label: "Value £", wch: 13, fmt: "money", get: (p) => round2(p.total_value) },
    { label: "Xero", wch: 12, get: (p) => poXeroStatusLabel(p) },
    { label: "Xero ref", wch: 12, get: (p) => p.xero_po_number ?? "" },
    { label: "Raised", wch: 13, fmt: "date", get: (p) => asDate(p.created_at) },
    { label: "Raised by", wch: 30, get: (p) => p.created_by },
    { label: "Approved", wch: 13, fmt: "date", get: (p) => asDate(p.approved_at) },
    { label: "Approved by", wch: 30, get: (p) => p.approved_by ?? "" },
    { label: "Delivery date", wch: 13, fmt: "date", get: (p) => asDate(p.delivery_date) },
    { label: "Delivery", wch: 17, get: (p) => poDeliveryStateLabel(p.delivery_state) },
    { label: "Drops", wch: 7, get: (p) => p.delivery_drops ?? null },
    { label: "Paid", wch: 13, fmt: "date", get: (p) => asDate(p.paid_at) },
  );
  if (o.showDeleted) {
    cols.push(
      { label: "Deleted", wch: 13, fmt: "date", get: (p) => asDate(p.deleted_at) },
      { label: "Deleted by", wch: 30, get: (p) => p.deleted_by ?? "" },
      { label: "Reason", wch: 46, get: (p) => p.deletion_reason ?? "" },
    );
  }
  return cols;
}

export function generatePoListXlsx(pos: PoRegisterRow[], o: PoListExport): Uint8Array {
  const cols = columns(o);
  const valueCol = cols.findIndex((c) => c.fmt === "money");
  const t = summarisePoRegister(pos);
  const rows: Cell[][] = [];

  rows.push([`Purchase orders — ${o.subject}`]);
  if (o.scope) rows.push([o.scope]);
  rows.push([`Exported ${new Date().toLocaleString("en-GB")}`]);
  rows.push([]);
  rows.push(["POs listed", pos.length]);
  const committedRow = rows.length;
  rows.push(["Committed £", round2(t.committed), "approved + issued + pending"]);
  rows.push(["Total value £", round2(t.all), "across all statuses"]);
  rows.push(["In Xero", t.inXero, t.xeroFailed > 0 ? `${t.xeroFailed} push failed` : "synced"]);
  rows.push([]);

  rows.push(cols.map((c) => c.label));
  const firstDataRow = rows.length;   // 0-based index of the first PO row
  for (const po of pos) rows.push(cols.map((c) => c.get(po)));
  const lastDataRow = rows.length - 1;

  rows.push([]);
  const totalRow = rows.length;
  const foot: Cell[] = cols.map(() => "");
  if (valueCol > 0) { foot[valueCol - 1] = "Total"; foot[valueCol] = round2(t.all); }
  rows.push(foot);

  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  ws["!cols"] = cols.map((c) => ({ wch: c.wch }));
  // Filter dropdowns on the header row — the register is normally read by
  // supplier, project or status. (Freeze panes are a SheetJS Pro feature, so
  // the header scrolls away; the autofilter is what earns its keep here.)
  ws["!autofilter"] = {
    ref: XLSX.utils.encode_range(
      { s: { r: firstDataRow - 1, c: 0 }, e: { r: Math.max(lastDataRow, firstDataRow), c: cols.length - 1 } },
    ),
  };

  const fmt = (r: number, c: number, z: string, want: "d" | "n") => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (cell && cell.t === want) cell.z = z;
  };
  for (let r = firstDataRow; r <= lastDataRow; r++) {
    cols.forEach((col, c) => {
      if (col.fmt === "date") fmt(r, c, DATE_FMT, "d");
      else if (col.fmt === "money") fmt(r, c, MONEY_FMT, "n");
    });
  }
  if (valueCol >= 0) fmt(totalRow, valueCol, MONEY_FMT, "n");
  for (const r of [committedRow, committedRow + 1]) fmt(r, 1, MONEY_FMT, "n");

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Purchase orders");
  return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
}

/** Null, empty and unparseable dates all become a blank cell rather than
 *  "Invalid Date" text, which would break the column's sort. */
function asDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
function round2(n: number): number { return Math.round(n * 100) / 100; }
