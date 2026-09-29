import { test } from "node:test";
import assert from "node:assert/strict";
import { plantAccrued, plantBeyondOrders, prelimsOutturn } from "./prelims-cost";

const hire = (o: { rate: number; unit?: string; from: string; to?: string | null }) =>
  ({ day_rate: o.rate, rate_unit: o.unit ?? "day", on_hire_from: o.from, off_hire_to: o.to ?? null });

test("a day rate accrues for every day on hire, the first day included", () => {
  assert.equal(plantAccrued(hire({ rate: 126, from: "2026-09-01", to: "2026-09-10" }), "2026-09-29"), 126 * 10);
});

test("a weekly rate charges each week begun", () => {
  assert.equal(plantAccrued(hire({ rate: 400, unit: "week", from: "2026-09-01", to: "2026-09-08" }), "2026-09-29"), 400 * 2);
  assert.equal(plantAccrued(hire({ rate: 400, unit: "week", from: "2026-09-01", to: "2026-09-07" }), "2026-09-29"), 400);
});

test("plant still on hire accrues to today", () => {
  assert.equal(plantAccrued(hire({ rate: 100, from: "2026-09-20" }), "2026-09-29"), 1000);
});

test("a row with no rate or no on-hire date accrues nothing", () => {
  assert.equal(plantAccrued({ day_rate: null, rate_unit: "day", on_hire_from: "2026-09-01", off_hire_to: null }, "2026-09-29"), 0);
  assert.equal(plantAccrued({ day_rate: 100, rate_unit: "day", on_hire_from: null, off_hire_to: null }, "2026-09-29"), 0);
});

// A telehandler ordered for 4 weeks at £630 a week, kept 6: two weeks nobody ordered.
test("hire kept on past its order counts the weeks beyond it", () => {
  const over = plantBeyondOrders([{ ...hire({ rate: 630, unit: "week", from: "2026-08-01", to: "2026-09-11" }), po_id: "po1", po_value: 2520 }], "2026-09-29");
  assert.equal(over, 630 * 6 - 2520);
});

test("hire inside its order adds nothing — the order is already counted", () => {
  const over = plantBeyondOrders([{ ...hire({ rate: 630, unit: "week", from: "2026-09-01", to: "2026-09-14" }), po_id: "po1", po_value: 2520 }], "2026-09-29");
  assert.equal(over, 0);
});

test("two items on one order share it, and one order's slack doesn't cover another's overrun", () => {
  const rows = [
    { ...hire({ rate: 100, from: "2026-09-01", to: "2026-09-10" }), po_id: "a", po_value: 1500 }, // £1,000
    { ...hire({ rate: 100, from: "2026-09-01", to: "2026-09-10" }), po_id: "a", po_value: 1500 }, // £1,000 — £500 past order a
    { ...hire({ rate: 100, from: "2026-09-01", to: "2026-09-05" }), po_id: "b", po_value: 5000 }, // £500 — well inside order b
  ];
  assert.equal(plantBeyondOrders(rows, "2026-09-29"), 500);
});

test("prelims inside their budget leave the forecast at the budget", () => {
  const o = prelimsOutturn({ budget: 13_600, orders: 561.44, labour: 0, plant: 0 });
  assert.equal(o.spend, 561.44);
  assert.equal(o.overrun, 0);
});

test("prelims past their budget carry the excess, from every source", () => {
  const o = prelimsOutturn({ budget: 10_000, orders: 8_000, labour: 1_500, plant: 900 });
  assert.equal(o.spend, 10_400);
  assert.equal(o.overrun, 400);
});

test("with no budget at all, every pound of prelims spend is over it", () => {
  assert.equal(prelimsOutturn({ budget: 0, orders: 250, labour: 0, plant: 0 }).overrun, 250);
});

test("a missing position reads as nothing spent and nothing over", () => {
  assert.deepEqual(prelimsOutturn(null), { budget: 0, orders: 0, labour: 0, plant: 0, spend: 0, overrun: 0 });
});
