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
  // The leading 0? admits ZERO-PADDING, and nothing else. Supplier systems pad
  // our job code to a fixed width — Fixfast print every order as "026003-0020"
  // — and without this the ref failed to parse at all, so the quoted-reference
  // checks below silently never ran for that supplier. Their whole book lost
  // wrong-PO and cross-job detection on a character we put there ourselves.
  //
  // This is not typo repair, which stays out on purpose (see the test for
  // PO-262002-0004): an extra 0 in front is a known rendering of the same
  // number, while an extra digit inside it could be any of several jobs.
  // resolvePoRef does the fuzzy guessing where recall matters more.
  const m = /(?<!\d)0?(\d{5})\D{1,3}(\d{4})(?!\d)/.exec(String(s ?? ""));
  return m ? `${m[1]}-${m[2]}` : null;
}

/** Sentinel po_line_id meaning "explicitly a service/misc charge, not a product
 *  line" — a human picked this deliberately, so it counts as matched but is
 *  excluded from qty/value variance checks. */
export const SERVICE_CHARGE_LINE_ID = -1;

/** Sentinel meaning "this row is a payment schedule, not something being bought".
 *
 *  Deposit invoices state the whole purchase and then break the money into
 *  instalments, and extraction reads that table as goods lines. A £22,500
 *  container invoice arrives as three rows — Purchase Price £22,500, Deposit Due
 *  (20%) £4,500, Balance Remaining £18,000 — which sum to £45,000 against an
 *  invoice net of £4,500, because two of them are the same money described twice.
 *  Only the first row is a thing; the other two are terms.
 *
 *  Marked by hand, like the service charge, and exempt from linking and variance
 *  for the same reason: there is nothing on the order for a payment term to
 *  reconcile against. */
export const PAYMENT_SCHEDULE_LINE_ID = -2;

/** Rows a person has declared to be neither goods nor comparable to an order line. */
export const NON_GOODS_LINE_IDS: readonly number[] = [SERVICE_CHARGE_LINE_ID, PAYMENT_SCHEDULE_LINE_ID];

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
 *                    Not raised where the quoted ref is a FRAMEWORK covering the
 *                    same job as the linked order — suppliers quote the framework
 *                    because that's the agreement on their system, while we bill
 *                    the call-off or job order raised under it. That is correct.
 *  `ambiguous_job` — the invoice disagrees WITH ITSELF about which job it is
 *                    for: the order number it quotes belongs to one job, and the
 *                    delivery address printed on it belongs to another. Reported
 *                    ahead of everything else because it undermines the rest —
 *                    the coding, the linked order, and every price comparison
 *                    beneath them all rest on the job being right. Neither
 *                    reading is preferred: both are literal readings of the
 *                    document, and only the lines being billed can settle it.
 *  `cross_project` — the linked order belongs to a different job than the invoice
 *                    is coded to. Reported against the LINK, not the coding: the
 *                    coding is set or confirmed by a person, while the link is
 *                    routinely a machine guess, and on every case examined so far
 *                    the coding was right and the guessed order was wrong.
 *  `unlinked` — the line couldn't be tied to any line on the order. Usually a
 *  service, carriage or misc charge that nobody marked as a service charge.
 *  `rate`     — linked, billed at a rate we didn't agree, AND the money disagrees
 *                too. A rate difference on its own is usually a unit conversion
 *                (per piece against a per-box order), which the detail panel has
 *                always treated as fine — reporting it here contradicted that.
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
  | { kind: "ambiguous_job"; ref_project: string; address_project: string; quoted: string; quoted_po: string | null }
  | { kind: "wrong_po"; quoted: string; linked: string }
  | { kind: "cross_project"; invoice_project: string; po_project: string; linked: string }
  | { kind: "unlinked"; item: string }
  | { kind: "rate"; item: string; billed: number; ordered: number }
  | { kind: "over"; item: string; billed: number; ordered: number; excess: number; why: "qty" | "rate" | "value" };

/**
 * Does the invoice contradict itself about which job it belongs to?
 *
 * Two independent readings of the same document: the order number the supplier
 * quotes, and the ship-to address they printed. When both resolve and disagree,
 * something is wrong with one of them and no amount of price checking will say
 * which — so it is raised on its own, before a PO is even linked.
 *
 * Deliberately silent when only one reading resolves. One signal and no
 * contradiction is the ordinary case, not a problem.
 */
export function jobAmbiguity(
  refProject: string | null | undefined,
  addressProject: string | null | undefined,
  quotedRef: string | null | undefined,
  quotedPo: string | null | undefined,
): MatchIssue | null {
  if (!refProject || !addressProject || refProject === addressProject) return null;
  return {
    kind: "ambiguous_job",
    ref_project: refProject,
    address_project: addressProject,
    quoted: String(quotedRef ?? ""),
    quoted_po: quotedPo ?? null,
  };
}

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
 * Linking follows the same precedence as computeInvoiceMatch — stored link,
 * learned alias, exact wording, leading product code — so the list badge and the
 * detail panel cannot disagree about whether a line found its order line.
 */
