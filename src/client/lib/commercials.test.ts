import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accumulateMaterials, materialOverspendOf, summariseMaterials, oneScope, budgetMoneyHint, pickUnit,
  budgetMoney, poLineBudgetMoney,
  unexpectedSpendDrill, combinedUnexpectedSpendDrill, withCombinedOverspend,
  computeForecast, contractTotals, totalChange, labourProfit, labourDrill, addForecasts, prelimLabourCertified,
  prelimsDrill, quoteSavingsOf, isPrelimMaterial,
  type UnpricedLine, type Forecast, type PrelimsSummary,
} from "./commercials";
import type { ApplicationForPayment, ContractItem, MaterialWithCommitment, POLine, ProjectCommercial } from "../../shared/types";
import type { LabourPositionRow } from "../../shared/labour-cost";

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

// ── What the budget pickers put under each line ─────────────────────────────

test("a budget line offers its price and what is left of it", () => {
  assert.deepEqual(
    budgetMoneyHint(mat({ item: "Fixings", cost: 10, total_units: 100, committed_qty: 30 })),
    ["£1,000.00 budgeted", "£700.00 left"],
  );
});

test("headroom prices committed at the buy rate, not the BOQ rate", () => {
  // 120 bought against 100 budgeted, but at £8 on a £10 budget — £40 still left.
  assert.deepEqual(
    budgetMoneyHint(mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 120, live_unit_price: 8 })),
    ["£1,000.00 budgeted", "£40.00 left"],
  );
});

test("a line bought past its budget reads as over, not as negative headroom", () => {
  assert.deepEqual(
    budgetMoneyHint(mat({ item: "Fixings", cost: 10, total_units: 100, committed_qty: 150 })),
    ["£1,000.00 budgeted", "£500.00 over"],
  );
});

test("a lump-sum line falls back to the workbook's own total", () => {
  // Mansafe/smoke-vent kits: priced as one figure, no units to multiply.
  assert.deepEqual(
    budgetMoneyHint(mat({ item: "PPE (Mansafe)", cost: 3081, total_units: 0, committed_qty: 0, material_total_cost: 3081 })),
    ["£3,081.00 budgeted", "£3,081.00 left"],
  );
});

test("an omitted quantity is not resurrected by the workbook total", () => {
  assert.deepEqual(
    budgetMoneyHint(mat({ item: "Top Hat", cost: 10, total_units: 40, omitted_qty: 40, committed_qty: 0, material_total_cost: 400 })),
    ["no priced budget"],
  );
});

test("a line carrying only a unit rate says so rather than quoting £0", () => {
  assert.deepEqual(
    budgetMoneyHint(mat({ item: "Eurobond S5 Wall Panel", cost: 155, total_units: 0, committed_qty: 0 })),
    ["no priced budget"],
  );
});

// ── What a PO line says about the budget line it is coded to ────────────────
//
// A PO line's figures arrive already totalled by GET /api/pos/:id, against the
// BUDGET LINE the cost is coded to (shared/committed-spend.ts) — so the row
// quotes the same money the picker beside it quotes, and two lines of one order
// coded to one budget line quote one figure between them rather than a private
// share each. The live case: Dallas Rd's cavity barriers, ordered under two
// descriptions against one £32,192.16 line.

/** A PO line as the API hands it over — only the budget money. */
function poLine(o: Partial<POLine>): POLine {
  return { id: 1, item: "", qty: 1, unit: "nr", unit_cost: 0, line_total: 0, ...o } as POLine;
}

test("a coded line reports what its budget line has left", () => {
  assert.deepEqual(
    poLineBudgetMoney(poLine({ budget_priced: 32192.16, budget_committed: 18963.26 }))?.words,
    ["£32,192.16 budgeted", "£13,228.90 left"],
  );
});

test("two lines on one budget line quote one figure between them", () => {
  // Both carry the budget line's whole tally, not their own line's share.
  const a = poLineBudgetMoney(poLine({ budget_priced: 32192.16, budget_committed: 18963.26, line_total: 3568.32 }));
  const b = poLineBudgetMoney(poLine({ budget_priced: 32192.16, budget_committed: 18963.26, line_total: 5342.90 }));
  assert.deepEqual(a?.words, b?.words);
});

test("a budget line spent past reads as over, not as negative headroom", () => {
  assert.deepEqual(
    poLineBudgetMoney(poLine({ budget_priced: 594, budget_committed: 3200.44 }))?.words,
    ["£594.00 budgeted", "£2,606.44 over"],
  );
});

