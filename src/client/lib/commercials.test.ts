import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accumulateMaterials, materialOverspendOf, summariseMaterials, oneScope,
  unexpectedSpendDrill, combinedUnexpectedSpendDrill, withCombinedOverspend,
  computeForecast, contractTotals, totalChange,
  type UnpricedLine, type Forecast,
} from "./commercials";
import type { MaterialWithCommitment, ProjectCommercial } from "../../shared/types";

/** A priced BOQ row — only the fields the commercial maths reads. */
function mat(o: Partial<MaterialWithCommitment> & { item: string; cost: number; total_units: number; committed_qty: number }): MaterialWithCommitment {
  return {
    id: 1, snapshot_id: 1, type: "", element_code: null, manufacturer: null,
    pack_qty: null, pack_unit: null, cost_unit: null, coverage_qty: null, coverage_unit: null,
    waste_pct: null, unit_rate: null, rate_unit: null, total_qty: null, total_qty_unit: null,
    total_units_unit: null, material_total_cost: null, labour_unit_cost: null, labour_total_cost: null,
    remaining_qty: null,
    ...o,
  } as MaterialWithCommitment;
}

const RATE = 13.92;
const MSB36 = "MS-B36 - METShield MS-B36 Bars @ 3.6m Long";
// The live Dallas Rd case: bars over-ordered on block B, under-ordered on C and
// D. Each block is its own contract, so each keeps its own over-run — but the
// site as a whole is £5k inside budget on the material.
const dallas = [
  { scope: "26001", mats: [mat({ item: MSB36, cost: RATE, total_units: 561, committed_qty: 698.22 })] },
  { scope: "26002", mats: [mat({ item: MSB36, cost: RATE, total_units: 535.06, committed_qty: 100 })] },
  { scope: "26003", mats: [mat({ item: MSB36, cost: RATE, total_units: 484.73, committed_qty: 411.06 })] },
];
const OVER_26001 = (698.22 - 561) * RATE;

// ── The netting rule ────────────────────────────────────────────────────────

test("a block's own over-run still counts on its own page", () => {
  assert.ok(Math.abs(materialOverspendOf([dallas[0]]) - OVER_26001) < 0.01);
});

test("an over-run the rest of the site covers is not overspend", () => {
  assert.equal(materialOverspendOf(dallas), 0);
  const [acc] = accumulateMaterials(dallas);
  assert.ok(acc.committed - acc.budget < 0, "the combined position is under budget");
  assert.equal(acc.mats.length, 3, "the three blocks' rows merged into one material");
  assert.deepEqual(acc.scopes, ["26001", "26002", "26003"]);
});

test("the cover only stretches as far as it goes", () => {
  const over = materialOverspendOf([
    { scope: "A", mats: [mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 90 })] },  // −100
    { scope: "B", mats: [mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 130 })] }, // +300
  ]);
  assert.equal(over, 200);
});

test("a material over budget on every block is flagged at the total", () => {
  assert.equal(materialOverspendOf(oneScope([
    mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 150 }),
    mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 120 }),
  ])), 700);
});

test("committed is valued at the live quote, like the Materials tab", () => {
  // 120 bought against 100 budgeted, but at £8 on a £10 budget — under, not over.
  assert.equal(materialOverspendOf(oneScope([
    mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 120, live_unit_price: 8 }),
  ])), 0);
});

test("rows merge on the master product even when the wording differs", () => {
  const acc = accumulateMaterials(oneScope([
    mat({ item: "Pro Drain P-110 SBS", cost: 10, total_units: 10, committed_qty: 40, product_id: 7 }),
    mat({ item: "PRO-DRAIN-P-110-SBS", cost: 10, total_units: 50, committed_qty: 10, product_id: 7 }),
  ]));
  assert.equal(acc.length, 1);
  assert.equal(materialOverspendOf(oneScope(acc[0].mats)), 0);
});

test("an unlinked row joins the linked row of the same wording", () => {
  assert.equal(accumulateMaterials(oneScope([
    mat({ item: "Capping", cost: 10, total_units: 10, committed_qty: 40, product_id: 3 }),
    mat({ item: "capping ", cost: 10, total_units: 50, committed_qty: 10 }),
  ])).length, 1);
});

test("omitted lines are out of the job entirely", () => {
  assert.equal(materialOverspendOf(oneScope([mat({ item: "Top Hat", cost: 10, total_units: 0, committed_qty: 50, omitted: 1 })])), 0);
});

test("a partial omission reduces the budget the over-run is measured against", () => {
  // 100 budgeted, 40 omitted → 60 units of budget; 70 committed → 10 units over.
  assert.equal(materialOverspendOf(oneScope([mat({ item: "Fixings", cost: 10, total_units: 100, omitted_qty: 40, committed_qty: 70 })])), 100);
});

// ── The drills ──────────────────────────────────────────────────────────────

const unpriced: UnpricedLine[] = [
  { po_id: "po1", line_id: 1, po_number: "PO-26001-0013", supplier: "SIG", item: "Single Sided Tape", qty: 1, unit: "ea", line_total: 2674, status: "issued" },
];

