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
 *   BOQ lines are a CUMULATIVE position. A subcontractor's application restates
 *   where they have got to, so only their latest certified application counts —
 *   summing the series double-counts everything before it.
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

/** An application that is a standalone prelims drawdown, not a measured claim.
 *  The same test recalcTotals applies (`isPrelimClaim`). */
export const PRELIM_CLAIM = "(a.prelim_heading IS NOT NULL AND a.claimed_amount IS NOT NULL)";

/** Applications whose position counts: the newest certified/paid one per
 *  subcontractor on each project. */
const LATEST_PER_SUPPLIER = `
  SELECT a.id, a.project_id,
         ROW_NUMBER() OVER (
           PARTITION BY a.project_id, a.counterparty_supplier_id
           ORDER BY a.app_number DESC
         ) AS rn
    FROM applications_for_payment a
   WHERE a.direction = 'incoming_labour' AND a.status IN ('certified', 'paid')
     AND NOT ${PRELIM_CLAIM}`;

/** An ad-hoc line claimed against a variation. Its budget is the variation's
 *  labour budget, which forecast cost already carries — so it is measured
 *  against that, never counted as unbudgeted. Uploaded workbooks' Variations
 *  tabs arrive untagged, so the section label counts as well as the tag. */
const VARIATION_LINE = "(al.variation_id IS NOT NULL OR lower(COALESCE(al.section, '')) LIKE '%variation%')";

/**
 * Where each project's labour stands against its budget, per BOQ section — the
 * one query behind every figure that puts labour into the money: the Labour
 * subtab, forecast final cost, and the dashboard's committed and GP columns.
 *
 *   budget / line_count   the labour BOQ (active snapshot)
 *   saving                live subcontract rates vs BOQ, on the same "latest
 *                         applied rate" rule as the Profit/Loss from Labour lever
 *   boq_expended          the cumulative measured position, latest application
 *                         per subcontractor
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
        JOIN (${LATEST_PER_SUPPLIER}) l ON l.id = al.afp_id AND l.rn = 1
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
