// Tests for the guard that stops one supplier invoice number becoming two
// Xero bills.
//
//   npm test
//
// The case: the same Amazon invoice was uploaded twice 26 seconds apart, and
// both copies were pushed as separate bills — GB65XX05UAEUI, £8.32 booked
// twice, invoices #131 and #132. Nothing compared a push against what had
// already gone across.
//
// The SQL predicate itself was verified against the production book, where it
// selects exactly the two known duplicate numbers out of 157 invoices and
// nothing else. What these pin down is the behaviour around it: that a blank
// number can't be a duplicate, that a refusal names the twin, and above all
// that retrying a push is still allowed — a guard that broke the manual Push
// button would be worse than the duplicate it prevents.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { duplicateBillRefusal } from "./invoices";

type Row = { id: number; xero_bill_number: string | null };

/** Minimal D1 stand-in: hands back a canned twin for the SELECT, records the
 *  UPDATE so the test can assert the refusal is written to the row. */
function fakeEnv(twin: Row | null) {
  const sql: string[] = [];
  const bound: unknown[][] = [];
  const env = {
    DB: {
      prepare(q: string) {
        sql.push(q);
        return {
          bind(...args: unknown[]) {
            bound.push(args);
            return {
              first: async () => (q.includes("SELECT") ? twin : null),
              run: async () => ({ success: true }),
            };
          },
        };
      },
    },
  };
  return { env: env as never, sql, bound };
}

const ARGS = { id: "131", invoiceNumber: "GB65XX05UAEUI", supplierId: null, supplierName: "Amazon" };

describe("duplicateBillRefusal", () => {
  test("refuses when the same supplier's number is already in Xero", async () => {
    const { env } = fakeEnv({ id: 132, xero_bill_number: "BILL-9001" });
    const r = await duplicateBillRefusal(env, ARGS);
    assert.ok(r, "expected a refusal");
    assert.match(r.error, /already in Xero as bill BILL-9001/);
    assert.match(r.error, /invoice #132/);
  });

  test("the refusal names the twin even when Xero gave the bill no number", async () => {
    const { env } = fakeEnv({ id: 132, xero_bill_number: null });
    const r = await duplicateBillRefusal(env, ARGS);
    assert.ok(r);
    assert.match(r.error, /already in Xero, pushed from invoice #132/);
  });

  test("a refusal is recorded on the row, not just returned", async () => {
    // Otherwise the invoice sits there looking un-pushed with no reason why.
    const { env, sql } = fakeEnv({ id: 132, xero_bill_number: null });
    await duplicateBillRefusal(env, ARGS);
    assert.ok(sql.some((q) => /UPDATE invoices SET xero_sync_status = 'failed', xero_sync_error/.test(q)));
  });

  test("allows the push when nothing matches", async () => {
    const { env } = fakeEnv(null);
    assert.equal(await duplicateBillRefusal(env, ARGS), null);
  });

  test("a blank invoice number is never a duplicate", async () => {
    // Plenty of the book has no number read off the document. Treating those as
    // matching each other would block every one of them after the first.
    for (const invoiceNumber of [null, undefined, "", "   "]) {
      const { env, sql } = fakeEnv({ id: 999, xero_bill_number: "X" });
      assert.equal(await duplicateBillRefusal(env, { ...ARGS, invoiceNumber }), null);
      assert.equal(sql.length, 0, "should not even query");
    }
  });

  test("the query excludes the invoice being pushed, so a retry still works", async () => {
    // The manual Push button exists to retry a push that failed part-way. If
    // this guard compared an invoice against itself, the first failure would
    // make it permanently unpushable.
    const { env, sql, bound } = fakeEnv(null);
    await duplicateBillRefusal(env, ARGS);
    assert.match(sql[0]!, /id != CAST\(\? AS INTEGER\)/);
    assert.equal(bound[0]![0], "131");
  });

  test("only rows that actually reached Xero can block a push", async () => {
    // A second upload sitting unpushed in the inbox is not a reason to refuse.
    const { env, sql } = fakeEnv(null);
    await duplicateBillRefusal(env, ARGS);
    assert.match(sql[0]!, /xero_bill_id IS NOT NULL/);
  });

  test("matches on supplier id when both rows carry one", async () => {
    const { env, bound } = fakeEnv(null);
    await duplicateBillRefusal(env, { ...ARGS, supplierId: 76 });
    assert.equal(bound[0]![2], 76);
    assert.equal(bound[0]![3], 76);
  });
});
