// Client-side .xlsx of ONE purchase order — the spreadsheet counterpart to
// po-pdf. The PDF is the order as it goes to the supplier; this is the same
// order opened up for checking: the lines with their cost coding and budget
// line, what's been received against each, and the receipts they came in on.
//
// Sheet 1 is the order. A framework order adds its call-off drawdown columns
// and lists the call-offs beneath the totals; an order with deliveries logged
// gets a second sheet for the register.
//
// Dates go in as real dates and money as money, so the lines sort and sum.

import * as XLSX from "xlsx";
import { COMPANY } from "../../shared/company";
import { poDeliveryStateLabel, poOrderTypeLabel, poStatusLabel, poXeroLabel } from "./po-register";
import type { PurchaseOrder } from "../../shared/types";

export type PoXlsxInput = PurchaseOrder & {
  project_code?: string;
  project_name?: string;
  /** The framework this call-off draws against. */
  parent_po_number?: string | null;
  /** Framework orders only: the call-offs drawn against this order. */
  call_offs?: Array<{ po_number: string; status: string; total_value: number; created_at: string }>;
};

type Cell = string | number | Date | null;
const DATE_FMT = "dd mmm yyyy";
const MONEY_FMT = "#,##0.00";

export function generatePoXlsx(po: PoXlsxInput): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, orderSheet(po), "Order");
  if (po.deliveries?.length) XLSX.utils.book_append_sheet(wb, deliveriesSheet(po), "Deliveries");
  return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
}

