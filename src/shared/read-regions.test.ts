import { test } from "node:test";
import assert from "node:assert/strict";
import { clampRegion, cleanRegion } from "./read-regions";

const box = { x: 0.62, y: 0.11, w: 0.2, h: 0.03 };

test("a box whose text carries the value is kept", () => {
  assert.deepEqual(cleanRegion({ ...box, text: "Order No: PO-26003-0040" }, "PO-26003-0040"), box);
});

// The failure that had field boxes withdrawn: coordinates over the letterhead,
// reported as the PO number.
test("a box over the wrong text is thrown away", () => {
  assert.equal(cleanRegion({ ...box, text: "Alumasc Building Products Ltd" }, "PO-26003-0040"), null);
});

test("a box with no transcription is thrown away", () => {
  assert.equal(cleanRegion(box, "PO-26003-0040"), null);
  assert.equal(cleanRegion({ ...box, text: "" }, "PO-26003-0040"), null);
});

test("a value with no box, and a box with no value, both yield nothing", () => {
  assert.equal(cleanRegion(null, "PO-26003-0040"), null);
  assert.equal(cleanRegion({ ...box, text: "PO-26003-0040" }, ""), null);
  assert.equal(cleanRegion({ ...box, text: "PO-26003-0040" }, null), null);
});

test("0-100 coordinates are read as percentages", () => {
  const r = cleanRegion({ x: 62, y: 11, w: 20, h: 3, text: "PO-26003-0040" }, "PO-26003-0040");
  assert.ok(r && Math.abs(r.x - 0.62) < 1e-9 && Math.abs(r.w - 0.2) < 1e-9);
});

test("a box swallowing the page points at nothing and is refused", () => {
  assert.equal(clampRegion({ x: 0, y: 0, w: 1, h: 1 }), null);
  assert.equal(cleanRegion({ x: 0, y: 0, w: 1, h: 1, text: "PO-26003-0040" }, "PO-26003-0040"), null);
});

test("a box is clipped to the page rather than overflowing it", () => {
  const r = clampRegion({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 });
  assert.ok(r && r.x === 0.9 && r.y === 0.9);
  assert.ok(r && Math.abs(r.w - 0.1) < 1e-9 && Math.abs(r.h - 0.1) < 1e-9);
});

test("nonsense geometry is refused", () => {
  for (const bad of [{ x: -0.1, y: 0, w: 0.2, h: 0.2 }, { x: 0, y: 0, w: 0, h: 0.2 }, { x: "a", y: 0, w: 0.2, h: 0.2 }, {}]) {
    assert.equal(clampRegion({ ...bad, text: "x" }), null);
  }
});

// A date is the same date however the supplier prints it.
test("a date box is kept when the page writes the date its own way", () => {
  assert.deepEqual(cleanRegion({ ...box, text: "Delivered 26/09/2026" }, "2026-09-26"), box);
  assert.equal(cleanRegion({ ...box, text: "Invoice Date" }, "2026-09-26"), null);
});
