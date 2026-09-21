// Spreadsheet invoices. Subcontractors who bill from their own template send an
// .xlsx rather than a PDF (day-work sheets, CIS invoices), and Claude can't read
// a spreadsheet part — so the workbook is flattened to text before extraction.
// The "is this a spreadsheet?" test lives in ./file-kind, which the browser also
// uses and which must stay free of this module's SheetJS import.
import * as XLSX from "xlsx";

/** Rows past this per sheet, or characters overall, are dropped — an invoice
 *  lives in the first page or two, and a stray 10k-row export shouldn't blow
 *  the extraction request up. */
const MAX_ROWS_PER_SHEET = 400;
const MAX_CHARS = 40_000;

/**
 * Flatten a workbook to plain text for the extractor. CSV keeps the column
 * alignment that makes a table legible, but these templates are mostly padding
 * — merged title blocks, whitespace-padded descriptions, columns out to K — so
 * blank rows, trailing commas and repeated spaces come out. What's left is the
 * header block, the works rows and the totals, which is what gets read.
 */
export function spreadsheetToText(buffer: ArrayBuffer): string {
  const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
  const out: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_csv(ws, { blankrows: false })
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").replace(/,+\s*$/, "").trim())
      // A row of nothing but separators is a spacer, not data.
      .filter((line) => /[^,\s]/.test(line))
      .slice(0, MAX_ROWS_PER_SHEET);
    if (rows.length === 0) continue;
    out.push(`--- Sheet: ${name} ---`, ...rows);
  }
  const text = out.join("\n");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[truncated]` : text;
}
