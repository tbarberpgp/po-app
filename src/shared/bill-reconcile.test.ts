import { test } from "node:test";
import assert from "node:assert/strict";
import { looseRefKey, reconcileBills, refKey, type AppInvoiceSide, type XeroBillSide } from "./bill-reconcile";

function bill(over: Partial<XeroBillSide> & { id: string }): XeroBillSide {
  return {
    number: null, reference: null, status: "AUTHORISED", total: 100, amount_due: 100,
    currency: "GBP", date: "2026-09-01T00:00:00.000Z", contact_name: "Alumasc Ltd", ...over,
  };
}
function inv(over: Partial<AppInvoiceSide> & { id: number }): AppInvoiceSide {
  return {
    invoice_number: null, supplier_name: "Alumasc", gross_amount: 100, currency: "GBP",
    status: "pushed", invoice_date: "2026-09-01", xero_bill_id: null, xero_bill_number: null,
    project_code: null, ...over,
  };
}

test("references compare past case, spaces and punctuation", () => {
  assert.equal(refKey("INV-0012 345"), "INV0012345");
  assert.equal(refKey(null), "");
  assert.equal(looseRefKey("INV-0012345"), "12345");
  // Three digits collide too easily to stand in for an identity.
  assert.equal(looseRefKey("INV-123"), "");
});

test("the stored bill id wins over anything written on the documents", () => {
  const { rows } = reconcileBills(
    [bill({ id: "guid-1", reference: "COMPLETELY DIFFERENT" })],
    [inv({ id: 7, invoice_number: "A-1", xero_bill_id: "guid-1" })],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "matched");
  assert.equal(rows[0].match_by, "bill_id");
});

test("a hand-keyed bill matches on the number Xero holds, and says it was entered separately", () => {
  // Keyed into Xero: the supplier's number lands in InvoiceNumber, Reference is blank.
  const { rows, summary } = reconcileBills(
    [bill({ id: "guid-2", number: "ALU-77421" })],
    [inv({ id: 9, invoice_number: "alu 77421", status: "ready" })],
  );
  assert.equal(summary.matched, 1);
  assert.equal(rows[0].match_by, "invoice_number");
  assert.match(rows[0].notes.join(" "), /entered in Xero separately/);
});

test("a bill nobody logged here is reported, with its value totalled", () => {
  const { rows, summary } = reconcileBills([bill({ id: "guid-3", number: "ALU-900", total: 4250.5 })], []);
  assert.equal(summary.xero_only, 1);
  assert.equal(summary.xero_only_total, 4250.5);
  assert.equal(rows[0].state, "xero_only");
});

test("a Xero-only bill quoting one of our orders says so", () => {
  const { rows } = reconcileBills(
    [bill({ id: "guid-4", reference: "PO-BNC001-0007" })],
    [],
    [{ po_number: "PO-BNC001-0007", supplier: "Alumasc", total_value: 100, xero_bill_id: null }],
  );
  assert.equal(rows[0].po_number, "PO-BNC001-0007");
  assert.match(rows[0].notes.join(" "), /no invoice was logged here/);
});

test("voided bills don't count towards the exposure", () => {
  const { summary } = reconcileBills([bill({ id: "guid-5", status: "VOIDED", total: 9999 })], []);
  assert.equal(summary.xero_only, 1);
  assert.equal(summary.xero_only_total, 0);
});

test("totals that disagree are flagged with the difference", () => {
  const { rows, summary } = reconcileBills(
    [bill({ id: "guid-6", reference: "ALU-1", total: 1200 })],
    [inv({ id: 3, invoice_number: "ALU-1", gross_amount: 1000 })],
  );
  assert.equal(summary.amount_mismatches, 1);
  assert.equal(rows[0].amount_delta, 200);
});

test("two currencies are reported as incomparable rather than as a discrepancy", () => {
  const { rows, summary } = reconcileBills(
    [bill({ id: "guid-7", reference: "ALU-2", total: 1000, currency: "EUR" })],
    [inv({ id: 4, invoice_number: "ALU-2", gross_amount: 1000, currency: "GBP" })],
  );
  assert.equal(summary.amount_mismatches, 0);
  assert.equal(rows[0].amount_delta, null);
  assert.match(rows[0].notes.join(" "), /aren't comparable/);
});

test("an invoice the app thinks it pushed but Xero doesn't have is called out", () => {
  const { rows, summary } = reconcileBills(
    [],
    [inv({ id: 11, invoice_number: "ALU-3", status: "pushed", xero_bill_id: "gone" })],
  );
  assert.equal(summary.app_only, 1);
  assert.match(rows[0].notes.join(" "), /no matching bill came back from Xero/);
});

test("one bill can't consume two app invoices that share a number", () => {
  const { summary } = reconcileBills(
    [bill({ id: "guid-8", reference: "DUP-1" })],
    [inv({ id: 1, invoice_number: "DUP-1" }), inv({ id: 2, invoice_number: "DUP-1" })],
  );
  assert.equal(summary.matched, 1);
  assert.equal(summary.app_only, 1);
});

test("exceptions sort above clean matches", () => {
  const { rows } = reconcileBills(
    [bill({ id: "clean", reference: "OK-1" }), bill({ id: "orphan", reference: "ORPH" })],
    [inv({ id: 5, invoice_number: "OK-1", xero_bill_id: "clean" })],
  );
  assert.equal(rows[0].state, "xero_only");
  assert.equal(rows[rows.length - 1].state, "matched");
});
