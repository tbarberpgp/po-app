import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceNumberOf, planLabourLink, type LinkApp, type LinkBill } from "./labour-xero-link";

const app = (over: Partial<LinkApp> = {}): LinkApp => ({
  id: 1, status: "submitted", certified_amount: null, this_period_net: 3300, amount_due: 3300,
  xero_po_id: null, xero_po_number: null, invoice_number: null, source_file_name: null, ...over,
});
const BILLS: LinkBill[] = [
  { InvoiceID: "b15", InvoiceNumber: "INV-015", Status: "PAID", Total: 3850 },
  { InvoiceID: "b16", InvoiceNumber: "INV-016", Status: "AUTHORISED", Total: 3300 },
  { InvoiceID: "c13", InvoiceNumber: "013", Status: "AUTHORISED", SubTotal: 17510, Total: 17510 },
];

test("the invoice number comes from the document, a hand-keyed record, or the file name", () => {
  assert.equal(invoiceNumberOf({ invoice_number: "INV - 016", xero_po_number: null, source_file_name: "x.pdf" }), "INV - 016");
  assert.equal(invoiceNumberOf({ invoice_number: null, xero_po_number: "INV-015", source_file_name: null }), "INV-015");
  assert.equal(invoiceNumberOf({ invoice_number: null, xero_po_number: null, source_file_name: "Invoice 13.pdf" }), "13");
  assert.equal(invoiceNumberOf({ invoice_number: null, xero_po_number: null, source_file_name: "Invoice INV - 017.docx" }), "017");
  assert.equal(invoiceNumberOf({ invoice_number: null, xero_po_number: null, source_file_name: "PGP - Expenses and Mileage Claim - 26-06-26 BLYTH.xlsx" }), null);
});

test("a submitted certificate whose bill Xero has paid is linked as paid", () => {
  const p = planLabourLink(app({ this_period_net: 3850, amount_due: 3850, source_file_name: "Invoice 15.pdf" }), BILLS, new Set());
  assert.deepEqual(p && p.kind === "link" ? [p.bill.InvoiceID, p.paid] : p, ["b15", true]);
});

test("one Xero owes is linked as certified, not paid", () => {
  const p = planLabourLink(app({ source_file_name: "Invoice INV - 016.docx" }), BILLS, new Set());
  assert.deepEqual(p && p.kind === "link" ? [p.bill.InvoiceID, p.paid] : p, ["b16", false]);
  const c = planLabourLink(app({ this_period_net: 17510, amount_due: 17510, source_file_name: "Invoice 13.pdf" }), BILLS, new Set());
  assert.deepEqual(c && c.kind === "link" ? [c.bill.InvoiceID, c.paid] : c, ["c13", false]);
});

test("no bill in Xero yet: left alone", () => {
  assert.equal(planLabourLink(app({ this_period_net: 3850, source_file_name: "Invoice INV - 017.docx" }), BILLS, new Set()), null);
});

test("same number, different amount: flagged, not linked", () => {
  const p = planLabourLink(app({ this_period_net: 3300, amount_due: 3300, source_file_name: "Invoice 15.pdf" }), BILLS, new Set());
  assert.equal(p?.kind, "amount_differs");
});

test("a bill already tied to another certificate can't be claimed again", () => {
  assert.equal(planLabourLink(app({ source_file_name: "Invoice INV - 016.docx" }), BILLS, new Set(["b16"])), null);
});

test("a linked certificate turns paid when Xero pays it, and a paid one is finished", () => {
  assert.equal(planLabourLink(app({ status: "certified", xero_po_id: "b15" }), BILLS, new Set())?.kind, "now_paid");
  assert.equal(planLabourLink(app({ status: "certified", xero_po_id: "b16" }), BILLS, new Set()), null);
  assert.equal(planLabourLink(app({ status: "paid", source_file_name: "Invoice 15.pdf" }), BILLS, new Set()), null);
});
