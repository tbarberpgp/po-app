// Delivery arrival tracking — which emails are read as order acknowledgements,
// which dates count as a promise, and how open orders sort into the tracker.
//
//   npm test
//
// Cases are the real ones from the accounts@ / projects@ mail seen in Nov 2026:
// Alumasc SOR465143 (PO-26001-0100, promised 05 Nov against our 29 Oct, £115
// carriage, still awaiting approval), Fixfast 713963 (PO-26001-0093, no
// required-by), and Barwell, who never send an acknowledgement at all.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ackChecks, bucketArrivals, isPlaceholderPromise, looksLikeOrderAck, type ArrivalRow } from "./order-acks";

describe("looksLikeOrderAck — the same net as the Outlook rule", () => {
  for (const subject of [
    "SOR465143/ Order Acknowledgment",
    "SOR464371/SP151122-PO-26003-0041",
    "26001 -Fw: Fixfast Acknowledgement PO-26001-0093 (713963)",
    "26004 Fw: Your Eurocell order confirmation",
    "26001 Fw: Your Fixfast order will be delivered today between 09:27 - 10:27",
  ]) test(`reads: ${subject}`, () => assert.equal(looksLikeOrderAck(subject), true));

  for (const subject of [
    "Invoice SI559358 — SOR465143",            // invoices have their own pipeline
    "26001 Re: Materials for blocks D-C-B",
    "Sorry for the delay",                      // "SOR" inside a word
    "26004 - Quote for Blyth please // 167671 POW019",
  ]) test(`ignores: ${subject}`, () => assert.equal(looksLikeOrderAck(subject), false));

  test("a body that says the delivery is arranged counts when the subject is about the order", () => {
    assert.equal(looksLikeOrderAck("RE: 26003 Re: PO 26003-0048", "Hi Angela Your delivery has now been arranged for Thursday"), true);
  });
});

describe("isPlaceholderPromise — Alumasc's ERP fills 24/12 and 29/12 when it has no date", () => {
  test("Alumasc 24/12 and 29/12 are placeholders", () => {
    assert.equal(isPlaceholderPromise("Alumasc Building Products", "2026-12-24"), true);
    assert.equal(isPlaceholderPromise("Alumasc Water Management Solutions", "2026-12-29"), true);
  });
  test("a real Alumasc date, and anyone else's 24 Dec, stand", () => {
    assert.equal(isPlaceholderPromise("Alumasc Building Products", "2026-11-05"), false);
    assert.equal(isPlaceholderPromise("Fixfast Ltd", "2026-12-24"), false);
  });
});

const row = (o: Partial<ArrivalRow>): ArrivalRow => ({
  id: o.po_number ?? "x", po_number: "PO-26001-0000", supplier: "Supplier", project_id: "p", project_code: "26001",
  status: "approved", total_value: 100, created_at: "2026-11-01T09:00:00Z",
  required_date: null, promised_date: null, promised_source: null, promised_ref: null, promised_note: null,
  collect_by_us: 0, collector: null, ...o,
});

describe("bucketArrivals", () => {
  const today = "2026-11-06";
  const rows = [
    // Alumasc: promised yesterday (later than our 29 Oct) — overdue on the PROMISED date.
    row({ po_number: "PO-26001-0100", supplier: "Alumasc", status: "pending_approval", required_date: "2026-10-29", promised_date: "2026-11-05", promised_source: "sor_folder", promised_ref: "SOR465143" }),
    // Our date only, due Monday — this week, and the supplier hasn't confirmed.
    row({ po_number: "PO-26001-0118", supplier: "Fixfast Ltd", required_date: "2026-11-11" }),
    // Barwell, no date at all — only "No confirmation".
    row({ po_number: "PO-26001-0104", supplier: "Barwell Spares & Service Ltd", created_at: "2026-11-05T10:00:00Z" }),
    // Phoned in for today.
    row({ po_number: "PO-26008-0015", supplier: "Skyline", promised_date: "2026-11-06", promised_source: "manual" }),
    // We collect — never in the delivery lists.
    row({ po_number: "PO-26008-0014", supplier: "Toolstation", required_date: "2026-11-01", collect_by_us: 1 }),
    // Raised months ago with nothing received and no date: not "waiting to hear".
    row({ po_number: "PO-26003-0001", supplier: "Old Co", created_at: "2026-07-01T09:00:00Z" }),
    // Still awaiting approval: can't chase a confirmation for it.
    row({ po_number: "PO-26004-0020", supplier: "Braddan", status: "pending_approval" }),
  ];
  const b = bucketArrivals(rows, today);
  const nums = (rs: ArrivalRow[]) => rs.map((r) => r.po_number);

  test("the promised date wins over ours", () => assert.deepEqual(nums(b.overdue), ["PO-26001-0100"]));
  test("due today includes phoned-in dates", () => assert.deepEqual(nums(b.today), ["PO-26008-0015"]));
  test("this week falls back to our required-by", () => assert.deepEqual(nums(b.week), ["PO-26001-0118"]));
  test("collections only ever sit in To collect", () => assert.deepEqual(nums(b.collect), ["PO-26008-0014"]));
  test("no confirmation = sent recently, no supplier date — oldest first", () => {
    assert.deepEqual(nums(b.unconfirmed), ["PO-26001-0118", "PO-26001-0104"]);
  });
});

describe("ackChecks", () => {
  test("Alumasc SOR465143 against PO-26001-0100", () => {
    const checks = ackChecks(
      { promised_date: "2026-11-05", goods_total: 1315.4, carriage: 115, total_ex_vat: 1430.4, matched_by: "po_number" },
      { status: "pending_approval", delivery_date: "2026-10-29", total_value: 1315.4 },
    );
    const text = checks.map((c) => `${c.tone}:${c.text}`).join("\n");
    assert.match(text, /ok:Our PO number is printed/);
    assert.match(text, /warn:Promised 05 Nov — 7 days after our required-by of 29 Oct/);
    assert.match(text, /warn:.*still awaiting approval/);
    assert.match(text, /warn:Carriage £115\.00/);
    assert.match(text, /ok:Goods total agrees with the PO \(£1,315\.40\)/);
  });
  test("Fixfast 713963 — priced under the PO, and the PO had no date", () => {
    const checks = ackChecks(
      { promised_date: "2026-10-28", goods_total: 1117.92, carriage: 0, total_ex_vat: 1117.92 },
      { status: "approved", delivery_date: null, total_value: 1447.8 },
    );
    const text = checks.map((c) => c.text).join("\n");
    assert.match(text, /had no required-by date/);
    assert.match(text, /£1,117\.92 against £1,447\.80 on the PO \(−£329\.88\)/);
  });
});
