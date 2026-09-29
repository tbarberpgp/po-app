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
 * is not yet expenditure.
 */

/** Applications whose position counts: the newest certified/paid one per
 *  subcontractor on each project. */
const LATEST_PER_SUPPLIER = `
  SELECT a.id, a.project_id,
         ROW_NUMBER() OVER (
           PARTITION BY a.project_id, a.counterparty_supplier_id
           ORDER BY a.app_number DESC
         ) AS rn
    FROM applications_for_payment a
   WHERE a.direction = 'incoming_labour' AND a.status IN ('certified', 'paid')`;

/**
 * Labour expended per project — cumulative BOQ position plus every ad-hoc
 * claim. Returns `pid` and `v`; takes no binds.
 */
export const LABOUR_EXPENDED_BY_PROJECT = `
  SELECT pid, COALESCE(SUM(v), 0) AS v FROM (
    -- Cumulative BOQ position: latest application per subcontractor.
    SELECT l.project_id AS pid, COALESCE(SUM(al.cumulative_value), 0) AS v
      FROM afp_lines al
      JOIN (${LATEST_PER_SUPPLIER}) l ON l.id = al.afp_id AND l.rn = 1
     WHERE al.is_adhoc = 0
     GROUP BY l.project_id
    UNION ALL
    -- Per-application claims: expenses and variations, across the whole series.
    SELECT a.project_id AS pid, COALESCE(SUM(al.cumulative_value), 0) AS v
      FROM afp_lines al
      JOIN applications_for_payment a ON a.id = al.afp_id
     WHERE a.direction = 'incoming_labour' AND a.status IN ('certified', 'paid')
       AND al.is_adhoc = 1
     GROUP BY a.project_id
  ) GROUP BY pid`;

/**
 * Labour expended for ONE project, split by BOQ section. Binds the project id
 * twice. Returns `section` and `expended`.
 */
export const LABOUR_EXPENDED_BY_SECTION = `
  SELECT section, COALESCE(SUM(expended), 0) AS expended FROM (
    SELECT COALESCE(NULLIF(TRIM(al.section), ''), 'Other') AS section,
           COALESCE(SUM(al.cumulative_value), 0) AS expended
      FROM afp_lines al
      JOIN (${LATEST_PER_SUPPLIER}) l ON l.id = al.afp_id AND l.rn = 1
     WHERE l.project_id = ? AND al.is_adhoc = 0
     GROUP BY section
    UNION ALL
    SELECT COALESCE(NULLIF(TRIM(al.section), ''), 'Other') AS section,
           COALESCE(SUM(al.cumulative_value), 0) AS expended
      FROM afp_lines al
      JOIN applications_for_payment a ON a.id = al.afp_id
     WHERE a.project_id = ? AND a.direction = 'incoming_labour'
       AND a.status IN ('certified', 'paid') AND al.is_adhoc = 1
     GROUP BY section
  ) GROUP BY section`;
