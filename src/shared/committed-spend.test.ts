// Tests for what counts as spend against a budget line.
//
//   npm test
//
// The case this exists for: PO-26003-0034, a retro PO raised off an invoice.
// Its three lines are worded as the supplier's paperwork ("Pro Drain P-110
// SBS"), coded afterwards to "Fixings Tubes and Fixing", and flagged unpriced
// because the wording is off-BOQ. A tally keyed on the line's wording matched
// none of them and skipped them again for being unpriced, so GET /api/pos/:id
// reported £0 committed against a £594.00 budget line carrying £3,200.44 —
// untouched, on the screen where someone decides whether to spend more of it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { drawsOnBudgetLine, committedAgainstBudgetLine, type SpendLine, type BudgetLine } from "./committed-spend";

const fixings: BudgetLine = { name: "fixings tubes and fixing", replacement: null };
const line = (o: Partial<SpendLine> = {}): SpendLine =>
  ({ item: "fixings tubes and fixing", codedTo: null, isUnpriced: false, lineTotal: 100, ...o });

describe("drawsOnBudgetLine", () => {
  test("an order raised under the budget line's own wording counts", () => {
    assert.equal(drawsOnBudgetLine(line(), fixings), true);
  });

  test("a retro line coded here under invoice wording counts", () => {
    // The whole point: nothing in "Pro Drain P-110 SBS" says which budget it
    // spends, and it is unpriced besides. The coding is the statement.
    assert.equal(drawsOnBudgetLine(
      line({ item: "pro drain p-110 sbs", codedTo: "fixings tubes and fixing", isUnpriced: true }),
      fixings,
    ), true);
  });

  test("an order under the active substitution's wording counts", () => {
    assert.equal(drawsOnBudgetLine(
      line({ item: "ms-b36 replacement bar" }),
      { name: "fixings tubes and fixing", replacement: "ms-b36 replacement bar" },
    ), true);
  });

  test("an off-BOQ line coded nowhere draws on nothing", () => {
    assert.equal(drawsOnBudgetLine(line({ item: "line misc charge: 12h00 service a", isUnpriced: true }), fixings), false);
  });

  test("an unpriced line worded as the budget line still isn't spend against it", () => {
    // Unpriced means there is no priced budget here to draw on.
    assert.equal(drawsOnBudgetLine(line({ isUnpriced: true }), fixings), false);
  });

  test("a cost coded to another budget line is that line's, not this one's", () => {
    assert.equal(drawsOnBudgetLine(line({ item: "pro drain p-110 sbs", codedTo: "colour coded screw" }), fixings), false);
  });

  test("wording settles it, so one cost is never counted against one budget twice", () => {
    // Worded as the budget line AND coded to it: one arm or the other, never
    // both — the arms are exclusive, and this is the case that proves it.
    const both = line({ codedTo: "fixings tubes and fixing" });
    assert.equal(drawsOnBudgetLine(both, fixings), true);
    assert.equal(committedAgainstBudgetLine([both], fixings), 100);
  });
});

describe("committedAgainstBudgetLine", () => {
  test("the live PO-26003-0034 case: £3,200.44 against £594.00, not £0", () => {
    const spend: SpendLine[] = [
      line({ item: "pro drain p-110 sbs", codedTo: "fixings tubes and fixing", isUnpriced: true, lineTotal: 1238.52 }),
      line({ item: "pro-drain-p-110-sbs", codedTo: "fixings tubes and fixing", isUnpriced: true, lineTotal: 1482.72 }),
      line({ item: "pro drain p-110", codedTo: "fixings tubes and fixing", isUnpriced: true, lineTotal: 479.20 }),
      // Not this budget line's money.
      line({ item: "fo ug 210 leaf", codedTo: "colour coded screw", isUnpriced: true, lineTotal: 328.56 }),
    ];
    assert.ok(Math.abs(committedAgainstBudgetLine(spend, fixings) - 3200.44) < 0.005);
  });

  test("two lines of one order on one budget line both draw on it", () => {
    // PO-26001-0060: cavity barriers ordered under two descriptions against one
    // £32,192.16 line. Counting them apart made each look affordable.
    const cavity: BudgetLine = { name: "cavity fire barrier", replacement: null };
    const spend: SpendLine[] = [
      line({ item: "1 hr - c/w brackets 1000 x 90 x 206mm", codedTo: "cavity fire barrier", isUnpriced: true, lineTotal: 3568.32 }),
      line({ item: "1 hr - c/w brackets and coarse wound screws", codedTo: "cavity fire barrier", isUnpriced: true, lineTotal: 5342.90 }),
    ];
    assert.ok(Math.abs(committedAgainstBudgetLine(spend, cavity) - 8911.22) < 0.005);
  });

  test("nothing drawing on it is £0, not a missing figure", () => {
    assert.equal(committedAgainstBudgetLine([line({ item: "something else", isUnpriced: true })], fixings), 0);
  });
});
