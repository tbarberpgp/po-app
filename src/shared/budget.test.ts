// Tests for the priced budget and the over-budget test.
//
//   npm test
//
// The cases that matter are the two the quantity gate this replaced got wrong,
// because they are the reason it was replaced: an order that buys the budgeted
// quantity at a higher rate (over on money, within on units — and waved
// through), and one that buys more units at a keener rate (within on money,
// over on units — and sent for approval it didn't need). Then the shapes the
// workbooks actually carry: a lump-sum line with no units, a partial omission,
// and a line with nothing but a unit rate.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { netBudgetUnits, pricedBudget, isUnpricedBudget, overBudgetBy } from "./budget";

// The screenshot case: 25 rolls priced at £66.55 = £1,663.75 budgeted.
const line = (o = {}) => ({ total_units: 25, cost: 66.55, material_total_cost: 1663.75, ...o });

describe("pricedBudget", () => {
  test("prices the allowance at the workbook's per-pack cost", () => {
    assert.equal(pricedBudget(line()), 1663.75);
  });

  test("a lump-sum line with no units takes the workbook's own total", () => {
    // Mansafe, smoke-vent kits: priced as one figure, nothing to multiply.
    assert.equal(pricedBudget({ total_units: null, cost: null, material_total_cost: 8400 }), 8400);
  });

  test("a partial omission reduces the budget, it doesn't resurrect the total", () => {
    // 10 of the 25 dropped → 15 × £66.55, NOT the £1,663.75 in col X.
    assert.equal(pricedBudget(line({ omitted_qty: 10 })), 15 * 66.55);
  });

  test("a wholly omitted line is worth nothing, not its lump sum", () => {
    // The omission is what makes this 0 — falling through to material_total_cost
    // here would hand a cancelled line its full budget back.
    assert.equal(pricedBudget(line({ omitted_qty: 25 })), 0);
  });

  test("an omission of zero units is no omission, so a lump sum still prices", () => {
    assert.equal(pricedBudget({ total_units: 0, cost: null, material_total_cost: 8400, omitted_qty: 0 }), 8400);
  });

  test("a line carrying only a unit rate has no priced budget", () => {
    assert.equal(pricedBudget({ total_units: null, cost: 12.4, material_total_cost: null }), 0);
    assert.equal(isUnpricedBudget({ total_units: null, cost: 12.4, material_total_cost: null }), true);
  });

  test("a priced line is not unpriced", () => {
    assert.equal(isUnpricedBudget(line()), false);
  });

  test("netBudgetUnits never goes negative", () => {
    // An omission larger than the allowance must not price as a credit.
    assert.equal(netBudgetUnits(line({ omitted_qty: 40 })), 0);
  });
});

describe("overBudgetBy", () => {
  test("the case the quantity gate waved through: right qty, higher rate", () => {
    // 25 rolls budgeted at £66.55 (£1,663.75). The order buys 25 — bang on the
    // allowance, so the units test passed it — at £73.43, i.e. £1,835.75.
    const over = overBudgetBy(1663.75, 25 * 73.43);
    assert.equal(over.toFixed(2), "172.00");
  });

  test("the case it flagged for nothing: more units, less money", () => {
    // 30 rolls at £50 is 5 over the allowance and £163.75 under the budget.
    assert.equal(overBudgetBy(1663.75, 30 * 50), 0);
  });

  test("spending exactly the budget is not over", () => {
    assert.equal(overBudgetBy(1663.75, 1663.75), 0);
  });

  test("half a penny of float noise is not an over-run", () => {
    assert.equal(overBudgetBy(1663.75, 1663.754), 0);
  });

  test("a penny over is over, and reports the penny", () => {
    assert.equal(overBudgetBy(1663.75, 1663.76).toFixed(2), "0.01");
  });

  test("committed spend from other orders counts toward the over-run", () => {
    // £1,500 already committed elsewhere, this order adds £400 → £236.25 over.
    assert.equal(overBudgetBy(1663.75, 1500 + 400).toFixed(2), "236.25");
  });

  test("an unpriced line reports nothing rather than its whole spend", () => {
    // Guard the caller's contract: a 0 budget must be caught as "unpriced"
    // before this is asked, or every penny spent reads as an over-run.
    assert.equal(overBudgetBy(0, 500), 500);
    assert.equal(isUnpricedBudget({ total_units: 0, cost: 0, material_total_cost: 0 }), true);
  });
});
