// Every purchase order on a project, in one workbook — what you want when the
// question is about the job's buying as a whole rather than one order.
//
//   Orders      one row per PO (the register, exactly as the screen lists it)
//   Lines       every line of every order, each row naming its PO
//   Deliveries  every receipt logged, each row naming its PO
//
// The Lines sheet is the point of the thing: with the PO, supplier, cost code
// and budget line on each row it pivots by any of them, which the register
// (one row per order, no line detail) can't answer.
//
// Scoped to a project deliberately — it needs each order's detail, which only
// the single-PO GET carries, so the workspace register stays a register.

import * as XLSX from "xlsx";
import { poStatusLabel, type PoListExport } from "./po-register";
import { registerSheet } from "./po-list-xlsx";
import type { PoXlsxInput } from "./po-xlsx";
import { DATE_FMT, MONEY_FMT, asDate, autofilter, round2, setFormat } from "./xlsx-cells";

type Cell = string | number | Date | null;

export function generatePoBundleXlsx(details: PoXlsxInput[], o: PoListExport): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, registerSheet(details, o), "Orders");
  XLSX.utils.book_append_sheet(wb, linesSheet(details), "Lines");
  const deliveries = deliveriesSheet(details);
  if (deliveries) XLSX.utils.book_append_sheet(wb, deliveries, "Deliveries");
  return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
}

const LINE_COLS = [
  "PO", "Supplier", "PO status", "Raised", "Item", "Manufacturer", "Cost code",
  "Budget line", "Qty", "Unit", "Unit price £", "Net £", "Received qty", "Outstanding qty", "Flags",
] as const;

function linesSheet(details: PoXlsxInput[]): XLSX.WorkSheet {
  const rows: Cell[][] = [["Order lines — every line of every order listed"], []];
  rows.push([...LINE_COLS]);
  const first = rows.length;

  let net = 0;
  for (const po of details) {
    for (const ln of po.lines ?? []) {
      const received = ln.received_qty ?? 0;
      net += ln.line_total;
      rows.push([
        po.po_number, po.supplier, poStatusLabel(po.status), asDate(po.created_at),
        ln.item, ln.manufacturer ?? "", ln.cost_code ?? "", ln.budget_item ?? "",
        ln.qty, ln.unit ?? "", round2(ln.unit_cost), round2(ln.line_total),
        ln.received_qty ?? null,
        // What's still to come. Only meaningful once something has been booked
        // in against the line — an untouched line reads blank, not "all of it",
        // because nothing has been received *or* confirmed outstanding yet.
        received > 0 ? round2(Math.max(0, ln.qty - received)) : null,
        [ln.is_unpriced ? "unpriced" : "", ln.is_over_budget ? "over budget" : ""].filter(Boolean).join(", "),
      ]);
    }
  }
  const last = rows.length - 1;

  const netCol = LINE_COLS.indexOf("Net £");
  rows.push([]);
  const totalRow = rows.length;
  const foot: Cell[] = new Array(LINE_COLS.length).fill("");
  foot[netCol - 1] = "Total (ex VAT)";
  foot[netCol] = round2(net);
  rows.push(foot);

  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  ws["!cols"] = [
    { wch: 17 }, { wch: 28 }, { wch: 15 }, { wch: 13 }, { wch: 46 }, { wch: 20 }, { wch: 16 },
    { wch: 32 }, { wch: 10 }, { wch: 8 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 15 }, { wch: 20 },
  ];
  autofilter(ws, first - 1, last, LINE_COLS.length);
  for (let r = first; r <= last; r++) {
    setFormat(ws, r, LINE_COLS.indexOf("Raised"), DATE_FMT, "d");
    setFormat(ws, r, LINE_COLS.indexOf("Unit price £"), MONEY_FMT, "n");
    setFormat(ws, r, netCol, MONEY_FMT, "n");
  }
  setFormat(ws, totalRow, netCol, MONEY_FMT, "n");
  return ws;
}

const DELIVERY_COLS = [
  "PO", "Supplier", "Delivery note", "Date", "Signed by", "Item", "Qty", "Unit", "Completes line", "Flags", "Notes",
] as const;

/** Null when nothing has been received against any order — an empty tab reads
 *  as a broken export rather than as "no deliveries yet". */
function deliveriesSheet(details: PoXlsxInput[]): XLSX.WorkSheet | null {
  const body: Cell[][] = [];
  for (const po of details) {
    for (const d of po.deliveries ?? []) {
      const source = d.collected_from
        ? `collected — invoice ${d.collected_from.invoice_number ?? "?"}`
        : d.manual ? "manual check-in, no ticket" : "";
      const base: Cell[] = [po.po_number, po.supplier, d.dn ?? "(no ticket)", asDate(d.delivered_at), d.signed_by ?? ""];
      if (d.whole_order || d.items.length === 0) {
        body.push([...base, "(whole order signed for)", null, "", "", source, d.notes ?? ""]);
        continue;
      }
      for (const it of d.items) {
        body.push([
          ...base, it.line_desc || it.description, it.qty ?? null, it.unit ?? "",
          it.completes ? "yes" : "",
          [source, it.duplicate ? "possible duplicate" : ""].filter(Boolean).join("; "),
          d.notes ?? "",
        ]);
      }
    }
  }
  if (body.length === 0) return null;

  const rows: Cell[][] = [["Deliveries — every receipt logged against these orders"], [], [...DELIVERY_COLS], ...body];
  const first = 3;
  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  ws["!cols"] = [
    { wch: 17 }, { wch: 26 }, { wch: 18 }, { wch: 13 }, { wch: 20 },
    { wch: 44 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 26 }, { wch: 28 },
  ];
  autofilter(ws, first - 1, rows.length - 1, DELIVERY_COLS.length);
  for (let r = first; r < rows.length; r++) setFormat(ws, r, DELIVERY_COLS.indexOf("Date"), DATE_FMT, "d");
  return ws;
}
