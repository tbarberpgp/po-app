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

// PRJ is only the last four digits of the project code, so the segment can't
// be read back as the job number — 26003 becomes 6003. Naming the project is
// the whole point of the hover.
test("names the project behind the PRJ segment when it's given one", () => {
  assert.equal(
    describeCostCode("6003.30.M", {
      project: "26003 Dallas Rd Block D Roofing",
      element: "Wall cladding - Composite panel",
      resource: "Materials",
    }),
    "project 6003 (26003 Dallas Rd Block D Roofing) · element 30 (Wall cladding - Composite panel) · resource M (Materials)",
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
