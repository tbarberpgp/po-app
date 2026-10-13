// Tests for approving a purchase order that was already rejected.
//
//   npm test
//
// The case: a director rejects a PO, then changes their mind. A rejection used
// to be terminal — /approve and /reject both demanded 'pending_approval', and
// amending a rejected order preserves its status — so the order was stuck and
// the only way forward was to raise it again from scratch under a new number.
// Amending a rejected order still preserves its status, deliberately: see
// pos.amend-reapproval.test.ts, which covers the statuses that now don't.
//
// What matters is that opening 'rejected' back up doesn't open anything else:
// an issued PO must not be re-approved (it has already gone to the supplier),
// an approved one must not be approved twice (it would re-push to Xero), and a
// deleted one must stay dead.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { approveGate, mayDecide, unapproveGate } from "./pos";

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

describe("unapproveGate", () => {
  test("an approved PO can be unapproved", () => {
    assert.deepEqual(unapproveGate("approved"), { ok: true });
  });

  test("an issued PO is refused and pointed at amending", () => {
    const gate = unapproveGate("issued");
    assert.equal(gate.ok, false);
    assert.match(gate.ok === false ? gate.error : "", /amend/);
  });

  test("nothing else can be unapproved", () => {
    for (const status of ["draft", "pending_approval", "rejected", "deleted"]) {
      assert.equal(unapproveGate(status).ok, false, `${status} must not be unapprovable`);
    }
  });
});

// Who may approve, reject or unapprove. The case that prompted this: a
// director with all three tiers was told "you are not an approver for this
// tier" when rejecting — /reject compared against "" on a PO with no tier,
// while /approve already let any approver through.
describe("mayDecide", () => {
  test("a director can decide a PO at any tier, and one with no tier", () => {
    for (const tier of ["line_manager", "commercial_manager", "director", null]) {
      assert.equal(mayDecide(["director"], tier), true, `director must decide ${tier}`);
    }
  });

  test("anyone else needs the PO's own tier", () => {
    assert.equal(mayDecide(["line_manager"], "line_manager"), true);
    assert.equal(mayDecide(["line_manager"], "commercial_manager"), false);
    assert.equal(mayDecide(["commercial_manager"], "director"), false);
  });

  test("a PO with no tier is open to any approver", () => {
    assert.equal(mayDecide(["line_manager"], null), true);
  });

  test("someone with no approver row decides nothing", () => {
    assert.equal(mayDecide([], null), false);
    assert.equal(mayDecide([], "line_manager"), false);
  });
});
