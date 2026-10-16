/**
 * One definition of "labour expended" for every screen that shows it.
 *
 * It was worked out twice, differently, and the two never agreed. The portfolio
 * dashboard took each subcontractor's LATEST certified application, while the
 * project's Labour subtab summed every certified line it could find — so each
 * superseded cumulative restatement was counted again. On Blyth that put
 * £17,368.80 on the project page against £15,172.80 on the dashboard, the same
 * £2,196 application counted twice.
 *
 * The rule, in one place:
 *
 *   BOQ lines on a RUNNING-TOTAL application are a cumulative position: it
 *   restates where the subcontractor has got to, so only their latest certified
 *   one counts — summing the series double-counts everything before it. BOQ
 *   lines on a PERIOD claim (claim_basis 'period', migration 0136) are that
 *   period's work alone, so every certified one counts. See COUNTED_BOQ_APPS.
 *
 *   Ad-hoc lines (expenses, variations) are a PER-APPLICATION claim. They are
 *   never carried forward into the next application, so they sum across the
 *   series instead. Taking only the latest would silently drop every earlier
 *   hotel bill and every earlier variation.
 *
 * Both parts count certified and paid applications only — an uncertified claim
 * is not yet expenditure. LABOUR_POSITION below is the query; labour expended is
 * its three certified columns added up.
 *
 * A prelim-tagged claim (a subcontract PM's time drawn against a Preliminaries
 * heading) is neither. Its value is the single claimed amount, recalcTotals
 * already holds it out of the cumulative position on both sides, and it draws on
 * the prelims allowance rather than the labour BOQ — the Prelims tab counts it
 * there. Letting it into the latest-per-subcontractor pick made it the
 * subcontractor's "latest" application, and their whole measured position read
 * £0 behind a line-less PM claim.
 */

/** A labour application awaiting certification: sent to us (submitted), not yet
 *  certified or paid. The one rule every "labour applied" figure uses.
 *
 *  Drafts are left out on purpose. A draft is a document the reader has had a
 *  go at and nobody has agreed — its figures still move when a line is
 *  resolved or the source re-read — so it is reported nowhere in the money.
 *  Certified and paid applications have moved on to labour expended. What is
 *  left is money a subcontractor has asked for that we have not yet agreed:
 *  owed, so it counts in committed, but not yet cost, so forecast cost and
 *  profit wait for certification.
 *
 *  Its client-side twin is `isLabourAwaitingCertification` in
 *  shared/forecast.ts — change both together. */
export const LABOUR_AWAITING_CERT = "(a.direction = 'incoming_labour' AND a.status = 'submitted')";

/** An application that is a standalone prelims drawdown, not a measured claim.
 *  The same test recalcTotals applies (`isPrelimClaim`). */
export const PRELIM_CLAIM = "(a.prelim_heading IS NOT NULL AND a.claimed_amount IS NOT NULL)";

/** PRELIM_CLAIM for a table alias other than `a`. */
const prelimClaimOf = (t: string) => `(${t}.prelim_heading IS NOT NULL AND ${t}.claimed_amount IS NOT NULL)`;

/** The number of the newest certified/paid RUNNING-TOTAL application for the
 *  same project and subcontractor as `a` (claim_basis 'cumulative', or NULL for
 *  anything created before 0136), or NULL if there is none. */
const LATEST_CUMULATIVE_NO = `(
  SELECT MAX(b.app_number) FROM applications_for_payment b
   WHERE b.project_id = a.project_id AND b.direction = 'incoming_labour'
     AND b.counterparty_supplier_id IS a.counterparty_supplier_id
     AND b.status IN ('certified', 'paid') AND NOT ${prelimClaimOf("b")}
     AND COALESCE(b.claim_basis, 'cumulative') <> 'period')`;

/** The applications whose BOQ lines count towards labour expended.
 *
 *  A running-total application restates the subcontractor's position, so only
 *  the newest certified one counts — adding up the series would count every
 *  earlier week again. A period claim holds one period's work, so every
 *  certified one counts — taking only the newest would drop all but the last
 *  week. When a subcontractor has both, the newest running total counts plus
 *  every period claim certified after it.
 *
 *  Everything created before 0136 has claim_basis NULL and is read as a running
 *  total, so this picks exactly the rows it always did until an application is
 *  deliberately set to 'period'. */
const COUNTED_BOQ_APPS = `
  SELECT a.id, a.project_id
    FROM applications_for_payment a
   WHERE a.direction = 'incoming_labour' AND a.status IN ('certified', 'paid')
     AND NOT ${PRELIM_CLAIM}
     AND (
       (COALESCE(a.claim_basis, 'cumulative') <> 'period' AND a.app_number = ${LATEST_CUMULATIVE_NO})
       OR (a.claim_basis = 'period' AND a.app_number > COALESCE(${LATEST_CUMULATIVE_NO}, 0))
     )`;

/** An ad-hoc line claimed against a variation in the register. Its budget is
 *  that variation's labour budget, which forecast cost already carries — so it
 *  is measured against that, in a pot of its own: the client pays for it.
 *
 *  Only the tag counts, not the section label. An uploaded workbook's
 *  "Variations" tab arrives untagged, and what a subcontractor lists there is
 *  usually daywork and extras nobody raised with the client — our own cost,
 *  with no variation budget behind it. Read by its label it went into the
 *  variations' pot, which had nothing in it, and every pound showed as a loss
 *  while the labour budget still had room (Blyth, 2026-10-16: −£32,488.44 with
 *  £243 of labour budget unspent). Untagged, it is unbudgeted labour and the
 *  labour pot covers it, as it does expenses and daywork. */
