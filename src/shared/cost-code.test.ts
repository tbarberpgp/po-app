import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCostCode, describeCostCode } from "./types";

// The complaint this answers: a PO line showed "6003.30.M" and nothing else,
// so the person reading it couldn't tell which budget the cost had landed in.
test("spells out a code's segments with their names", () => {
  assert.equal(
    describeCostCode("6003.30.M", { element: "Wall cladding - Composite panel", resource: "Materials" }),
    "project 6003 · element 30 (Wall cladding - Composite panel) · resource M (Materials)",
  );
});

test("reads out the segments it has when the names are missing", () => {
  assert.equal(describeCostCode("6003.30.M"), "project 6003 · element 30 · resource M");
  assert.equal(
    describeCostCode("6003.30.M", { element: null, resource: "Materials" }),
    "project 6003 · element 30 · resource M (Materials)",
  );
});

test("survives a code that isn't the full three segments", () => {
  assert.equal(describeCostCode("6003"), "project 6003");
  assert.equal(describeCostCode(""), "");
});

test("describes what buildCostCode builds", () => {
  assert.equal(
    describeCostCode(buildCostCode("6003", "30", "M"), { element: "Wall cladding - Composite panel" }),
    "project 6003 · element 30 (Wall cladding - Composite panel) · resource M",
  );
});
