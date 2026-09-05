// Tests for the two-stage invoice release.
//
//   npm test
//
// The cases that matter are the ones that would quietly re-open the gate this
// module exists to close: an invoice that is approved reading as releasable
// (it is) versus reading as pushable (it isn't, not until someone signs it
// off), and the overhead path, which has no approval stage to satisfy and so
// would be stranded forever by a naive `!approved_at` refusal.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isCertAwaitingApproval,
  isCertInXero,
  isCertReadyToPush,
  isCertReleased,
  isAwaitingApproval,
  isReadyToPush,
  isInXero,
  isReleased,
  needsApprovalBeforeRelease,
  readyForRelease,
  type ReleasableInvoice,
  type ReleasableLabourCert,
} from "./payment-release";

const project = (o: Partial<ReleasableInvoice> = {}): ReleasableInvoice =>
  ({ kind: "project", status: "ready", ...o });
const overhead = (o: Partial<ReleasableInvoice> = {}): ReleasableInvoice =>
  ({ kind: "overhead", status: "ready", ...o });

describe("isAwaitingApproval", () => {
  test("an approved project invoice is held — approval is not the release", () => {
    assert.equal(isAwaitingApproval(project({ approved_at: "2026-09-01T10:00:00Z" })), true);
  });

  test("an unapproved project invoice is not held — it isn't waiting on the signer", () => {
    assert.equal(isAwaitingApproval(project()), false);
  });

  test("a signed-off invoice is no longer held", () => {
    assert.equal(isAwaitingApproval(project({
      approved_at: "2026-09-01T10:00:00Z",
      released_at: "2026-09-02T09:00:00Z",
    })), false);
  });

  test("an invoice already in Xero is past the gate, however it got there", () => {
    // 46 of the book's pushed rows never carried an approval — they predate
    // the approve-for-payment gate. None of them is waiting on a sign-off.
    assert.equal(isAwaitingApproval(project({ status: "pushed" })), false);
    assert.equal(isAwaitingApproval(project({ approved_at: "x", status: "pushed" })), false);
    assert.equal(isAwaitingApproval(project({ approved_at: "x", xero_bill_id: "abc" })), false);
  });

  test("a coded overhead is held on its nominal, having no approval to carry", () => {
    assert.equal(isAwaitingApproval(overhead({ nominal_code: "6100" })), true);
  });

  test("an uncoded overhead is not held — the coding is still someone's job", () => {
    assert.equal(isAwaitingApproval(overhead()), false);
    assert.equal(isAwaitingApproval(overhead({ nominal_code: "   " })), false);
  });
});

describe("needsApprovalBeforeRelease", () => {
  test("project invoices must be approved first; overheads have no such stage", () => {
    assert.equal(needsApprovalBeforeRelease(project()), true);
    assert.equal(needsApprovalBeforeRelease(overhead()), false);
  });

  test("an unrouted invoice is treated as needing approval, not as an overhead", () => {
    // kind is null until someone routes it. Defaulting to the overhead path
    // would let an unrouted invoice be signed off with no approval at all.
    assert.equal(needsApprovalBeforeRelease({ kind: null }), true);
    assert.equal(needsApprovalBeforeRelease({}), true);
  });
});

describe("readyForRelease", () => {
  test("tracks the stage that precedes sign-off for each kind", () => {
    assert.equal(readyForRelease(project()), false);
    assert.equal(readyForRelease(project({ approved_at: "2026-09-01" })), true);
    assert.equal(readyForRelease(overhead()), false);
    assert.equal(readyForRelease(overhead({ nominal_code: "6100" })), true);
  });

  test("an approved overhead with no nominal is still not ready", () => {
    // The nominal is what the bill codes to; an approval can't substitute.
    assert.equal(readyForRelease(overhead({ approved_at: "2026-09-01" })), false);
  });
});

describe("isReleased / isInXero", () => {
  test("release is recorded independently of the push it triggers", () => {
    // A Xero failure never rolls back the sign-off, so released-but-not-pushed
    // is a real state — it's what the Retry button acts on.
    const signedOffPushFailed = project({ approved_at: "a", released_at: "b" });
    assert.equal(isReleased(signedOffPushFailed), true);
    assert.equal(isInXero(signedOffPushFailed), false);
    assert.equal(isAwaitingApproval(signedOffPushFailed), false);
  });

  test("either marker means in Xero", () => {
    assert.equal(isInXero(project({ status: "pushed" })), true);
    assert.equal(isInXero(project({ xero_bill_id: "abc" })), true);
    assert.equal(isInXero(project()), false);
  });
});