function orderSheet(po: PoXlsxInput): XLSX.WorkSheet {
  const isFramework = po.order_type === "framework";
  const rows: Cell[][] = [];
  const money: Array<[number, number]> = [];   // [row, col] cells to format as money
  const dates: Array<[number, number]> = [];

  const put = (label: string, value: Cell, fmt?: "date" | "money") => {
    if (fmt === "date") dates.push([rows.length, 1]);
    if (fmt === "money") money.push([rows.length, 1]);
    rows.push([label, value]);
  };

  rows.push([`Purchase order ${po.po_number}`]);
  rows.push([`Exported ${new Date().toLocaleString("en-GB")}`]);
  rows.push([]);
  put("Supplier", po.supplier);
  put("Project", [po.project_code, po.project_name].filter(Boolean).join(" — "));
  put("Status", poStatusLabel(po.status));
  put("Order type", poOrderTypeLabel(po.order_type));
  if (po.parent_po_number) put("Drawn against", po.parent_po_number);
  put("Cost category", po.category === "prelims" ? "Prelims" : "Materials");
  put("Raised", asDate(po.created_at), "date");
  put("Raised by", po.created_by);
  put("Approved", asDate(po.approved_at), "date");
  put("Approved by", po.approved_by ?? "");
  if (po.rejected_at) { put("Rejected", asDate(po.rejected_at), "date"); put("Rejection reason", po.rejection_reason ?? ""); }
  put("Delivery date", asDate(po.delivery_date), "date");
  put("Delivery", poDeliveryStateLabel(po.delivery_state));
  put("Xero", poXeroLabel(po));
  put("Paid", asDate(po.paid_at), "date");
  if (po.notes?.trim()) put("Notes", po.notes.trim());
  rows.push([]);

  // ── Lines ──
  const header: string[] = ["#", "Item", "Manufacturer", "Cost code", "Budget line", "Qty", "Unit", "Unit price £", "Net £", "Received qty", "Flags"];
  if (isFramework) header.splice(10, 0, "Called off qty", "Called off £", "Remaining qty", "Remaining £");
  rows.push(["Order lines"]);
  rows.push(header);
  const firstLine = rows.length;

  let subtotal = 0;
  (po.lines ?? []).forEach((ln, i) => {
    const flags = [ln.is_unpriced ? "unpriced" : "", ln.is_over_budget ? "over budget" : ""].filter(Boolean).join(", ");
    const row: Cell[] = [
      i + 1, ln.item, ln.manufacturer ?? "", ln.cost_code ?? "", ln.budget_item ?? "",
      ln.qty, ln.unit ?? "", round2(ln.unit_cost), round2(ln.line_total),
      ln.received_qty ?? null, flags,
    ];
    if (isFramework) {
      row.splice(10, 0,
        ln.called_off_qty ?? null, round2OrNull(ln.called_off_value),
        ln.available_qty ?? null, round2OrNull(ln.available_value));
    }
    rows.push(row);
    subtotal += ln.line_total;
  });
  const lastLine = rows.length - 1;

  // ── Totals — the same VAT the PO PDF prints, so the two agree ──
  const netCol = header.indexOf("Net £");
  const vat = round2(subtotal * COMPANY.default_vat_rate);
  rows.push([]);
  for (const [label, value] of [
    ["Subtotal (ex VAT)", round2(subtotal)],
    [`VAT @ ${(COMPANY.default_vat_rate * 100).toFixed(0)}%`, vat],
    ["Total GBP", round2(subtotal + vat)],
  ] as Array<[string, number]>) {
    const r: Cell[] = new Array(header.length).fill("");
    r[netCol - 1] = label; r[netCol] = value;
    money.push([rows.length, netCol]);
    rows.push(r);
  }

  // ── Framework orders: what's been drawn against this one ──
  if (isFramework && po.call_offs?.length) {
    rows.push([]);
    rows.push(["Call-offs against this framework"]);
    rows.push(["PO", "Status", "Raised", "Value £"]);
    for (const k of po.call_offs) {
      dates.push([rows.length, 2]);
      money.push([rows.length, 3]);
      rows.push([k.po_number, poStatusLabel(k.status as PurchaseOrder["status"]), asDate(k.created_at), round2(k.total_value)]);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  ws["!cols"] = colWidths(header);
  ws["!autofilter"] = {
    ref: XLSX.utils.encode_range(
      { s: { r: firstLine - 1, c: 0 }, e: { r: Math.max(lastLine, firstLine), c: header.length - 1 } },
    ),
  };

  for (let r = firstLine; r <= lastLine; r++) {
    fmt(ws, r, header.indexOf("Unit price £"), MONEY_FMT, "n");
    fmt(ws, r, netCol, MONEY_FMT, "n");
    if (isFramework) {
      fmt(ws, r, header.indexOf("Called off £"), MONEY_FMT, "n");
      fmt(ws, r, header.indexOf("Remaining £"), MONEY_FMT, "n");
    }
  }
  for (const [r, c] of money) fmt(ws, r, c, MONEY_FMT, "n");
  for (const [r, c] of dates) fmt(ws, r, c, DATE_FMT, "d");
  return ws;
}

function colWidths(header: string[]): Array<{ wch: number }> {
  const by: Record<string, number> = {
    "#": 5, "Item": 44, "Manufacturer": 22, "Cost code": 16, "Budget line": 34,
    "Qty": 10, "Unit": 8, "Unit price £": 13, "Net £": 13, "Received qty": 13, "Flags": 20,
    "Called off qty": 14, "Called off £": 13, "Remaining qty": 14, "Remaining £": 13,
  };
  return header.map((h) => ({ wch: by[h] ?? 14 }));
}

/** The order's delivery register — one row per line received, with the note it
 *  came in on. A note that booked the whole order in at once has no item rows,
 *  so it gets a single row of its own rather than vanishing. */
function deliveriesSheet(po: PoXlsxInput): XLSX.WorkSheet {
  const header = ["Delivery note", "Date", "Supplier", "Signed by", "Item", "Qty", "Unit", "Completes line", "Flags", "Notes"];
  const rows: Cell[][] = [[`Deliveries against ${po.po_number}`], []];
  rows.push(header);
  const first = rows.length;

  for (const d of po.deliveries ?? []) {
    const source = d.collected_from
      ? `collected — invoice ${d.collected_from.invoice_number ?? "?"}`
      : d.manual ? "manual check-in, no ticket" : "";
    const base: Cell[] = [d.dn ?? "(no ticket)", asDate(d.delivered_at), d.supplier ?? "", d.signed_by ?? ""];
    if (d.whole_order || d.items.length === 0) {
      rows.push([...base, "(whole order signed for)", null, "", "", source, d.notes ?? ""]);
      continue;
    }
    for (const it of d.items) {
      rows.push([
        ...base,
        it.line_desc || it.description,
        it.qty ?? null, it.unit ?? "",
        it.completes ? "yes" : "",
        [source, it.duplicate ? "possible duplicate" : ""].filter(Boolean).join("; "),
        d.notes ?? "",
      ]);
    }
  }
  const last = rows.length - 1;

  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  ws["!cols"] = [{ wch: 18 }, { wch: 13 }, { wch: 22 }, { wch: 20 }, { wch: 44 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 26 }, { wch: 30 }];
  ws["!autofilter"] = {
    ref: XLSX.utils.encode_range({ s: { r: first - 1, c: 0 }, e: { r: Math.max(last, first), c: header.length - 1 } }),
  };
  for (let r = first; r <= last; r++) fmt(ws, r, 1, DATE_FMT, "d");
  return ws;
}

/* ── helpers ────────────────────────────────────────────────────────── */

function fmt(ws: XLSX.WorkSheet, r: number, c: number, z: string, want: "d" | "n"): void {
  if (c < 0) return;
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (cell && cell.t === want) cell.z = z;
}
/** Null, empty and unparseable dates all become a blank cell rather than
 *  "Invalid Date" text, which would break the column's sort. */
function asDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
function round2(n: number): number { return Math.round(n * 100) / 100; }
function round2OrNull(n: number | null | undefined): number | null {
  return n == null ? null : round2(n);
}
