import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryVariance, matchItemToLine } from "./delivery-variance";

const FIXFAST_LINE = { id: 1, item: "DF3-5.5 × 45m", qty: 50, unit: "ea" };

// The ticket that started this: DN 704875, PO number read correctly, badge said
// "Matched", and 5,000 fasteners arrived against an order for 50.
test("flags the Fixfast 100x delivery the PO-number match passed", () => {
  const r = deliveryVariance(
    [{ description: "Carbon steel light-section mainfix fastener (DF3-5.5 × 45)", qty: 5000, unit: "ea" }],
    [FIXFAST_LINE], [], "PO-26003-0038",
  );
  assert.equal(r.ok, false);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].kind, "over");
  assert.equal(r.issues[0].ordered, 50);
  assert.equal(r.issues[0].ticket_qty, 5000);
  assert.equal(r.issues[0].factor, 100);
  assert.match(r.issues[0].headline, /exactly 100x/);
});

test("a clean multiple is named as a possible pack size, not asserted as one", () => {
  const r = deliveryVariance([{ description: "DF3-5.5 × 45", qty: 500, unit: "ea" }], [FIXFAST_LINE], [], "PO-1");
  assert.equal(r.issues[0].factor, 10);
  assert.match(r.issues[0].headline, /may be priced per pack/);
});

test("an untidy over-delivery reports the numbers without a pack story", () => {
  const r = deliveryVariance([{ description: "DF3-5.5 × 45", qty: 63, unit: "ea" }], [FIXFAST_LINE]);
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].factor, null);
  assert.doesNotMatch(r.issues[0].headline, /pack/);
});

// Everything below is the quiet half: the cases that must NOT flag, because a
// warning that fires on normal deliveries is one nobody will read by week two.
test("exact delivery is silent", () => {
  const r = deliveryVariance([{ description: "DF3-5.5 × 45", qty: 50, unit: "ea" }], [FIXFAST_LINE]);
  assert.equal(r.ok, true);
  assert.equal(r.checked, true);
  assert.equal(r.issues.length, 0);
});

test("part delivery is silent — that is what part deliveries are", () => {
  const r = deliveryVariance([{ description: "DF3-5.5 × 45", qty: 20, unit: "ea" }], [FIXFAST_LINE]);
  assert.equal(r.ok, true);
});

test("supplier rounding inside 1% is silent", () => {
  const r = deliveryVariance([{ description: "Insulation board", qty: 1004, unit: "m2" }],
    [{ id: 9, item: "Insulation board", qty: 1000, unit: "m2" }]);
  assert.equal(r.ok, true);
});

test("a ticket is never judged against its own receipts", () => {
  // The caller excludes this scan's rows; with them left in, a checked-in
  // ticket sees a fully burnt-down line and flags itself for over-delivering.
  const lines = [{ id: 3, item: "SAVBRF felt", qty: 200, unit: "roll" }];
  const items = [{ description: "SAVBRF felt", qty: 200, unit: "roll" }];
  assert.equal(deliveryVariance(items, lines, []).ok, true);
  assert.equal(deliveryVariance(items, lines, [{ po_line_id: 3, qty: 200 }]).ok, false);
});

test("a top-up drop is judged on what is outstanding, not the whole order", () => {
  const lines = [{ id: 3, item: "SAVBRF Euroroof felt", qty: 200, unit: "roll" }];
  const items = [{ description: "SAVBRF Euroroof felt", qty: 80, unit: "roll" }];
  // 120 already in: 80 more fits inside the outstanding 80 and must stay quiet.
  assert.equal(deliveryVariance(items, lines, [{ po_line_id: 3, qty: 120 }]).ok, true);
  // 160 already in: the same 80 now overshoots by 40 and must speak.
  const over = deliveryVariance(items, lines, [{ po_line_id: 3, qty: 160 }], "PO-2");
  assert.equal(over.ok, false);
  assert.equal(over.issues[0].outstanding, 40);
  assert.match(over.issues[0].headline, /still outstanding/);
});

test("rows landing on one line are summed before comparing", () => {
  // Three pallets of 40 against an order of 50 — each row passes alone, the
  // delivery does not.
  const r = deliveryVariance([
    { description: "SAVBRF Euroroof felt", qty: 40, unit: "roll" },
    { description: "SAVBRF Euroroof felt", qty: 40, unit: "roll" },
    { description: "SAVBRF Euroroof felt", qty: 40, unit: "roll" },
  ], [{ id: 3, item: "SAVBRF Euroroof felt", qty: 50, unit: "roll" }]);
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].ticket_qty, 120);
});

// Wording the matcher cannot tie to a line is NOT reported. Run over the live
// book the first cut raised this on 15 tickets — Knauf, Novia, Screwfix, Fixfast
// — and every one had already been checked in correctly by hand. "Never ordered"
// and "worded differently" are the same observation from here.
test("an item that ties to no line is passed over, not blamed on the supplier", () => {
  const r = deliveryVariance(
    [{ description: "DF3-5.5 × 45", qty: 50, unit: "ea" },
     { description: "MG3BASE primer 25L", qty: 4, unit: "drum" }],
    [FIXFAST_LINE], [], "PO-26003-0038",
  );
  assert.equal(r.ok, true);
  assert.equal(r.issues.length, 0);
});

