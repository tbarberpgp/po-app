import { test } from "node:test";
import assert from "node:assert/strict";
import { uncertifyBlock } from "./afp-uncertify";

const cert = { direction: "incoming_labour", status: "certified", claim_basis: "period" };

test("a certified labour certificate not yet in Xero can go back", () => {
  assert.equal(uncertifyBlock(cert, []), null);
});

test("a later certified period claim doesn't stand in the way", () => {
  assert.equal(uncertifyBlock(cert, [33]), null);
});

test("a later certified running total does", () => {
  assert.match(uncertifyBlock({ ...cert, claim_basis: "cumulative" }, [33]) ?? "", /#33/);
  assert.match(uncertifyBlock({ ...cert, claim_basis: null }, [33, 34]) ?? "", /#33, #34 have/);
});

test("pushed to Xero, keyed in by hand, or paid: refused", () => {
  assert.match(uncertifyBlock({ ...cert, xero_po_id: "abc", xero_po_number: "INV-016" }, []) ?? "", /INV-016/);
  assert.match(uncertifyBlock({ ...cert, xero_sync_status: "synced" }, []) ?? "", /Xero/);
  assert.match(uncertifyBlock({ ...cert, status: "paid" }, []) ?? "", /paid/);
});

test("a failed push isn't in Xero, so it can still go back", () => {
  assert.equal(uncertifyBlock({ ...cert, xero_sync_status: "failed" }, []), null);
});

test("only certified labour", () => {
  assert.match(uncertifyBlock({ ...cert, status: "submitted" }, []) ?? "", /Only a certified/);
  assert.match(uncertifyBlock({ ...cert, direction: "outgoing" }, []) ?? "", /labour/);
});
