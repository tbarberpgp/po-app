// Tests for the guard that stops an already-booked invoice being edited in the
// app, where the edit would never reach Xero.
//
//   npm test
//
// A push CREATES a Xero bill and there is no update path, so an edit accepted
// afterwards leaves the row and the bill disagreeing with nothing to show which
// is right. The detail page disabled its inputs on a pushed invoice, but the
// PATCH route enforced nothing — so anything that wasn't that form could still
// rewrite the amounts on a booked invoice.
//
// What these pin down: that the gate keys off either marker of "in Xero", that
// it names the fields it refused (so the message is actionable), and above all
// that it stays out of the way of an invoice that hasn't been pushed — a guard
// that locked the inbox would be far worse than the divergence it prevents.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pushedEditRefusal } from "./invoices";

const PUSHED = { status: "pushed", xero_bill_id: "b-1", xero_bill_number: "BILL-9001" };
const INBOX = { status: "new", xero_bill_id: null, xero_bill_number: null };

describe("pushedEditRefusal", () => {
  test("refuses an amount change on a booked invoice, naming the bill", () => {
    const r = pushedEditRefusal(PUSHED, { net_amount: 1234 });
    assert.ok(r, "expected a refusal");
    assert.match(r.error, /already in Xero as draft bill BILL-9001/);
    assert.match(r.error, /net_amount/);
    assert.match(r.error, /Amend the draft bill in Xero/);
  });

  test("names every field it refused, not just the first", () => {
    // The message is the only feedback a non-UI caller gets.
    const r = pushedEditRefusal(PUSHED, { net_amount: 1, vat_amount: 2, supplier_name: "X" });
    assert.ok(r);
    for (const f of ["net_amount", "vat_amount", "supplier_name"]) assert.match(r.error, new RegExp(f));
  });

  test("an unpushed invoice is never refused", () => {
    // The whole inbox lives here: coding, amounts, supplier, all still open.
    for (const k of ["kind", "project_id", "net_amount", "supplier_name", "status"]) {
      assert.equal(pushedEditRefusal(INBOX, { [k]: "v" }), null, `${k} should be editable`);
    }
  });

  test("a bill id alone is enough to refuse, without the status", () => {
    // A push that set the id but not the status, or a hand-edited row.
    const r = pushedEditRefusal({ status: "approved", xero_bill_id: "b-2", xero_bill_number: null }, { gross_amount: 9 });
    assert.ok(r, "expected a refusal");
    assert.match(r.error, /already in Xero as draft bill b-2/);
  });

  test("the pushed status alone is enough to refuse, without a bill id", () => {
    const r = pushedEditRefusal({ status: "pushed", xero_bill_id: null, xero_bill_number: null }, { net_amount: 9 });
    assert.ok(r, "expected a refusal");
    // Nothing to name the bill by, so the sentence has to still read properly.
    assert.match(r.error, /already in Xero, so net_amount can't be changed here/);
  });

  test("status can't be cleared to unlock a booked invoice", () => {
    // Otherwise this gate and the UI lock are both one PATCH away from gone.
    assert.ok(pushedEditRefusal(PUSHED, { status: "new" }), "clearing status should be refused");
  });

  test("notes stay editable after a push", () => {
    // They never went to Xero, so annotating a booked invoice diverges nothing
    // — and being unable to note anything on it would be its own problem.
    assert.equal(pushedEditRefusal(PUSHED, { notes: "queried with the supplier" }), null);
  });

  test("a body carrying no editable field is not refused", () => {
    // An empty PATCH already short-circuits to ok; refusing it would only give
    // a booked invoice a 409 for having asked to change nothing.
    assert.equal(pushedEditRefusal(PUSHED, {}), null);
  });

  test("a field set to null is still a change, so still refused", () => {
    // `k in body` on purpose: clearing the supplier is as much a divergence as
    // renaming it, and `body.supplier_name` alone would read as absent.
    assert.ok(pushedEditRefusal(PUSHED, { supplier_name: null }));
  });
});
