import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoney, parsePositiveMoney } from "./money";

// The three cases that were failing in the certify prompt. Number() gives NaN
// for all of them, which is what made "Invalid amount" reachable by typing
// money correctly.
test("parses money written the way people write it", () => {
  assert.equal(parseMoney("1,250.00"), 1250);
  assert.equal(parseMoney("£1250"), 1250);
  assert.equal(parseMoney("£1,250.00"), 1250);
});

test("plain numbers still work", () => {
  assert.equal(parseMoney("1250"), 1250);
  assert.equal(parseMoney("1250.5"), 1250.5);
  assert.equal(parseMoney("1250.55"), 1250.55);
  assert.equal(parseMoney(" 1250 "), 1250);
  assert.equal(parseMoney("0"), 0);
  assert.equal(parseMoney(".5"), 0.5);
  assert.equal(parseMoney("5."), 5);
});

test("strips currency symbols and codes on either side", () => {
  assert.equal(parseMoney("$1,250"), 1250);
  assert.equal(parseMoney("€1.250,00"), 1250);
  assert.equal(parseMoney("1250 GBP"), 1250);
  assert.equal(parseMoney("gbp 1,250.00"), 1250);
});

test("handles the space and apostrophe grouping that Excel pastes in", () => {
  assert.equal(parseMoney("1 250,00"), 1250);
  assert.equal(parseMoney("1 250.00"), 1250);   // non-breaking space
  assert.equal(parseMoney("1 250.00"), 1250);   // thin space
  assert.equal(parseMoney("1'250.00"), 1250);
});

test("when both separators appear, the later one is the decimal point", () => {
  assert.equal(parseMoney("1,250.00"), 1250);        // UK / US
  assert.equal(parseMoney("1.250,00"), 1250);        // continental
  assert.equal(parseMoney("1,250,000.50"), 1250000.5);
  assert.equal(parseMoney("1.250.000,50"), 1250000.5);
});

test("a lone comma is a thousands mark only in groups of three", () => {
  assert.equal(parseMoney("1,250"), 1250);
  assert.equal(parseMoney("1,250,000"), 1250000);
  assert.equal(parseMoney("12,500"), 12500);
  assert.equal(parseMoney("1,25"), 1.25);            // continental decimal
  assert.equal(parseMoney("1,5"), 1.5);
});

test("a lone dot groups only when it repeats", () => {
  assert.equal(parseMoney("1.250"), 1.25);           // reads as a decimal
  assert.equal(parseMoney("1.250.000"), 1250000);    // repeated → grouping
});

test("negatives parse, in both notations", () => {
  assert.equal(parseMoney("-1250"), -1250);
  assert.equal(parseMoney("-£1,250.00"), -1250);
  assert.equal(parseMoney("£-1250"), -1250);
  assert.equal(parseMoney("(1,250)"), -1250);
  assert.equal(parseMoney("(£1,250.00)"), -1250);
});

test("rounds to pence, so nothing sub-penny reaches a Xero line", () => {
  assert.equal(parseMoney("1250.567"), 1250.57);
  assert.equal(parseMoney("1250.564"), 1250.56);
  assert.equal(parseMoney("0.005"), 0.01);
});

test("rejects what isn't a figure rather than guessing", () => {
  for (const bad of ["", "   ", "abc", "1250abc", "£", "-", ".", ",", "--5",
                     "1..5", "1,,5", "1.2.3,4,5", "12 34 56.7.8", "NaN", "1e5x"]) {
    assert.equal(parseMoney(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney(undefined), null);
});

test("parsePositiveMoney refuses a negative", () => {
  assert.equal(parsePositiveMoney("1,250.00"), 1250);
  assert.equal(parsePositiveMoney("0"), 0);
  assert.equal(parsePositiveMoney("-1250"), null);
  assert.equal(parsePositiveMoney("(1,250)"), null);
  assert.equal(parsePositiveMoney("abc"), null);
});
