// Does what arrived actually match what was ordered?
//
// The delivery inbox matches a ticket to a PO on ONE thing: the order number
// printed on the paper resolves to a PO we hold. That is a match of the
// reference, not of the goods, and the badge saying "Matched" was being read as
// though it were both. Fixfast's DN 704875 came in against PO-26003-0038 —
// number correct, ticket says 5,000 fasteners, the order says 50. Checking that
// in would have closed the line as fully delivered and said nothing, because
// the check-in path uses quantities only to decide part vs complete: received
// >= ordered marks it done, and 5,000 >= 50.
//
// The only over-quantity scan in the system is on the invoice side
// (`line-match.ts`), it runs weeks later, and it flags on VALUE — so a supplier
// who ships 100x the units and invoices the agreed total never trips it.
//
// This module closes that gap at the point the goods land. It is deliberately
// quiet, and the shape of that quiet was set by running it over the whole book
// rather than by taste — a first cut flagged 33 of 36 matched tickets, which is
// a warning nobody would read by the second week. Three things came out of it:
//
//   * Items the matcher cannot tie to a line are NOT reported. "Not on the
//     order" and "worded differently from the order" are indistinguishable here,
//     and every one of the 15 it raised (Knauf, Novia, Screwfix, Fixfast) was a
//     delivery a human had already checked in correctly. Blaming the supplier
//     for the limits of our own wording match is worse than saying nothing.
//
//   * A clean multiple across DIFFERENT units is a pack conversion, not an
//     over-delivery. PO-26003-0023 orders 15 of unit "100" and the note reads
//     1,500 ea; Alumasc order 1 drum and deliver 4 tins. Both are right. Only a
//     clean multiple in the SAME unit is ambiguous enough to be worth a person —
//     which is exactly the Fixfast case, 5,000 ea against 50 ea.
//
//   * Receipts already logged by the ticket being judged must be excluded, or
//     every ticket flags itself the moment it is checked in.
//
// What is left: more arrived than is outstanding, and a quantified line the
// reader got no quantity for.
import { normText } from "./line-match";

export type TicketItem = { description: string; qty: number | null; unit: string | null };
export type VarianceLine = { id: number; item: string; qty: number | null; unit: string | null };
export type PriorReceipt = { po_line_id: number; qty: number | null };

export type VarianceIssue = {
  kind: "over" | "no_qty";
  /** Ticket wording, as read off the note. */
  item: string;
  po_line_id: number | null;
  po_line_desc: string | null;
  ticket_qty: number | null;
  ticket_unit: string | null;
  ordered: number | null;
  ordered_unit: string | null;
  /** Ordered less everything already received against the line. */
  outstanding: number | null;
  /** Whole-number multiple between the ticket and the outstanding quantity,
   *  when there is a clean one (5,000 against 50 → 100). A round factor is the
   *  signature of a pack-size difference — the order priced per box, the note
   *  counted in eaches — which is a paperwork fix, not a delivery error. The
   *  distinction changes who has to do something, so we surface the number and
   *  let the buyer decide rather than asserting which it is. */
  factor: number | null;
  headline: string;
};

export type VarianceReport = {
  /** True when nothing needs a human. An empty report on a ticket we could not
   *  check (no quantities on either side) is still `ok` — see `checked`. */
  ok: boolean;
  /** False when there was nothing to compare, so the UI can say "not checked"
   *  rather than implying the goods were verified. */
  checked: boolean;
  issues: VarianceIssue[];
  /** One line for a badge or a banner heading. */
  headline: string | null;
};

/** Quantities carry supplier rounding and our own unit conversions; 1% (never
 *  less than a hair over zero) is the same tolerance the invoice scan uses. */
function tol(n: number): number {
  return Math.max(0.001, Math.abs(n) * 0.01);
}

/** Units compared the way a buyer reads them — case, punctuation and a trailing
 *  plural carry no meaning ("Roll" / "rolls" / "roll" are one unit). */
