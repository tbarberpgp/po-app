import test from "node:test";
import assert from "node:assert/strict";
import { looksLikeDayworkLine, isDayworkSection, DAYWORKS_SECTION } from "./afp-dayworks";
import { looksLikeExpenseLine } from "./afp-expenses";

/**
 * Every wording below is a real line taken from the live applications on
 * 2026-10-07, where £40,818 of claimed time was sitting in the unmatched tray
 * because none of it describes a BOQ item.
 */
const CLAIMED_TIME = [
  // Cladders — hourly, Blyth
  "Hourly Rate of Pay £36.00 P/H - Monday 06/07/26 – Friday 10/07/26",
  "Hourly Rate of Pay £36.00 P/H — Monday 13/07/26 – Friday 17/07/26 – 3 x Operatives x 10 Hours per Shift",
  "Hourly Rate of Pay £33.00 - Monday 20/07/26 – Friday 24/07/26 – 2 x Operatives x 10 Hours per Shift",
  "Monday 03/08/26 – 07/08/26 – 2 x Operatives x 10 Hours per Shift @ £33.00 P/H",
  "Monday 10/08/26 – 14/08/26 – Plus One Day 18/08/26 x 2 x Operatives x 10 Hours per Shift @ £33.00 P/H",
  "Tuesday 01/09/26 – Wednesday 02/09/26 – 2 x Operatives x 10 Hours per Shift",
  "2 x Operatives x 10 Hours per Shift for Period 21/09/26 – 25/09/26 @ £33.00 P/H",
  "Saturday 11/07/26 (£36.00 x 1.8)",
  // Asgaard — day rate, Dallas Rd
  "Management on site -",
  "Management on site - DALLAS ROAD (17/08/2026)",
];

/**
 * The measured BOQ these subcontractors work against, live on the same day.
 * A daywork line is only ever offered wording the matcher has already given
 * up on, but filing measured work as daywork would still take it out of the
 * cumulative position — so none of this may read as time.
 */
const MEASURED_WORK = [
  "Flat Roof",
  "Felt Roof Gutter Line",
  "Felt Roof to Cladding Connection",
  "Alumasc Pitched Roof Built Up System",
  "Alumasc Pitched Roof Built Up System: Dormer Valley",
  "Alumasc Wall Rain Screen System",
  "Lift Shaft Head: Upstand from Felt Roof Average Height 1m",
  "Cladding Wall Base Detail",
  "Curtain Walling Connection",
  "Dormer Head - Roof Detail 4",
  "Removal of Gutters",
  "Removal of Downpipes",
  "Supply and Install new Ridge Flashing",
  "Vertical Jointing Flashing",
  "Gable Cladding Picture Frame Detail",
  // Prelims that ARE priced BOQ lines — "Project Manager" must not read as
  // "management on site", or Cladders' £2,500/wk PM line would stop matching.
  "Project Manager",
  "Project Manager Whole Scope",
  "Project Manager Flashing Scope",
  "Project Manager: Thomas Barber",
  "Quantity Surveyor",
  "Health and Safety Visiting",
  "Design Details and Plan Drawings",
  "Directors Adjustment",
  "Fall Arrest",
  "Access equipment x 2",
];

test("claimed time reads as daywork", () => {
  for (const d of CLAIMED_TIME) {
    assert.equal(looksLikeDayworkLine(d), true, `should be daywork: ${d}`);
  }
});

test("measured work never reads as daywork", () => {
  for (const d of MEASURED_WORK) {
    assert.equal(looksLikeDayworkLine(d), false, `should NOT be daywork: ${d}`);
  }
});

test("expenses are claimed first, so a hotel bill never lands in dayworks", () => {
  // These carry weekday-free wording but are disbursements; the ingest asks
  // looksLikeExpenseLine first. Assert that ordering is what protects them.
  const expenses = [
    "Expenses - Premier Inn + breakfast and evening meal x 4",
    "Expenses - The Nook hotel + breakfast and evening meal x 4",
    "Mileage - See Expenses Spreadsheet",
  ];
  for (const d of expenses) {
    assert.equal(looksLikeExpenseLine(d), true, `should be an expense: ${d}`);
  }
});

test("blank and missing descriptions are not dayworks", () => {
  assert.equal(looksLikeDayworkLine(""), false);
  assert.equal(looksLikeDayworkLine("   "), false);
  assert.equal(looksLikeDayworkLine(null), false);
  assert.equal(looksLikeDayworkLine(undefined), false);
});

test("the section label round-trips", () => {
  assert.equal(isDayworkSection(DAYWORKS_SECTION), true);
  assert.equal(isDayworkSection("Dayworks"), true);
  assert.equal(isDayworkSection("daywork"), true);
  assert.equal(isDayworkSection("Expenses"), false);
  assert.equal(isDayworkSection("Variations"), false);
  assert.equal(isDayworkSection(null), false);
});
