/** Which purchase-order costs count against a budget line, and how much.
 *
 *  A cost lands on a budget line one of two ways, and for a long time only the
 *  first was counted:
 *
 *   1. By WORDING — the PO line is worded as the budget line is (or as its
 *      active substitution's replacement), and carries a priced budget. This is
 *      the ordinary case: someone picks the material out of the BOQ and orders
 *      it under its own name.
 *   2. By CODING — the PO line is worded as something else entirely and points
 *      at the budget line through `material_id`. This is what a retro PO raised
 *      off an invoice is: the line reads "Alumasc Building Products Ltd —
 *      invoice SI559354" and is coded afterwards to
 *      "MS-VIEO-1050-0.7MM-GRAND". Nothing in its wording says which budget it
 *      spends, and those lines are `is_unpriced` besides, so a wording-only
 *      tally misses them twice over.
 *
 *  Missing (2) does not merely under-report. It reports a busted budget line as
 *  untouched: PO-26003-0034's three lines each came back with £0 committed
 *  against "Fixings Tubes and Fixing" while £3,200.44 stood against its
 *  £594.00 — on the screen where someone decides whether to spend more of it.
 *
 *  These are the rules `GET /api/materials/:projectId` already applies (its
 *  `committed_value` is arm 1 and `assigned_committed_value` arm 2), and so the
 *  figures here are the ones the coding pickers, the Materials tab and the
 *  project forecast have always shown. Restated here as a function rather than
 *  left as SQL so the rule can be read and tested on its own — the drift
 *  between two spellings of it is what produced the £0.
 *
 *  NOT here: the write-time approval gate in `routes/pos.ts`, which still
 *  tallies by wording alone and so can let an order past a budget line that is
 *  already over. Tightening it changes who has to approve what and was left as
 *  a separate decision; see [[shared/budget.ts]] for the over-budget test
 *  itself.
 */

/** A budget line, as the rules need to see it. */
export type BudgetLine = {
  /** `materials.item`, lowercased. Budget lines are matched by NAME and not by
   *  id: re-uploading a workbook re-mints every material id, and spend already
   *  coded against the old rows has to keep counting. */
  name: string;
  /** An active substitution's `replacement_item`, lowercased — orders for a
   *  replaced material are raised under the replacement's wording. Null where
   *  the line has no substitution. */
  replacement: string | null;
};

/** A purchase-order line, as the rules need to see it. */
export type SpendLine = {
  /** The line's own wording, lowercased. */
  item: string;
  /** The budget line it is coded to (`materials.item`, lowercased), or null if
   *  it is coded to nothing. */
  codedTo: string | null;
  /** Off-BOQ wording with no priced budget of its own. */
  isUnpriced: boolean;
  /** £. */
  lineTotal: number;
};

/** Does this cost draw on this budget line?
 *
 *  The two arms are exclusive by construction — a line worded as the budget
 *  line is judged on its wording alone, never on its coding — which is what
 *  stops a cost being counted twice against one budget. */
export function drawsOnBudgetLine(line: SpendLine, budget: BudgetLine): boolean {
  const wordedAsBudgetLine =
    line.item === budget.name || (budget.replacement != null && line.item === budget.replacement);
  // Arm 1. An unpriced line worded as the budget line has no priced budget to
  // draw on — that is what unpriced means — so it is not spend against it.
  if (wordedAsBudgetLine) return !line.isUnpriced;
  // Arm 2. Coded here under other wording. Unpriced or not: the coding is an
  // explicit statement of which budget the money came out of, and on a retro PO
  // it is the only one there is.
  return line.codedTo === budget.name;
}

/** £ committed against this budget line by these lines. Pass every live order's
 *  lines — call-offs excluded by the caller, since a framework reserves its
 *  budget once and its call-offs draw inside that reservation. */
export function committedAgainstBudgetLine(lines: readonly SpendLine[], budget: BudgetLine): number {
  let total = 0;
  for (const l of lines) if (drawsOnBudgetLine(l, budget)) total += l.lineTotal;
  return total;
}
