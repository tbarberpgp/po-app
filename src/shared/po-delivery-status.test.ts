// Tests for the PO-level delivery/billing state shown in the order pickers.
//
//   npm test
//
// The cases that matter here are the ones that made the pickers confusing in
// the first place: a second note against an order that is already complete, a
// part-load that must NOT read as finished, and an order with no line detail
// at all. The rule is shared by the delivery check-in, the invoice matcher and
// the awaiting list, so a change to it moves three screens at once.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  summarisePoDeliveries,
  deliveryNoteKey,
  poBilledState,
  isPoClosed,
  poDeliveryLabel,
  poStatusHint,
  type PoDeliveryRow,
  type PoLineRef,
} from "./po-delivery-status";

const lines: PoLineRef[] = [
  { id: 1, po_id: "po-a" },
  { id: 2, po_id: "po-a" },
  { id: 9, po_id: "po-b" },
];
const del = (po_id: string, po_line_id: number | null, completes_po = 1): PoDeliveryRow =>
  ({ po_id, po_line_id, completes_po });

describe("summarisePoDeliveries", () => {
  test("no receipts at all reads as nothing received", () => {
    const s = summarisePoDeliveries("po-a", lines, []);
    assert.equal(s.state, "none");
    assert.equal(s.drops, 0);
    assert.equal(s.lines_delivered, 0);
    assert.equal(s.lines_total, 2);
  });

  test("one line of two complete is a part delivery", () => {
    const s = summarisePoDeliveries("po-a", lines, [del("po-a", 1)]);
    assert.equal(s.state, "part");
    assert.equal(s.lines_delivered, 1);
  });

  test("every line complete is a full delivery", () => {
    const s = summarisePoDeliveries("po-a", lines, [del("po-a", 1), del("po-a", 2)]);
    assert.equal(s.state, "full");
    assert.equal(s.drops, 2);
  });

  // The whole point of completes_po: a drop that does not close the line leaves
  // the order open however many of them land.
  test("part-load receipts never add up to a full delivery", () => {
    const s = summarisePoDeliveries("po-a", lines, [
      del("po-a", 1, 0), del("po-a", 1, 0), del("po-a", 2, 0),
    ]);
    assert.equal(s.state, "part");
    assert.equal(s.lines_delivered, 0);
    assert.equal(s.drops, 3);
  });

  test("a whole-order receipt completes lines it never named", () => {
    const s = summarisePoDeliveries("po-a", lines, [del("po-a", null)]);
    assert.equal(s.state, "full");
    assert.equal(s.lines_delivered, 2);
  });

  // Guard: "every line is delivered" is vacuously true of no lines, which would
  // mark every order without line detail as fully delivered.
  test("an order with no lines is not full without a whole-order receipt", () => {
    assert.equal(summarisePoDeliveries("po-c", lines, []).state, "none");
    assert.equal(summarisePoDeliveries("po-c", lines, [del("po-c", null, 0)]).state, "part");
    assert.equal(summarisePoDeliveries("po-c", lines, [del("po-c", null)]).state, "full");
  });

  test("another order's receipts and lines don't leak in", () => {
    const s = summarisePoDeliveries("po-a", lines, [del("po-b", 9), del("po-b", null)]);
    assert.equal(s.state, "none");
    assert.equal(s.drops, 0);
    assert.equal(s.lines_total, 2);
  });
});

describe("counting notes rather than rows", () => {
  // The count feeds "fully delivered · 3 notes", and a note is checked in as
  // one ROW PER PO LINE it covers. Counting rows made one van turning up once
  // against five lines read as five separate deliveries — PO-26001-0013 in
  // production carries 16 rows from 3 notes.
  const scanned = (scan_id: number, po_line_id: number): PoDeliveryRow =>
    ({ po_id: "po-a", po_line_id, completes_po: 1, scan_id, created_at: "2026-08-01T09:00:00.000Z", created_by: "site@x" });

  test("one scanned ticket across three lines is one note", () => {
    const s = summarisePoDeliveries("po-a", lines, [scanned(7, 1), scanned(7, 2), scanned(7, 1)]);
    assert.equal(s.drops, 1);
    assert.equal(s.state, "full");
  });

  test("separate tickets stay separate notes", () => {
    assert.equal(summarisePoDeliveries("po-a", lines, [scanned(7, 1), scanned(8, 2)]).drops, 2);
  });

  test("a ticket with no scan groups on the copied ticket file", () => {
    const row = (ticket_key: string, po_line_id: number): PoDeliveryRow =>
      ({ po_id: "po-a", po_line_id, completes_po: 0, ticket_key });
    const s = summarisePoDeliveries("po-a", lines, [row("k/1.jpg", 1), row("k/1.jpg", 2), row("k/2.jpg", 1)]);
    assert.equal(s.drops, 2);
  });

  // A manual check-in has neither a scan nor a ticket; every row of one is
  // written with the same instant, which is the only thing tying them together.
  test("a manual check-in groups on the instant it was logged", () => {
    const row = (created_at: string, po_line_id: number): PoDeliveryRow =>
      ({ po_id: "po-a", po_line_id, completes_po: 0, created_at, created_by: "admin@x" });
    const s = summarisePoDeliveries("po-a", lines, [
      row("2026-08-01T09:00:00.000Z", 1), row("2026-08-01T09:00:00.000Z", 2),
      row("2026-08-04T14:22:11.000Z", 1),
    ]);
    assert.equal(s.drops, 2);
  });

  test("the same instant from two people is two check-ins", () => {
    const at = "2026-08-01T09:00:00.000Z";
    const s = summarisePoDeliveries("po-a", lines, [
      { po_id: "po-a", po_line_id: 1, completes_po: 0, created_at: at, created_by: "a@x" },
      { po_id: "po-a", po_line_id: 2, completes_po: 0, created_at: at, created_by: "b@x" },
    ]);
    assert.equal(s.drops, 2);
  });

  // Callers that don't select the grouping columns keep the old count rather
  // than collapsing every row into one phantom note.
  test("rows with nothing to group on are each their own note", () => {
    const s = summarisePoDeliveries("po-a", lines, [del("po-a", 1, 0), del("po-a", 1, 0), del("po-a", 2, 0)]);
    assert.equal(s.drops, 3);
  });

  test("the key prefers the scan, then the ticket, then the check-in", () => {
    assert.equal(deliveryNoteKey({ scan_id: 7, ticket_key: "k", created_at: "t", created_by: "u" }), "s:7");
    assert.equal(deliveryNoteKey({ scan_id: null, ticket_key: "k", created_at: "t" }), "t:k");
    assert.equal(deliveryNoteKey({ created_at: "t", created_by: "u" }), "m:t|u");
    assert.equal(deliveryNoteKey({ id: 4 }), "r:4");
  });
});