export type PoContext = {
  po_number?: string | null;
  po_project?: string | null;
  invoice_project?: string | null;
  quoted_ref?: string | null;
  /** What the quoted ref resolves to, when it resolves to one of our orders at
   *  all. Needed to tell a mislink from the normal framework workflow. */
  quoted_type?: string | null;
  quoted_project?: string | null;
};

/**
 * @param aliases alias_norm → target_norm, the wording corrections people have
 *   already made for this supplier. computeInvoiceMatch has consulted these all
 *   along; this scan didn't, so the list could report "line not on the PO" for a
 *   line the detail panel linked happily off a correction someone had already
 *   made. Same divergence class as the rate contradiction on Fixfast 1610590.
 */
export function scanLineMatch(
  invLines: InvLine[],
  poLines: PoLineRow[],
  po?: PoContext,
  aliases?: Map<string, string>,
): MatchSummary {
  const taken = new Set<number>();
  const issues: MatchIssue[] = [];

  // PO-level checks first — they come before the line detail because they can
  // invalidate all of it. A price agreeing with the wrong order proves nothing.
  if (po) {
    const quoted = poRefCore(po.quoted_ref);
    const linked = poRefCore(po.po_number);
    if (quoted && linked && quoted !== linked) {
      // A framework is the umbrella agreement, not something you bill against:
      // you raise a standard or call-off order under it for each drop and bill
      // that. So a supplier quoting the framework while we've linked the job
      // order is the intended workflow, not a mislink — provided the framework
      // covers the SAME job as the order billed. A framework on another job is
      // still wrong, and so is a quoted ordinary order that isn't the linked one.
      const frameworkForSameJob = po.quoted_type === "framework"
        && !!po.quoted_project && !!po.po_project && po.quoted_project === po.po_project;
      if (!frameworkForSameJob) {
        issues.push({ kind: "wrong_po", quoted: String(po.quoted_ref), linked: String(po.po_number) });
      }
    }
    if (po.invoice_project && po.po_project && po.invoice_project !== po.po_project) {
      issues.push({
        kind: "cross_project", invoice_project: po.invoice_project,
        po_project: po.po_project, linked: String(po.po_number),
      });
    }
  }
  for (const il of invLines) {
    if (il.po_line_id != null && NON_GOODS_LINE_IDS.includes(il.po_line_id)) continue;
    // Same precedence as computeInvoiceMatch: stored link, then a learned alias,
    // then exact wording, then the leading product code.
    let pl = il.po_line_id ? poLines.find((p) => p.id === il.po_line_id) : null;
    if (!pl && aliases) {
      const learned = aliases.get(normText(il.description));
      if (learned) pl = poLines.find((p) => normText(p.item) === learned) || null;
    }
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

    // VALUE FIRST, matching computeInvoiceMatch. A rate difference only means
    // something once the money disagrees: suppliers bill a different unit basis
    // to the order all the time (1,500 fasteners at £0.26 against 15 boxes at
    // £26.11 — £391.65 either way), and reporting the rate there contradicts the
    // detail panel, which correctly calls that line ok.
    //
    // The reciprocal test catches the same thing from the other side: many more
    // units at a proportionally smaller rate is a unit conversion, not a price
    // change. Needed as well as the value test because a part-shipment on a
    // different basis has BOTH a lower value and a wildly different rate.
    const valuesKnown = billed != null && ordered != null && ordered > 0;
    const valuesAgree = valuesKnown && Math.abs(billed! - ordered!) <= Math.max(1, ordered! * 0.01);
    const qtyRatio = qty != null && pl.qty != null && pl.qty > 0 ? qty / pl.qty : null;
    const rateRatio = rate != null && pl.unit_cost != null && pl.unit_cost > 0 ? rate / pl.unit_cost : null;
    const unitBasisDiffers = qtyRatio != null && rateRatio != null
      && ((qtyRatio > 2 && rateRatio < 0.5) || (qtyRatio < 0.5 && rateRatio > 2));

    if (rate != null && pl.unit_cost != null && pl.unit_cost > 0
      && Math.abs(rate - pl.unit_cost) > 0.01
      && !valuesAgree && !unitBasisDiffers) {
      issues.push({ kind: "rate", item: pl.item, billed: rate, ordered: pl.unit_cost });
    }

    if (!valuesKnown) continue;
    const excess = billed! - ordered!;
    if (excess <= Math.max(1, ordered! * 0.01)) continue;
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
