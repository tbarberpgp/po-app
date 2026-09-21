// Client-side .xlsx export of a project's purchase-order register — the rows
// the Purchase orders tab lists, plus the columns that only start to matter
// once you're filtering in Excel (order type, cost category, approval, delivery
// and payment state). The headline figures are repeated above the table so a
// forwarded copy still carries the committed total it was taken from.
//
// Dates go in as real dates, not text, so the register sorts and filters by
// them; `dd mmm yyyy` keeps them readable in UK Excel.

import * as XLSX from "xlsx";
import type { PurchaseOrder } from "../../shared/types";
import {
  poDeliveryLabel, poOrderTypeLabel, poStatusLabel, poXeroStatusLabel, summarisePoRegister,
} from "./po-register";

type Cell = string | number | Date | null;

/** Columns holding dates / money (0-based), for the display formats below. */
const DATE_COLS = [8, 10, 12, 15];
const VALUE_COL = 5;
const DATE_FMT = "dd mmm yyyy";
const MONEY_FMT = "#,##0.00";

export function generatePoListXlsx(pos: PurchaseOrder[], projectCode: string, projectName: string): Uint8Array {
  const t = summarisePoRegister(pos);
  const rows: Cell[][] = [];

  rows.push([`Purchase orders — ${[projectCode, projectName].filter(Boolean).join(" · ")}`]);
  rows.push([`Exported ${new Date().toLocaleString("en-GB")}`]);
  rows.push([]);
  rows.push(["POs raised", pos.length]);
  rows.push(["Committed £", round2(t.committed), "approved + issued + pending"]);
  rows.push(["Total value £", round2(t.all), "across all statuses"]);
  rows.push(["In Xero", t.inXero, t.xeroFailed > 0 ? `${t.xeroFailed} push failed` : "synced"]);
  rows.push([]);

  const header = [
    "PO", "Supplier", "Status", "Order type", "Category", "Value £",
    "Xero", "Xero ref", "Raised", "Raised by", "Approved", "Approved by",
    "Delivery date", "Delivery", "Drops", "Paid",
  ];
  rows.push(header);
  const firstDataRow = rows.length;   // 0-based index of the first PO row

  for (const po of pos) {
    rows.push([
      po.po_number,
      po.supplier,
      poStatusLabel(po.status),
      poOrderTypeLabel(po.order_type),
      po.category === "prelims" ? "Prelims" : "Materials",
      round2(po.total_value),
      poXeroStatusLabel(po),
      po.xero_po_number ?? "",
      asDate(po.created_at),
      po.created_by,
      asDate(po.approved_at),
      po.approved_by ?? "",
      asDate(po.delivery_date),
      poDeliveryLabel(po.delivery_state),
      po.delivery_drops ?? null,
      asDate(po.paid_at),
    ]);
  }
  const lastDataRow = rows.length - 1;

  rows.push([]);
  rows.push(["", "", "", "", "Total", round2(t.all)]);
  const totalRow = rows.length - 1;

  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  ws["!cols"] = [
    { wch: 17 }, { wch: 28 }, { wch: 17 }, { wch: 11 }, { wch: 10 }, { wch: 12 },
    { wch: 12 }, { wch: 12 }, { wch: 13 }, { wch: 30 }, { wch: 13 }, { wch: 30 },
    { wch: 13 }, { wch: 16 }, { wch: 7 }, { wch: 13 },
  ];
  // Filter dropdowns on the header row — the register is normally read by
  // supplier or by status. (Freeze panes are a SheetJS Pro feature, so the
  // header scrolls away; the autofilter is what earns its keep here.)
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: firstDataRow - 1, c: 0 }, e: { r: Math.max(lastDataRow, firstDataRow), c: header.length - 1 } }) };

  const fmt = (r: number, c: number, z: string, want: "d" | "n") => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (cell && cell.t === want) cell.z = z;
  };
  for (let r = firstDataRow; r <= lastDataRow; r++) {
    for (const c of DATE_COLS) fmt(r, c, DATE_FMT, "d");
    fmt(r, VALUE_COL, MONEY_FMT, "n");
  }
  fmt(totalRow, VALUE_COL, MONEY_FMT, "n");
  for (const r of [4, 5]) fmt(r, 1, MONEY_FMT, "n");   // Committed £ / Total value £

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
