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

/** One invoice line billed above what the PO ordered for it. */
export type OverbillLine = {
  item: string;
  billed_qty: number | null;
  po_qty: number | null;
  billed_rate: number | null;
  po_rate: number | null;
  billed_total: number;
  po_total: number;
  excess: number;
  reason: "qty" | "rate" | "value";
};

/**
 * Value-first over-billing scan — cheap enough to run across a whole invoice list.
 *
 * Deliberately gated on LINE VALUE, not on quantity. Suppliers routinely bill a
 * different unit basis to the order (3,000 fasteners at £0.17 against an order for
 * 40 boxes at £17.20); comparing those quantities head-on flags most of the book
 * while the money is identical. Only once a line's billed value genuinely exceeds
 * the ordered value do the qty/rate figures explain WHY — the same reasoning as the
 * "VALUE FIRST" rule in computeInvoiceMatch, and the same 1% / £1 tolerance.
 *
 * Conservative on linking: stored link, then exact wording, then leading product
 * code — no learned aliases. A line it can't link is not reported. This flag stays
 * visible on approved invoices, so a false positive is expensive.
 */
export function scanOverbill(invLines: InvLine[], poLines: PoLineRow[]): OverbillLine[] {
  const taken = new Set<number>();
  const out: OverbillLine[] = [];
  for (const il of invLines) {
    if (il.po_line_id === SERVICE_CHARGE_LINE_ID) continue;
    let pl = il.po_line_id ? poLines.find((p) => p.id === il.po_line_id) : null;
    if (!pl) pl = poLines.find((p) => normText(p.item) === normText(il.description)) || null;
    if (!pl) {
      const code = invMaterialCode(il.description ?? "");
      if (code.length >= 3) pl = poLines.find((p) => invMaterialCode(p.item) === code && !taken.has(p.id)) || null;
    }
    if (!pl) continue;
    taken.add(pl.id);

    const qty = lineQty(il);
    const rate = typeof il.unit_price === "number" ? il.unit_price : null;
    const billed = typeof il.amount === "number" ? il.amount : (qty != null && rate != null ? qty * rate : null);
    const ordered = pl.qty != null && pl.unit_cost != null ? pl.qty * pl.unit_cost : null;
    if (billed == null || ordered == null || ordered <= 0) continue;
    const excess = billed - ordered;
    if (excess <= Math.max(1, ordered * 0.01)) continue;

    const sameRate = rate != null && pl.unit_cost != null && Math.abs(rate - pl.unit_cost) <= 0.01;
    const overQty = qty != null && pl.qty != null && qty > pl.qty + 0.001;
    const sameQty = qty != null && pl.qty != null && Math.abs(qty - pl.qty) <= 0.001;
    const overRate = rate != null && pl.unit_cost != null && rate > pl.unit_cost + 0.01;
    out.push({
      item: pl.item, billed_qty: qty, po_qty: pl.qty, billed_rate: rate, po_rate: pl.unit_cost,
      billed_total: billed, po_total: ordered, excess,
      reason: overQty && sameRate ? "qty" : sameQty && overRate ? "rate" : "value",
    });
  }
  return out;
}
