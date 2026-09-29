// Tests for what amending a purchase order costs it.
//
//   npm test
//
// The case: an order is approved, and someone with `pos.edit` then changes it.
// The edit handler used to preserve the workflow status, so the order stayed
// approved at whatever the new supplier, quantity and price happened to be —
// no email, no queue, nothing but an audit row. 22 production orders were
// amended after approval that way, six of them on an order already issued.
//
// What matters is that sending the decided states back doesn't disturb the
// undecided ones: an order already in the queue must not be bounced around it,
// and a rejected one must stay rejected or approveGate can no longer be used
// to overturn a rejection.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { amendSendsBackForApproval, approveGate } from "./pos";

describe("amendSendsBackForApproval", () => {
  test("an approved PO goes back — the signature was for what it used to say", () => {
    assert.equal(amendSendsBackForApproval("approved"), true);
  });

  test("an issued PO goes back too, and will need re-issuing after", () => {
    assert.equal(amendSendsBackForApproval("issued"), true);
    // Not a separate branch in the handler, but the reason it matters: the
    // supplier is holding the version from before the amendment, and only
    // /issue sends them another one.
    assert.equal(approveGate("issued").ok, false);
  });

  test("an order already in the queue is left where it is", () => {
    assert.equal(amendSendsBackForApproval("pending_approval"), false);
  });

  test("a rejected order stays rejected, so the reversal path still works", () => {
    assert.equal(amendSendsBackForApproval("rejected"), false);
    // The whole point of leaving it alone: approveGate reads the status to
    // decide whether approving now overturns a rejection.
    assert.deepEqual(approveGate("rejected"), { ok: true, reversal: true });
  });

  test("a draft has never been signed off, so there is nothing to send back", () => {
    assert.equal(amendSendsBackForApproval("draft"), false);
  });

  test("anything sent back is a status approveGate will then accept", () => {
    // Otherwise an amendment would park the order in a state nobody can clear.
    for (const status of ["approved", "issued"]) {
      assert.equal(amendSendsBackForApproval(status), true, status);
    }
    assert.deepEqual(approveGate("pending_approval"), { ok: true, reversal: false });
  });
});
