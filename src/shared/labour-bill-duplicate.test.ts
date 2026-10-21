import { test } from "node:test";
import assert from "node:assert/strict";
import { findKeyedBill } from "./labour-bill-duplicate";

const bills = [
  { InvoiceID: "a", InvoiceNumber: "INV-015", Status: "PAID", Total: 3850 },
  { InvoiceID: "b", InvoiceNumber: "INV16", Status: "AUTHORISED", Total: 3300 },
  { InvoiceID: "c", InvoiceNumber: "INV-017", Status: "VOIDED", Total: 3300 },
];

test("matches the subbie's own number however it was typed", () => {
  assert.equal(findKeyedBill(bills, "INV - 016")?.InvoiceID, "b");
  assert.equal(findKeyedBill(bills, "inv-015")?.InvoiceID, "a");
  assert.equal(findKeyedBill(bills, "16")?.InvoiceID, "b");
});

test("a voided or deleted bill doesn't count", () => {
  assert.equal(findKeyedBill(bills, "INV-017"), null);
});

test("nothing to compare means no match", () => {
  assert.equal(findKeyedBill(bills, null), null);
  assert.equal(findKeyedBill(bills, "  "), null);
  assert.equal(findKeyedBill(bills, "INV-018"), null);
});

test("Invoice 001 does not match Invoice 010", () => {
  assert.equal(findKeyedBill([{ InvoiceID: "x", InvoiceNumber: "Invoice 010", Status: "PAID" }], "Invoice 001"), null);
});
