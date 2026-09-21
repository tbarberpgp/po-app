import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { isSpreadsheetFile } from "./file-kind";
import { spreadsheetToText } from "./spreadsheet-text";

/** A workbook shaped like the subbie invoices that prompted this — a padded
 *  title block, works rows out to column I, spacer rows between sections. */
function asgardLikeWorkbook(): ArrayBuffer {
  const rows = [
    ["", "", "", "", "", "", "", "INVOICE"],
    ["", "", "Asgard Projects LTD"],
    [],
    ["Invoice Number:   022", "", "", "", "", "", "Date Of Issue:  18/09/2026"],
    ["Project Name: DALLAS ROAD BEDFORD"],
    ["Date", "Works Description ", "", "", "", "", "Quantity ", "Rate (£)", "Sub Total (£)"],
    ["9/7/26", "Management on site -    DALLAS ROAD    ", "", "", "", "", 1, 420, 420],
    [],
    ["", "", "", "", "CIS Tax @ 20%", "", "", "", 420],
    ["", "", "", "", "Total Amount Due This Invoice", "", "", "", 2309.9],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

test("spreadsheets are recognised by MIME type and by filename", () => {
  assert.equal(isSpreadsheetFile("x.xlsx", "application/octet-stream"), true);
  assert.equal(isSpreadsheetFile("Updated Asgard Projects Ltd PGP-022.XLSX", null), true);
  assert.equal(isSpreadsheetFile(null, "application/vnd.ms-excel"), true);
  assert.equal(isSpreadsheetFile("scan.pdf", "application/pdf"), false);
  assert.equal(isSpreadsheetFile("logo.png", "image/png"), false);
  assert.equal(isSpreadsheetFile(null, null), false);
});

test("the figures an invoice is read from survive flattening", () => {
  const text = spreadsheetToText(asgardLikeWorkbook());
  assert.match(text, /Asgard Projects LTD/);
  assert.match(text, /Invoice Number: 022/);
  assert.match(text, /Date Of Issue: 18\/09\/2026/);
  assert.match(text, /Management on site - DALLAS ROAD/);  // padding collapsed
  assert.match(text, /CIS Tax @ 20%/);
  assert.match(text, /2309\.9/);
});

test("padding is stripped so the real rows aren't buried", () => {
  const lines = spreadsheetToText(asgardLikeWorkbook()).split("\n");
  assert.ok(!lines.some((l) => /^,+$/.test(l)), "spacer rows should be gone");
  assert.ok(!lines.some((l) => /,\s*$/.test(l)), "trailing separators should be gone");
  assert.equal(lines[0], "--- Sheet: Sheet1 ---");
});

test("an empty workbook yields nothing rather than a header", () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), "Sheet1");
  assert.equal(spreadsheetToText(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer), "");
});
