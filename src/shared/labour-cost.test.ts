import { test } from "node:test";
import assert from "node:assert/strict";
import { labourOutturn, type LabourPositionRow } from "./labour-cost";

const row = (o: Partial<LabourPositionRow> & { section: string }): LabourPositionRow =>
  ({ labour_total: 0, saving: 0, boq_expended: 0, variation_expended: 0, other_expended: 0, ...o });

test("certified labour inside its budget adds nothing to forecast cost", () => {
  const o = labourOutturn([row({ section: "Roof", labour_total: 10_000, boq_expended: 6_000 })], 0);
  assert.equal(o.overrun, 0);
  assert.equal(o.certified, 6_000);
  assert.equal(o.budget, 10_000);
  assert.deepEqual(o.lines, []);
});

test("labour certified past its section's budget is carried pound for pound", () => {
  const o = labourOutturn([row({ section: "Roof", labour_total: 10_000, boq_expended: 12_500 })], 0);
  assert.equal(o.overBudget, 2_500);
  assert.equal(o.overrun, 2_500);
  assert.deepEqual(o.lines, [{ section: "Roof", kind: "over_budget", budget: 10_000, certified: 12_500, over: 2_500 }]);
});

// Per section, as the Labour subtab shows it: the walls being cheap doesn't
// mean the roof isn't over.
test("an underspend in one section doesn't hide an overrun in another", () => {
  const o = labourOutturn([
    row({ section: "Roof", labour_total: 10_000, boq_expended: 11_000 }),
    row({ section: "Walls", labour_total: 10_000, boq_expended: 2_000 }),
  ], 0);
  assert.equal(o.overrun, 1_000);
});

// The live-rate lever already takes the saving off forecast cost. If the gang
// then certifies back up past the cheaper rate, that saving has been spent —
// measuring against the BOQ would claim it and ignore the spend.
test("a live-rate saving certified work has eaten into isn't counted twice", () => {
  const o = labourOutturn([row({ section: "Roof", labour_total: 10_000, saving: 3_000, boq_expended: 9_000 })], 0);
  assert.equal(o.overBudget, 2_000, "measured against the £7,000 live-rate budget, not the £10,000 BOQ");
});

test("an approved rate increase raises the allowance it's measured against", () => {
  const o = labourOutturn([row({ section: "Roof", labour_total: 10_000, saving: -1_000, boq_expended: 10_800 })], 0);
  assert.equal(o.overrun, 0);
});

test("a saving bigger than the budget leaves an allowance of nothing, not less", () => {
  const o = labourOutturn([row({ section: "Roof", labour_total: 1_000, saving: 1_500, boq_expended: 200 })], 0);
  assert.equal(o.overBudget, 200);
});

// Blyth's Cladders expenses: £1,389.18 of hotels and mileage, certified and
// paid, with no budget line anywhere in the workbook.
test("expenses and daywork have no budget, so all of it is carried", () => {
  const o = labourOutturn([
    row({ section: "Expenses", other_expended: 1_389.18 }),
    row({ section: "Roof", labour_total: 5_000, boq_expended: 1_000, other_expended: 250 }),
  ], 0);
  assert.equal(o.unbudgeted, 1_639.18);
  assert.equal(o.overrun, 1_639.18);
});

test("variation labour inside the variations' budget adds nothing — the budget is already in cost", () => {
  const o = labourOutturn([row({ section: "Variations", variation_expended: 4_000 })], 5_000);
  assert.equal(o.overrun, 0);
  assert.equal(o.certified, 4_000);
});

test("variation labour past the variations' budget carries only the excess", () => {
  const o = labourOutturn([row({ section: "Variations", variation_expended: 6_500 })], 5_000);
  assert.equal(o.variationsOver, 1_500);
  assert.deepEqual(o.lines, [{ section: "Variations", kind: "variations", budget: 5_000, certified: 6_500, over: 1_500 }]);
});

test("the overrun lines add up to the overrun", () => {
  const o = labourOutturn([
    row({ section: "Roof", labour_total: 10_000, boq_expended: 12_000 }),
    row({ section: "Expenses", other_expended: 300 }),
    row({ section: "Variations", variation_expended: 900 }),
  ], 400);
  assert.equal(o.lines.reduce((s, l) => s + l.over, 0), o.overrun);
  assert.equal(o.overrun, 2_000 + 300 + 500);
  assert.deepEqual(o.lines.map((l) => l.section), ["Roof", "Variations", "Expenses"], "largest first");
});

test("a row from an older response reads as nothing certified", () => {
  const o = labourOutturn([{ section: "Roof", labour_total: 5_000 }], 0);
  assert.equal(o.overrun, 0);
  assert.equal(o.certified, 0);
  assert.equal(o.budget, 5_000);
});
