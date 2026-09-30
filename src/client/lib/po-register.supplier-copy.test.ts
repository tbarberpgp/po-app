// What the supplier is holding, as distinct from where the order has got to.
//
//   npm test
//
// The case these exist for: an order is issued, the supplier files the PDF,
// and someone then amends the order. `issued_at` is cleared — correct, it
// isn't issued any more — but that made the order indistinguishable from one
// nobody had ever sent, and the two need opposite things done about them. One
// supplier is waiting for a first copy. The other has a copy in hand that says
// a different number, and will deliver and invoice against it.
//
// Five live orders were in the second state for months, up to 8 amendments
// deep, with nothing anywhere saying so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isApprovedNotIssued, supplierCopyState, supplierHasStaleCopy } from "./po-register";

test("what the supplier is holding", async (t) => {
  await t.test("nothing sent yet", () => {
    assert.deepEqual(supplierCopyState({}), { state: "none" });
    assert.equal(supplierHasStaleCopy({}), false);
  });

  await t.test("they hold this order as it stands", () => {
    assert.deepEqual(
      supplierCopyState({ supplier_copy_issued_at: "2026-06-17T16:33:09.548Z", supplier_copy_value: 71604.7 }),
      { state: "current", issuedAt: "2026-06-17T16:33:09.548Z", value: 71604.7 },
    );
    assert.equal(
      supplierHasStaleCopy({ supplier_copy_issued_at: "2026-06-17T16:33:09.548Z", supplier_copy_value: 71604.7 }),
      false,
    );
  });

  await t.test("amended since: they hold an earlier version", () => {
    const po = {
      supplier_copy_issued_at: "2026-06-17T16:33:09.548Z",
      supplier_copy_value: 71604.7,
      supplier_copy_stale_since: "2026-09-30T09:15:00.000Z",
    };
    assert.deepEqual(supplierCopyState(po), {
      state: "stale",
      issuedAt: "2026-06-17T16:33:09.548Z",
      value: 71604.7,
      staleSince: "2026-09-30T09:15:00.000Z",
    });
    assert.equal(supplierHasStaleCopy(po), true);
  });

  await t.test("stale with no record of what the copy said — null, never a guess", () => {
    // The backfill's case: amended before the app recorded issue values, so
    // the figure they are working to genuinely isn't known. The UI has to say
    // that rather than print the order's current total as though it were sent.
    const state = supplierCopyState({
      supplier_copy_issued_at: "2026-06-17T16:33:09.548Z",
      supplier_copy_value: null,
      supplier_copy_stale_since: "2026-07-21T13:30:19.339Z",
    });
    assert.equal(state.state, "stale");
    assert.equal(state.state === "stale" ? state.value : "unread", null);
  });

  await t.test("a stale order ALSO reads as approved-but-not-issued, so stale has to win", () => {
    // Both are true of the same row, and only one of them says a supplier is
    // acting on the wrong figures. Every caller checks stale first.
    const amended = {
      status: "approved",
      issued_at: null,
      supplier_copy_issued_at: "2026-06-17T16:33:09.548Z",
      supplier_copy_stale_since: "2026-09-30T09:15:00.000Z",
    };
    assert.equal(isApprovedNotIssued(amended), true);
    assert.equal(supplierHasStaleCopy(amended), true);
  });

  await t.test("re-issuing clears it — the columns are the supplier's copy, not our history", () => {
    // What /issue writes: a fresh date and value, stale back to null.
    assert.equal(
      supplierHasStaleCopy({
        supplier_copy_issued_at: "2026-09-30T11:00:00.000Z",
        supplier_copy_value: 73120.4,
        supplier_copy_stale_since: null,
      }),
      false,
    );
  });
});