test("float noise on a fully committed budget line is not an over-run", () => {
  assert.equal(poLineBudgetMoney(poLine({ budget_priced: 1000, budget_committed: 1000.004 }))?.words[1], "£0.00 left");
});

test("a line the API sends no budget for offers no figures to quote", () => {
  // Coded to nothing, lump-rate, or any line on a call-off — the row keeps the
  // bare workbook figure rather than inventing headroom.
  assert.equal(poLineBudgetMoney(poLine({ budget_priced: null, budget_committed: null })), null);
  assert.equal(poLineBudgetMoney(poLine({})), null);
});

test("both readers of a budget line word the answer the same way", () => {
  // One from a materials row it prices itself, one from a tally the API did.
  // Same budget, same committed, so the wording must not differ.
  const m = mat({ item: "Fixings", cost: 10, total_units: 100, committed_qty: 30 });
  assert.deepEqual(budgetMoneyHint(m), budgetMoney(m)?.words);
  assert.deepEqual(
    poLineBudgetMoney(poLine({ budget_priced: 1000, budget_committed: 300 }))?.words,
    budgetMoney(m)?.words,
  );
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
    labourOverrun: 0, labourCertified: 0, labourBudget: 0,
    prelimsOverrun: 0, prelimsSpend: 0, prelimsBudget: 0,
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
function forecastWith(o: {
  contingency?: number; committed?: number; unpriced?: number; variationSell?: number; variationCost?: number;
  variationLabour?: number; labour?: readonly LabourPositionRow[]; contractItems?: readonly ContractItem[];
  prelims?: PrelimsSummary;
}) {
  const commercials = [{ is_total: 1, value: 100_000, cost: 80_000 }] as unknown as ProjectCommercial[];
  const mats = [mat({ item: "Butyl Tape", cost: 10, total_units: 1000, committed_qty: o.committed ?? 0, live_unit_price: 9 })];
  const variations = (o.variationSell || o.variationCost || o.variationLabour)
    ? [{ sell_value: o.variationSell ?? 0, material_budget: o.variationCost ?? 0, labour_budget: o.variationLabour ?? 0 }] as never[]
    : [];
  return computeForecast({
    commercials, variations, contractItems: [...(o.contractItems ?? [])], afps: [], mats,
    contingency: o.contingency ?? 0,
    summary: summariseMaterials(mats, o.unpriced ?? 0),
    labour: o.labour && [...o.labour],
    prelims: o.prelims,
  });
}

/** A project's prelims pot, as `/prelims` returns it. */
const pot = (o: Partial<PrelimsSummary> = {}): PrelimsSummary =>
  ({ budget: 13_600, po_committed: 0, labour_committed: 0, plant_beyond_orders: 0, ...o });

/** A labour BOQ section's position, as `/labour-by-cost-code` returns it. */
const section = (o: Partial<LabourPositionRow> & { section: string }): LabourPositionRow =>
  ({ labour_total: 0, saving: 0, boq_expended: 0, variation_expended: 0, other_expended: 0, ...o });
const roofOver = [section({ section: "Roof", labour_total: 20_000, boq_expended: 23_000 })];
const expenses = [section({ section: "Expenses", other_expended: 1_389.18 })];
const varLabourOver = [section({ section: "Variations", variation_expended: 2_500 })];

/** A labour BOQ line with a live subcontract rate applied. */
const labourLine = (o: { description: string; qty: number; labour_rate: number; live_labour_rate: number | null; section?: string }) =>
  ({ id: 1, snapshot_id: 1, item_no: 1, category: "measured", section: o.section ?? "Roof", unit: "m2",
     sell_rate: 0, sell_total: 0, labour_total: o.qty * o.labour_rate, ...o }) as ContractItem;

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
  ["with labour certified past its budget", { labour: roofOver }],
  ["with labour expenses", { labour: expenses }],
  ["with variation labour past its budget", { variationSell: 4_000, variationLabour: 2_000, labour: varLabourOver }],
  ["with a live labour rate", { contractItems: [labourLine({ description: "Roof sheets", qty: 100, labour_rate: 50, live_labour_rate: 45 })] }],
  ["with prelims inside their budget", { prelims: pot({ po_committed: 561.44 }) }],
  ["with prelims past their budget", { prelims: pot({ budget: 10_000, po_committed: 9_000, labour_committed: 1_200, plant_beyond_orders: 650 }) }],
  ["with all of them at once", {
    contingency: 5_000, committed: 1200, unpriced: 3_000, variationSell: 9_000, variationCost: 6_000, variationLabour: 2_000,
    labour: [...roofOver, ...expenses, ...varLabourOver],
    contractItems: [labourLine({ description: "Roof sheets", qty: 100, labour_rate: 50, live_labour_rate: 45 })],
    prelims: pot({ budget: 10_000, po_committed: 9_000, labour_committed: 1_200, plant_beyond_orders: 650 }),
  }],
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

// ── Labour in the forecast ──────────────────────────────────────────────────

test("labour certified past its budget raises forecast cost pound for pound", () => {
  const base = forecastWith({});
  const f = forecastWith({ labour: roofOver });
  assert.equal(f.labourOverrun, 3_000);
  assert.equal(Math.round((f.ffc - base.ffc) * 100) / 100, 3_000);
  assert.equal(Math.round((base.forecastProfit - f.forecastProfit) * 100) / 100, 3_000);
  assert.ok((f.forecastGpPct ?? 0) < (base.forecastGpPct ?? 0), "GP% comes down with it");
});

test("labour inside its budget leaves forecast cost where the budget put it", () => {
  const base = forecastWith({});
  const f = forecastWith({ labour: [section({ section: "Roof", labour_total: 20_000, boq_expended: 8_000 })] });
  assert.equal(f.ffc, base.ffc);
  assert.equal(f.labourCertified, 8_000);
  assert.equal(f.labourBudget, 20_000);
});

test("with no labour position the forecast is what it always was", () => {
  const a = forecastWith({});
  const b = forecastWith({ labour: [] });
  assert.equal(a.ffc, b.ffc);
  assert.equal(a.labourOverrun, 0);
});

test("variation labour counts only past the variation's own labour budget", () => {
  const within = forecastWith({ variationSell: 4_000, variationLabour: 3_000, labour: varLabourOver });
  assert.equal(within.labourOverrun, 0, "£2,500 certified against a £3,000 budget");
  const past = forecastWith({ variationSell: 4_000, variationLabour: 2_000, labour: varLabourOver });
  assert.equal(past.labourOverrun, 500);
});

test("the labour lever is live-rate savings less the overrun, and its drill adds up to it", () => {
  const items = [labourLine({ description: "Roof sheets", qty: 100, labour_rate: 50, live_labour_rate: 45 })];
  const f = forecastWith({ contractItems: items, labour: [...roofOver, ...expenses] });
  assert.equal(f.labourSavings, 500);
  assert.equal(labourProfit(f), 500 - 3_000 - 1_389.18);
  const drill = labourDrill(items, [...roofOver, ...expenses], []);
  const effect = drill.rows.reduce((s, r) => s + Number(r.effect), 0);
  assert.ok(Math.abs(effect - labourProfit(f)) < 0.005, `drill ${effect} vs lever ${labourProfit(f)}`);
  assert.deepEqual(drill.rows.map((r) => r.description), ["Roof sheets", "Roof", "Expenses"]);
});

test("combining blocks adds up their labour", () => {
  const a = forecastWith({ labour: roofOver });
  const b = forecastWith({ labour: expenses });
  const both = addForecasts(a, b);
  assert.equal(both.labourOverrun, a.labourOverrun + b.labourOverrun);
  assert.equal(both.labourCertified, a.labourCertified + b.labourCertified);
  assert.equal(both.ffc, a.ffc + b.ffc);
});

// ── Prelims in the forecast ─────────────────────────────────────────────────

// 26002: £561.44 of prelim orders inside a £13,600 prelims budget. They used to
// sit in unexpected spend at full value on top of the budget already in cost.
test("prelims inside their budget leave forecast cost at the budget", () => {
  const base = forecastWith({});
  const f = forecastWith({ prelims: pot({ po_committed: 561.44 }) });
  assert.equal(f.ffc, base.ffc);
  assert.equal(f.prelimsOverrun, 0);
  assert.equal(f.prelimsSpend, 561.44);
  assert.equal(f.prelimsBudget, 13_600);
});

test("prelims past their budget raise forecast cost by the excess, from every source", () => {
  const base = forecastWith({});
  const f = forecastWith({ prelims: pot({ budget: 10_000, po_committed: 9_000, labour_committed: 1_200, plant_beyond_orders: 650 }) });
  assert.equal(f.prelimsOverrun, 850);
  assert.equal(Math.round((f.ffc - base.ffc) * 100) / 100, 850);
  assert.equal(Math.round((base.forecastProfit - f.forecastProfit) * 100) / 100, 850);
});

test("combining blocks adds up their prelims, each measured against its own budget", () => {
  const a = forecastWith({ prelims: pot({ budget: 1_000, po_committed: 1_500 }) });   // £500 over
  const b = forecastWith({ prelims: pot({ budget: 5_000, po_committed: 1_000 }) });   // £4,000 to spare
  const both = addForecasts(a, b);
  assert.equal(both.prelimsOverrun, 500, "one block's slack doesn't pay for another's contract");
  assert.equal(both.prelimsSpend, 2_500);
  assert.equal(both.ffc, a.ffc + b.ffc);
});

const prelimMat = (item: string, cost: number, units: number, committed: number, o: Partial<MaterialWithCommitment> = {}) =>
  mat({ item, cost, total_units: units, committed_qty: committed, type: "Preliminaries", element_name: "Preliminaries", ...o } as never);

test("a prelims budget row is told apart the way the server tells it", () => {
  assert.equal(isPrelimMaterial({ element_name: "Preliminaries", type: "Preliminaries" }), true);
  assert.equal(isPrelimMaterial({ element_name: null, type: "Business Prelims" }), true);
  assert.equal(isPrelimMaterial({ element_name: "Roofing", type: "Sheet" }), false);
});

// A prelim row committed past its own line is the pot's business — booking it
// as material overspend too would carry the same money twice.
test("prelims rows stay out of material overspend", () => {
  const rows = [prelimMat("Site Manager", 1700, 3, 5), mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 120 })];
  assert.equal(summariseMaterials(rows, 0).material_overspend, 200);
});

