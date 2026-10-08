/**
 * Dayworks on an application for payment.
 *
 * A measured BOQ prices work by what it covers — m2 of roof, lm of gutter. Two
 * of our labour subcontractors don't invoice that way: they invoice time.
 * Cladders claim "2 x Operatives x 10 Hours per Shift @ £33.00 P/H", Asgaard
 * claim "Management on site — DALLAS ROAD (17/08/2026)" at a day rate. A time
 * claim describes no BOQ item and never will, so it matched nothing, fell to
 * the unmatched tray, and held its whole value out of the application — which
 * is why every one of their applications read £0.
 *
 * Dayworks sit as ad-hoc lines under the "Dayworks" section. Unlike expenses
 * they ARE labour: they count against the labour budget and in front of the
 * over-budget gate, because that is exactly the overspend the gate exists to
 * catch. Like expenses they are a claim for THIS period only — next week is a
 * fresh line on a fresh application — so they stay out of the cumulative
 * position, or each week's claim would cancel the last.
 */

/** Section label a daywork ad-hoc line carries. */
export const DAYWORKS_SECTION = "Dayworks";

/** True for the section label used by daywork ad-hoc lines. */
export function isDayworkSection(s: string | null | undefined): boolean {
  return /daywork/i.test(s ?? "");
}

/**
 * Wording that marks a claimed line as time rather than measured work.
 *
 * Read in a different place from the expense patterns, and so tuned
 * differently: this runs only over lines that have ALREADY failed to match a
 * BOQ item. A line the matcher claimed is never offered here, so a broad
 * pattern cannot pull measured work out of the budget — the worst a false
 * positive does is file an unmatchable line as daywork instead of leaving it
 * stranded in the tray, where it was worth nothing at all.
 */
const DAYWORK_PATTERNS: RegExp[] = [
  /\bday\s*works?\b/i,
  /\bday\s*rate\b/i,
  /\bhourly\s*rate\b/i,
  /\brate\s*of\s*pay\b/i,
  // "£36.00 P/H", "£33 per hour", "£420/hr"
  /£\s*[\d,]+(?:\.\d+)?\s*(?:p\s*\/?\s*h\b|per\s*hour\b|\/\s*hrs?\b|\/\s*hour\b)/i,
  /\boperatives?\b/i,
  /\bper\s*shift\b/i,
  /\bman[\s-]*(?:day|hour)s?\b/i,
  /\bmanagement\s+on\s+site\b/i,
  /\btime\s*(?:and|&)\s*materials?\b/i,
  // A named weekday is a timesheet, not a BOQ item: "Monday 03/08/26 –
  // 07/08/26", "Saturday 11/07/26 (£36.00 x 1.8)". The Saturday overtime line
  // carries no rate wording at all and this is the only thing that catches it.
  /\b(?:mon|tues?|wednes|thurs?|fri|satur|sun)day\b/i,
];

/**
 * True when an unmatched claimed line reads as time worked rather than
 * measured work or a disbursement.
 *
 * Check `looksLikeExpenseLine` FIRST: a hotel bill is a disbursement that sits
 * outside the labour budget, and some expense wording ("Premier Inn +
 * breakfast and evening meal x 4") would otherwise be read here.
 */
export function looksLikeDayworkLine(description: string | null | undefined): boolean {
  const d = (description ?? "").trim();
  if (!d) return false;
  return DAYWORK_PATTERNS.some((re) => re.test(d));
}
