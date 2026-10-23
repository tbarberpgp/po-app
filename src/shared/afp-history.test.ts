import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAfpHistory, isFastTracked, type AfpHistoryRow } from "./afp-history";

const blank: AfpHistoryRow = {
  submitted_at: null, submitted_by: null, certified_at: null, certified_by: null, certified_amount: null,
  pay_released_at: null, pay_released_by: null, xero_po_id: null, xero_po_number: null,
  xero_sync_status: null, xero_synced_at: null, paid_at: null, paid_by: null,
};

test("a fast-tracked certificate says so, with who did each step, in order", () => {
  const h = buildAfpHistory({
    ...blank,
    submitted_at: "2026-10-20T09:00:00Z", submitted_by: "email:subbie@example.com",
    certified_at: "2026-10-23T14:30:00Z", certified_by: "nsantosa@powergridprojects.net", certified_amount: 1234.5,
    pay_released_at: "2026-10-23T14:30:00Z", pay_released_by: "nsantosa@powergridprojects.net",
    xero_po_id: "B1", xero_sync_status: "synced", xero_synced_at: "2026-10-23T14:30:01Z",
  }, [
    { action: "fast_track_certified", actor: "nsantosa@powergridprojects.net", details: null, created_at: "2026-10-23T14:30:00Z" },
    { action: "pushed_to_xero", actor: "nsantosa@powergridprojects.net", details: null, created_at: "2026-10-23T14:30:01Z" },
  ]);
  assert.deepEqual(h.map((e) => e.what), ["Submitted", "Fast-track certified", "Approved (fast-track)", "Pushed to Xero"]);
  assert.equal(h[1].by, "nsantosa@powergridprojects.net");
  assert.equal(h[1].detail, "£1,234.50");
});

test("an ordinary certificate reads Certified, and an old push with no audit row still shows", () => {
  const h = buildAfpHistory({
    ...blank, certified_at: "2026-10-01T10:00:00Z", certified_by: "qs@x", xero_po_id: "B2",
    xero_synced_at: "2026-10-02T10:00:00Z", xero_po_number: "INV-9",
  }, []);
  assert.deepEqual(h.map((e) => e.what), ["Certified", "Pushed to Xero"]);
  assert.equal(h[1].detail, "bill INV-9");
});

test("the first fast-track version counts as fast-tracked too", () => {
  assert.equal(isFastTracked([{ action: "fast_track_pushed", actor: "a", details: null, created_at: "x" }]), true);
  assert.equal(isFastTracked([{ action: "uncertified", actor: "a", details: null, created_at: "x" }]), false);
});