// The pack-conversion cases from the live book. Each is a correct delivery and
// each flagged before the unit test was added.
test("a clean multiple across DIFFERENT units is a pack conversion, not a variance", () => {
  // PO-26003-0023: ordered 15 of unit "100"; the note reads 1,500 ea.
  assert.equal(deliveryVariance([{ description: "DF3-SS-6.0 x 45 halter fastener", qty: 1500, unit: "ea" }],
    [{ id: 1, item: "DF3-SS-6.0 x 45 A2/304 Stainless halter fastener", qty: 15, unit: "100" }]).ok, true);
  // PO-26001-0013: ordered 1 drum of primer; Alumasc delivered 4 tins.
  assert.equal(deliveryVariance([{ description: "Euroroof SA Primer", qty: 4, unit: "Tins" }],
    [{ id: 2, item: "Euroroof SA Primer - Roller applied", qty: 1, unit: "drum" }]).ok, true);
});

test("an unstated unit is not agreement — it is unknown, so it stays quiet", () => {
  // PO-26003-0014: ordered "1" with no unit, BOC delivered "2 CYL". A second
  // cylinder and a pack of two are indistinguishable from here.
  assert.equal(deliveryVariance([{ description: "CYLINDER PROPANE SIZE D", qty: 2, unit: "CYL" }],
    [{ id: 3, item: "CYLINDER PROPANE SIZE D", qty: 1, unit: "" }]).ok, true);
});

test("the same multiple in the SAME unit still speaks — that is the ambiguous one", () => {
  const r = deliveryVariance([{ description: "DF3-5.5 × 45", qty: 5000, unit: "ea" }], [FIXFAST_LINE]);
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].factor, 100);
});

test("plural and case differences are the same unit, not a pack conversion", () => {
  const r = deliveryVariance([{ description: "SAVBRF felt", qty: 40, unit: "Rolls" }],
    [{ id: 4, item: "SAVBRF felt", qty: 20, unit: "roll" }]);
  assert.equal(r.ok, false);
});

test("an odd over-delivery speaks even when the units disagree", () => {
  // No clean multiple, so there is no pack story to explain it away.
  const r = deliveryVariance([{ description: "SAVBRF felt", qty: 37, unit: "pcs" }],
    [{ id: 4, item: "SAVBRF felt", qty: 20, unit: "roll" }]);
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].factor, null);
});

test("a quantity-less ticket says so instead of passing as agreed", () => {
  const r = deliveryVariance([{ description: "DF3-5.5 × 45", qty: null, unit: null }], [FIXFAST_LINE]);
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].kind, "no_qty");
});

test("nothing to compare reports unchecked, not clean", () => {
  assert.equal(deliveryVariance([], [FIXFAST_LINE]).checked, false);
  assert.equal(deliveryVariance([{ description: "x", qty: 1, unit: null }], []).checked, false);
  // A line with no ordered quantity cannot be judged either.
  assert.equal(deliveryVariance([{ description: "Sundries", qty: 5, unit: "ea" }],
    [{ id: 1, item: "Sundries", qty: null, unit: "ea" }]).checked, false);
});

test("item matching prefers the product code, then wording", () => {
  const lines = [
    { id: 1, item: "DF3-5.5 × 45m", qty: 50, unit: "ea" },
    { id: 2, item: "SAVBRF Euroroof felt", qty: 10, unit: "roll" },
  ];
  assert.equal(matchItemToLine("DF3-5.5 x 45 carbon steel fastener", lines)?.line.id, 1);
  assert.equal(matchItemToLine("SAVBRF", lines)?.line.id, 2);
  assert.equal(matchItemToLine("Pallet deposit", lines), null);
});

// Regression: the wording that made this whole check necessary. The reader
// concatenates the ticket's stock-code and description columns, so the code
// lands at the END — "Carbon steel light-section mainfix fastener (DF3-5.5 x
// 45)". Matching only the leading token ("Carbon") missed the line, and the
// delivery was reported as goods that were not on the order.
test("finds the PO line when the stock code is buried mid-wording", () => {
  const lines = [{ id: 1, item: "DF3-5.5 × 45m", qty: 50, unit: "ea" }];
  const m = matchItemToLine("Carbon steel light-section mainfix fastener (DF3-5.5 × 45)", lines);
  assert.equal(m?.line.id, 1);
});

test("a buried code still will not match a different product", () => {
  const lines = [{ id: 1, item: "MG3BASE primer", qty: 4, unit: "drum" }];
  assert.equal(matchItemToLine("Carbon steel fastener (DF3-5.5 × 45)", lines), null);
});
