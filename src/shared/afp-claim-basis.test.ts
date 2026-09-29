import { test } from "node:test";
import assert from "node:assert/strict";
import { looksCumulative, amountsArePeriod } from "./afp-claim-basis";

test("a weekly hours invoice reads as period", () => {
  // Cladders, application #11 — one week of two operatives.
  const lines = [{ cumulative_value: 3300, cumulative_pct: null, this_period_value: 3300 }];
  assert.equal(amountsArePeriod(lines), true);
  assert.equal(looksCumulative(lines), false);
});

test("period-only figures read as period", () => {
  const lines = [
    { cumulative_value: null, cumulative_pct: null, this_period_value: 828 },
    { cumulative_value: null, cumulative_pct: null, this_period_value: 720 },
  ];
  assert.equal(amountsArePeriod(lines), true);
});

test("a stated percentage complete reads as cumulative", () => {
  const lines = [{ cumulative_value: null, cumulative_pct: 45, this_period_value: null }];
  assert.equal(looksCumulative(lines), true);
  assert.equal(amountsArePeriod(lines), false);
});

test("a to-date figure above the period figure reads as cumulative", () => {
  const lines = [
    { cumulative_value: 3300, cumulative_pct: null, this_period_value: 3300 },
    { cumulative_value: 9676.8, cumulative_pct: null, this_period_value: 7480.8 },
  ];
  assert.equal(looksCumulative(lines), true);
});

test("a figure copied into both columns is not cumulative evidence", () => {
  const lines = [
    { cumulative_value: 5400, cumulative_pct: null, this_period_value: 5400 },
    { cumulative_value: 3960, cumulative_pct: null, this_period_value: 3960 },
  ];
  assert.equal(looksCumulative(lines), false);
});

test("rounding noise between the two columns is not a difference", () => {
  const lines = [{ cumulative_value: 3300.001, cumulative_pct: null, this_period_value: 3300 }];
  assert.equal(looksCumulative(lines), false);
});

test("no lines reads as period", () => {
  assert.equal(amountsArePeriod([]), true);
});
