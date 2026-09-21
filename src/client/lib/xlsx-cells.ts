// Cell conventions shared by every .xlsx this app writes: dates go in as real
// dates and money as money, so a downloaded sheet sorts, filters and sums
// instead of being a wall of text that only looks like numbers.

import * as XLSX from "xlsx";

export const DATE_FMT = "dd mmm yyyy";
export const MONEY_FMT = "#,##0.00";

/** Null, empty and unparseable dates all become a blank cell rather than
 *  "Invalid Date" text, which would break the column's sort. */
export function asDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function round2(n: number): number { return Math.round(n * 100) / 100; }

export function round2OrNull(n: number | null | undefined): number | null {
  return n == null ? null : round2(n);
}

/** Apply a display format, but only where the cell really is that type — a
 *  blank or a stray string keeps its own formatting rather than being told to
 *  render as a date it isn't. */
export function setFormat(ws: XLSX.WorkSheet, r: number, c: number, z: string, want: "d" | "n"): void {
  if (c < 0) return;
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (cell && cell.t === want) cell.z = z;
}

/** Filter dropdowns over a header row and its data. */
export function autofilter(ws: XLSX.WorkSheet, headerRow: number, lastRow: number, cols: number): void {
  ws["!autofilter"] = {
    ref: XLSX.utils.encode_range({ s: { r: headerRow, c: 0 }, e: { r: Math.max(lastRow, headerRow + 1), c: cols - 1 } }),
  };
}
