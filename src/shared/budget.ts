/** What a budget line is priced at in £, and when a spend has run past it.
 *
 *  Over budget is a question about MONEY, and it used to be asked about
 *  quantity: the gate compared pack units ordered against the BOQ allowance
 *  (materials.total_units, col V). That misses the case the commercial team
 *  actually cares about — an order that buys exactly the budgeted quantity at a
 *  higher rate than the workbook priced spends money the line hasn't got, and
 *  read as within budget. It also flagged the mirror case as an over-run: more
 *  units bought at a keener rate, for less money than was budgeted.
 *
 *  These are the same definitions the coding dropdowns' hint uses
 *  ("£13,838.10 budgeted · £8,834.62 left" — `budgetMoneyHint` in
 *  client/lib/commercials.ts, which now calls into here), so the gate cannot
 *  flag a line the picker beside it said had headroom. They live in `shared/`
 *  rather than in commercials.ts because the worker decides the approval gate
 *  and the client previews it, and the two disagreeing is the bug.
 */

/** Half a penny. Float noise on a sum of line totals is not an over-run — the
 *  same tolerance the framework draw-down gate uses on money. */
export const MONEY_EPSILON = 0.005;

/** The columns a priced budget is read off a `materials` row. Kept structural
 *  so both the worker's raw D1 rows and the client's MaterialWithCommitment
 *  satisfy it without either side importing the other's types. */
export type PricedBudgetInput = {
  /** col V — the allowance for this job, in pack units. */
  total_units?: number | null;
  /** col F — cost per pack. */
  cost?: number | null;
  /** col X — the workbook's own total for the line. */
  material_total_cost?: number | null;
  /** Units dropped from this job by a partial omission. */
  omitted_qty?: number | null;
};

/** Budgeted quantity net of a partial omission. Whole-line omissions are
 *  filtered out by the caller (m.omitted); this handles the "we only need 150
 *  of the 400" case, so every budget figure prices the reduced quantity. */
export function netBudgetUnits(m: PricedBudgetInput): number {
  return Math.max(0, (m.total_units ?? 0) - (m.omitted_qty ?? 0));
}

/** What this budget line is worth, in £.
 *
 *  A lump-sum line (Mansafe, smoke-vent kits — priced as one figure with no
 *  units) has nothing to multiply, so it takes the workbook's own total for the
 *  line; a line whose units were omitted keeps the omission's £0 rather than
 *  resurrecting that total. A line carrying only a unit rate returns 0, which
 *  the caller reads as "no priced budget" — not as "£0 budgeted", because
 *  nothing can be measured against it. */
export function pricedBudget(m: PricedBudgetInput): number {
  const units = netBudgetUnits(m);
  // `m.omitted_qty` is deliberately truthy-tested, not null-tested: an omission
  // row of 0 units is no omission at all, and such a line must still fall
  // through to the lump-sum total rather than price itself at 0 × cost.
  if (units > 0 || m.omitted_qty) return units * (m.cost ?? 0);
  return m.material_total_cost ?? 0;
}

/** A line carries no priced budget — there is nothing to be over. This is what
 *  the "unpriced" badge and the unpriced half of the approval reason mean. */
export function isUnpricedBudget(m: PricedBudgetInput): boolean {
  return !(pricedBudget(m) > 0);
}

/** How far past its budget the committed spend runs, in £ — 0 unless genuinely
 *  over, so callers can treat it as both the test and the amount.
 *
 *  `committed` is actual purchase-order money (Σ line_total across live orders
 *  for the item, plus the order being judged), not quantity re-valued at a rate
 *  nobody paid: re-valuing would price an over-rate order back down to the rate
 *  it was supposed to cost, and hide the very over-run being looked for. */
export function overBudgetBy(budget: number, committed: number): number {
  const over = committed - budget;
  return over > MONEY_EPSILON ? over : 0;
}
