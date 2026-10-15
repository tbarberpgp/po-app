// A delivery note is booked once, against one order.
//
// One PO can take several notes (part-deliveries), but a note belongs to exactly
// one PO. The Alumasc audit found the same note booked twice — Knauf 0013507928
// and 0013515782, Novia 103047 — and each second booking made an order look
// received that never was. The same paper also routinely arrives twice (WhatsApp
// and email both carry it), so the twin has to be recognised, not booked.
//
// Pure helpers here; the worker does the lookup. Kept in `shared/` so the rules
// can be tested without D1.

import { supplierNameOverlap, supplierNameTokens } from "./line-match";

/** Canonical form of a note number: case and punctuation dropped. Null when the
 *  text can't identify a note — blank, or words like "TBC" / "N/A" with no run
 *  of digits to them. */
export function deliveryNoteKey(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if ((s.match(/\d/g) ?? []).length < 3) return null;
  return s;
}

/** The note's digits without leading zeros — the reader keeps "0013507928" on
 *  one scan and drops it to "13507928" on another, or loses a "DN" prefix. */
export function deliveryNoteDigits(raw: string | null | undefined): string {
  const k = deliveryNoteKey(raw);
  return k ? k.replace(/\D/g, "").replace(/^0+/, "") : "";
}

/** Whether two printed note numbers are the same note. */
export function sameDeliveryNote(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = deliveryNoteKey(a), kb = deliveryNoteKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const da = deliveryNoteDigits(a);
  return da.length >= 5 && da === deliveryNoteDigits(b);
}

/** Note numbers only run per supplier, so two firms can both issue "18422".
 *  When both bookings name a supplier they have to be the same firm; when one
 *  doesn't, only a long number is distinctive enough to stand on its own. */
export function isSameDeliveryNote(
  a: { note: string | null | undefined; supplier: string | null | undefined },
  b: { note: string | null | undefined; supplier: string | null | undefined },
): boolean {
  if (!sameDeliveryNote(a.note, b.note)) return false;
  if (supplierNameTokens(a.supplier).size && supplierNameTokens(b.supplier).size) {
    return supplierNameOverlap(a.supplier, b.supplier) >= 0.5 || supplierNameOverlap(b.supplier, a.supplier) >= 0.5;
  }
  return deliveryNoteDigits(a.note).length >= 6;
}

/** The note number the booking form writes into a delivery's notes
 *  ("Delivery note 0013507928") — the only place hand-logged deliveries kept it
 *  before they had a column of their own. */
export function deliveryNoteFromNotes(notes: string | null | undefined): string | null {
  const m = String(notes ?? "").match(/delivery note\s*(?:no\.?|number|#)?\s*:?\s*([A-Za-z0-9][A-Za-z0-9\-/]*)/i);
  return m ? m[1] : null;
}

/** Whether a booking of an already-booked note is its next page rather than a
 *  second copy. A note can run to two pages, and each page arrives as its own
 *  photo — DEL563874 (Alumasc) had the rolls on page 1 and the PIR insulation on
 *  page 2, and the guard refused page 2 as if it were page 1 sent twice.
 *
 *  It is a later page only when it goes on the same order as every earlier
 *  booking of the note, and books lines none of them booked. A whole-order
 *  booking on either side covers every line, so it can't be told apart from a
 *  twin and is refused. */
export function isLaterPageOfNote(
  earlier: Array<{ poId: string | null; lineId: number | null }>,
  incoming: { poId: string | null; lineIds: Array<number | null> },
): boolean {
  if (!earlier.length || !incoming.poId || !incoming.lineIds.length) return false;
  if (incoming.lineIds.some((id) => id == null)) return false;
  const booked = new Set<number>();
  for (const e of earlier) {
    if (e.poId !== incoming.poId || e.lineId == null) return false;
    booked.add(e.lineId);
  }
  return incoming.lineIds.every((id) => !booked.has(id as number));
}
