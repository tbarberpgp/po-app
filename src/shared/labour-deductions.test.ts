// Nothing is deducted from a subbie's bill here — that's Xero's job.
//
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLabourDeduction } from "./labour-deductions";

test("Asgard 025's own rows: the work stays, the CIS row is a deduction", () => {
  // As read off the live invoice (#291).
  assert.equal(isLabourDeduction({ description: "Management on site - DALLAS ROAD (04/10/2026)", cumulative_value: 420 }), false);
  assert.equal(isLabourDeduction({ description: "Mileage - See Expenses Spreadsheet", cumulative_value: 108.9 }), false);
  assert.equal(isLabourDeduction({ description: "Expenses - Premier Inn + breakfast and evening meal x 4", cumulative_value: 585 }), false);
  assert.equal(isLabourDeduction({ description: "CIS Tax @ 20%", cumulative_value: -420 }), true);
});

test("a deduction printed as a positive figure is still a deduction", () => {
  // Added as a line, this one would have put £546 ON the bill.
  assert.equal(isLabourDeduction({ description: "CIS Tax @ 20% (deduction)", cumulative_value: 546 }), true);
  assert.equal(isLabourDeduction({ description: "Less retention 5%", this_period_value: 139.7 }), true);
  assert.equal(isLabourDeduction({ description: "VAT @ 20%", cumulative_value: 1540 }), true);
  assert.equal(isLabourDeduction({ description: "Early payment discount", cumulative_value: 50 }), true);
  assert.equal(isLabourDeduction({ description: "Contra charge - skip hire", cumulative_value: 300 }), true);
});

test("any negative figure is a deduction, whatever it's called", () => {
  assert.equal(isLabourDeduction({ description: "Adjustment", this_period_value: -75 }), true);
});

test("Latbuild App-03's work is not mistaken for one", () => {
  assert.equal(isLabourDeduction({ description: "install riser- Dogbox on roof - WC: 05.10.2026", cumulative_value: 2500 }), false);
  // "less" only counts at the start of a row — not inside a word.
  assert.equal(isLabourDeduction({ description: "Fix stainless steel brackets", cumulative_value: 800 }), false);
});
