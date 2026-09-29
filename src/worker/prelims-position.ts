/**
 * The prelims pot, worked out once — the SQL behind shared/prelims-cost.ts.
 *
 * The one rule that has to hold: every order line is counted in exactly ONE
 * place. A line either draws on the prelims budget or it is materials spend
 * (against a BOQ line, or unpriced), never both — PRELIM_LINE decides, and the
 * materials side (the unpriced list, the forecast's overspend) excludes exactly
 * what it admits. Before this, prelim orders sat in the unpriced list at full
 * value while their budget sat in the contract cost, so the forecast carried
 * the same money twice.
 */
import { PRELIM_LABOUR_BY_PROJECT } from "./labour-expended";

/** Order statuses that commit money — as every committed figure in the app. */
const COMMITTED = "('approved', 'issued', 'pending_approval')";

/** A materials row that is a prelims budget line — the Prelims tab's test,
 *  on a row aliased `m` with its element joined as `e`. */
export const prelimRow = (m = "m", e = "e") =>
  `(lower(COALESCE(${e}.name, '')) LIKE '%prelim%' OR lower(COALESCE(${m}.type, '')) LIKE '%prelim%')`;

/**
 * An order line (aliased `pl`, its order `po`) that draws on the prelims budget.
 * A line coded to a budget row goes where that row is — a materials order coded
 * to a prelim row is prelims spend, a prelim order coded to a BOQ material is
 * that material's. Otherwise the order's category decides: prelim orders are
 * free-text lines, never picked from the bill.
 */
export const PRELIM_LINE = `(COALESCE(
  (SELECT CASE WHEN ${prelimRow("pm", "pe")} THEN 1 ELSE 0 END
     FROM materials pm LEFT JOIN elements pe ON pe.code = pm.element_code
    WHERE pm.id = pl.material_id),
  CASE WHEN po.category = 'prelims' THEN 1 ELSE 0 END) = 1)`;

/** One prelim row's budget (row `m`, its snapshot `s`), net of omissions — a
 *  wholly omitted row has none left, a part-omitted one loses the omitted units
 *  at their cost, exactly as forecast cost takes them out (omittedMaterialValue). */
export const PRELIM_ROW_BUDGET = `CASE
    WHEN EXISTS (SELECT 1 FROM material_omissions mo
                  WHERE mo.project_id = s.project_id AND mo.item_key = lower(m.item)
                    AND mo.omit_qty IS NULL) THEN 0
    ELSE MAX(0, COALESCE(m.material_total_cost, 0)
         - MIN(MAX(0, COALESCE((SELECT mo.omit_qty FROM material_omissions mo
                                 WHERE mo.project_id = s.project_id AND mo.item_key = lower(m.item)), 0)),
               COALESCE(m.total_units, 0)) * COALESCE(m.cost, 0))
  END`;

/**
 * Per project: the prelims budget, the committed prelim order lines and the
 * certified prelim labour claims. Returns `pid`, `budget`, `row_count`,
 * `orders`, `po_count`, `labour`; takes no binds — wrap it as
 * `SELECT * FROM (…) WHERE pid = ?` for one project.
 *
 * The budget is the prelim rows' total when the bill has any (net of what has
 * been omitted, as forecast cost already takes omitted budget out), else the
 * cost sheet's Preliminaries line — the Prelims tab's rule. Orders exclude
 * call-offs: a framework reserves the value and its call-offs draw within it.
 */
export const PRELIMS_POSITION = `
  SELECT p.id AS pid,
         CASE WHEN COALESCE(r.n, 0) > 0 THEN COALESCE(r.budget, 0) ELSE COALESCE(sh.budget, 0) END AS budget,
         COALESCE(r.n, 0) AS row_count,
         COALESCE(o.orders, 0) AS orders, COALESCE(o.po_count, 0) AS po_count,
         COALESCE(l.v, 0) AS labour
    FROM projects p
    LEFT JOIN (
      SELECT s.project_id AS pid, COUNT(*) AS n, SUM(${PRELIM_ROW_BUDGET}) AS budget
        FROM materials m
        JOIN material_snapshots s ON s.id = m.snapshot_id AND s.is_active = 1
        LEFT JOIN elements e ON e.code = m.element_code
       WHERE ${prelimRow()}
       GROUP BY s.project_id
    ) r ON r.pid = p.id
    LEFT JOIN (
      SELECT s.project_id AS pid, COALESCE(SUM(COALESCE(pc.cost, 0)), 0) AS budget
        FROM project_commercials pc
        JOIN material_snapshots s ON s.id = pc.snapshot_id AND s.is_active = 1
       WHERE pc.is_total = 0 AND lower(pc.category) LIKE '%prelim%'
       GROUP BY s.project_id
    ) sh ON sh.pid = p.id
    LEFT JOIN (
      SELECT po.project_id AS pid, COALESCE(SUM(COALESCE(pl.line_total, 0)), 0) AS orders,
             COUNT(DISTINCT po.id) AS po_count
        FROM po_lines pl
        JOIN purchase_orders po ON po.id = pl.po_id
       WHERE po.status IN ${COMMITTED}
         AND COALESCE(po.order_type, 'standard') != 'call_off'
         AND ${PRELIM_LINE}
       GROUP BY po.project_id
    ) o ON o.pid = p.id
    LEFT JOIN (${PRELIM_LABOUR_BY_PROJECT}) l ON l.pid = p.id`;

/**
 * Plant-tracker rows with the live order each was raised against — the input to
 * plantBeyondOrders. Rows with no order behind them are left out on purpose
 * (see that function). Returns `pid`, `po_id`, `po_value` and the hire fields;
 * takes no binds.
 */
export const PLANT_ON_ORDER = `
  SELECT lg.project_id AS pid, lg.po_id AS po_id, COALESCE(po.total_value, 0) AS po_value,
         lg.day_rate AS day_rate, lg.rate_unit AS rate_unit,
         lg.on_hire_from AS on_hire_from, lg.off_hire_to AS off_hire_to
    FROM plant_logs lg
    JOIN purchase_orders po ON po.id = lg.po_id
   WHERE po.status IN ${COMMITTED}
     AND lg.day_rate IS NOT NULL AND lg.on_hire_from IS NOT NULL`;
