// Tests for which suppliers the register is willing to list.
//
//   npm test
//
// The case: the supplier register is really a mirror of Xero — "Sync with Xero"
// pulls every contact flagged IsSupplier and creates a row for anything it
// can't match. So it fills with names the company pays but never raises a PO
// against: a director's expense claim, the bookkeeper, a software subscription.
// Deleting those doesn't hold — the sync, invoice coding and PO raising all
// recreate a supplier whose name has no row — so they're hidden instead, and
// the row surviving is what suppresses them.
//
// Which makes the default the thing worth pinning down: a caller has to ask for
// hidden suppliers, because every caller that forgets is a picker that would
// otherwise offer somebody's name as a place to buy roofing from.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { hiddenClause } from "./suppliers";

describe("hiddenClause", () => {
  test("the register asks for hidden suppliers explicitly, to offer an unhide", () => {
    assert.equal(hiddenClause("1"), "");
  });

  test("every other caller gets the curated list", () => {
    for (const q of [undefined, "", "0", "true", "yes"]) {
      assert.equal(
        hiddenClause(q),
        "WHERE s.hidden = 0",
        `include_hidden=${q ?? "(absent)"} must not surface hidden suppliers`,
      );
    }
  });
});
