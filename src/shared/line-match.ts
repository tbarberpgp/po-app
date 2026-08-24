// Primitives for tying an invoice line to the PO line it bills against, and the
// over-billing scan built on them. Kept in `shared/` (no D1, no Hono, no Workers
// globals) so the same code the worker runs can be exercised from a harness —
// see scripts/overbill-harness.ts.

/** Normalise wording for equality: case and punctuation carry no meaning when
 *  comparing a supplier's line text to our own ("L bar" ≡ "L Bar"). */
export function normText(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Leading product-code token of a line, normalised for matching
 *  ("SAVBRF - Euroroof…" → "SAVBRF"). Mirrors the operations/client matcher. */
export function invMaterialCode(s: string): string {
  const first = (s || "").trim().split(/\s+/)[0] || "";
  return first.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Our PO numbers are PO-<5-digit project>-<4-digit sequence>, optionally a
 *  call-off suffix (-C1, -C2). Returns "<project>-<sequence>", or null when the
 *  text isn't one of ours.
 *
 *  The null case is the point. Suppliers print whatever they like in their "your
 *  ref" field — a contact name ("TOM BARBER"), a site ("DALLAS ROAD"), their own
 *  quote number ("Q164563/AD28/07"), a date ("AD 23/06"). On the current book 70
 *  of 99 refs are text like that, and comparing them to a PO number says nothing.
 *  Only a ref that parses as one of ours is worth comparing. */
export function poRefCore(s: string | null | undefined): string | null {
  const m = /(?<!\d)(\d{5})\D{1,3}(\d{4})(?!\d)/.exec(String(s ?? ""));
  return m ? `${m[1]}-${m[2]}` : null;
}

/** Sentinel po_line_id meaning "explicitly a service/misc charge, not a product
 *  line" — a human picked this deliberately, so it counts as matched but is
 *  excluded from qty/value variance checks. */
export const SERVICE_CHARGE_LINE_ID = -1;

export type InvLine = {
  description?: string;
  qty?: number | null;
  quantity?: number | null;
  unit_price?: number | null;
  amount?: number | null;
  account_code?: string | null;
  po_line_id?: number | null;
};

export type PoLineRow = {
  id: number;
  po_id?: string;
  item: string;
  qty: number | null;
  unit?: string | null;
  unit_cost: number | null;
};

/** Billed quantity for an invoice line. Extraction writes `quantity`; older
 *  manual rows use `qty`. Both must be honoured — reading only `qty` treats every
 *  extracted invoice as quantity-less, which silently disables the over-qty
 *  check, suppresses the rate comparison whenever totals disagree, and makes
 *  "not delivered" measure against the whole PO line instead of what's billed. */
export function lineQty(l: InvLine): number | null {
  if (typeof l.qty === "number") return l.qty;
  if (typeof l.quantity === "number") return l.quantity;
  return null;
}

/** Why one invoice line doesn't reconcile with the order line it bills against.
 *
 *  `wrong_po`      — the invoice prints one of our PO numbers and it isn't the one
 *                    linked. The most serious kind: if the wrong order is linked,
 *                    every price and quantity comparison beneath it is meaningless.
 *  `cross_project` — the linked order belongs to a different job than the invoice
 *                    is coded to. Either the coding or the link is wrong.
 *  `unlinked` — the line couldn't be tied to any line on the order. Usually a
 *  service, carriage or misc charge that nobody marked as a service charge.
 *  `rate`     — linked, but billed at a rate we didn't agree.
 *  `over`     — linked, but the line bills more value than was ordered. `why`
 *               says which figure moved: more units at the agreed rate (`qty`),
 *               the same units at a dearer rate (`rate`), or a higher total on a
 *               different unit basis (`value`).
 *
 *  Deliberately NOT an issue: billing FEWER units than ordered. Part-deliveries
 *  are normal — 400m invoiced against a 500m order is a correct invoice, and
 *  flagging it would put a warning on ordinary business. Measured on the current
 *  book, treating any quantity difference as a mismatch marks 38% of invoices;
 *  this definition marks 35%, and the 9 it drops are all genuine part-invoices. */
export type MatchIssue =
  | { kind: "wrong_po"; quoted: string; linked: string }
  | { kind: "cross_project"; invoice_project: string; po_project: string; linked: string }
  | { kind: "unlinked"; item: string }
  | { kind: "rate"; item: string; billed: number; ordered: number }
  | { kind: "over"; item: string; billed: number; ordered: number; excess: number; why: "qty" | "rate" | "value" };

/** Reconciliation of an invoice against its matched PO, on price and quantity
 *  only — the delivery leg is not consulted. `excess` totals the value billed
 *  above the order across all lines (0 when nothing is over). */
export type MatchSummary = { state: "matched" | "unmatched" | "no_po"; issues: MatchIssue[]; excess: number };

/**
 * Reconcile an invoice's lines against its PO's lines on price and quantity —
 * cheap enough to run across a whole invoice list, and the source of the
 * matched/unmatched state on the Accounts dashboard.
 *
 * The over-value test is gated on LINE VALUE, not on quantity. Suppliers bill a
 * different unit basis to the order (3,000 fasteners at £0.17 against an order for
 * 40 boxes at £17.20); comparing those quantities head-on flags most of the book
 * while the money is identical. Only once a line's billed value genuinely exceeds
 * the ordered value do the qty/rate figures explain WHY — the same reasoning as the
 * "VALUE FIRST" rule in computeInvoiceMatch, and the same 1% / £1 tolerance.
 *
 * Nothing here consults deliveries. 53 invoices on the current book have no site
 * receipt at all, so including the delivery leg would mark almost everything and
 * the state would carry no information.
 *
 * Conservative on linking: stored link, then exact wording, then leading product
 * code — no learned aliases, so a line the running app would match via a learned
 * alias may report as unlinked here. The state stays visible on approved invoices,
 * so a false positive is expensive; erring toward "say something" on an unlinked
 * line is deliberate, since marking it as a service charge clears it in one click.
 */
export type PoContext = {
  po_number?: string | null;
  po_project?: string | null;
  invoice_project?: string | null;
  quoted_ref?: string | null;
};

export function scanLineMatch(invLines: InvLine[], poLines: PoLineRow[], po?: PoContext): MatchSummary {
  const taken = new Set<number>();
  const issues: MatchIssue[] = [];

  // PO-level checks first — they come before the line detail because they can
  // invalidate all of it. A price agreeing with the wrong order proves nothing.
  if (po) {
    const quoted = poRefCore(po.quoted_ref);
    const linked = poRefCore(po.po_number);
    if (quoted && linked && quoted !== linked) {
      issues.push({ kind: "wrong_po", quoted: String(po.quoted_ref), linked: String(po.po_number) });
    }
    if (po.invoice_project && po.po_project && po.invoice_project !== po.po_project) {
      issues.push({
        kind: "cross_project", invoice_project: po.invoice_project,
        po_project: po.po_project, linked: String(po.po_number),
      });
    }
  }
  for (const il of invLines) {
    if (il.po_line_id === SERVICE_CHARGE_LINE_ID) continue;
    let pl = il.po_line_id ? poLines.find((p) => p.id === il.po_line_id) : null;
    if (!pl) pl = poLines.find((p) => normText(p.item) === normText(il.description)) || null;
    if (!pl) {
      const code = invMaterialCode(il.description ?? "");
      if (code.length >= 3) pl = poLines.find((p) => invMaterialCode(p.item) === code && !taken.has(p.id)) || null;
    }
    if (!pl) {
      issues.push({ kind: "unlinked", item: il.description || "unnamed line" });
      continue;
    }
    taken.add(pl.id);

    const qty = lineQty(il);
    const rate = typeof il.unit_price === "number" ? il.unit_price : null;
    const billed = typeof il.amount === "number" ? il.amount : (qty != null && rate != null ? qty * rate : null);
    const ordered = pl.qty != null && pl.unit_cost != null ? pl.qty * pl.unit_cost : null;

    // A rate we didn't agree is worth saying whatever the totals do — it's the
    // one figure both sides signed up to. Skipped where either side has no rate.
    if (rate != null && pl.unit_cost != null && pl.unit_cost > 0 && Math.abs(rate - pl.unit_cost) > 0.01) {
      issues.push({ kind: "rate", item: pl.item, billed: rate, ordered: pl.unit_cost });
    }

    if (billed == null || ordered == null || ordered <= 0) continue;
    const excess = billed - ordered;
    if (excess <= Math.max(1, ordered * 0.01)) continue;
    const sameRate = rate != null && pl.unit_cost != null && Math.abs(rate - pl.unit_cost) <= 0.01;
    const overQty = qty != null && pl.qty != null && qty > pl.qty + 0.001;
    const sameQty = qty != null && pl.qty != null && Math.abs(qty - pl.qty) <= 0.001;
    const overRate = rate != null && pl.unit_cost != null && rate > pl.unit_cost + 0.01;
    issues.push({
      kind: "over", item: pl.item, billed, ordered, excess,
      why: overQty && sameRate ? "qty" : sameQty && overRate ? "rate" : "value",
    });
  }
  const excess = issues.reduce((s2, i2) => s2 + (i2.kind === "over" ? i2.excess : 0), 0);
  return { state: issues.length ? "unmatched" : "matched", issues, excess };
}