describe("poBilledState", () => {
  test("nothing billed", () => {
    assert.equal(poBilledState(0, 1000), "none");
  });
  test("part, full and over, on the 1% tolerance", () => {
    assert.equal(poBilledState(400, 1000), "part");
    assert.equal(poBilledState(995, 1000), "full");
    assert.equal(poBilledState(1000, 1000), "full");
    assert.equal(poBilledState(1200, 1000), "over");
  });
  // An order with no value can carry invoices and there is nothing to measure
  // them against — saying "part billed" would be inventing the denominator.
  test("no order value to measure against is unknown, not part", () => {
    assert.equal(poBilledState(500, null), "unknown");
    assert.equal(poBilledState(500, 0), "unknown");
    assert.equal(poBilledState(0, null), "none");
  });
});

describe("isPoClosed", () => {
  test("closed needs both legs finished", () => {
    assert.equal(isPoClosed("full", "full"), true);
    assert.equal(isPoClosed("full", "over"), true);
    assert.equal(isPoClosed("full", "none"), false);
    assert.equal(isPoClosed("full", "part"), false);
    assert.equal(isPoClosed("part", "full"), false);
    assert.equal(isPoClosed("none", "none"), false);
  });
  // The case that decides whether this feature helps or hurts: goods in, not
  // yet invoiced, is the order an incoming invoice is most likely FOR.
  test("delivered but unbilled is not closed", () => {
    assert.equal(isPoClosed("full", "none"), false);
    assert.equal(isPoClosed("full", "unknown"), false);
  });
});

describe("labels", () => {
  // "3 notes" was read as three materials on one ticket, so the label names
  // what it counts and says it at one as well as at three.
  test("the note count survives into the label, spelled out", () => {
    assert.equal(poDeliveryLabel({ state: "full", lines_delivered: 2, lines_total: 2, drops: 3 }), "fully delivered · 3 delivery notes");
    assert.equal(poDeliveryLabel({ state: "full", lines_delivered: 1, lines_total: 1, drops: 1 }), "fully delivered · 1 delivery note");
    assert.equal(poDeliveryLabel({ state: "part", lines_delivered: 1, lines_total: 4, drops: 2 }), "part delivered · 1 of 4 lines · 2 delivery notes");
    assert.equal(poDeliveryLabel({ state: "part", lines_delivered: 0, lines_total: 1, drops: 1 }), "part delivered · 1 delivery note");
    // Nothing received is nothing to count — "0 delivery notes" would be noise.
    assert.equal(poDeliveryLabel({ state: "none", lines_delivered: 0, lines_total: 2, drops: 0 }), "nothing received");
  });

  test("the billing half only shows when it changes the reading", () => {
    const full = { state: "full" as const, lines_delivered: 1, lines_total: 1, drops: 1 };
    const none = { state: "none" as const, lines_delivered: 0, lines_total: 1, drops: 0 };
    assert.equal(poStatusHint(full, "none"), "fully delivered · 1 delivery note · not yet billed");
    assert.equal(poStatusHint(full, "full"), "fully delivered · 1 delivery note · fully billed");
    assert.equal(poStatusHint(full, "over"), "fully delivered · 1 delivery note · billed over the order");
    // Nothing received and nothing billed is one fact, not two.
    assert.equal(poStatusHint(none, "none"), "nothing received");
    assert.equal(poStatusHint(full, "unknown"), "fully delivered · 1 delivery note");
  });
});
