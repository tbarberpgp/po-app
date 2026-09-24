import { test } from "node:test";
import assert from "node:assert/strict";
import { isApprovedNotIssued } from "./po-register";

/** Approval commits the money; issuing is what sends the order to the supplier.
 *  Nothing chases the gap between them, so an order can sit consuming budget
 *  the supplier has never been told about — which is what this flags. */
test("approved but never issued", async (t) => {
  await t.test("an approved order with no issue date is flagged", () => {
    assert.equal(isApprovedNotIssued({ status: "approved", issued_at: null }), true);
  });

  await t.test("an approved order that WAS issued is not", () => {
    assert.equal(isApprovedNotIssued({ status: "approved", issued_at: "2026-06-17T16:33:25.634Z" }), false);
  });

  await t.test("a missing issued_at reads the same as an explicit null", () => {
    assert.equal(isApprovedNotIssued({ status: "approved" }), true);
  });

  await t.test("no other status is flagged, issued or not", () => {
    for (const status of ["draft", "pending_approval", "issued", "rejected", "deleted"]) {
      assert.equal(isApprovedNotIssued({ status, issued_at: null }), false, status);
    }
  });

  await t.test("an empty issue date counts as never issued, not as issued", () => {
    assert.equal(isApprovedNotIssued({ status: "approved", issued_at: "" }), true);
  });
});
