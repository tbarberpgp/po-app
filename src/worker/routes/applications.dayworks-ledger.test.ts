// What a week of dayworks is worth, and what it leaves behind for next week.
//
//   npm test
//
// The case: Cladders and Asgaard invoice time, not measure — "2 x Operatives
// x 10 Hours per Shift @ £33.00 P/H", "Management on site - DALLAS ROAD". Time
// describes no BOQ item, so until 0133 those lines stranded in the unmatched
// tray and every application read £0. Filing them as ad-hoc lines fixes that
// only if they also stay OUT of the cumulative position: an ad-hoc line is
// never carried into the next application, so leaving it in the anchor would
// make week 2 subtract week 1's hours as work already certified — the series
// would net to nothing, which is the failure 0126 had already fixed once for
// expenses.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { periodNet, priorAnchor } from "./applications";

const nil = { certified_amount: null, cumulative_value: null, expenses_amount: null, dayworks_amount: null };

describe("priorAnchor", () => {
  test("a prior week's dayworks come off the anchor they were added on top of", () => {
    // Week 1: no measured work at all, £3,300 of hours.
    assert.equal(priorAnchor({ ...nil, cumulative_value: 0, dayworks_amount: 3300 }), 0);
  });

  test("expenses and dayworks both come off, measured work stays", () => {
    assert.equal(
      priorAnchor({ ...nil, cumulative_value: 9676.8, expenses_amount: 636.9, dayworks_amount: 2100 }),
      9676.8 - 636.9 - 2100,
    );
  });

  test("a certified figure wins over the claimed one", () => {
    assert.equal(priorAnchor({ ...nil, certified_amount: 7480.8, cumulative_value: 9676.8 }), 7480.8);
    // …and still nets off its own standalone claims.
    assert.equal(
      priorAnchor({ ...nil, certified_amount: 7480.8, cumulative_value: 9676.8, dayworks_amount: 480.8 }),
      7000,
    );
  });

  test("a row from before the column existed reads as nothing carried", () => {
    assert.equal(priorAnchor({ ...nil, cumulative_value: 2196 }), 2196);
  });

  test("standalone claims against no measured work floor at zero, not below", () => {
    // Asgaard's live Block B weeks: £0 measured, £2,100 of site management and
    // ~£637 of hotel and mileage. Subtracting those bare gives -£2,736.90, and
    // the next application would read that as measured work owed back and pay
    // the same money twice. This floor is the only thing stopping it.
    assert.equal(
      priorAnchor({ ...nil, cumulative_value: 0, expenses_amount: 636.9, dayworks_amount: 2100 }),
      0,
    );
  });

  test("the floor bites on expenses alone, which is true of main today", () => {
    assert.equal(priorAnchor({ ...nil, cumulative_value: 0, expenses_amount: 636.9 }), 0);
  });
});

describe("periodNet", () => {
  test("a week of dayworks alone is worth that week's dayworks", () => {
    assert.equal(
      periodNet({ cumulative: 0, previousCertified: 0, expensesAmount: 0, dayworksAmount: 3300 }),
      3300,
    );
  });

  test("week 2 does not cancel week 1 — the bug this exists to stop", () => {
    // Week 1: £3,300 of hours, nothing measured.
    const w1 = periodNet({ cumulative: 0, previousCertified: 0, expensesAmount: 0, dayworksAmount: 3300 });
    // What week 1 leaves as the anchor, once it is submitted.
    const anchor = priorAnchor({ ...nil, cumulative_value: 0, dayworks_amount: 3300 });
    // Week 2: another £3,300 of hours.
    const w2 = periodNet({ cumulative: 0, previousCertified: anchor, expensesAmount: 0, dayworksAmount: 3300 });
    assert.equal(w1, 3300);
    assert.equal(anchor, 0, "week 1's hours must not anchor week 2");
    assert.equal(w2, 3300, "week 2 was worked and must be paid");
  });

  test("six weeks of Asgaard day rate add up instead of flattening", () => {
    // Asgaard's live Block B series: £2,100, £2,730, £1,680, £2,100, £2,100,
    // £2,100 of site management, no measured work on any of them. Live on
    // 2026-10-07 every one of these read £0.
    const weeks = [2100, 2730, 1680, 2100, 2100, 2100];
    let anchor = 0;
    let paid = 0;
    for (const dayworks of weeks) {
      paid += periodNet({ cumulative: 0, previousCertified: anchor, expensesAmount: 0, dayworksAmount: dayworks });
      anchor = priorAnchor({ ...nil, cumulative_value: 0, dayworks_amount: dayworks });
    }
    assert.equal(paid, 12810);
  });

  test("dayworks survive an over-certified measured position", () => {
    // The max(0,…) floor is on the measured movement alone: a subbie whose
    // measured claim has gone backwards still gets this week's hours.
    assert.equal(
      periodNet({ cumulative: 5000, previousCertified: 9000, expensesAmount: 120, dayworksAmount: 3300 }),
      3420,
    );
  });

  test("measured movement and dayworks both land in the same period", () => {
    assert.equal(
      periodNet({ cumulative: 9676.8, previousCertified: 2196, expensesAmount: 0, dayworksAmount: 3300 }),
      9676.8 - 2196 + 3300,
    );
  });
});
