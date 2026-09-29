/**
 * What labour does to a project's forecast cost — one rule, used by the project
 * page, the site-group page and the portfolio dashboard alike.
 *
 * Forecast final cost starts from the pricing workbook's cost total, which
 * already holds the labour BOQ at its budget. Until this existed, the only way
 * labour could move the forecast was the live-rate lever, and that only ever
 * brought it DOWN. Certified labour never reached it at all: a gang running
 * past its allowance, a hotel bill, a variation's labour going over — the
 * forecast carried on showing the budget, and GP% kept the margin the job was
 * no longer making.
 *
 * So forecast cost now carries, on top of the budget:
 *
 *   over budget   BOQ labour certified past its section's budget. The budget is
 *                 the live-rate one — BOQ less the saving the lever already
 *                 claims — so a saving that certified work has eaten into isn't
 *                 counted twice. Per section, as the Labour subtab shows it, so
 *                 an underspend in one section can't hide an overrun in another.
 *
 *   unbudgeted    ad-hoc claims with no budget line anywhere: expenses (hotel,
 *                 mileage, fares) and daywork. The whole amount is cost the
 *                 workbook never priced, the labour analogue of off-BOQ spend.
 *
 *   variations    variation labour certified past the variations' labour
 *                 budget. Forecast cost already carries that budget, so only
 *                 the excess is new — counting the whole claim would book the
 *                 same labour twice.
 *
 * Nothing here can lower forecast cost: an underspend is not a saving until the
 * work is finished, and the live-rate lever is where genuine savings come from.
 *
 * Prelim-tagged claims are not here. They draw on the Preliminaries allowance,
 * not the labour BOQ, and the Prelims tab measures them against it.
 */

/** One BOQ section's labour position, as `/labour-by-cost-code` returns it
 *  (built on LABOUR_POSITION in worker/labour-expended.ts). The split fields
 *  are optional so a row from an older response reads as nothing certified. */
export type LabourPositionRow = {
  section: string;
  /** BOQ labour budget for the section. */
  labour_total: number;
  /** Live-rate saving on the section's lines (BOQ − live, × qty). */
  saving?: number;
  /** Certified measured work — each subcontractor's latest position. */
  boq_expended?: number;
  /** Certified ad-hoc claims against variations. */
  variation_expended?: number;
  /** Certified ad-hoc claims with no budget line: expenses, daywork. */
  other_expended?: number;
};

export type LabourOverrunLine = {
  section: string;
  kind: "over_budget" | "unbudgeted" | "variations";
  /** What the forecast had allowed for this labour. */
  budget: number;
  /** What has been certified. */
  certified: number;
  /** The part of `certified` forecast cost now carries on top of the budget. */
  over: number;
};

export type LabourOutturn = {
  /** BOQ labour budget across every section. */
  budget: number;
  /** Everything certified against the labour budget — measured work, variation
   *  labour and expenses. The same figure as "Labour expended". */
  certified: number;
  overBudget: number;
  unbudgeted: number;
  variationsOver: number;
  /** overBudget + unbudgeted + variationsOver: what forecast cost carries. */
  overrun: number;
  /** Where the overrun comes from, largest first. */
  lines: LabourOverrunLine[];
};

const n = (v: number | null | undefined) => (Number.isFinite(v) ? Number(v) : 0);
const pence = (v: number) => Math.round(v * 100) / 100;

/**
 * @param rows            per-section labour position for one project
 * @param variationBudget the variations' labour budget forecast cost already
 *                        carries — absorbed variations count as £0, as they do
 *                        in the forecast itself
 */
export function labourOutturn(rows: LabourPositionRow[], variationBudget: number): LabourOutturn {
  const lines: LabourOverrunLine[] = [];
  let budget = 0, certified = 0, overBudget = 0, unbudgeted = 0, varCertified = 0;

  for (const r of rows) {
    const boq = n(r.boq_expended), other = n(r.other_expended), vari = n(r.variation_expended);
    budget += n(r.labour_total);
    certified += boq + other + vari;
    varCertified += vari;

    // A saving bigger than the budget would read as a negative allowance; the
    // section can't be allowed less than nothing.
    const allowed = Math.max(0, n(r.labour_total) - n(r.saving));
    const over = boq - allowed;
    if (over > 0.005) {
      overBudget += over;
      lines.push({ section: r.section, kind: "over_budget", budget: pence(allowed), certified: pence(boq), over: pence(over) });
    }
    if (other > 0.005) {
      unbudgeted += other;
      lines.push({ section: r.section, kind: "unbudgeted", budget: 0, certified: pence(other), over: pence(other) });
    }
  }

  const varAllowed = Math.max(0, n(variationBudget));
  const variationsOver = Math.max(0, varCertified - varAllowed);
  if (variationsOver > 0.005) {
    lines.push({ section: "Variations", kind: "variations", budget: pence(varAllowed), certified: pence(varCertified), over: pence(variationsOver) });
  }

  lines.sort((a, b) => b.over - a.over);
  return {
    budget: pence(budget),
    certified: pence(certified),
    overBudget: pence(overBudget),
    unbudgeted: pence(unbudgeted),
    variationsOver: pence(variationsOver),
    overrun: pence(overBudget + unbudgeted + variationsOver),
    lines,
  };
}