test("the drill lists only what the headline figure counts", () => {
  const body = combinedUnexpectedSpendDrill(dallas.map((g, i) => ({ block: g.scope, lines: i === 0 ? unpriced : [], mats: g.mats })));
  assert.equal(body.rows.filter((r) => r.kind === "Over budget").length, 0, "the netted material is gone");
  const shown = body.rows.reduce((s, r) => s + Number(r.amount), 0);
  assert.ok(Math.abs(shown - (2674 + materialOverspendOf(dallas))) < 0.01, `drill ${shown}`);
});

test("a combined over-budget row names the blocks it sits on", () => {
  const over = (qty: number) => [mat({ item: "Butyl Tape", cost: 10, total_units: 10, committed_qty: qty })];
  const both = combinedUnexpectedSpendDrill([
    { block: "26001", lines: [], mats: over(30) },
    { block: "26002", lines: [], mats: over(30) },
  ]);
  const row = both.rows.find((r) => r.kind === "Over budget");
  assert.equal(row?.__block, "All blocks");
  assert.equal(row?.amount, 400);

  const one = combinedUnexpectedSpendDrill([
    { block: "26001", lines: [], mats: over(30) },
    { block: "26002", lines: [], mats: [] },
  ]);
  assert.equal(one.rows.find((r) => r.kind === "Over budget")?.__block, "26001");
});

test("the per-block drill and the per-block summary agree", () => {
  const summary = summariseMaterials(dallas[0].mats, 2674);
  const shown = unexpectedSpendDrill(unpriced, dallas[0].mats).rows.reduce((s, r) => s + Number(r.amount), 0);
  assert.ok(Math.abs(shown - (summary.unpriced_spend + summary.material_overspend)) < 0.01, `drill ${shown}`);
});

// ── Rolling the blocks up ───────────────────────────────────────────────────

test("re-basing the overspend pulls forecast cost, profit and GP% with it", () => {
  // A summed forecast double-counts: 26001's over-run stands even though the
  // site as a whole is under budget on the material.
  const summed: Forecast = {
    hasContract: true, ffa: 1000, ffc: 900, forecastProfit: 100, forecastGpPct: 0.1, contingency: 0,
    materialSavings: 0, labourSavings: 0, varProfit: 0, omittedValue: 0,
    unpricedSpend: 0, materialOverspend: OVER_26001, unexpectedSpend: OVER_26001,
    appliedValue: 0, certifiedValue: 0, varApplied: 0, varCertified: 0,
  };
  const fc = withCombinedOverspend(summed, dallas);
  assert.equal(fc.materialOverspend, 0);
  assert.equal(fc.unexpectedSpend, 0);
  assert.ok(Math.abs(fc.ffc - (900 - OVER_26001)) < 0.01);
  assert.ok(Math.abs(fc.forecastProfit - (1000 - fc.ffc)) < 0.01);
  assert.ok(Math.abs((fc.forecastGpPct ?? 0) - fc.forecastProfit / 1000) < 1e-9);
});

// ── The levers have to add up to the outturn ────────────────────────────────

/** Total Change in Profit/Loss is the profit-lever tiles summed; Forecast Profit
 *  comes the other way round, off contract value and cost. They are the same
 *  quantity, so they have to agree — a term that reaches one and not the other
 *  is the bug this guards. */
function forecastWith(o: { contingency?: number; committed?: number; unpriced?: number; variationSell?: number; variationCost?: number }) {
  const commercials = [{ is_total: 1, value: 100_000, cost: 80_000 }] as unknown as ProjectCommercial[];
  const mats = [mat({ item: "Butyl Tape", cost: 10, total_units: 1000, committed_qty: o.committed ?? 0, live_unit_price: 9 })];
  const variations = (o.variationSell || o.variationCost)
    ? [{ sell_value: o.variationSell ?? 0, material_budget: o.variationCost ?? 0, labour_budget: 0 }] as never[]
    : [];
  return computeForecast({
    commercials, variations, contractItems: [], afps: [], mats,
    contingency: o.contingency ?? 0,
    summary: summariseMaterials(mats, o.unpriced ?? 0),
  });
}

const contractGp = () => {
  const ct = contractTotals([{ is_total: 1, value: 100_000, cost: 80_000 }] as unknown as ProjectCommercial[])!;
  return ct.value - ct.cost;
};

for (const [name, opts] of [
  ["a bare contract", {}],
  ["with a contingency", { contingency: 5_000 }],
  ["with material spend over budget", { committed: 1200 }],
  ["with off-BOQ spend", { unpriced: 3_000 }],
  ["with a variation", { variationSell: 9_000, variationCost: 6_000 }],
  ["with all of them at once", { contingency: 5_000, committed: 1200, unpriced: 3_000, variationSell: 9_000, variationCost: 6_000 }],
] as const) {
  test(`the levers reconcile to forecast profit — ${name}`, () => {
    const f = forecastWith(opts);
    assert.ok(
      Math.abs(totalChange(f) - (f.forecastProfit - contractGp())) < 0.005,
      `levers ${totalChange(f).toFixed(2)} vs outturn ${(f.forecastProfit - contractGp()).toFixed(2)}`,
    );
  });
}

test("a contingency comes off the change in profit, pound for pound", () => {
  assert.equal(totalChange(forecastWith({})) - totalChange(forecastWith({ contingency: 5_000 })), 5_000);
});
