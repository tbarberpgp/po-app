/**
 * A subcontractor's bill is stated as billed — nothing is taken off it here.
 *
 * The user's rule (2026-10-23): "make sure there will be NO DEDUCTION for
 * anything. The deduction is not our job, it's Xero's job." CIS, retention,
 * VAT and any other deduction are worked out in Xero from the bill.
 *
 * So a bill's own deduction rows are not lines of work. Asgard's invoices end
 * "CIS Tax @ 20% … -420"; read in as a line, that row would have come off the
 * claim (and a "CIS" row printed as a positive figure would have been ADDED to
 * it). This says which extracted rows are deductions, so they never reach a
 * labour certificate.
 */

const DEDUCTION_WORDS =
  /\b(cis|retention|retained|withh[eo]ld|deduct(ed|ion|ions)?|discount|contra|vat)\b|^\s*less\b/i;

type ValuedLine = {
  description?: unknown;
  cumulative_value?: unknown;
  this_period_value?: unknown;
  contract_value?: unknown;
};

/** Is this extracted row a deduction rather than work billed? Any negative
 *  figure is one, and so is a row named as CIS, retention, VAT, a discount,
 *  a contra-charge or "less …", whatever sign it was printed with. */
export function isLabourDeduction(l: ValuedLine): boolean {
  for (const v of [l.cumulative_value, l.this_period_value, l.contract_value]) {
    if (typeof v === "number" && v < 0) return true;
  }
  return DEDUCTION_WORDS.test(String(l.description ?? ""));
}