const VARIATION_LINE = "(al.variation_id IS NOT NULL)";

/**
 * Where each project's labour stands against its budget, per BOQ section — the
 * one query behind every figure that puts labour into the money: the Labour
 * subtab, forecast final cost, and the dashboard's committed and GP columns.
 *
 *   budget / line_count   the labour BOQ (active snapshot)
 *   saving                live subcontract rates vs BOQ, on the same "latest
 *                         applied rate" rule as the Profit/Loss from Labour lever
 *   boq_expended          the measured position per subcontractor: their newest
 *                         certified running total, plus every certified period
 *                         claim after it (COUNTED_BOQ_APPS)
 *   variation_expended    ad-hoc claims against variations, across the series
 *   other_expended        every other ad-hoc claim — expenses, daywork — which
 *                         has no budget line anywhere
 *
 * The three expended columns add up to labour expended; the split is what lets
 * forecast cost tell work past its budget from work that was never budgeted. Returns `pid` and `section` with those columns; takes no binds
 * — wrap it as `SELECT * FROM (…) WHERE pid = ?` for one project.
 */
export const LABOUR_POSITION = `
  SELECT pid, section,
         SUM(line_count) AS line_count, SUM(budget) AS budget, SUM(saving) AS saving,
         SUM(boq) AS boq_expended, SUM(variation) AS variation_expended, SUM(other) AS other_expended
    FROM (
      SELECT sn.project_id AS pid,
             COALESCE(NULLIF(TRIM(ci.section), ''), 'Other') AS section,
             CASE WHEN ci.labour_total > 0 THEN 1 ELSE 0 END AS line_count,
             CASE WHEN ci.labour_total > 0 THEN ci.labour_total ELSE 0 END AS budget,
             COALESCE((ci.labour_rate - (
               SELECT llr.live_rate FROM labour_live_rates llr
                WHERE (llr.contract_item_id = ci.id
                       OR (llr.description IS NOT NULL AND lower(llr.description) = lower(ci.description)))
                  AND llr.project_id = sn.project_id
                  AND llr.status IN ('applied', 'approved')
                  AND llr.live_rate <= COALESCE(ci.labour_rate, llr.live_rate) * 5
                ORDER BY llr.applied_at DESC LIMIT 1
             )) * COALESCE(ci.qty, 0), 0) AS saving,
             0 AS boq, 0 AS variation, 0 AS other
        FROM contract_items ci
        JOIN material_snapshots sn ON sn.id = ci.snapshot_id
       WHERE sn.is_active = 1 AND (ci.labour_total > 0 OR ci.labour_rate IS NOT NULL)
      UNION ALL
      SELECT l.project_id, COALESCE(NULLIF(TRIM(al.section), ''), 'Other'),
             0, 0, 0, COALESCE(al.cumulative_value, 0), 0, 0
        FROM afp_lines al
        JOIN (${COUNTED_BOQ_APPS}) l ON l.id = al.afp_id
       WHERE al.is_adhoc = 0
      UNION ALL
      SELECT a.project_id, COALESCE(NULLIF(TRIM(al.section), ''), 'Other'),
             0, 0, 0, 0,
             CASE WHEN ${VARIATION_LINE} THEN COALESCE(al.cumulative_value, 0) ELSE 0 END,
             CASE WHEN ${VARIATION_LINE} THEN 0 ELSE COALESCE(al.cumulative_value, 0) END
        FROM afp_lines al
        JOIN applications_for_payment a ON a.id = al.afp_id
       WHERE a.direction = 'incoming_labour' AND a.status IN ('certified', 'paid')
         AND al.is_adhoc = 1 AND NOT ${PRELIM_CLAIM}
    )
   GROUP BY pid, section`;

/**
 * Certified labour per BOQ line — the Labour BOQ's "Spent to date" column.
 *
 * The same measured position LABOUR_POSITION adds up per section (the lines of
 * COUNTED_BOQ_APPS), kept apart by the contract item each line was claimed
 * against, so a section's lines add up to its BOQ expended. Ad-hoc lines
 * (expenses, dayworks, variations) have no BOQ line and stay out. A line whose
 * contract item belongs to an earlier BOQ upload keeps its id here; the screen
 * reports what it cannot place rather than guessing by description (Blyth's BOQ
 * repeats "Supply and Install new Ridge Flashing" under two sections).
 * Returns `pid`, `contract_item_id`, `spent`; takes no binds.
 */
export const LABOUR_SPENT_BY_ITEM = `
  SELECT l.project_id AS pid, al.contract_item_id, SUM(COALESCE(al.cumulative_value, 0)) AS spent
    FROM afp_lines al
    JOIN (${COUNTED_BOQ_APPS}) l ON l.id = al.afp_id
   WHERE al.is_adhoc = 0
   GROUP BY l.project_id, al.contract_item_id`;

/**
 * Certified prelim-tagged labour claims per project — labour cost that draws on
 * the Preliminaries allowance instead of the labour BOQ. Not part of labour
 * expended (that is measured against the labour budget), but it is money the
 * job owes, so committed-to-date counts it. Each claim stands alone, so they
 * sum. Returns `pid` and `v`; takes no binds.
 */
export const PRELIM_LABOUR_BY_PROJECT = `
  SELECT a.project_id AS pid, COALESCE(SUM(COALESCE(a.cumulative_value, a.claimed_amount, 0)), 0) AS v
    FROM applications_for_payment a
   WHERE a.direction = 'incoming_labour' AND a.status IN ('certified', 'paid')
     AND ${PRELIM_CLAIM}
   GROUP BY a.project_id`;