function unitKey(u: string | null | undefined): string {
  return (u ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");
}

/** Are the ticket and the order provably counting the same thing?
 *
 *  Only "both sides named a unit and named the same one" counts. A blank unit is
 *  not agreement — BOC order "1" with no unit and deliver "2 CYL", and there is
 *  no way to tell a second cylinder from a pack of two. Treating unknown as
 *  agreement is what turns this into a noise generator. */
function sameBasis(ticketUnit: string | null, orderedUnit: string | null): boolean {
  const t = unitKey(ticketUnit), o = unitKey(orderedUnit);
  return !!t && !!o && t === o;
}

/** Leading product-code token of a line, normalised ("DF3-5.5 x 45" → "DF355X45").
 *  Mirrors the matcher in operations/Operations so a ticket item lands on the
 *  same PO line here as it does in the check-in modal. */
export function materialCode(s: string): string {
  const first = (s || "").trim().split(/\s+/)[0] || "";
  return first.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function tokens(s: string): Set<string> {
  return new Set((s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 2));
}

/** Every whitespace token of a line, normalised the way `materialCode` treats
 *  the first one. Suppliers print the stock code in its own column and our
 *  reader concatenates the columns, so the code arrives buried mid-string —
 *  Fixfast's DN 704875 read as "Carbon steel light-section mainfix fastener
 *  (DF3-5.5 x 45)", with the code LAST. Matching on the leading token alone
 *  missed it, fell through to word overlap (1 shared word in 7), and reported
 *  the delivery as goods that were not on the order at all. */
function codeTokens(s: string): Set<string> {
  return new Set(
    (s || "").trim().split(/\s+/)
      .map((t) => t.toUpperCase().replace(/[^A-Z0-9]/g, ""))
      .filter((t) => t.length >= 4),
  );
}

/** Best PO line for one ticket item: exact product code first, then description
 *  token overlap. Returns null below 50% overlap — a bad line match would blame
 *  the wrong line for a variance, which is worse than reporting none. */
export function matchItemToLine(item: string, lines: VarianceLine[]): { line: VarianceLine; lc: number } | null {
  const code = materialCode(item);
  if (code.length >= 3) {
    const hit = lines.find((l) => materialCode(l.item) === code);
    if (hit) return { line: hit, lc: 92 };
  }
  // The PO line's code appearing ANYWHERE in the ticket wording. Exact token
  // equality, not a substring test: "DF355" inside some longer code would be a
  // different product, and a variance blamed on the wrong line is worse than
  // none. Four characters minimum keeps ordinary words out of it.
  const itemTokens = codeTokens(item);
  if (itemTokens.size) {
    const hit = lines.find((l) => {
      const lc = materialCode(l.item);
      return lc.length >= 4 && itemTokens.has(lc);
    });
    if (hit) return { line: hit, lc: 88 };
  }
  const norm = normText(item);
  const exact = lines.find((l) => normText(l.item) === norm);
  if (exact) return { line: exact, lc: 95 };
  const tks = tokens(item);
  if (!tks.size) return null;
  let best: { line: VarianceLine; score: number } | null = null;
  for (const l of lines) {
    const lt = tokens(l.item);
    let ov = 0;
    for (const t of tks) if (lt.has(t)) ov++;
    const score = ov / tks.size;
    if (!best || score > best.score) best = { line: l, score };
  }
  return best && best.score >= 0.5 ? { line: best.line, lc: Math.round(best.score * 80) } : null;
}

/** Clean whole multiple of `b` in `a`, or null. Only from 2x up: below that a
 *  ratio is noise, and 1.5x of a small order is an over-delivery, not a pack. */
function wholeFactor(a: number, b: number): number | null {
  if (!(a > 0) || !(b > 0)) return null;
  const r = a / b;
  const near = Math.round(r);
  return near >= 2 && Math.abs(r - near) <= Math.max(0.0005, near * 0.005) ? near : null;
}

function fmtQty(n: number | null, unit: string | null): string {
  if (n == null) return "no quantity";
  const s = Number.isInteger(n) ? n.toLocaleString("en-GB") : String(Math.round(n * 100) / 100);
  return unit ? `${s} ${unit}` : s;
}

/** Short label for the ticket wording — enough to tell two lines apart without
 *  wrapping a badge onto three rows. */
function shortItem(s: string): string {
  const t = (s || "").trim();
  return t.length > 42 ? `${t.slice(0, 41)}…` : t;
}

/**
 * Compare a scanned ticket's items against the PO's lines.
 *
 * `prior` is every receipt already logged against those lines, so a second drop
 * on a part-delivered line is judged on what is still outstanding rather than on
 * the original order — otherwise every top-up delivery would flag.
 */
export function deliveryVariance(
  items: TicketItem[],
  lines: VarianceLine[],
  prior: PriorReceipt[] = [],
  poNumber?: string | null,
): VarianceReport {
  const issues: VarianceIssue[] = [];
  const ticketItems = items.filter((i) => (i.description || "").trim());
  if (!ticketItems.length || !lines.length) {
    return { ok: true, checked: false, issues, headline: null };
  }

  const receivedBy = new Map<number, number>();
  for (const p of prior) {
    if (p.qty == null) continue;
    receivedBy.set(p.po_line_id, (receivedBy.get(p.po_line_id) ?? 0) + p.qty);
  }

  // Several ticket rows can land on one PO line (a note listing the same product
  // across three pallets), so quantities are summed per line before comparing —
  // judging each row on its own would let 3 x 40 pass against an order of 50.
  const byLine = new Map<number, { line: VarianceLine; qty: number | null; unit: string | null; descs: string[] }>();
  let checked = false;

  for (const it of ticketItems) {
    const m = matchItemToLine(it.description, lines);
    // No line for this wording — say nothing. We cannot tell goods that were
    // never ordered from goods the supplier words differently, and on the live
    // book every single one of these was a delivery that had been checked in
    // correctly by hand. See the note at the top of this file.
    if (!m) continue;
    const cur = byLine.get(m.line.id) ?? { line: m.line, qty: null, unit: it.unit, descs: [] };
    cur.qty = it.qty == null ? cur.qty : (cur.qty ?? 0) + it.qty;
    cur.unit = cur.unit || it.unit;
    cur.descs.push(it.description);
    byLine.set(m.line.id, cur);
  }

  for (const { line, qty, unit, descs } of byLine.values()) {
    const ordered = line.qty;
    if (ordered == null || ordered <= 0) continue; // unquantified line — nothing to compare against
    checked = true;
    const outstanding = Math.max(0, ordered - (receivedBy.get(line.id) ?? 0));
    const label = shortItem(descs[0]);

    // A ticket the reader got no quantity off cannot be checked, and checking it
    // in pre-fills nothing — say so rather than passing it as agreed.
    if (qty == null) {
      issues.push({
        kind: "no_qty", item: descs[0], po_line_id: line.id, po_line_desc: line.item,
        ticket_qty: null, ticket_unit: unit, ordered, ordered_unit: line.unit,
        outstanding, factor: null,
        headline: `No quantity read for "${label}" — the order is for ${fmtQty(ordered, line.unit)}.`,
      });
      continue;
    }

    if (qty <= outstanding + tol(outstanding)) continue; // part or exact delivery — normal

    const factor = wholeFactor(qty, outstanding);
    // A clean multiple in a DIFFERENT (or unstated) unit is the signature of a
    // pack conversion, and on this book it was one every time: 15 of unit "100"
    // arriving as 1,500 ea, 1 drum arriving as 4 tins. The order and the note
    // are both right, so there is nothing for a person to do. The same multiple
    // in the SAME unit stays a flag — that is the ambiguous case, and it is the
    // one that let 5,000 ea through against an order for 50 ea.
    if (factor && !sameBasis(unit, line.unit)) continue;

    const partly = outstanding < ordered - tol(ordered);
    const against = partly
      ? `${fmtQty(outstanding, line.unit)} still outstanding of ${fmtQty(ordered, line.unit)}`
      : `the order is for ${fmtQty(ordered, line.unit)}`;
    issues.push({
      kind: "over", item: descs[0], po_line_id: line.id, po_line_desc: line.item,
      ticket_qty: qty, ticket_unit: unit, ordered, ordered_unit: line.unit,
      outstanding, factor,
      headline: factor
        ? `Ticket says ${fmtQty(qty, unit)} — ${against}. That is exactly ${factor}x, so the order may be priced per pack.`
        : `Ticket says ${fmtQty(qty, unit)} — ${against}.`,
    });
  }

  if (!issues.length) return { ok: true, checked, issues, headline: null };

  const over = issues.filter((i) => i.kind === "over");
  const headline = issues.length === 1
    ? issues[0].headline
    : over.length === issues.length
      ? `${over.length} lines deliver more than is outstanding on ${poNumber || "this order"}.`
      : `${issues.length} lines on this ticket do not match ${poNumber || "this order"}.`;
  return { ok: false, checked, issues, headline };
}
