// Tests for when an order can be recorded as issued to the supplier.
//
//   npm test
//
// /issue sends nothing. The PO PDF is built in the browser and emailed by a
// person; this endpoint is them recording that they did it, and the moment the
// app learns what the supplier is now holding.
//
// The case that forced a gate: five orders were amended after being issued,
// back when amending preserved the status. They sat as 'issued' with a
// superseded copy out in the world — so migration 0127 flags them, and without
// 'issued' being issuable the app would show "the supplier has an older
// version" on each one with no control anywhere that could clear it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { issueGate, amendSendsBackForApproval } from "./pos";

describe("issueGate", () => {
  test("approved is the normal path", () => {
    assert.deepEqual(issueGate("approved", false), { ok: true });
  });

  test("approved with a stale copy too — the amend, re-approve, re-send route", () => {
    assert.deepEqual(issueGate("approved", true), { ok: true });
  });

  test("issued with a stale copy can be re-sent: the pre-0127 orders", () => {
    assert.deepEqual(issueGate("issued", true), { ok: true });
  });

  test("issued with the current copy out is refused, and says why", () => {
    const gate = issueGate("issued", false);
    assert.equal(gate.ok, false);
    assert.equal(gate.ok === false ? gate.error : "", "this PO has already been issued");
  });

  test("nothing unapproved can be issued, stale copy or not", () => {
    for (const status of ["draft", "pending_approval", "rejected", "deleted"]) {
      for (const stale of [true, false]) {
        const gate = issueGate(status, stale);
        assert.equal(gate.ok, false, `${status} (stale=${stale}) must not be issuable`);
        assert.equal(
          gate.ok === false ? gate.error : "",
          `cannot issue a ${status} PO`,
        );
      }
    }
  });

  test("the stale-and-issued opening can't be reached by amending", () => {
    // Which is what keeps it from being a way round approval: amending an
    // issued order moves it off 'issued' in the same statement that marks the
    // supplier's copy stale.
    assert.equal(amendSendsBackForApproval("issued"), true);
    assert.equal(issueGate("pending_approval", true).ok, false);
  });
});
