import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accumulateMaterials, materialOverspendOf, projectedOverspendOf, toOrderValueOf,
  summariseMaterials, oneScope,
  unexpectedSpendDrill, combinedUnexpectedSpendDrill, stillToOrderDrill, withCombinedOverspend,
  type UnpricedLine, type Forecast,
} from "./commercials";
import type { MaterialWithCommitment } from "../../shared/types";

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
// The live Dallas Rd case: bars over-ordered on block B, while C and D are only
// part way through ordering theirs.
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

test("budget a block hasn't ordered against can't cover a sibling's over-run", () => {
  // 26002 and 26003 are £7k under between them, but neither has finished
  // ordering — that money is a purchase still to come, not a saving.
  assert.ok(Math.abs(materialOverspendOf(dallas) - OVER_26001) < 0.01);
  const [acc] = accumulateMaterials(dallas);
  assert.deepEqual(acc.parts.map((p) => p.fullyOrdered), [true, false, false]);
});

test("a block that has FINISHED ordering under budget does cover one", () => {
  const over = materialOverspendOf([
    // All 100 bought, at £8 against a £10 budget — a real £200 saving.
    { scope: "A", mats: [mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 100, live_unit_price: 8 })] },
    { scope: "B", mats: [mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 120 })] },
  ]);
  assert.equal(over, 0);
});

test("the saving only stretches as far as it goes", () => {
  const over = materialOverspendOf([
    { scope: "A", mats: [mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 100, live_unit_price: 9 })] }, // −100
    { scope: "B", mats: [mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 130 })] },                     // +300
  ]);
  assert.equal(over, 200);
});

test("a material over budget on every block is flagged at the total", () => {
  assert.equal(materialOverspendOf(oneScope([
    mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 150 }),
    mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 120 }),
  ])), 700);
});

test("rows merge on the master product even when the wording differs", () => {
  const acc = accumulateMaterials(oneScope([
    mat({ item: "Pro Drain P-110 SBS", cost: 10, total_units: 10, committed_qty: 10, product_id: 7 }),
    mat({ item: "PRO-DRAIN-P-110-SBS", cost: 10, total_units: 50, committed_qty: 50, product_id: 7 }),
  ]));
  assert.equal(acc.length, 1);
  assert.equal(acc[0].budgetQty, 60);
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

// ── The projection ──────────────────────────────────────────────────────────

test("still to order is the budget nothing has been ordered against", () => {
  // 26001 has over-ordered (nothing left), 26002 has 435.06 to go, 26003 73.67.
  const expected = (435.06 + 484.73 - 411.06) * RATE;
  assert.ok(Math.abs(toOrderValueOf(dallas) - expected) < 0.01);
});

test("the projection shows an over-run the unordered budget is masking", () => {
  // Buying the rest at today's rate leaves 26001's over-order standing.
  assert.ok(Math.abs(projectedOverspendOf(dallas) - OVER_26001) < 1);
});

test("the projection nets freely — by then every block has bought", () => {
  const scopes = [
    { scope: "A", mats: [mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 0, live_unit_price: 8 })] },  // −200 to come
    { scope: "B", mats: [mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 120 })] },                    // +200 today
  ];
  assert.equal(materialOverspendOf(scopes), 200, "today, A has bought nothing");
  assert.equal(projectedOverspendOf(scopes), 0, "once A buys at £8 the over-run washes out");
});

test("a material fully ordered everywhere has nothing left to project", () => {
  const scopes = oneScope([mat({ item: "Top Hat", cost: 10, total_units: 100, committed_qty: 130 })]);
  assert.equal(toOrderValueOf(scopes), 0);
  assert.equal(projectedOverspendOf(scopes), materialOverspendOf(scopes));
});

// ── The drills ──────────────────────────────────────────────────────────────

const unpriced: UnpricedLine[] = [
  { po_id: "po1", line_id: 1, po_number: "PO-26001-0013", supplier: "SIG", item: "Single Sided Tape", qty: 1, unit: "ea", line_total: 2674, status: "issued" },
];

