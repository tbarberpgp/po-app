/**
 * Expenses on an application for payment.
 *
 * A subcontractor's application mixes the week's work with the costs of being
 * there — hotel, mileage, train fares, parking, congestion charge. Those costs
 * have no BOQ line to claim against, so they sit as ad-hoc lines under the
 * "Expenses" section: paid as project cost, but outside the measured labour
 * budget, and outside the cumulative ledger that carries work forward between
 * applications.
 */

/** Section label an expense ad-hoc line carries. */
export const EXPENSES_SECTION = "Expenses";

/** True for the section label used by expense ad-hoc lines. */
export function isExpenseSection(s: string | null | undefined): boolean {
  return /expense/i.test(s ?? "");
}

/**
 * Words that mark a claimed line as a disbursement rather than work done.
 *
 * Deliberately conservative: it only has to catch what subcontractors actually
 * write on their applications, and a false positive moves real labour out of
 * the measured budget. Anything it doesn't recognise still goes to the
 * unmatched tray for a human, which is the safe direction to fail.
 */
const EXPENSE_PATTERNS: RegExp[] = [
  /\bexpenses?\b/i,
  /\bmileage\b/i,
  /\bfuel\b/i,
  /\bdiesel\b/i,
  /\bpetrol\b/i,
  /\bhotel\b/i,
  /\b(?:premier\s*inn|travelodge|travel\s*lodge|ibis|holiday\s*inn)\b/i,
  /\b(?:b\s*&\s*b|bed\s*(?:and|&)\s*breakfast)\b/i,
  /\baccommodation\b/i,
  /\blodging\b/i,
  /\bsubsistence\b/i,
  /\bper\s*diem\b/i,
  /\b(?:train|rail|flight|airfare|taxi|bus|ferry)\s*(?:ticket|fare|travel)?\b/i,
  /\btravel\s*(?:costs?|expenses?)\b/i,
  /\bcongestion\s*charge\b/i,
  /\b(?:car\s*)?parking\b/i,
  /\btoll(?:s|\s*charge)?\b/i,
  /\bmeals?\b/i,
  /\bevening\s*meal\b/i,
  /\bbreakfast\b/i,
];

/**
 * True when a claimed line reads as an expense/disbursement rather than work.
 *
 * Used to route a line straight into the Expenses bucket on ingest instead of
 * parking it in the unmatched tray, where — because a hotel bill will never
 * match a BOQ item — it would sit unreconciled and keep the application's value
 * out of every total.
 */
export function looksLikeExpenseLine(description: string | null | undefined): boolean {
  const d = (description ?? "").trim();
  if (!d) return false;
  return EXPENSE_PATTERNS.some((re) => re.test(d));
}
