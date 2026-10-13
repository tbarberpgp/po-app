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

// One pot, like prelims: a section past its own line is listed, but while the
// labour budget as a whole has room it is covered, not a loss.
test("a section over its own line is covered while the labour budget has room", () => {
  const o = labourOutturn([
    row({ section: "Roof", labour_total: 10_000, boq_expended: 11_000 }),
    row({ section: "Walls", labour_total: 10_000, boq_expended: 2_000 }),
  ], 0);
  assert.equal(o.overrun, 0);
  assert.equal(o.overBudget, 1_000);
  assert.equal(o.absorbed, 1_000);
  assert.deepEqual(o.lines.map((l) => l.section), ["Roof"], "still listed");
});

test("once the labour budget as a whole is spent, only the excess is carried", () => {
  const o = labourOutturn([
    row({ section: "Roof", labour_total: 10_000, boq_expended: 15_000 }),
    row({ section: "Walls", labour_total: 10_000, boq_expended: 8_000 }),
    row({ section: "Expenses", other_expended: 500 }),
  ], 0);
  assert.equal(o.overrun, 3_500, "£23,500 spent against £20,000");
  assert.equal(o.absorbed, 2_000, "£5,500 past the lines, £2,000 of it covered by Walls");
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

// Blyth 2026-10-13: Garbutt's INV-001 laptop (£366.58, paid) put the labour
// lever at −£366.58 with tens of thousands of labour budget unspent.
test("expenses and daywork with no line of their own are covered while the budget has room", () => {
  const o = labourOutturn([
    row({ section: "Expenses", other_expended: 366.58 }),
    row({ section: "Roof", labour_total: 92_062.45, boq_expended: 49_826.80 }),
  ], 0);
  assert.equal(o.unbudgeted, 366.58);
  assert.equal(o.absorbed, 366.58);
  assert.equal(o.overrun, 0);
});

test("expenses and daywork with no budget left to cover them are carried in full", () => {
  const o = labourOutturn([
    row({ section: "Expenses", other_expended: 1_389.18 }),
    row({ section: "Roof", labour_total: 5_000, boq_expended: 5_000, other_expended: 250 }),
  ], 0);
  assert.equal(o.unbudgeted, 1_639.18);
  assert.equal(o.absorbed, 0);
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

test("the overrun lines less what the budget covers add up to the overrun", () => {
  const o = labourOutturn([
    row({ section: "Roof", labour_total: 10_000, boq_expended: 12_000 }),
    row({ section: "Walls", labour_total: 1_000, boq_expended: 800 }),
    row({ section: "Expenses", other_expended: 300 }),
    row({ section: "Variations", variation_expended: 900 }),
  ], 400);
  assert.equal(o.lines.reduce((s, l) => s + l.over, 0) - o.absorbed, o.overrun);
  assert.equal(o.overrun, 2_000 + 300 - 200 + 500);
  assert.deepEqual(o.lines.map((l) => l.section), ["Roof", "Variations", "Expenses"], "largest first");
});

test("a row from an older response reads as nothing certified", () => {
  const o = labourOutturn([{ section: "Roof", labour_total: 5_000 }], 0);
  assert.equal(o.overrun, 0);
  assert.equal(o.certified, 0);
  assert.equal(o.budget, 5_000);
});
