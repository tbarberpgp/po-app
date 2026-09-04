// Has this order already arrived — and is there anything left to bill?
//
// A PO is delivered across as many drops as the supplier feels like making.
// PO-26003-0038 can carry three delivery notes, and the two screens that ask
// "which order is this against?" — the delivery check-in and the invoice
// matcher — both listed bare order numbers with nothing to say whether the
// order had already been received in full. So the third note against a
// finished order looked exactly like the first note against an open one, and
// the only way to tell them apart was to leave the screen and go and look.
//
// The delivery rule below is not new: it is the one the awaiting list has
// always used (`GET /:projectId/deliveries/po-status`), lifted out so the
// pickers cannot drift from it. What matters about it is that it keys off the
// `completes_po` FLAG rather than comparing quantities, and that is deliberate
// — the note counts packs where the order counts m², so a quantity comparison
// reads a complete delivery as a 98% shortfall. Quantities ARE compared, but
// in `delivery-variance.ts`, and only on the one leg where both sides provably
// name the same unit.

export type PoDeliveryRow = {
  po_id: string;
  /** null = the delivery was logged against the whole order, not one line. */
  po_line_id: number | null;
  completes_po: number;
  // Which NOTE this row arrived on. A delivery note is checked in as one row
  // per PO line it covers, so without these the row count stands in for the
  // note count and one ticket covering five lines reads as five deliveries.
  // All of them are optional: a caller that doesn't select them falls back to
  // the row count, which is what the count has always been.
  /** The supplier's own number for the note, off the scanned ticket. */
  dn?: string | null;
  /** When the goods landed — the other half of the note's identity. */
  delivered_at?: string | null;
  /** The scanned ticket this row was checked in from. */
  scan_id?: number | null;
  /** R2 key of the ticket image — every row of one check-in shares the copy. */
  ticket_key?: string | null;
  /** Written once per check-in, so it groups a manual (ticket-less) drop. */
  created_at?: string | null;
  created_by?: string | null;
};

/**
 * Which delivery note a receipt row belongs to.
 *
 * The keys are tried in order of how firmly they tie rows together.
 *
 * The supplier's note NUMBER plus the delivery DATE comes first, because the
 * scan is not the note — the note is the piece of paper, and one piece of
 * paper gets photographed more than once. A ticket that arrives twice on
 * WhatsApp is checked in twice, from two scans, and read as two deliveries:
 * DEL557528 landed on PO-26001-0028 that way, seventeen minutes apart. Every
 * multi-scan number-and-date group in production is one physical note.
 *
 * The date has to be in that key. Suppliers reuse and mis-read numbers across
 * days — Fixfast's 697728 appears on three different delivery dates, and those
 * ARE three deliveries. Number alone would have merged them.
 *
 * Failing a number: the scan; then the copied ticket file, shared by every row
 * of a check-in that has no scan; then the instant a manual check-in wrote
 * across all its rows. A row carrying none of them is its own note — falling
 * back to the row id says the same thing, since nothing links it to another.
 */
export function deliveryNoteKey(
  r: Pick<PoDeliveryRow, "dn" | "delivered_at" | "scan_id" | "ticket_key" | "created_at" | "created_by"> & { id?: number },
): string {
  if (r.dn && r.delivered_at) return `d:${r.dn}|${r.delivered_at.slice(0, 10)}`;
  if (r.scan_id != null) return `s:${r.scan_id}`;
  if (r.ticket_key) return `t:${r.ticket_key}`;
  if (r.created_at) return `m:${r.created_at}|${r.created_by ?? ""}`;
  return `r:${r.id ?? Math.random()}`;
}

/**
 * What a caller has to SELECT for the counting above to see notes rather than
 * rows, as a SQL fragment. Kept here beside the rule because it has now been
 * threaded through seven queries twice: a new call site that copies the shape
 * gets the whole set, instead of silently falling back to the row count.
 *
 * Assumes `site_deliveries` is aliased `d` and joined with NOTE_JOIN. The PO id
 * is deliberately left out — one caller has to coalesce it against the order it
 * matched by number — so callers add their own.
 */
export const PO_DELIVERY_NOTE_COLUMNS =
  "d.po_line_id, d.completes_po, s.delivery_note_number AS dn, d.delivered_at, d.scan_id, d.ticket_key, d.created_at, d.created_by";

/** The join `PO_DELIVERY_NOTE_COLUMNS` needs to reach the note number. */
export const PO_DELIVERY_NOTE_JOIN =
  "LEFT JOIN delivery_ticket_scans s ON s.id = d.scan_id";

export type PoLineRef = { id: number; po_id: string };

