// One subcontractor invoice = one labour application.
//
//   npm test
//
// The case is Paul Garbutt on Blyth: INV-016 went in as #32 from the .docx and
// again as #34 from the .pdf, both submitted at £3,300. Neither had its invoice
// number recorded — the extractor didn't read it then — so the file name has
// to stand in for those.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { invoiceNumberKey, pickLabourInvoiceDupe, type LabourInvoiceCandidate } from "./labour-invoice-dupe";

const app = (over: Partial<LabourInvoiceCandidate> = {}): LabourInvoiceCandidate => ({
  id: 102, app_number: 32, status: "submitted", invoice_number: null,
  source_file_name: "Invoice INV - 016.docx", ...over,
});

describe("invoiceNumberKey", () => {
  test("spacing, case, dashes and leading zeros don't matter", () => {
    assert.equal(invoiceNumberKey("INV - 016"), "INV16");
    assert.equal(invoiceNumberKey("inv-16"), "INV16");
    assert.equal(invoiceNumberKey("INV016"), "INV16");
  });
  test("no digits identifies nothing", () => {
    assert.equal(invoiceNumberKey("Invoice"), null);
    assert.equal(invoiceNumberKey(""), null);
    assert.equal(invoiceNumberKey(null), null);
  });
});

describe("pickLabourInvoiceDupe", () => {
  test("Garbutt INV-016: the PDF of an invoice already in as a Word file", () => {
    const d = pickLabourInvoiceDupe([app()], { invoice_number: "INV - 016", file_name: "Invoice INV - 016.pdf" });
    assert.equal(d?.app_number, 32);
    assert.equal(d?.matched_on, "file_name");
  });

  test("same stem, different format, even if the number wasn't read off either", () => {
    const d = pickLabourInvoiceDupe([app()], { invoice_number: null, file_name: "Invoice INV - 016.pdf" });
    assert.equal(d?.app_number, 32);
  });

  test("recorded numbers match whatever the files are called", () => {
    const d = pickLabourInvoiceDupe(
      [app({ invoice_number: "INV-016", source_file_name: "scan0042.pdf" })],
      { invoice_number: "INV 16", file_name: "Paul invoice.docx" },
    );
    assert.equal(d?.matched_on, "invoice_number");
  });

  test("two recorded numbers that differ are never a duplicate", () => {
    const d = pickLabourInvoiceDupe(
      [app({ invoice_number: "INV-015", source_file_name: "Invoice.pdf" })],
      { invoice_number: "INV-016", file_name: "Invoice.pdf" },
    );
    assert.equal(d, null);
  });

  test("the next week's invoice goes through", () => {
    const d = pickLabourInvoiceDupe([app()], { invoice_number: "INV - 017", file_name: "Invoice INV - 017.pdf" });
    assert.equal(d, null);
  });

  test("INV-001 is not found inside INV-016's file name", () => {
    const d = pickLabourInvoiceDupe([app()], { invoice_number: "INV - 001", file_name: "Invoice INV - 001.pdf" });
    assert.equal(d, null);
  });

  test("a bare number from a subbie who doesn't prefix theirs", () => {
    const d = pickLabourInvoiceDupe(
      [app({ source_file_name: "CLADDERS Invoice 001.pdf" })],
      { invoice_number: "001", file_name: "Cladders 1.docx" },
    );
    assert.equal(d?.matched_on, "file_name");
  });

  test("a bare number isn't found inside a longer one", () => {
    const d = pickLabourInvoiceDupe(
      [app({ source_file_name: "Invoice 011.pdf" })],
      { invoice_number: "1", file_name: "inv.pdf" },
    );
    assert.equal(d, null);
  });

  test("nothing to go on: a file name with no number blocks nothing", () => {
    const d = pickLabourInvoiceDupe(
      [app({ source_file_name: "invoice.pdf" })],
      { invoice_number: null, file_name: "invoice.pdf" },
    );
    assert.equal(d, null);
  });
});
