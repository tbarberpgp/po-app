// Tests for which purchase orders the PO list is willing to show.
//
//   npm test
//
// The case: deleting a PO is a soft delete — the row stays, its status becomes
// 'deleted', and every list hides it so it stops counting against committed
// budget and stops turning up in pickers. The PO dashboard's "Deleted" filter
// is the one place that wants them back, and it asks by status like every
// other filter does. Before this, the list's hide-deleted guard was
// unconditional, so that filter asked for deleted orders and got an empty
// table — the orders were there, the query just cancelled itself out.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { listShowsDeleted } from "./pos";

describe("listShowsDeleted", () => {
  test("the dashboard's Deleted filter asks for them by status", () => {
    assert.equal(listShowsDeleted("deleted", false), true);
  });

  test("include_deleted=1 mixes them in with the live orders", () => {
    assert.equal(listShowsDeleted(undefined, true), true);
  });

  test("every other list hides them", () => {
    for (const status of [undefined, "", "draft", "pending_approval", "approved", "issued", "rejected"]) {
      assert.equal(listShowsDeleted(status, false), false, `${status ?? "(no status)"} must not show deleted POs`);
    }
  });
});
