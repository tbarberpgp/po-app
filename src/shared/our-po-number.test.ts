import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeOurPoNumber } from "./line-match";

test("our own order numbers are recognised", () => {
  for (const s of ["PO-26003-0040", "PO-26001-0085", "PO-26004-0008"]) {
    assert.ok(looksLikeOurPoNumber(s), s);
  }
});

test("call-offs carry a suffix and are still ours", () => {
  for (const s of ["PO-26001-0013-C1", "PO-26002-0004-C2", "PO-26003-0020-C3"]) {
    assert.ok(looksLikeOurPoNumber(s), s);
  }
});

// Job 25008 exists — the second digit is not always 6.
test("a job that isn't 26xxx is still ours", () => {
  assert.ok(looksLikeOurPoNumber("PO-25008-0001"));
});

// How it is written doesn't change which order it is.
test("ours written carelessly is still ours", () => {
  for (const s of ["026003-0020", "PO 26003 0020", "po-26004-0008", "PO26003-0040", "P.O. 26003-0040"]) {
    assert.ok(looksLikeOurPoNumber(s), s);
  }
});

// The whole point: these are what suppliers actually print where ours goes.
test("a supplier's own reference is not ours", () => {
  for (const s of ["POR117594", "SOR458448", "1204155", "Q164563/AD28/07", "POWFILLERS2909", "55551", "161247935", "AD2906"]) {
    assert.equal(looksLikeOurPoNumber(s), false, s);
  }
});

test("a site name is not an order number", () => {
  for (const s of ["DALLAS ROAD", "DALLAS ROAD C2", "Blyth"]) {
    assert.equal(looksLikeOurPoNumber(s), false, s);
  }
});

test("demo and empty references are not ours", () => {
  for (const s of ["DEMO", "PO-DEMO-0001", "", "   ", null, undefined]) {
    assert.equal(looksLikeOurPoNumber(s), false, String(s));
  }
});