test("prelims rows stay out of quote savings", () => {
  const rows = [prelimMat("Accommodation", 55, 200, 0, { live_unit_price: 40 }), mat({ item: "Butyl Tape", cost: 10, total_units: 100, committed_qty: 0, live_unit_price: 9 })];
  assert.equal(quoteSavingsOf(rows), 100);
});

test("the prelims drill lists the pot's spend per heading and adds up to it", () => {
  const drill = prelimsDrill(pot({
    budget: 13_600, po_committed: 561.44, labour_committed: 0, plant_beyond_orders: 120,
    headings: [
      { name: "Project Manager", budget: 2_750, committed: 504.68 },
      { name: "Site Manager", budget: 5_100, committed: 0 },
      { name: "Preliminaries", budget: 0, committed: 52.76 },
      { name: "Untyped", budget: 0, committed: 4 },
      { name: "Quantity Surveyor", budget: 0, committed: 0 },
    ],
  }));
  const spent = drill.rows.reduce((s, r) => s + Number(r.spent), 0);
  assert.equal(Math.round(spent * 100) / 100, 561.44 + 120);
  assert.equal(drill.total, "£681.44");
  assert.ok(drill.rows.some((r) => r.what === "Plant hire kept past its order"));
  assert.ok(!drill.rows.some((r) => r.what === "Quantity Surveyor"), "a heading with no budget and no spend isn't listed");
  // The £5,750 of budget the headings don't hold comes from the cost sheet's line.
  assert.ok(drill.rows.some((r) => r.what === "Preliminaries (cost sheet)" && r.budget === 13_600 - 2_750 - 5_100));
});

