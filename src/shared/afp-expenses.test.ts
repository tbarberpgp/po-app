import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeExpenseLine, isExpenseSection } from "./afp-expenses";

// Wordings taken verbatim from labour applications already in the system.
const EXPENSES = [
  "Mileage - See Expenses Spreadsheet",
  "Expenses Premier Inn + breakfast and evening meal x 4",
  "Expenses - Premier Inn + breakfast and evening meal x 4 x 4",
  "Travel expenses",
  "Hotel accommodation 3 nights",
  "Train ticket London - Newcastle",
  "Taxi fare to site",
  "Congestion charge",
  "Car parking at site",
  "Subsistence allowance",
  "Fuel",
];

const WORK = [
  "25/06/26 - 2 x Operatives x 10 hours / 1 x operative x 3 hours",
  "26/06/26 - 2 x Operatives x 10 hours",
  "27/06/26 (Saturday) - 2 x Operatives x 5 Hours @ 1.8 as Instructed by Power Grid Manager",
  "Hourly Rate of Pay £36.00 P/H - Monday 06/07/26 – Friday 10/07/26",
  "Monday 03/08/26 – 07/08/26 – 2 x Operatives x 10 Hours per Shift @ £33.00 P/H",
  "Management on site - DALLAS ROAD (17/08/2026)",
  "Management on site -",
  "Supply and fix standing seam roof cladding",
  "Install New Flashings Roof",
  "Roof Cladding",
];

test("expense wordings from real applications are recognised", () => {
  for (const d of EXPENSES) {
    assert.equal(looksLikeExpenseLine(d), true, `should be an expense: ${d}`);
  }
});

test("labour and BOQ wordings are not mistaken for expenses", () => {
  for (const d of WORK) {
    assert.equal(looksLikeExpenseLine(d), false, `should NOT be an expense: ${d}`);
  }
});

test("empty and missing descriptions are not expenses", () => {
  assert.equal(looksLikeExpenseLine(null), false);
  assert.equal(looksLikeExpenseLine(undefined), false);
  assert.equal(looksLikeExpenseLine("   "), false);
});

test("the Expenses section label is recognised", () => {
  assert.equal(isExpenseSection("Expenses"), true);
  assert.equal(isExpenseSection("expenses"), true);
  assert.equal(isExpenseSection("Variations"), false);
  assert.equal(isExpenseSection("Materials on Site"), false);
  assert.equal(isExpenseSection(null), false);
});
