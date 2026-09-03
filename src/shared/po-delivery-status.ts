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
};

export type PoLineRef = { id: number; po_id: string };

/** How far an order has got: nothing received, some of it, or all of it. */
export type PoDeliveryState = "none" | "part" | "full";

export type PoDeliverySummary = {
  state: PoDeliveryState;
  lines_delivered: number;
  lines_total: number;
  /** Delivery notes logged against the order. This is the number that makes
   *  "another note for an order that is already complete" legible at a glance,
   *  and it is why the count is carried separately from the state. */
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
  return {
    state: full ? "full" : poDels.length > 0 ? "part" : "none",
    lines_delivered: delivered,
    lines_total: poLines.length,
    drops: poDels.length,
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

/** The delivery state in the words a buyer would use, with the note count when
 *  more than one has landed — "fully delivered · 3 notes" is the whole point of
 *  the exercise, so it is never abbreviated away. */
export function poDeliveryLabel(d: PoDeliverySummary): string {
  const notes = d.drops > 1 ? ` · ${d.drops} notes` : "";
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