/** How far an order has got: nothing received, some of it, or all of it. */
export type PoDeliveryState = "none" | "part" | "full";

export type PoDeliverySummary = {
  state: PoDeliveryState;
  lines_delivered: number;
  lines_total: number;
  /** Delivery notes logged against the order — DISTINCT notes, not receipt
   *  rows. This is the number that makes "another note for an order that is
   *  already complete" legible at a glance, and it is why the count is carried
   *  separately from the state. */
  drops: number;
};

/**
 * Roll one order's lines and receipts up into a single delivery state.
 *
 * A line is delivered when a receipt assigned to it says it completes, or when
 * a whole-order receipt completes everything. An order with no lines at all can
 * only be completed by a whole-order receipt — inferring "full" from an empty
 * line list would mark every order without line detail as delivered.
 */
export function summarisePoDeliveries(
  poId: string,
  lines: readonly PoLineRef[],
  dels: readonly PoDeliveryRow[],
): PoDeliverySummary {
  const poDels = dels.filter((d) => d.po_id === poId);
  const wholePoDone = poDels.some((d) => d.po_line_id == null && d.completes_po === 1);
  const poLines = lines.filter((l) => l.po_id === poId);
  const delivered = poLines.filter(
    (l) => wholePoDone || poDels.some((d) => d.po_line_id === l.id && d.completes_po === 1),
  ).length;
  const full = wholePoDone || (poLines.length > 0 && delivered === poLines.length);
  // Notes, not rows: one ticket checked in against five lines is one delivery.
  // Rows selected without the grouping columns each key to themselves, so the
  // count degrades to the row count rather than collapsing to 1.
  const notes = new Set(poDels.map((d, i) => deliveryNoteKey({ ...d, id: i })));
  return {
    state: full ? "full" : poDels.length > 0 ? "part" : "none",
    lines_delivered: delivered,
    lines_total: poLines.length,
    drops: notes.size,
  };
}

/** How much of the order's value has been invoiced. */
export type PoBilledState = "none" | "part" | "full" | "over" | "unknown";

/**
 * Billed-to-date against the order's value, on the same 1% tolerance the
 * invoice scan uses for everything else.
 *
 * "unknown" is a real answer, not a fallback: an order carrying no value can
 * have invoices against it and there is nothing to measure them against.
 * Calling that "part billed" would be a guess dressed as a fact, and this
 * feeds a "nothing left to bill" judgement that decides list order.
 */
export function poBilledState(billedNet: number, poValue: number | null | undefined): PoBilledState {
  if (!(billedNet > 0.005)) return "none";
  if (poValue == null || poValue <= 0) return "unknown";
  if (billedNet > poValue * 1.01) return "over";
  if (billedNet >= poValue * 0.99) return "full";
  return "part";
}

/** Nothing left to receive and nothing left to bill — the order is finished.
 *  Finished orders stay pickable everywhere; they just stop competing for
 *  attention with the ones that still need something doing to them. */
export function isPoClosed(delivery: PoDeliveryState, billed: PoBilledState): boolean {
  return delivery === "full" && (billed === "full" || billed === "over");
}

/** The delivery state in the words a buyer would use, followed by how many
 *  delivery notes are behind it.
 *
 *  Both halves of that phrasing were learned the hard way. "3 notes" got read
 *  as three materials on ONE ticket — a count only earns its place if it says
 *  what it is counting, so it is spelled out. And it shows at one as well as
 *  at three: "fully delivered" alone left the reader to guess whether any
 *  paperwork existed, when "1 delivery note" answers it outright. */
export function poDeliveryLabel(d: PoDeliverySummary): string {
  const notes = d.drops > 0 ? ` · ${d.drops} delivery note${d.drops === 1 ? "" : "s"}` : "";
  if (d.state === "full") return `fully delivered${notes}`;
  if (d.state === "part") {
    return d.lines_total > 1
      ? `part delivered · ${d.lines_delivered} of ${d.lines_total} lines${notes}`
      : `part delivered${notes}`;
  }
  return "nothing received";
}

/** One line for a picker option: where the goods are, then whether the money
 *  has followed. The billing half is only worth the width when it changes what
 *  the reader would do — "none" on an undelivered order says nothing. */
export function poStatusHint(d: PoDeliverySummary, billed?: PoBilledState): string {
  const parts = [poDeliveryLabel(d)];
  if (billed === "full") parts.push("fully billed");
  else if (billed === "over") parts.push("billed over the order");
  else if (billed === "part") parts.push("part billed");
  else if (billed === "none" && d.state !== "none") parts.push("not yet billed");
  return parts.join(" · ");
}
