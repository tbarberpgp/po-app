// Tests for "has Xero paid for this order?" — the PO list's Xero column.
//
//   npm test
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { summarisePoPayment, type PoBill } from "./po-payment";

const bill = (o: Partial<PoBill>): PoBill => ({
  net: 100, gross: 120, paid_at: null, amount_paid: null, xero_bill_status: "AUTHORISED", ...o,
});

describe("summarisePoPayment", () => {
  test("no bill in Xero is 'none'", () => {
    assert.equal(summarisePoPayment([], 100).state, "none");
  });

  test("a bill in Xero with nothing paid is 'unpaid'", () => {
    assert.equal(summarisePoPayment([bill({})], 100).state, "unpaid");
  });

  test("every bill paid and the order billed in full is 'paid', dated by the last bill", () => {
    const p = summarisePoPayment([
      bill({ net: 60, paid_at: "2026-10-02T00:00:00.000Z" }),
      bill({ net: 40, paid_at: "2026-10-20T00:00:00.000Z" }),
    ], 100);
    assert.equal(p.state, "paid");
    assert.equal(p.last_paid_at, "2026-10-20T00:00:00.000Z");
    assert.equal(p.bills_paid, 2);
  });

  test("the only bill paid but the order not yet billed in full is 'part', not 'paid'", () => {
    const p = summarisePoPayment([bill({ net: 30, paid_at: "2026-10-02T00:00:00.000Z" })], 100);
    assert.equal(p.state, "part");
    assert.equal(p.last_paid_at, null);
  });

  test("one of two bills paid is 'part'", () => {
    const p = summarisePoPayment([bill({ net: 50, paid_at: "2026-10-02T00:00:00.000Z" }), bill({ net: 50 })], 100);
    assert.equal(p.state, "part");
    assert.equal(p.paid_net, 50);
  });

  test("a part payment on a bill counts pro rata", () => {
    const p = summarisePoPayment([bill({ net: 100, gross: 120, amount_paid: 60 })], 100);
    assert.equal(p.state, "part");
    assert.equal(p.paid_net, 50);
  });

  test("a voided bill drops out rather than counting as owed", () => {
    const p = summarisePoPayment([
      bill({ net: 100, paid_at: "2026-10-02T00:00:00.000Z" }),
      bill({ net: 100, xero_bill_status: "VOIDED" }),
    ], 100);
    assert.equal(p.state, "paid");
    assert.equal(p.bills, 1);
  });

  test("an order with no value is paid once every bill is", () => {
    assert.equal(summarisePoPayment([bill({ paid_at: "2026-10-02T00:00:00.000Z" })], 0).state, "paid");
  });
});
