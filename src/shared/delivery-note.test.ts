// Tests for recognising the same delivery note booked twice.
//
//   npm test
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deliveryNoteKey, deliveryNoteFromNotes, isSameDeliveryNote, sameDeliveryNote } from "./delivery-note";

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
