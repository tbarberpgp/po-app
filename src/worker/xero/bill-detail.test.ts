// A supplier bill's lines, tracking and attachments, as the bill-detail route
// returns them.
//
//   npm test
//
// The case is Asgard Projects bill 018: the invoice says £3,482.28, Xero holds
// £2,975.97, and the bill check only ever compared the totals.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { summariseBill } from "./bill-detail";
import { parseXeroDate, type XeroBillRaw } from "./client";

const BILL: XeroBillRaw = {
  InvoiceID: "bill-018",
  InvoiceNumber: "018",
  Type: "ACCPAY",
  Status: "PAID",
  Reference: "",
  Total: 2975.97,
  AmountDue: 0,
  Date: "/Date(1787529600000+0000)/",
  Contact: { Name: "Asgard Projects Ltd" },
  HasAttachments: true,
  LineItems: [
    { Description: " Management on site - DALLAS ROAD ", Quantity: 5, UnitAmount: 420, LineAmount: 2100, AccountCode: "320",
      Tracking: [{ Name: "Project", Option: "26001" }] },
    { Description: "Mileage", Quantity: 1, UnitAmount: 217.8, LineAmount: 217.8, AccountCode: "493", Tracking: [] },
    { LineAmount: 658.17 },
  ],
};

describe("summariseBill", () => {
  test("keeps every line, with what it was tracked to", () => {
    const d = summariseBill(BILL, [], parseXeroDate);
    assert.equal(d.number, "018");
    assert.equal(d.contact, "Asgard Projects Ltd");
    assert.equal(d.total, 2975.97);
    assert.equal(d.reference, null, "an empty reference reads as none");
    assert.deepEqual(d.lines.map((l) => [l.description, l.line_amount, l.tracking]), [
      ["Management on site - DALLAS ROAD", 2100, ["Project: 26001"]],
      ["Mileage", 217.8, []],
      ["", 658.17, []],
    ]);
    assert.equal(d.lines[2].quantity, null, "a line without a quantity says so rather than 0");
  });

  test("lists the attached files", () => {
    const d = summariseBill(BILL, [{ AttachmentID: "a1", FileName: "PGP-018.pdf", MimeType: "application/pdf", ContentLength: 256300 }], parseXeroDate);
    assert.deepEqual(d.attachments, [{ id: "a1", file_name: "PGP-018.pdf", mime_type: "application/pdf", size: 256300 }]);
  });

  test("the bill's date comes out as a plain date", () => {
    const d = summariseBill(BILL, [], parseXeroDate);
    assert.equal(d.date, "2026-08-24");
  });
});
