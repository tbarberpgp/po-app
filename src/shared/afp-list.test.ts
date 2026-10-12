// Which invoice each application is, and the order the list shows them in.
//
//   npm test
//
// The file names below are every labour document name in the live database on
// 12 Oct 2026.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { invoiceRefOf, filterAndSortAfps, countBy, type AfpListRow } from "./afp-list";

const file = (source_file_name: string) => invoiceRefOf({ source_file_name, payment_reference: null });

describe("invoiceRefOf — from the file name", () => {
  test("Garbutt's names, all three ways he writes them", () => {
    assert.equal(file("Invoice INV - 002.docx"), "INV-002");
    assert.equal(file("Invoice INV - 009.docx.pdf"), "INV-009");
    assert.equal(file("Invoice INV - 010.pdf"), "INV-010");
    assert.equal(file("Invoice 11.pdf"), "INV-011");
    assert.equal(file("INV 13.pdf"), "INV-013");
    assert.equal(file("Invoice 15.pdf"), "INV-015");
  });

  test("Cladders'", () => {
    assert.equal(file("INV 011.pdf"), "INV-011");
    assert.equal(file("INV 10.pdf"), "INV-010");
    assert.equal(file("Cladders Inv 12.pdf"), "INV-012");
  });

  test("Asgaard's template numbers", () => {
    assert.equal(file("Asgard Projects Ltd (Template) PGP-010.xlsx"), "PGP-010");
    assert.equal(file("Updated Asgard Projects Ltd PGP-024.pdf"), "PGP-024");
  });

  test("names that carry no reference give nothing, not a guess", () => {
    assert.equal(file("CLADDERS LTD copy.pdf"), null);
    assert.equal(file("CLADDERS LTD copy copy.docx"), null);
    assert.equal(file("2026-07-26 12.53 TINY SCANNER.pdf"), null);
    assert.equal(file("PGP - Expenses and Mileage Claim - 26-06-26 BLYTH.xlsx"), null);
  });

  test("a long number is kept as written", () => {
    assert.equal(file("Invoice INV2500037.pdf"), "INV-2500037");
  });
});

describe("invoiceRefOf — the payment reference wins", () => {
  test("a Xero payment reference names the bill", () => {
    assert.equal(invoiceRefOf({ payment_reference: "Paid in Xero — INV-013", source_file_name: "INV 13.pdf" }), "INV-013");
    assert.equal(invoiceRefOf({ payment_reference: "Paid in Xero - INV-001", source_file_name: null }), "INV-001");
  });

  test("any other payment reference is not an invoice number", () => {
    assert.equal(invoiceRefOf({ payment_reference: "BACS 12/10", source_file_name: "Invoice 12.pdf" }), "INV-012");
  });
});

// Garbutt's Blyth series as it stands after the restatement, with two Cladders
// applications interleaved. Period ends are mostly upload dates.
const G = 51, C = 7;
const row = (id: number, n: number, sup: number, status: string, period_end: string, f: string): AfpListRow =>
  ({ id, app_number: n, counterparty_supplier_id: sup, status, period_end, source_file_name: f, payment_reference: null });
const BLYTH: AfpListRow[] = [
  row(54, 3, G, "paid", "2026-07-10", "Invoice INV - 002.docx"),
  row(63, 9, G, "paid", "2026-07-23", "Invoice INV - 004.docx"),
  row(68, 10, G, "paid", "2026-07-30", "Invoice INV - 005.docx"),
  row(73, 12, G, "paid", "2026-08-14", "Invoice INV - 007.docx"),
  row(75, 14, G, "paid", "2026-08-14", "Invoice INV - 006.docx"),
  row(77, 16, G, "paid", "2026-08-20", "Invoice INV - 008.docx"),
  row(81, 18, G, "paid", "2026-09-04", "Invoice INV - 009.docx.pdf"),
  row(82, 19, G, "paid", "2026-09-04", "Invoice INV - 010.pdf"),
  row(83, 20, G, "paid", "2026-09-10", "Invoice 11.pdf"),
  row(87, 22, G, "paid", "2026-09-17", "Invoice 12.pdf"),
  row(92, 23, G, "paid", "2026-10-01", "INV 13.pdf"),
  row(94, 25, G, "paid", "2026-10-01", "Invoice 14.pdf"),
  row(96, 27, G, "submitted", "2026-10-08", "Invoice 15.pdf"),
  row(99, 29, G, "paid", "2026-06-29", "Invoice INV - 001.docx"),
  row(100, 30, G, "paid", "2026-07-13", "Invoice INV - 003.docx"),
  row(95, 26, C, "draft", "2026-10-01", "INV 011.pdf"),
  row(97, 28, C, "submitted", "2026-10-08", "Cladders Inv 12.pdf"),
];
const refs = (rows: AfpListRow[]) => rows.map((r) => invoiceRefOf(r));

describe("filterAndSortAfps", () => {
  test("Garbutt alone, oldest first, reads INV-001 to INV-015 in order", () => {
    const out = filterAndSortAfps(BLYTH, { supplierId: G, sort: "oldest" });
    assert.deepEqual(refs(out), Array.from({ length: 15 }, (_, i) => `INV-${String(i + 1).padStart(3, "0")}`));
  });

  test("newest first is the same order reversed", () => {
    const out = filterAndSortAfps(BLYTH, { supplierId: G, sort: "newest" });
    assert.equal(invoiceRefOf(out[0]), "INV-015");
    assert.equal(invoiceRefOf(out[14]), "INV-001");
  });

  test("filtering by status", () => {
    const submitted = filterAndSortAfps(BLYTH, { status: "submitted", sort: "oldest" });
    assert.deepEqual(submitted.map((r) => r.app_number), [27, 28]);
    assert.equal(filterAndSortAfps(BLYTH, { status: "paid", supplierId: G }).length, 14);
    assert.equal(filterAndSortAfps(BLYTH, { status: "paid", supplierId: C }).length, 0);
  });

  test("everything, unfiltered, keeps every row", () => {
    assert.equal(filterAndSortAfps(BLYTH, {}).length, BLYTH.length);
  });

  test("counts for the filter menus", () => {
    const bySupplier = countBy(BLYTH, (r) => r.counterparty_supplier_id);
    assert.equal(bySupplier.get(G), 15);
    assert.equal(bySupplier.get(C), 2);
    assert.equal(countBy(BLYTH, (r) => r.status).get("paid"), 14);
  });
});