/* ── Subcontractor labour certificates ─────────────────────────────────── */

const cert = (o: Partial<ReleasableLabourCert> = {}): ReleasableLabourCert =>
  ({ status: "certified", ...o });

describe("isCertAwaitingApproval", () => {
  test("approved for payment but unsigned is held", () => {
    assert.equal(isCertAwaitingApproval(cert({ pay_approved_at: "2026-09-01" })), true);
  });

  test("certified but not yet approved for payment is NOT held", () => {
    // It's still with the people who agree the money — the signer isn't
    // waiting on anything yet.
    assert.equal(isCertAwaitingApproval(cert()), false);
  });

  test("signed off is no longer held", () => {
    assert.equal(isCertAwaitingApproval(cert({ pay_approved_at: "a", pay_released_at: "b" })), false);
  });

  test("a certificate already in Xero is past the gate, by either marker", () => {
    assert.equal(isCertAwaitingApproval(cert({ pay_approved_at: "a", xero_po_id: "X1" })), false);
    assert.equal(isCertAwaitingApproval(cert({ pay_approved_at: "a", xero_sync_status: "synced" })), false);
  });
});

describe("isCertReleased / isCertInXero", () => {
  test("the sign-off survives a failed push, which is what the retry acts on", () => {
    const signedOffPushFailed = cert({
      pay_approved_at: "a", pay_released_at: "b", xero_sync_status: "failed",
    });
    assert.equal(isCertReleased(signedOffPushFailed), true);
    assert.equal(isCertInXero(signedOffPushFailed), false);
    assert.equal(isCertAwaitingApproval(signedOffPushFailed), false);
  });

  test("a failed sync is not in Xero — only an id or a synced status counts", () => {
    assert.equal(isCertInXero(cert({ xero_sync_status: "failed" })), false);
    assert.equal(isCertInXero(cert({ xero_po_id: "X1" })), true);
    assert.equal(isCertInXero(cert({ xero_sync_status: "synced" })), true);
    assert.equal(isCertInXero(cert()), false);
  });
});


/* ── The queues the two dashboards are built from ──────────────────────── */

describe("isReadyToPush / isCertReadyToPush", () => {
  test("approval moves a payable from one queue to the other, not into Xero", () => {
    // The whole point of the split: approving decides, it does not post. A
    // just-approved invoice must leave the approver's queue and appear in
    // Accounts' — if it satisfied both it would be actionable twice, and if it
    // satisfied neither it would vanish between them.
    const committed = project({ approved_at: "2026-09-01" });
    assert.equal(isAwaitingApproval(committed), true);
    assert.equal(isReadyToPush(committed), false);

    const approved = { ...committed, released_at: "2026-09-02" };
    assert.equal(isAwaitingApproval(approved), false);
    assert.equal(isReadyToPush(approved), true);

    const posted = { ...approved, status: "pushed" };
    assert.equal(isAwaitingApproval(posted), false);
    assert.equal(isReadyToPush(posted), false);
  });

  test("a failed push leaves it in Accounts' queue to retry", () => {
    assert.equal(isReadyToPush(project({ approved_at: "a", released_at: "b" })), true);
  });

  test("the two queues never overlap, for either payable", () => {
    const states: ReleasableInvoice[] = [
      project(), project({ approved_at: "a" }), project({ approved_at: "a", released_at: "b" }),
      project({ approved_at: "a", released_at: "b", status: "pushed" }),
      overhead(), overhead({ nominal_code: "6100" }),
      overhead({ nominal_code: "6100", released_at: "b" }),
    ];
    for (const st of states) {
      assert.ok(!(isAwaitingApproval(st) && isReadyToPush(st)),
        `both queues claimed ${JSON.stringify(st)}`);
    }
    const certs: ReleasableLabourCert[] = [
      cert(), cert({ pay_approved_at: "a" }), cert({ pay_approved_at: "a", pay_released_at: "b" }),
      cert({ pay_approved_at: "a", pay_released_at: "b", xero_po_id: "X1" }),
    ];
    for (const st of certs) {
      assert.ok(!(isCertAwaitingApproval(st) && isCertReadyToPush(st)),
        `both queues claimed ${JSON.stringify(st)}`);
    }
  });

  test("an unapproved certificate is in neither queue", () => {
    assert.equal(isCertAwaitingApproval(cert()), false);
    assert.equal(isCertReadyToPush(cert()), false);
  });
});
