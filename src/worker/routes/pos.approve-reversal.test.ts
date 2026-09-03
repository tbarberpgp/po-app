// Tests for approving a purchase order that was already rejected.
//
//   npm test
//
// The case: a director rejects a PO, then changes his mind. A rejection used
// to be terminal — /approve and /reject both demanded 'pending_approval', and
// an amend deliberately preserves workflow status — so the order was stuck and
// the only way forward was to raise it again from scratch under a new number.
//
// What matters is that opening 'rejected' back up doesn't open anything else:
// an issued PO must not be re-approved (it has already gone to the supplier),
// an approved one must not be approved twice (it would re-push to Xero), and a
// deleted one must stay dead.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { approveGate } from "./pos";

describe("approveGate", () => {
  test("a pending PO approves, and isn't a reversal", () => {
    assert.deepEqual(approveGate("pending_approval"), { ok: true, reversal: false });
  });

  test("a rejected PO approves, flagged as a reversal", () => {
    assert.deepEqual(approveGate("rejected"), { ok: true, reversal: true });
  });

  test("every other status is still refused, and says which", () => {
    for (const status of ["draft", "approved", "issued", "deleted"]) {
      const gate = approveGate(status);
      assert.equal(gate.ok, false, `${status} must not be approvable`);
      assert.equal(
        gate.ok === false ? gate.error : "",
        `cannot approve a ${status} PO`,
      );
    }
  });
});
