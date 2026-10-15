// Tests for recognising the same delivery note booked twice.
//
//   npm test
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deliveryNoteKey, deliveryNoteFromNotes, isSameDeliveryNote, mayRebookNote, sameDeliveryNote } from "./delivery-note";

describe("deliveryNoteKey", () => {
  test("drops case and punctuation", () => {
    assert.equal(deliveryNoteKey(" del-512 345 "), "DEL512345");
  });
  test("words with no number identify nothing", () => {
    assert.equal(deliveryNoteKey("TBC"), null);
    assert.equal(deliveryNoteKey("N/A"), null);
    assert.equal(deliveryNoteKey(""), null);
    assert.equal(deliveryNoteKey(null), null);
  });
});

describe("sameDeliveryNote", () => {
  test("a dropped leading zero is the same note (Knauf 0013507928)", () => {
    assert.ok(sameDeliveryNote("0013507928", "13507928"));
  });
  test("a dropped DN prefix is the same note", () => {
    assert.ok(sameDeliveryNote("DN 103047", "103047"));
  });
  test("different numbers are different notes", () => {
    assert.ok(!sameDeliveryNote("0013507928", "0013515782"));
  });
  test("short numbers must match exactly, not by digits alone", () => {
    assert.ok(!sameDeliveryNote("A123", "B123"));
  });
});

describe("isSameDeliveryNote", () => {
  test("same note, same supplier spelled two ways", () => {
    assert.ok(isSameDeliveryNote(
      { note: "103047", supplier: "Novia" },
      { note: "103047", supplier: "Novia Ltd" },
    ));
  });
  test("same number from two different suppliers is two notes", () => {
    assert.ok(!isSameDeliveryNote(
      { note: "18422", supplier: "One Stop Aerosols" },
      { note: "18422", supplier: "Fixfast Ltd" },
    ));
  });
  test("an unnamed supplier still matches on a long number", () => {
    assert.ok(isSameDeliveryNote({ note: "0013507928", supplier: null }, { note: "13507928", supplier: "Knauf" }));
  });
  test("an unnamed supplier does not match on a short one", () => {
    assert.ok(!isSameDeliveryNote({ note: "18422", supplier: "" }, { note: "18422", supplier: "Fixfast Ltd" }));
  });
});

describe("deliveryNoteFromNotes", () => {
  test("reads the number the booking form writes", () => {
    assert.equal(deliveryNoteFromNotes("Delivery note 0013507928"), "0013507928");
    assert.equal(deliveryNoteFromNotes("Short 2 bags. Delivery note: DEL512345"), "DEL512345");
  });
  test("nothing when it isn't there", () => {
    assert.equal(deliveryNoteFromNotes("Checked in from WhatsApp delivery ticket"), null);
  });
});

describe("mayRebookNote", () => {
  // PO-26008-0004 as it stood: DEL563874 booked the four rolls/adhesive lines,
  // the PIR (1887) and two more lines still to come.
  const po = "po-4";
  const lines = [1883, 1884, 1885, 1886, 1887, 1888, 1889].map((id) => ({ id, po_id: po, qty: 10 }));
  const drop1 = [1883, 1884, 1885, 1886].map((po_line_id) => ({ po_id: po, po_line_id, completes_po: 1, received_qty: 10 }));
  const earlier = drop1.map(() => ({ poId: po }));
  test("the next drop under the same number, on a part-delivered order, is allowed", () => {
    assert.ok(mayRebookNote(earlier, { poId: po, lineIds: [1887] }, lines, drop1));
  });
  test("the same ticket sent twice re-books finished lines, so it is refused", () => {
    assert.ok(!mayRebookNote(earlier, { poId: po, lineIds: [1884] }, lines, drop1));
  });
  test("topping up a line that is only part received is allowed", () => {
    const part = [...drop1, { po_id: po, po_line_id: 1887, completes_po: 0, received_qty: 4 }];
    assert.ok(mayRebookNote(earlier, { poId: po, lineIds: [1887] }, lines, part));
  });
  test("an order already fully delivered is refused", () => {
    const all = lines.map((l) => ({ po_id: po, po_line_id: l.id, completes_po: 1, received_qty: 10 }));
    assert.ok(!mayRebookNote(earlier, { poId: po, lineIds: [null] }, lines, all));
  });
  test("a whole-order receipt that closed the order is refused", () => {
    const closed = [{ po_id: po, po_line_id: null, completes_po: 1 }];
    assert.ok(!mayRebookNote([{ poId: po }], { poId: po, lineIds: [1887] }, lines, closed));
  });
  test("a different order is refused — a note belongs to one PO", () => {
    assert.ok(!mayRebookNote(earlier, { poId: "po-9", lineIds: [1887] }, lines, drop1));
  });
  test("no PO on the new booking is refused", () => {
    assert.ok(!mayRebookNote(earlier, { poId: null, lineIds: [1887] }, lines, drop1));
  });
  test("a line that isn't on the order is refused", () => {
    assert.ok(!mayRebookNote(earlier, { poId: po, lineIds: [9999] }, lines, drop1));
  });
});
