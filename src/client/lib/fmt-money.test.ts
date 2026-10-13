import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtMoney } from "./api";

test("fmtMoney never prints a negative zero", () => {
  assert.equal(fmtMoney(-0), "£0.00");
  assert.equal(fmtMoney(-0.001), "£0.00");
  assert.equal(fmtMoney(0), "£0.00");
});

test("fmtMoney keeps real signs", () => {
  assert.equal(fmtMoney(-366.58), "-£366.58");
  assert.equal(fmtMoney(-0.01), "-£0.01");
  assert.equal(fmtMoney(14208.33), "£14,208.33");
});
