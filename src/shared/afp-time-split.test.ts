import { test } from "node:test";
import assert from "node:assert/strict";
import { planTimeSplit, scaleSplit, dayworksTotal, type TimeSplitLine } from "./afp-time-split";

// Shaped on Cladders Invoice 002 (Blyth afp 53): 268.8 hrs, £9,676.80, one
// Dayworks line, and the labour BOQ seeded on the application at £0.
const boq = (id: number, description: string, contract_value: number, cumulative_value = 0): TimeSplitLine => ({
  id, is_adhoc: 0, section: "Removal of Flashings", description, contract_item_id: id + 467,
  variation_id: null, contract_value, cumulative_value, display_order: id - 1394,
});
const daywork = (id: number, value: number, display_order: number): TimeSplitLine => ({
  id, is_adhoc: 1, section: "Dayworks", description: "Invoice 002", contract_item_id: null,
  variation_id: null, contract_value: value, cumulative_value: value, display_order,
});
const lines = [boq(1398, "Cladding Removal of Flashings", 5940), boq(1400, "Removal of Downpipes", 5940), daywork(2846, 9676.8, 14)];
const period = { claim_basis: "period", prelim_heading: null, claimed_amount: null, this_period_net: 9676.8 };

test("placing all the time moves it off Dayworks and keeps the value", () => {
  const p = planTimeSplit(period, lines, [{ line_id: 1398, amount: 5112 }, { line_id: 1400, amount: 4564.8 }]);
  assert.ok(p.ok);
  assert.equal(p.moved, 9676.8);
  assert.equal(p.left_in_dayworks, 0);
  assert.deepEqual(p.boq.map((b) => [b.line_id, b.after]), [[1398, 5112], [1400, 4564.8]]);
  assert.equal(Math.round(p.boq[0].percent * 100) / 100, 86.06);
  assert.deepEqual(p.dayworks, [{ line_id: 2846, before: 9676.8, after: 0 }]);
});

test("a partial split leaves the rest in Dayworks", () => {
  const p = planTimeSplit(period, lines, [{ line_id: 1398, amount: 3000 }]);
  assert.ok(p.ok);
  assert.equal(p.left_in_dayworks, 6676.8);
  assert.deepEqual(p.dayworks, [{ line_id: 2846, before: 9676.8, after: 6676.8 }]);
});

test("several Dayworks lines are drawn down in order", () => {
  // Cladders #7: the Mon–Fri claim and a Saturday overtime line.
  const two = [boq(1398, "Cladding Removal of Flashings", 5940), daywork(10, 4680, 14), daywork(11, 648, 15)];
  const p = planTimeSplit({ ...period, this_period_net: 5328 }, two, [{ line_id: 1398, amount: 5000 }]);
  assert.ok(p.ok);
  assert.deepEqual(p.dayworks, [{ line_id: 10, before: 4680, after: 0 }, { line_id: 11, before: 648, after: 328 }]);
});

test("adds to a BOQ line that already carries value", () => {
  const p = planTimeSplit({ ...period, this_period_net: 1500 }, [boq(1398, "Cladding Removal of Flashings", 5940, 1000), daywork(2846, 500, 14)],
    [{ line_id: 1398, amount: 500 }]);
  assert.ok(p.ok);
  assert.equal(p.boq[0].after, 1500);
});

test("refuses more than the time claimed", () => {
  const p = planTimeSplit(period, lines, [{ line_id: 1398, amount: 9000 }, { line_id: 1400, amount: 1000 }]);
  assert.equal(p.ok, false);
});

test("refuses a running-total claim and a prelims drawdown", () => {
  assert.equal(planTimeSplit({ ...period, claim_basis: "cumulative" }, lines, [{ line_id: 1398, amount: 1 }]).ok, false);
  assert.equal(planTimeSplit({ ...period, claim_basis: null }, lines, [{ line_id: 1398, amount: 1 }]).ok, false);
  assert.equal(planTimeSplit({ ...period, prelim_heading: "PM", claimed_amount: 3300 }, lines, [{ line_id: 1398, amount: 1 }]).ok, false);
});

test("refuses ad-hoc lines, variations, unknown lines, duplicates and non-positive amounts", () => {
  const variation: TimeSplitLine = { ...boq(1500, "Var 1", 1000), variation_id: 7 };
  const withVar = [...lines, variation];
  assert.equal(planTimeSplit(period, withVar, [{ line_id: 2846, amount: 1 }]).ok, false);
  assert.equal(planTimeSplit(period, withVar, [{ line_id: 1500, amount: 1 }]).ok, false);
  assert.equal(planTimeSplit(period, withVar, [{ line_id: 999, amount: 1 }]).ok, false);
  assert.equal(planTimeSplit(period, withVar, [{ line_id: 1398, amount: 1 }, { line_id: 1398, amount: 1 }]).ok, false);
  assert.equal(planTimeSplit(period, withVar, [{ line_id: 1398, amount: 0 }]).ok, false);
  assert.equal(planTimeSplit(period, withVar, [{ line_id: 1398, amount: -5 }]).ok, false);
});

test("refuses when the submitted figure no longer matches the lines", () => {
  const p = planTimeSplit({ ...period, this_period_net: 7480.8 }, lines, [{ line_id: 1398, amount: 1 }]);
  assert.equal(p.ok, false);
});

test("dayworksTotal counts only Dayworks lines", () => {
  const expense: TimeSplitLine = { ...daywork(3000, 57.86, 16), section: "Expenses" };
  assert.equal(dayworksTotal([...lines, expense]), 9676.8);
});

test("scaleSplit repeats an earlier split in proportion, to the penny", () => {
  // Invoice 002's split applied to Invoice 012 (£9,504).
  const parts = scaleSplit(
    [{ contract_item_id: 1865, value: 5112 }, { contract_item_id: 1867, value: 4564.8 }],
    new Map([[1865, 3398], [1867, 3400]]),
    9504,
  );
  assert.equal(parts.length, 2);
  assert.equal(Math.round(parts.reduce((s, p) => s + p.amount, 0) * 100) / 100, 9504);
  assert.equal(parts[0].line_id, 3398);
  assert.equal(parts[0].amount, 5020.71); // 5112 / 9676.80 × 9504
});

test("scaleSplit skips items this application doesn't carry", () => {
  const parts = scaleSplit([{ contract_item_id: 1, value: 100 }, { contract_item_id: 2, value: 100 }], new Map([[1, 10]]), 50);
  assert.deepEqual(parts, [{ line_id: 10, amount: 50 }]);
  assert.deepEqual(scaleSplit([], new Map(), 50), []);
});