test("certified prelim labour claims are counted, drafts and measured claims aren't", () => {
  const afp = (o: Partial<ApplicationForPayment>) =>
    ({ direction: "incoming_labour", status: "certified", prelim_heading: "Site management", claimed_amount: 1_000, cumulative_value: 1_000, ...o }) as ApplicationForPayment;
  assert.equal(prelimLabourCertified([
    afp({}),
    afp({ status: "paid", claimed_amount: 250, cumulative_value: 250 }),
    afp({ status: "submitted" }),
    afp({ prelim_heading: null }),
    afp({ direction: "outgoing" }),
  ]), 1_250);
});

// ── pickUnit ──────────────────────────────────────────────────────────────
// The unit columns hold "" far more often than NULL (166 of 565 po_lines, with
// no nulls at all), so the `a ?? b ?? "ea"` chains these replaced never reached
// their default — a picker prefilled from a previous order came up blank.

test("a blank unit is skipped, not treated as an answer", () => {
  assert.equal(pickUnit("", "ea"), "ea");
  assert.equal(pickUnit("   ", "ea"), "ea");
  assert.equal(pickUnit(null, undefined, "", "ea"), "ea");
});

test("the first unit that says something wins, and is trimmed", () => {
  assert.equal(pickUnit("Roll", "ea"), "Roll");
  assert.equal(pickUnit("  drum  ", "ea"), "drum");
  assert.equal(pickUnit(null, "m2", "ea"), "m2");
});

test("with nothing to go on it returns empty, so callers keep their own default", () => {
  assert.equal(pickUnit(), "");
  assert.equal(pickUnit(null, undefined, ""), "");
});