test("the drill lists only what the headline figure counts", () => {
  const body = combinedUnexpectedSpendDrill(dallas.map((g, i) => ({ block: g.scope, lines: i === 0 ? unpriced : [], mats: g.mats })));
  const shown = body.rows.reduce((s, r) => s + Number(r.amount), 0);
  assert.ok(Math.abs(shown - (2674 + materialOverspendOf(dallas))) < 0.01, `drill ${shown}`);
  const over = body.rows.find((r) => r.kind === "Over budget");
  assert.equal(over?.__block, "All blocks", "the merged material names every block it sits on");
  assert.ok(Number(over?.still) > 0, "and says how much of it is still to buy");
});

test("a combined over-budget row names only the blocks it sits on", () => {
  const body = combinedUnexpectedSpendDrill([
    { block: "26001", lines: [], mats: [mat({ item: "Top Hat", cost: 10, total_units: 10, committed_qty: 30 })] },
    { block: "26002", lines: [], mats: [] },
  ]);
  assert.equal(body.rows.find((r) => r.kind === "Over budget")?.__block, "26001");
});

test("the per-block drill and the per-block summary agree", () => {
  const summary = summariseMaterials(dallas[0].mats, 2674);
  const shown = unexpectedSpendDrill(unpriced, dallas[0].mats).rows.reduce((s, r) => s + Number(r.amount), 0);
  assert.ok(Math.abs(shown - (summary.unpriced_spend + summary.material_overspend)) < 0.01, `drill ${shown}`);
});

test("still to order lists each material's projected landing point", () => {
  const body = stillToOrderDrill(dallas);
  assert.equal(body.rows.length, 1, "one merged row, not one per block");
  const [row] = body.rows;
  assert.ok(Math.abs(Number(row.projected) - (Number(row.committed) + Number(row.still))) < 0.01);
  assert.ok(Math.abs(Number(row.variance) - (Number(row.projected) - Number(row.budget))) < 0.01);
  assert.ok(Number(row.variance) > 0, "the over-order survives the rest of the buying");
});

test("a material with nothing left to buy stays off the still-to-order list", () => {
  assert.equal(stillToOrderDrill(oneScope([mat({ item: "Top Hat", cost: 10, total_units: 10, committed_qty: 30 })])).rows.length, 0);
});

test("the Block column only appears when there is more than one", () => {
  const one = stillToOrderDrill(oneScope([mat({ item: "Top Hat", cost: 10, total_units: 10, committed_qty: 0 })]));
  assert.ok(!one.columns.some((c) => c.key === "__block"));
  assert.ok(stillToOrderDrill(dallas).columns.some((c) => c.key === "__block"));
});

// ── Rolling the blocks up ───────────────────────────────────────────────────

test("re-basing the overspend pulls forecast cost, profit and GP% with it", () => {
  // A summed forecast double-counts: block B's £200 over-run stands even though
  // block A has finished buying the same material £200 under.
  const scopes = [
    { scope: "A", mats: [mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 100, live_unit_price: 8 })] },
    { scope: "B", mats: [mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 120 })] },
  ];
  const summed: Forecast = {
    hasContract: true, ffa: 1000, ffc: 900, forecastProfit: 100, forecastGpPct: 0.1, contingency: 0,
    materialSavings: 0, labourSavings: 0, varProfit: 0, omittedValue: 0,
    unpricedSpend: 0, materialOverspend: 200, unexpectedSpend: 200,
    stillToOrder: 0, projectedOverspend: 200,
    appliedValue: 0, certifiedValue: 0, varApplied: 0, varCertified: 0,
  };
  const fc = withCombinedOverspend(summed, scopes);
  assert.equal(fc.materialOverspend, 0);
  assert.equal(fc.unexpectedSpend, 0);
  assert.equal(fc.projectedOverspend, 0);
  assert.equal(fc.ffc, 700);
  assert.equal(fc.forecastProfit, 300);
  assert.ok(Math.abs((fc.forecastGpPct ?? 0) - 0.3) < 1e-9);
});
