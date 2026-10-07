import { test } from "node:test";
import assert from "node:assert/strict";
import { supplierRefKey } from "./line-match";

// Every string below is one a supplier actually printed, read off production.
test("a real supplier reference becomes a key", () => {
  assert.equal(supplierRefKey("Q164563/AD28/07"), "Q164563AD2807");
  assert.equal(supplierRefKey("POR117594"), "POR117594");
  assert.equal(supplierRefKey("SOR458448"), "SOR458448");
  assert.equal(supplierRefKey("1001786219"), "1001786219");
});

test("punctuation and case don't make it a different reference", () => {
  assert.equal(supplierRefKey("por 117594"), supplierRefKey("POR-117594"));
});

// The whole reason the bar is high: these were in the same field.
test("a site name is not a reference", () => {
  assert.equal(supplierRefKey("DALLAS ROAD"), null);
  assert.equal(supplierRefKey("DALLAS ROAD C2"), null);
});

test("a placeholder is not a reference", () => {
  assert.equal(supplierRefKey("TBC"), null);
  assert.equal(supplierRefKey("DEMO"), null);
  assert.equal(supplierRefKey(""), null);
  assert.equal(supplierRefKey(null), null);
});

test("our own order number is not a supplier's reference", () => {
  assert.equal(supplierRefKey("PO-26003-0040"), null);
  assert.equal(supplierRefKey("026003-0020"), null);
  assert.equal(supplierRefKey("PO-26001-0013-C1"), null);
});

test("something too short to identify anything is refused", () => {
  assert.equal(supplierRefKey("AD29"), null);
  assert.equal(supplierRefKey("12345"), null);
});
