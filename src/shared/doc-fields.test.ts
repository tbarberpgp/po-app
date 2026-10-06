import { test } from "node:test";
import assert from "node:assert/strict";
import { norm, writtenForms, textConfirms } from "./doc-fields";

test("norm strips everything that varies between printings", () => {
  assert.equal(norm("PO-26003-0040"), "po260030040");
  assert.equal(norm("£1,250.00"), "125000");
  assert.equal(norm("  Alumasc  Ltd. "), "alumascltd");
});

test("a date is recognised however the supplier prints it", () => {
  const forms = writtenForms("2026-09-26");
  for (const printed of ["26/09/2026", "26 September 2026", "26 Sep 2026", "26.09.2026", "26/9/2026"]) {
    assert.ok(forms.includes(norm(printed)), `${printed} should be a written form`);
  }
});

test("an amount is recognised with or without separators", () => {
  const forms = writtenForms("1250");
  assert.ok(forms.includes(norm("1,250.00")));
  assert.ok(forms.includes(norm("1250.00")));
});

test("a box is confirmed when its text carries the value", () => {
  assert.ok(textConfirms("Order No: PO-26003-0040", "PO-26003-0040"));
  assert.ok(textConfirms("PO 26003 0040", "PO-26003-0040"));
  // The box caught only the number, not the label — still the right place.
  assert.ok(textConfirms("260030040", "PO-26003-0040"));
  assert.ok(textConfirms("Delivered 26/09/2026", "2026-09-26"));
});

// The whole point of the check: a box over the wrong text is thrown away.
test("a box is refused when its text is something else", () => {
  assert.equal(textConfirms("Alumasc Building Products", "PO-26003-0040"), false);
  assert.equal(textConfirms("Delivery Note No 704875", "PO-26003-0040"), false);
  assert.equal(textConfirms("", "PO-26003-0040"), false);
  assert.equal(textConfirms("Invoice Date", "2026-09-26"), false);
});

test("no value means no box, however plausible the text", () => {
  assert.equal(textConfirms("PO-26003-0040", ""), false);
  assert.equal(textConfirms("anything", "   "), false);
});

// A two-character "match" would land on half the page.
test("fragments too short to locate anything are refused", () => {
  assert.equal(textConfirms("A", "A"), false);
  assert.deepEqual(writtenForms("12"), []);
});
