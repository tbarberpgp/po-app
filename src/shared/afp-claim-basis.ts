/**
 * Is a received application stating a CUMULATIVE position, or THIS PERIOD?
 *
 * The two read identically on the page — a column of pounds — but mean opposite
 * things to the ledger. A cumulative application restates the whole position to
 * date, so the payment is the movement since last time. A period application
 * states only the new work, so the payment is the figure itself and it stacks on
 * what came before.
 *
 * Read wrong in the cumulative direction, a subcontractor's twelfth weekly
 * invoice replaces the previous eleven instead of adding to them, and the
 * project's labour figure collapses to one week's work.
 *
 * Subcontractors here invoice weekly for days and hours worked, so PERIOD is
 * the safe default. We only read an application as cumulative when it says so:
 * a stated percentage complete, or a to-date figure that differs from the
 * period figure on the same line. A single figure copied into both columns by
 * the extractor is not evidence of anything.
 */
export type ClaimBasisLine = {
  cumulative_value?: number | null;
  cumulative_pct?: number | null;
  this_period_value?: number | null;
};

export function looksCumulative(lines: readonly ClaimBasisLine[]): boolean {
  return lines.some((l) => {
    // A percentage complete is only meaningful against the whole item.
    if (l.cumulative_pct != null) return true;
    // A to-date figure that genuinely differs from the period figure.
    return (
      l.cumulative_value != null &&
      l.this_period_value != null &&
      Math.abs(l.cumulative_value - l.this_period_value) > 0.005
    );
  });
}

/** True when the application's figures should stack on the previous position. */
export function amountsArePeriod(lines: readonly ClaimBasisLine[]): boolean {
  return !looksCumulative(lines);
}
