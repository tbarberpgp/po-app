import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";
import { parsePaymentTerms, expectedDueDate } from "./invoices";

// Admin reporting dashboard — org-wide (or single-project) aggregates across
// projects, POs, commercials, operations and operative compliance.
// Admin/superadmin only. Optional filters: ?project_id=…  ?months=3|6|12
export const reports = new Hono<{ Bindings: Env; Variables: Variables }>();

function qualBucket(expiry: string | null, verifiedAt: string | null): "valid" | "expiring" | "expired" | "pending" | "none" {
  if (!verifiedAt) return "pending";
  if (!expiry) return "none";
  const exp = new Date(expiry + "T00:00:00").getTime();
  if (Number.isNaN(exp)) return "none";
  const now = Date.now();
  if (exp < now) return "expired";
  if (exp < now + 30 * 86_400_000) return "expiring";
  return "valid";
}

reports.get("/dashboard", async (c) => {
  const denied = requirePermission(c, "users.read");
  if (denied) return denied;
  const db = c.env.DB;
  const today = new Date().toISOString().slice(0, 10);

  // ── Filters ─────────────────────────────────────────────────────────────
  const pid = c.req.query("project_id") || null;
  const months = Math.min(24, Math.max(1, Number(c.req.query("months")) || 6));
  // Convenience: a clause + binds for "this PO belongs to the selected project".
  const poProj = pid ? "AND po.project_id = ?" : "";
  const aProj = pid ? "AND a.project_id = ?" : "";
  const sProj = pid ? "AND s.project_id = ?" : "";
  const siProj = pid ? "AND si.project_id = ?" : "";
  const plProj = pid ? "AND pl.project_id = ?" : "";
  const b = (...extra: unknown[]) => (pid ? [pid, ...extra] : extra);

  // In production each D1 query is a network round-trip, so issuing these ~16
  // independent aggregates sequentially stacked the latency. None depends on
  // another's result, so fire them all in one parallel batch instead.
  const [
    proj, withBoq, poStatus, paidRow, poMonthly,
    prelimBudget, prelimCommitted, apps, ops, signinDaily,
    opv, qrows, ramsRow, xeroConn, xeroPo, byProject, plantTests,
    prelimBudgetPP, prelimCommittedPP, keyDates,
    plantHire, signals, worstCard,
    afpPaidMonthly, poPaidMonthly, revenueMonthly,
  ] = await Promise.all([
    // ── Projects (portfolio context — not project-scoped) ───────────────────
    db.prepare(
      `SELECT
          SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed,
          COUNT(*) AS total
         FROM projects WHERE deleted_at IS NULL AND id <> 'sandbox'`,
    ).first<{ active: number; completed: number; total: number }>(),
    db.prepare(
      `SELECT COUNT(DISTINCT p.id) AS n FROM projects p
         JOIN material_snapshots s ON s.project_id = p.id AND s.is_active = 1
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox'`,
    ).first<{ n: number }>(),
    // ── Purchase orders ───────────────────────────────────────────────────
    db.prepare(
      // Committed value excludes call-offs (a framework reserves the value; its
      // call-offs draw within it, so counting both double-spends). PO counts
      // still include call-offs — they're real orders.
      `SELECT po.status AS status, COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN COALESCE(po.order_type,'standard') != 'call_off' THEN po.total_value ELSE 0 END), 0) AS value
         FROM purchase_orders po JOIN projects p ON p.id = po.project_id
        WHERE po.status != 'deleted' AND p.deleted_at IS NULL AND p.id <> 'sandbox' ${poProj}
        GROUP BY po.status`,
    ).bind(...b()).all<{ status: string; n: number; value: number }>(),
    db.prepare(
      `SELECT COALESCE(SUM(po.total_value), 0) AS paid, COUNT(*) AS n
         FROM purchase_orders po JOIN projects p ON p.id = po.project_id
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND po.paid_at IS NOT NULL ${poProj}`,
    ).bind(...b()).first<{ paid: number; n: number }>(),
    db.prepare(
      `SELECT substr(po.created_at, 1, 7) AS month, COUNT(*) AS count,
              COALESCE(SUM(CASE WHEN COALESCE(po.order_type,'standard') != 'call_off' THEN po.total_value ELSE 0 END), 0) AS value
         FROM purchase_orders po JOIN projects p ON p.id = po.project_id
        WHERE po.status != 'deleted' AND p.deleted_at IS NULL AND p.id <> 'sandbox' ${poProj}
          AND po.created_at >= date('now', ?, 'start of month')
        GROUP BY month ORDER BY month`,
    ).bind(...b(`-${months - 1} months`)).all<{ month: string; count: number; value: number }>(),
    // ── Prelims ─────────────────────────────────────────────────────────────
    db.prepare(
      `SELECT COALESCE(SUM(m.material_total_cost), 0) AS budget
         FROM materials m JOIN material_snapshots s ON s.id = m.snapshot_id
         LEFT JOIN elements e ON e.code = m.element_code
         JOIN projects p ON p.id = s.project_id
        WHERE s.is_active = 1 AND p.deleted_at IS NULL AND p.id <> 'sandbox' ${sProj}
          AND (lower(COALESCE(e.name, '')) LIKE '%prelim%' OR lower(COALESCE(m.type, '')) LIKE '%prelim%')`,
    ).bind(...b()).first<{ budget: number }>(),
    db.prepare(
      `SELECT COALESCE(SUM(po.total_value), 0) AS c
         FROM purchase_orders po JOIN projects p ON p.id = po.project_id
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND po.category = 'prelims'
          AND COALESCE(po.order_type,'standard') != 'call_off'
          AND po.status IN ('approved','issued','pending_approval') ${poProj}`,
    ).bind(...b()).first<{ c: number }>(),
    // ── Applications (applied vs certified, by direction) ───────────────────
    db.prepare(
      `SELECT a.direction AS direction,
              COALESCE(SUM(CASE WHEN a.status IN ('submitted','certified','paid') THEN a.cumulative_value ELSE 0 END), 0) AS applied,
              COALESCE(SUM(CASE WHEN a.status IN ('certified','paid') THEN a.certified_amount ELSE 0 END), 0) AS certified,
              COALESCE(SUM(CASE WHEN a.status = 'paid' OR a.paid_at IS NOT NULL THEN COALESCE(a.certified_amount, a.cumulative_value, 0) ELSE 0 END), 0) AS paid
         FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' ${aProj}
        GROUP BY a.direction`,
    ).bind(...b()).all<{ direction: string; applied: number; certified: number; paid: number }>(),
    // ── Operations ──────────────────────────────────────────────────────────
    db.prepare(
      `SELECT
          (SELECT COUNT(*) FROM site_signins si JOIN projects p ON p.id = si.project_id
             WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND substr(si.signed_in_at,1,10) = ? AND si.signed_out_at IS NULL ${siProj}) AS on_site_now,
          (SELECT COUNT(*) FROM site_signins si JOIN projects p ON p.id = si.project_id
             WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND substr(si.signed_in_at,1,10) = ? ${siProj}) AS signins_today,
          (SELECT COUNT(*) FROM plant_logs pl JOIN projects p ON p.id = pl.project_id
             WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND pl.off_hire_to IS NULL ${plProj}) AS plant_on_site`,
    ).bind(...(pid ? [today, pid, today, pid, pid] : [today, today])).first<{ on_site_now: number; signins_today: number; plant_on_site: number }>(),
    db.prepare(
      `SELECT substr(si.signed_in_at,1,10) AS date, COUNT(*) AS signins
         FROM site_signins si JOIN projects p ON p.id = si.project_id
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND si.signed_in_at >= date('now','-13 days') ${siProj}
        GROUP BY date ORDER BY date`,
    ).bind(...b()).all<{ date: string; signins: number }>(),
    // ── Compliance (operatives — org-wide, not project-scoped) ──────────────
    db.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(induction_done), 0) AS inducted
         FROM operatives WHERE archived_at IS NULL`,
    ).first<{ total: number; inducted: number }>(),
    db.prepare(
      `SELECT q.expiry_date AS expiry_date, q.verified_at AS verified_at
         FROM operative_quals q JOIN operatives o ON o.id = q.operative_id
        WHERE o.archived_at IS NULL`,
    ).all<{ expiry_date: string | null; verified_at: string | null }>(),
    db.prepare(
      `SELECT SUM(CASE WHEN r.signed_at IS NOT NULL THEN 1 ELSE 0 END) AS signed,
              SUM(CASE WHEN r.signed_at IS NULL THEN 1 ELSE 0 END) AS awaiting
         FROM operative_rams_signs r JOIN operatives o ON o.id = r.operative_id
        WHERE o.archived_at IS NULL ${pid ? "AND r.project_id = ?" : ""}`,
    ).bind(...(pid ? [pid] : [])).first<{ signed: number; awaiting: number }>(),
    // ── Xero ──────────────────────────────────────────────────────────────
    db.prepare("SELECT tenant_name FROM xero_connection LIMIT 1")
      .first<{ tenant_name: string }>().catch(() => null),
    db.prepare(
      `SELECT
          SUM(CASE WHEN po.xero_po_id IS NOT NULL THEN 1 ELSE 0 END) AS synced,
          SUM(CASE WHEN po.xero_sync_status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN po.xero_po_id IS NULL AND COALESCE(po.xero_sync_status,'') != 'failed'
                    AND po.status IN ('approved','issued') THEN 1 ELSE 0 END) AS unsynced
         FROM purchase_orders po JOIN projects p ON p.id = po.project_id
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND po.status != 'deleted' ${poProj}`,
    ).bind(...b()).first<{ synced: number; failed: number; unsynced: number }>(),
    // ── Per-project breakdown (drill-down table) ────────────────────────────
    db.prepare(
      `SELECT p.id, p.code, p.name, p.completed_at, COALESCE(p.client_retention_pct, 5) AS client_retention_pct,
              COALESCE((SELECT SUM(po.total_value) FROM purchase_orders po
                         WHERE po.project_id = p.id AND po.status IN ('approved','issued','pending_approval')), 0) AS committed,
              COALESCE((SELECT SUM(po.total_value) FROM purchase_orders po
                         WHERE po.project_id = p.id AND po.paid_at IS NOT NULL), 0) AS paid,
              (SELECT COUNT(*) FROM purchase_orders po WHERE po.project_id = p.id AND po.status = 'pending_approval') AS pending,
              -- Applied = latest non-draft outgoing application's cumulative value;
              -- certified = latest certified/paid one. Mirrors the project Overview.
              COALESCE((SELECT a.cumulative_value FROM applications_for_payment a
                         WHERE a.project_id = p.id AND a.direction = 'outgoing' AND a.status != 'draft'
                         ORDER BY a.app_number DESC LIMIT 1), 0) AS applied,
              COALESCE((SELECT a.cumulative_value FROM applications_for_payment a
                         WHERE a.project_id = p.id AND a.direction = 'outgoing' AND a.status IN ('certified','paid')
                         ORDER BY a.app_number DESC LIMIT 1), 0) AS certified,
              (SELECT COUNT(*) FROM site_signins si WHERE si.project_id = p.id AND substr(si.signed_in_at,1,10) = ? AND si.signed_out_at IS NULL) AS on_site
         FROM projects p WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' ${pid ? "AND p.id = ?" : ""}
        ORDER BY committed DESC, p.code`,
    ).bind(...(pid ? [today, pid] : [today])).all<{ id: string; code: string; name: string; completed_at: string | null; client_retention_pct: number; committed: number; paid: number; pending: number; applied: number; certified: number; on_site: number }>(),
    // ── Owned-plant statutory test compliance (expiry dates, bucketed below) ──
    db.prepare(
      `SELECT t.expiry_date AS expiry_date
         FROM owned_plant_tests t JOIN owned_plant op ON op.id = t.plant_id
        WHERE op.archived_at IS NULL ${pid ? "AND op.assigned_project_id = ?" : ""}`,
    ).bind(...(pid ? [pid] : [])).all<{ expiry_date: string | null }>().catch(() => ({ results: [] as Array<{ expiry_date: string | null }> })),
    // ── Per-project prelims: budget (from prelim materials) + committed (prelim POs) ──
    db.prepare(
      `SELECT s.project_id AS pid, COALESCE(SUM(m.material_total_cost), 0) AS budget
         FROM materials m JOIN material_snapshots s ON s.id = m.snapshot_id
         LEFT JOIN elements e ON e.code = m.element_code
         JOIN projects p ON p.id = s.project_id
        WHERE s.is_active = 1 AND p.deleted_at IS NULL AND p.id <> 'sandbox'
          AND (lower(COALESCE(e.name, '')) LIKE '%prelim%' OR lower(COALESCE(m.type, '')) LIKE '%prelim%')
        GROUP BY s.project_id`,
    ).all<{ pid: string; budget: number }>().catch(() => ({ results: [] as Array<{ pid: string; budget: number }> })),
    db.prepare(
      `SELECT po.project_id AS pid, COALESCE(SUM(po.total_value), 0) AS committed, COUNT(*) AS n
         FROM purchase_orders po JOIN projects p ON p.id = po.project_id
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND po.category = 'prelims'
          AND po.status IN ('approved','issued','pending_approval')
        GROUP BY po.project_id`,
    ).all<{ pid: string; committed: number; n: number }>().catch(() => ({ results: [] as Array<{ pid: string; committed: number; n: number }> })),
    // ── Upcoming key dates (next 14 days, from the valuation schedule) ──────────
    db.prepare(
      `SELECT v.date AS date, v.entry_type AS entry_type, v.app_number AS app_number,
              p.code AS project_code, p.name AS project_name
         FROM valuation_schedule_entries v JOIN projects p ON p.id = v.project_id
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' ${pid ? "AND v.project_id = ?" : ""}
          AND v.date >= date('now') AND v.date <= date('now', '+14 days')
        ORDER BY v.date LIMIT 8`,
    ).bind(...(pid ? [pid] : [])).all<{ date: string; entry_type: string; app_number: number | null; project_code: string; project_name: string }>()
      .catch(() => ({ results: [] as Array<{ date: string; entry_type: string; app_number: number | null; project_code: string; project_name: string }> })),
    // ── Plant hire rows (for accrued plant cost in the prelims line) ────────────
    db.prepare(
      `SELECT pl.day_rate AS day_rate, pl.rate_unit AS rate_unit, pl.on_hire_from AS on_hire_from, pl.off_hire_to AS off_hire_to
         FROM plant_logs pl JOIN projects p ON p.id = pl.project_id
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' ${plProj}`,
    ).bind(...b()).all<{ day_rate: number | null; rate_unit: string | null; on_hire_from: string | null; off_hire_to: string | null }>()
      .catch(() => ({ results: [] as Array<{ day_rate: number | null; rate_unit: string | null; on_hire_from: string | null; off_hire_to: string | null }> })),
    // ── Commercial signals for "needs attention" + the Xero invoices count ──────
    db.prepare(
      `SELECT
          (SELECT COUNT(*) FROM variations v JOIN projects p ON p.id = v.project_id
             WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND v.status = 'pending_approval') AS var_pending,
          (SELECT COUNT(*) FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
             WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND a.direction = 'outgoing' AND a.status = 'submitted') AS afp_awaiting,
          (SELECT COUNT(*) FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
             WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND a.xero_invoice_id IS NOT NULL) AS invoices,
          -- Framework lines where live call-off draws exceed the agreed qty
          -- OR the line's budgeted value — computed fresh each time, not from
          -- a stored flag, so it also catches lines that went over before
          -- this check existed. Value is checked separately from qty since a
          -- call-off can stay within qty but still overspend on unit cost.
          (SELECT COUNT(*) FROM po_lines pl
             JOIN purchase_orders po ON po.id = pl.po_id
             JOIN projects p ON p.id = po.project_id
            WHERE po.order_type = 'framework' AND po.status != 'deleted'
              AND p.deleted_at IS NULL AND p.id <> 'sandbox'
              AND (
                pl.qty < (
                  SELECT COALESCE(SUM(cl.qty), 0) FROM po_lines cl
                    JOIN purchase_orders cp ON cp.id = cl.po_id
                   WHERE cp.parent_po_id = po.id AND cp.status IN ('approved','issued','pending_approval')
                     AND lower(cl.item) = lower(pl.item)
                ) - 0.0001
                OR pl.line_total < (
                  SELECT COALESCE(SUM(cl.line_total), 0) FROM po_lines cl
                    JOIN purchase_orders cp ON cp.id = cl.po_id
                   WHERE cp.parent_po_id = po.id AND cp.status IN ('approved','issued','pending_approval')
                     AND lower(cl.item) = lower(pl.item)
                ) - 0.005
              )) AS framework_overdrawn`,
    ).first<{ var_pending: number; afp_awaiting: number; invoices: number; framework_overdrawn: number }>()
      .catch(() => ({ var_pending: 0, afp_awaiting: 0, invoices: 0, framework_overdrawn: 0 })),
    // ── The single most-pressing qualification card (soonest expiry) ────────────
    db.prepare(
      `SELECT q.qual_type AS qual_type, o.name AS name, q.expiry_date AS expiry_date
         FROM operative_quals q JOIN operatives o ON o.id = q.operative_id
        WHERE o.archived_at IS NULL AND q.verified_at IS NOT NULL AND q.expiry_date IS NOT NULL
        ORDER BY q.expiry_date ASC LIMIT 1`,
    ).first<{ qual_type: string; name: string; expiry_date: string }>().catch(() => null),
    // ── Monthly cash flow: client receipts in, labour paid out, by month ────────
    db.prepare(
      `SELECT substr(a.paid_at, 1, 7) AS month, a.direction AS direction,
              COALESCE(SUM(COALESCE(a.certified_amount, a.cumulative_value, 0)), 0) AS v
         FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND a.paid_at IS NOT NULL ${aProj}
          AND a.paid_at >= date('now', ?, 'start of month')
        GROUP BY month, direction`,
    ).bind(...b(`-${months - 1} months`)).all<{ month: string; direction: string; v: number }>()
      .catch(() => ({ results: [] as Array<{ month: string; direction: string; v: number }> })),
    db.prepare(
      `SELECT substr(po.paid_at, 1, 7) AS month, COALESCE(SUM(po.total_value), 0) AS v
         FROM purchase_orders po JOIN projects p ON p.id = po.project_id
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND po.paid_at IS NOT NULL ${poProj}
          AND po.paid_at >= date('now', ?, 'start of month')
        GROUP BY month`,
    ).bind(...b(`-${months - 1} months`)).all<{ month: string; v: number }>()
      .catch(() => ({ results: [] as Array<{ month: string; v: number }> })),
    db.prepare(
      `SELECT substr(COALESCE(a.paid_at, a.created_at), 1, 7) AS month,
              COALESCE(SUM(COALESCE(a.certified_amount, 0)), 0) AS v
         FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND a.direction = 'outgoing' AND a.status IN ('certified','paid') ${aProj}
          AND COALESCE(a.paid_at, a.created_at) >= date('now', ?, 'start of month')
        GROUP BY month`,
    ).bind(...b(`-${months - 1} months`)).all<{ month: string; v: number }>()
      .catch(() => ({ results: [] as Array<{ month: string; v: number }> })),
  ]);

  // ── Derived (in-memory) ─────────────────────────────────────────────────
  const committedStatuses = new Set(["approved", "issued", "pending_approval"]);
  let committedValue = 0, pendingApproval = 0;
  for (const r of poStatus.results) {
    if (committedStatuses.has(r.status)) committedValue += r.value;
    if (r.status === "pending_approval") pendingApproval = r.n;
  }
  const appByDir = (dir: string) => apps.results.find((r) => r.direction === dir) ?? { applied: 0, certified: 0, paid: 0 };
  const cards = { valid: 0, expiring: 0, expired: 0, pending: 0 };
  for (const q of qrows.results) {
    const k = qualBucket(q.expiry_date, q.verified_at);
    if (k === "valid" || k === "none") cards.valid++;
    else if (k === "expiring") cards.expiring++;
    else if (k === "expired") cards.expired++;
    else cards.pending++;
  }
  // Owned-plant statutory tests (LOLER/service/etc.) bucketed by retest date.
  const plantTestBuckets = { valid: 0, expiring: 0, expired: 0 };
  const nowMs = Date.now();
  for (const t of plantTests.results) {
    if (!t.expiry_date) continue;
    const exp = new Date(t.expiry_date + "T00:00:00").getTime();
    if (Number.isNaN(exp)) continue;
    if (exp < nowMs) plantTestBuckets.expired++;
    else if (exp < nowMs + 30 * 86_400_000) plantTestBuckets.expiring++;
    else plantTestBuckets.valid++;
  }

  // ── Per-project commercial forecast ────────────────────────────────────
  // Mirrors the project Overview's forecast model so dashboard figures match
  // each project's own page: FFA = contract value + variation sell; forecast
  // cost = contract cost + variation cost − material/labour savings + contingency
  // + unexpected spend (off-BOQ unpriced POs + committed over a line's budget).
  // Savings reuse the "latest applied live price/rate" subqueries from materials.ts.
  const [contractRows, varSellRows, varMatRows, varLabRows, matSavRows, labSavRows, contRows, labBudgetRows, labCertRows, unpricedRows, committedItemRows, budgetItemRows] = await Promise.all([
    db.prepare(
      `SELECT sn.project_id AS pid, c.value AS value, c.cost AS cost
         FROM project_commercials c JOIN material_snapshots sn ON sn.id = c.snapshot_id
        WHERE c.is_total = 1 AND sn.is_active = 1`,
    ).all<{ pid: string; value: number | null; cost: number | null }>(),
    db.prepare("SELECT project_id AS pid, COALESCE(SUM(sell_value),0) AS v FROM variations GROUP BY project_id")
      .all<{ pid: string; v: number }>(),
    db.prepare("SELECT v.project_id AS pid, COALESCE(SUM(vm.value),0) AS v FROM variation_materials vm JOIN variations v ON v.id = vm.variation_id GROUP BY v.project_id")
      .all<{ pid: string; v: number }>(),
    db.prepare("SELECT v.project_id AS pid, COALESCE(SUM(vl.value),0) AS v FROM variation_labour vl JOIN variations v ON v.id = vl.variation_id GROUP BY v.project_id")
      .all<{ pid: string; v: number }>(),
    db.prepare(
      `SELECT sn.project_id AS pid,
              COALESCE(SUM((m.cost - COALESCE((
                SELECT mlp.unit_price FROM material_live_prices mlp
                 JOIN materials om ON om.id = mlp.material_id
                 WHERE mlp.project_id = sn.project_id AND lower(om.item) = lower(m.item) AND mlp.status IN ('applied','approved')
                   AND mlp.unit_price <= COALESCE(m.cost, mlp.unit_price) * 5
                 ORDER BY mlp.applied_at DESC LIMIT 1), m.cost)) * COALESCE(m.total_units, 0)), 0) AS sav
         FROM materials m JOIN material_snapshots sn ON sn.id = m.snapshot_id
        WHERE sn.is_active = 1 AND m.cost IS NOT NULL
        GROUP BY sn.project_id`,
    ).all<{ pid: string; sav: number }>(),
    db.prepare(
      `SELECT sn.project_id AS pid,
              COALESCE(SUM((ci.labour_rate - COALESCE((
                SELECT llr.live_rate FROM labour_live_rates llr
                 WHERE (llr.contract_item_id = ci.id
                        OR (llr.description IS NOT NULL AND lower(llr.description) = lower(ci.description)))
                   AND llr.project_id = sn.project_id AND llr.status IN ('applied','approved')
                   AND llr.live_rate <= COALESCE(ci.labour_rate, llr.live_rate) * 5
                 ORDER BY llr.applied_at DESC LIMIT 1), ci.labour_rate)) * COALESCE(ci.qty, 0)), 0) AS sav
         FROM contract_items ci JOIN material_snapshots sn ON sn.id = ci.snapshot_id
        WHERE sn.is_active = 1 AND ci.labour_rate IS NOT NULL
        GROUP BY sn.project_id`,
    ).all<{ pid: string; sav: number }>(),
    db.prepare("SELECT key, value FROM settings WHERE key LIKE 'contingency:%'")
      .all<{ key: string; value: string }>(),
    // Labour budget (BOQ) = labour_rate × qty across the active snapshot's items.
    db.prepare(
      `SELECT sn.project_id AS pid, COALESCE(SUM(ci.labour_rate * ci.qty), 0) AS v
         FROM contract_items ci JOIN material_snapshots sn ON sn.id = ci.snapshot_id
        WHERE sn.is_active = 1 AND ci.labour_rate IS NOT NULL
        GROUP BY sn.project_id`,
    ).all<{ pid: string; v: number }>(),
    // Labour expended = certified incoming-labour, taking each supplier's latest
    // cumulative value (a cumulative series would otherwise double-count).
    db.prepare(
      `SELECT project_id AS pid, COALESCE(SUM(cumulative_value), 0) AS v FROM (
         SELECT a.project_id AS project_id, a.cumulative_value AS cumulative_value,
                ROW_NUMBER() OVER (PARTITION BY a.project_id, a.counterparty_supplier_id ORDER BY a.app_number DESC) AS rn
           FROM applications_for_payment a
          WHERE a.direction = 'incoming_labour' AND a.status IN ('certified','paid')
       ) WHERE rn = 1 GROUP BY project_id`,
    ).all<{ pid: string; v: number }>(),
    // Unexpected spend (mirrors the project page): off-BOQ "unpriced" PO spend,
    // plus committed-above-budget per material line (bulk-joined in JS below).
    db.prepare(
      // Exclude call-offs: a framework PO already reserves the value and its
      // call-offs draw within it (same rule as the committed-value query above).
      // Counting both would double-book the spend.
      `SELECT po.project_id AS pid, COALESCE(SUM(pl.line_total), 0) AS v
         FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
        WHERE po.status IN ('approved','issued','pending_approval') AND pl.is_unpriced = 1
          AND COALESCE(po.order_type,'standard') != 'call_off'
        GROUP BY po.project_id`,
    ).all<{ pid: string; v: number }>(),
    db.prepare(
      `SELECT po.project_id AS pid, lower(pl.item) AS item, COALESCE(SUM(pl.line_total), 0) AS v
         FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
        WHERE po.status IN ('approved','issued','pending_approval') AND pl.is_unpriced = 0
          AND COALESCE(po.order_type,'standard') != 'call_off'
        GROUP BY po.project_id, lower(pl.item)`,
    ).all<{ pid: string; item: string; v: number }>(),
    db.prepare(
      `SELECT sn.project_id AS pid, lower(m.item) AS item, COALESCE(SUM(m.total_units * m.cost), 0) AS v
         FROM materials m JOIN material_snapshots sn ON sn.id = m.snapshot_id
        WHERE sn.is_active = 1 AND m.cost IS NOT NULL
        GROUP BY sn.project_id, lower(m.item)`,
    ).all<{ pid: string; item: string; v: number }>(),
  ]);
  const sumMap = (rows: { results: Array<{ pid: string; v: number }> }) => {
    const m = new Map<string, number>(); for (const r of rows.results) m.set(r.pid, r.v); return m;
  };
  const savMap = (rows: { results: Array<{ pid: string; sav: number }> }) => {
    const m = new Map<string, number>(); for (const r of rows.results) m.set(r.pid, r.sav); return m;
  };
  const cValue = new Map<string, number>(), cCost = new Map<string, number>();
  for (const r of contractRows.results) { cValue.set(r.pid, r.value ?? 0); cCost.set(r.pid, r.cost ?? 0); }
  const vSell = sumMap(varSellRows), vMat = sumMap(varMatRows), vLab = sumMap(varLabRows);
  const mSav = savMap(matSavRows), lSav = savMap(labSavRows);
  const lBudget = sumMap(labBudgetRows), lCert = sumMap(labCertRows);
  const conting = new Map<string, number>();
  for (const r of contRows.results) { const n = Number(r.value); conting.set(r.key.slice("contingency:".length), Number.isFinite(n) ? n : 0); }
  // Unexpected spend per project: off-BOQ unpriced spend + committed-above-budget
  // per material line (per-line, so an underspend elsewhere doesn't mask it).
  const unpriced = sumMap(unpricedRows);
  const budgetByItem = new Map<string, number>();
  for (const r of budgetItemRows.results) budgetByItem.set(`${r.pid}|${r.item}`, r.v);
  const overspend = new Map<string, number>();
  for (const r of committedItemRows.results) {
    // Only count an over-run where the item actually has a BOQ budget line. A
    // priced PO line whose name doesn't match the materials sheet (it was raised
    // against the contract-items BOQ, or the name was edited) is a matching gap,
    // NOT spend over budget — booking its whole committed value as "overspend"
    // inflated FFC and flipped the forecast to a phantom loss.
    const budget = budgetByItem.get(`${r.pid}|${r.item}`);
    if (budget == null) continue;
    const over = r.v - budget;
    if (over > 0) overspend.set(r.pid, (overspend.get(r.pid) ?? 0) + over);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const commercialFor = (id: string) => {
    const contractValue = cValue.get(id) ?? 0;
    const contractCost = cCost.get(id) ?? 0;
    const ffa = contractValue + (vSell.get(id) ?? 0);
    const unexpected = (unpriced.get(id) ?? 0) + (overspend.get(id) ?? 0);
    const ffc = contractCost + (vMat.get(id) ?? 0) + (vLab.get(id) ?? 0) - (mSav.get(id) ?? 0) - (lSav.get(id) ?? 0) + (conting.get(id) ?? 0) + unexpected;
    return {
      contract_value: r2(contractValue),
      contract_cost: r2(contractCost),
      ffa: r2(ffa),
      ffc: r2(ffc),
      contract_gp_pct: contractValue > 0 ? (contractValue - contractCost) / contractValue : null,
      forecast_gp_pct: ffa > 0 ? (ffa - ffc) / ffa : null,
      labour_budget: r2(lBudget.get(id) ?? 0),
      labour_expended: r2(lCert.get(id) ?? 0),
    };
  };
  const prelimBudgetMap = new Map(prelimBudgetPP.results.map((r) => [r.pid, r.budget]));
  const prelimCommittedMap = new Map(prelimCommittedPP.results.map((r) => [r.pid, r.committed]));
  const prelimCountMap = new Map(prelimCommittedPP.results.map((r) => [r.pid, r.n]));
  const byProjectEnriched = byProject.results.map((p) => ({
    ...p, ...commercialFor(p.id),
    prelim_budget: r2(prelimBudgetMap.get(p.id) ?? 0),
    prelim_committed: r2(prelimCommittedMap.get(p.id) ?? 0),
  }));
  const prelimPoCount = byProjectEnriched.reduce((s, p) => s + (prelimCountMap.get(p.id) ?? 0), 0);
  // Accrued plant-hire cost (mirrors the project Prelims tab calc).
  let plantAccrued = 0;
  for (const pl of plantHire.results) {
    if (pl.day_rate == null || !pl.on_hire_from) continue;
    const from = new Date(pl.on_hire_from + "T00:00:00").getTime();
    const to = new Date((pl.off_hire_to ?? today) + "T00:00:00").getTime();
    if (Number.isNaN(from) || Number.isNaN(to)) continue;
    const days = Math.max(1, Math.floor((to - from) / 86_400_000) + 1);
    const units = pl.rate_unit === "week" ? Math.ceil(days / 7) : days;
    plantAccrued += units * pl.day_rate;
  }
  // The single most-pressing qualification card, "PASMA · P. Shah · expired".
  let worstCardLabel: string | null = null;
  if (worstCard?.expiry_date) {
    const exp = new Date(worstCard.expiry_date + "T00:00:00").getTime();
    const state = !Number.isNaN(exp)
      ? (exp < Date.now() ? "expired" : exp < Date.now() + 30 * 86_400_000 ? "expiring" : null)
      : null;
    if (state) {
      const parts = worstCard.name.trim().split(/\s+/).filter(Boolean);
      const who = parts.length > 1 ? `${parts[0][0]}. ${parts[parts.length - 1]}` : worstCard.name;
      worstCardLabel = `${worstCard.qual_type} · ${who} · ${state}`;
    }
  }
  // Monthly cash-flow series for the dashboard charts: the last `months` months
  // of actuals, plus 3 months forward so due-dated supplier invoices (payables)
  // are visible before they land.
  const FORWARD = 3;
  const monthKeys: string[] = [];
  {
    const dt = new Date(); dt.setUTCDate(1); dt.setUTCMonth(dt.getUTCMonth() - (months - 1));
    for (let i = 0; i < months + FORWARD; i++) { monthKeys.push(dt.toISOString().slice(0, 7)); dt.setUTCMonth(dt.getUTCMonth() + 1); }
  }
  // Supplier invoices in the Accounts inbox, keyed by due month: committed
  // money going out, whether or not it's reached Xero yet. The supplier's
  // ACCOUNT terms outrank the date printed on the invoice — Alumasc bill on
  // 30 days while the account is Net 60 EOM, so bucketing by the printed
  // due date lands payables a month early. Dismissed invoices are noise;
  // there's no paid flag on the inbox, so this reads as "payables due".
  const invoicesDueMap = new Map<string, number>();
  try {
    const inv = await c.env.DB.prepare(
      `SELECT i.invoice_date, i.due_date, i.received_at,
              -- Sterling roll-up: prefer the GBP equivalent (Xero FX rate) on a
              -- foreign-currency invoice; sterling ones have no base figure.
              COALESCE(i.base_net_amount, i.base_gross_amount, i.net_amount, i.gross_amount, 0) AS v,
              s.payment_terms AS supplier_terms
         FROM invoices i LEFT JOIN suppliers s ON s.id = i.supplier_id
        WHERE i.status != 'dismissed'`,
    ).all<{ invoice_date: string | null; due_date: string | null; received_at: string | null; v: number | null; supplier_terms: string | null }>();
    for (const r of inv.results) {
      const terms = parsePaymentTerms(r.supplier_terms);
      const expected = terms && r.invoice_date ? expectedDueDate(r.invoice_date, terms) : null;
      const month = (expected ?? r.due_date ?? r.invoice_date ?? r.received_at ?? "").slice(0, 7);
      if (month) invoicesDueMap.set(month, (invoicesDueMap.get(month) ?? 0) + (r.v ?? 0));
    }
  } catch { /* invoices table may predate migration */ }
  // Labour due — certified subcontractor applications not yet paid: committed
  // money going out alongside supplier invoices, bucketed to the month they
  // were certified (payable once certified/approved; no schedule exists).
  const labourDueMap = new Map<string, number>();
  try {
    const lab = await c.env.DB.prepare(
      `SELECT substr(COALESCE(a.certified_at, a.created_at), 1, 7) AS month,
              COALESCE(SUM(COALESCE(a.certified_amount, a.amount_due, 0)), 0) AS v
         FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND a.direction = 'incoming_labour'
          AND a.status = 'certified' AND a.paid_at IS NULL ${aProj}
        GROUP BY month`,
    ).bind(...b()).all<{ month: string; v: number }>();
    for (const r of lab.results) if (r.month) labourDueMap.set(r.month, r.v);
  } catch { /* pre-migration DBs */ }
  // Labour applied — subcontractor claims not yet certified (draft/submitted):
  // the softest layer of the pipeline. Valued at this-period NET (amount_due,
  // i.e. the claim less previously-certified) so re-sent or cumulative claims
  // don't double-count money already counted under Labour due / Cash out.
  const labourAppliedMap = new Map<string, number>();
  try {
    const lab = await c.env.DB.prepare(
      `SELECT substr(COALESCE(a.period_end, a.created_at), 1, 7) AS month,
              COALESCE(SUM(COALESCE(a.amount_due, 0)), 0) AS v
         FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND a.direction = 'incoming_labour'
          AND a.status IN ('draft', 'submitted') AND a.paid_at IS NULL ${aProj}
        GROUP BY month`,
    ).bind(...b()).all<{ month: string; v: number }>();
    for (const r of lab.results) if (r.month && r.v > 0) labourAppliedMap.set(r.month, r.v);
  } catch { /* pre-migration DBs */ }
  // Expected cash IN — certified client applications not yet paid, keyed by
  // their contractual receipt month: the valuation schedule's final date for
  // payment for that application, else certification date + the project's
  // client payment terms (Net 30 when unparseable). The mirror of
  // invoices_due, so money coming is visible before it lands.
  const receivablesDueMap = new Map<string, number>();
  try {
    const rec = await c.env.DB.prepare(
      `SELECT COALESCE(a.certified_amount, a.amount_due, 0) AS v, a.certified_at,
              p.payment_terms AS client_terms,
              (SELECT v2.date FROM valuation_schedule_entries v2
                WHERE v2.project_id = a.project_id AND v2.app_number = a.app_number
                  AND v2.entry_type = 'final_payment'
                ORDER BY v2.date DESC LIMIT 1) AS final_date
         FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
        WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND a.direction = 'outgoing'
          AND a.status = 'certified' AND a.paid_at IS NULL ${aProj}`,
    ).bind(...b()).all<{ v: number; certified_at: string | null; client_terms: string | null; final_date: string | null }>();
    for (const r of rec.results) {
      if (!(r.v > 0)) continue;
      let month = r.final_date ? r.final_date.slice(0, 7) : null;
      if (!month && r.certified_at) {
        const terms = parsePaymentTerms(r.client_terms) ?? { days: 30, eom: false };
        month = expectedDueDate(r.certified_at, terms).slice(0, 7);
      }
      if (month) receivablesDueMap.set(month, (receivablesDueMap.get(month) ?? 0) + r.v);
    }
  } catch { /* schedule/AfP tables may predate migration */ }
  const cashInMap = new Map<string, number>(), labourOutMap = new Map<string, number>();
  for (const r of afpPaidMonthly.results) {
    if (r.direction === "outgoing") cashInMap.set(r.month, (cashInMap.get(r.month) ?? 0) + r.v);
    else if (r.direction === "incoming_labour") labourOutMap.set(r.month, (labourOutMap.get(r.month) ?? 0) + r.v);
  }
  const poOutMap = new Map(poPaidMonthly.results.map((r) => [r.month, r.v]));
  const revMap = new Map(revenueMonthly.results.map((r) => [r.month, r.v]));
  const cashMonthly = monthKeys.map((m) => ({
    month: m,
    cash_in: r2(cashInMap.get(m) ?? 0),
    cash_out: r2((poOutMap.get(m) ?? 0) + (labourOutMap.get(m) ?? 0)),
    invoices_due: r2(invoicesDueMap.get(m) ?? 0),
    labour_due: r2(labourDueMap.get(m) ?? 0),
    labour_applied: r2(labourAppliedMap.get(m) ?? 0),
    receivables_due: r2(receivablesDueMap.get(m) ?? 0),
    revenue: r2(revMap.get(m) ?? 0),
  }));

  return c.json({
    filter: { project_id: pid, months },
    projects: { active: proj?.active ?? 0, completed: proj?.completed ?? 0, with_boq: withBoq?.n ?? 0 },
    pos: {
      committed_value: Math.round(committedValue * 100) / 100,
      paid_value: paidRow?.paid ?? 0,
      paid_count: paidRow?.n ?? 0,
      outstanding_value: Math.round((committedValue - (paidRow?.paid ?? 0)) * 100) / 100,
      pending_approval: pendingApproval,
      by_status: poStatus.results,
      monthly: poMonthly.results,
    },
    prelims: { budget: prelimBudget?.budget ?? 0, committed: prelimCommitted?.c ?? 0, po_count: prelimPoCount, plant_accrued: r2(plantAccrued) },
    applications: { client: appByDir("outgoing"), labour: appByDir("incoming_labour") },
    operations: {
      on_site_now: ops?.on_site_now ?? 0,
      signins_today: ops?.signins_today ?? 0,
      plant_on_site: ops?.plant_on_site ?? 0,
      daily: signinDaily.results,
    },
    compliance: {
      operatives: opv?.total ?? 0,
      inducted: opv?.inducted ?? 0,
      cards: { ...cards, worst_label: worstCardLabel },
      rams: { signed: ramsRow?.signed ?? 0, awaiting: ramsRow?.awaiting ?? 0 },
      plant_tests: plantTestBuckets,
    },
    xero: {
      connected: !!xeroConn,
      tenant: xeroConn?.tenant_name ?? null,
      pos_synced: xeroPo?.synced ?? 0,
      pos_unsynced: xeroPo?.unsynced ?? 0,
      pos_failed: xeroPo?.failed ?? 0,
      invoices_raised: signals?.invoices ?? 0,
    },
    signals: {
      variations_pending: signals?.var_pending ?? 0,
      afp_awaiting_cert: signals?.afp_awaiting ?? 0,
      framework_overdrawn: signals?.framework_overdrawn ?? 0,
    },
    by_project: byProjectEnriched,
    key_dates: keyDates.results,
    cash_monthly: cashMonthly,
  });
});

/** Row-level detail behind one month of the dashboard cash-flow charts — what
 *  was received, what's expected in, what went out, which supplier invoices
 *  fall due (at ACCOUNT-terms dates) and what revenue was recognised. Powers
 *  the click-through drill on the two charts. */
reports.get("/cash-detail", async (c) => {
  const denied = requirePermission(c, "users.read");
  if (denied) return denied;
  const month = (c.req.query("month") ?? "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: "month=YYYY-MM required" }, 400);
  const pid = c.req.query("project_id") || null;
  const db = c.env.DB;
  const aProj = pid ? "AND a.project_id = ?" : "";
  const poProj = pid ? "AND po.project_id = ?" : "";
  const b = (...extra: unknown[]) => (pid ? [...extra, pid] : extra);

  type Row = { kind: string; detail: string; date: string | null; amount: number };
  const rows: Row[] = [];

  // Cash in — client applications actually paid in the month. GROSS: the bank
  // receives the invoice total, VAT included, so the certified net is grossed
  // up at the application's own VAT rate (0% / reverse-charge jobs gross to
  // themselves).
  const paidIn = await db.prepare(
    `SELECT a.app_number, a.paid_at, p.code,
            COALESCE(a.certified_amount, a.cumulative_value, 0)
              * (1 + COALESCE(a.vat_pct, 0) / 100.0) AS v
       FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
      WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND a.direction = 'outgoing'
        AND substr(a.paid_at, 1, 7) = ? ${aProj}`,
  ).bind(...b(month)).all<{ app_number: number; paid_at: string; v: number; code: string }>();
  for (const r of paidIn.results) rows.push({ kind: "Cash in", detail: `${r.code} · Application #${r.app_number} paid`, date: r.paid_at?.slice(0, 10) ?? null, amount: r.v });

  // Expected in — certified, unpaid client applications landing in the month
  // (schedule final date for payment, else certification + client terms/Net 30).
  const certified = await db.prepare(
    `SELECT a.app_number, a.certified_at, p.code,
            COALESCE(a.certified_amount, a.amount_due, 0)
              * (1 + COALESCE(a.vat_pct, 0) / 100.0) AS v,
            p.payment_terms AS client_terms,
            (SELECT v2.date FROM valuation_schedule_entries v2
              WHERE v2.project_id = a.project_id AND v2.app_number = a.app_number AND v2.entry_type = 'final_payment'
              ORDER BY v2.date DESC LIMIT 1) AS final_date
       FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
      WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND a.direction = 'outgoing'
        AND a.status = 'certified' AND a.paid_at IS NULL ${aProj}`,
  ).bind(...b()).all<{ app_number: number; certified_at: string | null; v: number; code: string; client_terms: string | null; final_date: string | null }>();
  for (const r of certified.results) {
    if (!(r.v > 0)) continue;
    let due = r.final_date ? r.final_date.slice(0, 10) : null;
    if (!due && r.certified_at) {
      const terms = parsePaymentTerms(r.client_terms) ?? { days: 30, eom: false };
      due = expectedDueDate(r.certified_at, terms);
    }
    if (due?.slice(0, 7) === month) rows.push({ kind: "Expected in", detail: `${r.code} · Application #${r.app_number} certified — final date for payment`, date: due, amount: r.v });
  }

  // Cash out — POs and labour applications paid in the month.
  const paidPos = await db.prepare(
    `SELECT po.po_number, po.supplier, po.total_value AS v, po.paid_at, p.code
       FROM purchase_orders po JOIN projects p ON p.id = po.project_id
      WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND substr(po.paid_at, 1, 7) = ? ${poProj}`,
  ).bind(...b(month)).all<{ po_number: string; supplier: string | null; v: number; paid_at: string; code: string }>();
  for (const r of paidPos.results) rows.push({ kind: "Cash out", detail: `${r.code} · ${r.po_number}${r.supplier ? ` — ${r.supplier}` : ""} paid`, date: r.paid_at?.slice(0, 10) ?? null, amount: r.v });
  const paidLabour = await db.prepare(
    `SELECT a.app_number, a.paid_at, COALESCE(a.certified_amount, a.cumulative_value, 0) AS v, p.code
       FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
      WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND a.direction = 'incoming_labour'
        AND substr(a.paid_at, 1, 7) = ? ${aProj}`,
  ).bind(...b(month)).all<{ app_number: number; paid_at: string; v: number; code: string }>();
  for (const r of paidLabour.results) rows.push({ kind: "Cash out", detail: `${r.code} · labour application #${r.app_number} paid`, date: r.paid_at?.slice(0, 10) ?? null, amount: r.v });

  // Labour due — certified subcontractor applications awaiting payment,
  // bucketed to the month certified.
  const labDue = await db.prepare(
    `SELECT a.app_number, COALESCE(a.certified_at, a.created_at) AS d,
            COALESCE(a.certified_amount, a.amount_due, 0) AS v, p.code
       FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
      WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND a.direction = 'incoming_labour'
        AND a.status = 'certified' AND a.paid_at IS NULL
        AND substr(COALESCE(a.certified_at, a.created_at), 1, 7) = ? ${aProj}`,
  ).bind(...b(month)).all<{ app_number: number; d: string; v: number; code: string }>();
  for (const r of labDue.results) {
    if (!(r.v > 0)) continue;
    rows.push({ kind: "Labour due", detail: `${r.code} · labour application #${r.app_number} certified — awaiting payment`, date: r.d?.slice(0, 10) ?? null, amount: r.v });
  }

  // Labour applied — claims not yet certified, at this-period net value.
  const labApplied = await db.prepare(
    `SELECT a.app_number, a.status, COALESCE(a.period_end, a.created_at) AS d,
            COALESCE(a.amount_due, 0) AS v, p.code
       FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
      WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND a.direction = 'incoming_labour'
        AND a.status IN ('draft', 'submitted') AND a.paid_at IS NULL
        AND substr(COALESCE(a.period_end, a.created_at), 1, 7) = ? ${aProj}`,
  ).bind(...b(month)).all<{ app_number: number; status: string; d: string; v: number; code: string }>();
  for (const r of labApplied.results) {
    if (!(r.v > 0)) continue;
    rows.push({ kind: "Labour applied", detail: `${r.code} · labour application #${r.app_number} (${r.status}) — claim awaiting certification`, date: r.d?.slice(0, 10) ?? null, amount: r.v });
  }

  // Invoices due — supplier invoices whose ACCOUNT-terms due date lands in the
  // month (the invoice's own date only when no account terms are readable).
  const inv = await db.prepare(
    `SELECT i.supplier_name, i.invoice_number, i.invoice_date, i.due_date, i.received_at,
            -- Sterling roll-up: prefer the GBP equivalent (Xero FX rate) on a
              -- foreign-currency invoice; sterling ones have no base figure.
              COALESCE(i.base_net_amount, i.base_gross_amount, i.net_amount, i.gross_amount, 0) AS v, s.payment_terms AS supplier_terms
       FROM invoices i LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.status != 'dismissed'`,
  ).all<{ supplier_name: string | null; invoice_number: string | null; invoice_date: string | null; due_date: string | null; received_at: string | null; v: number; supplier_terms: string | null }>();
  for (const r of inv.results) {
    const terms = parsePaymentTerms(r.supplier_terms);
    const expected = terms && r.invoice_date ? expectedDueDate(r.invoice_date, terms) : null;
    const due = expected ?? r.due_date?.slice(0, 10) ?? r.invoice_date?.slice(0, 10) ?? r.received_at?.slice(0, 10) ?? null;
    if (due?.slice(0, 7) === month) {
      rows.push({ kind: "Invoices due", detail: `${r.supplier_name ?? "Unknown supplier"}${r.invoice_number ? ` · ${r.invoice_number}` : ""}${expected && r.due_date && expected !== r.due_date.slice(0, 10) ? " (account terms)" : ""}`, date: due, amount: r.v });
    }
  }

  // Revenue recognised — certified client applications bucketed as the
  // revenue chart buckets them (paid date, else certification created date).
  const rev = await db.prepare(
    `SELECT a.app_number, COALESCE(a.paid_at, a.created_at) AS d, COALESCE(a.certified_amount, 0) AS v, p.code
       FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
      WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND a.direction = 'outgoing'
        AND a.status IN ('certified','paid') AND substr(COALESCE(a.paid_at, a.created_at), 1, 7) = ? ${aProj}`,
  ).bind(...b(month)).all<{ app_number: number; d: string; v: number; code: string }>();
  for (const r of rev.results) rows.push({ kind: "Revenue", detail: `${r.code} · Application #${r.app_number} certified`, date: r.d?.slice(0, 10) ?? null, amount: r.v });

  rows.sort((x, y) => (x.kind === y.kind ? y.amount - x.amount : x.kind.localeCompare(y.kind)));
  return c.json({ month, rows });
});

/** Projected future cash — derived, no manual input:
 *  IN: remaining FFA split across the valuation schedule's future final-payment
 *      dates (even spread over the horizon when a project has no schedule),
 *      net of client retention.
 *  OUT labour: remaining labour BOQ phased over the remaining programme, paid
 *      on the fortnightly-application + 7-days-from-invoice cycle (≈75% of a
 *      month's burn pays in-month, 25% rolls into the next).
 *  OUT materials: committed-but-uninvoiced POs (50/50 over the next two
 *      months) plus unspent materials budget phased over the remaining
 *      programme at a default Net-45 lag.
 *  Every £ carries a basis row so the outlook drawer can show its working. */
reports.get("/cash-outlook", async (c) => {
  const denied = requirePermission(c, "users.read");
  if (denied) return denied;
  const pid = c.req.query("project_id") || null;
  const fwd = Math.min(12, Math.max(1, Number(c.req.query("months_fwd") ?? 6)));
  const db = c.env.DB;
  const pProj = pid ? "AND p.id = ?" : "";
  const bp = (...extra: unknown[]) => (pid ? [...extra, pid] : extra);
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);

  // Future month keys, starting this month.
  const futureMonths: string[] = [];
  { const dt = new Date(); dt.setUTCDate(1); for (let i = 0; i < fwd; i++) { futureMonths.push(dt.toISOString().slice(0, 7)); dt.setUTCMonth(dt.getUTCMonth() + 1); } }
  const monthAfter = (m: string, n = 1) => { const d = new Date(m + "-01T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };

  const [projects, contractTotals, varSell, appliedRows, finals, labBudget, labCert, matBudget, committedRows, invNet, progEnd, adjRows, progStart, committedSupRows, invoicedSupRows, inflightRows, groupRows] = await Promise.all([
    db.prepare(`SELECT p.id, p.code, COALESCE(p.client_retention_pct, p.retention_pct, 0) AS ret
                  FROM projects p WHERE p.deleted_at IS NULL AND p.id <> 'sandbox' AND p.completed_at IS NULL ${pProj}`)
      .bind(...bp()).all<{ id: string; code: string; ret: number }>(),
    db.prepare(`SELECT sn.project_id AS pid, COALESCE(c.value, 0) AS v
                  FROM project_commercials c JOIN material_snapshots sn ON sn.id = c.snapshot_id
                 WHERE c.is_total = 1 AND sn.is_active = 1`).all<{ pid: string; v: number }>(),
    db.prepare("SELECT project_id AS pid, COALESCE(SUM(sell_value),0) AS v FROM variations GROUP BY project_id")
      .all<{ pid: string; v: number }>(),
    db.prepare(`SELECT project_id AS pid, cumulative_value AS v FROM (
                  SELECT a.project_id, a.cumulative_value,
                         ROW_NUMBER() OVER (PARTITION BY a.project_id ORDER BY a.app_number DESC) AS rn
                    FROM applications_for_payment a WHERE a.direction = 'outgoing'
                ) WHERE rn = 1`).all<{ pid: string; v: number }>(),
    // Only schedule slots for applications NOT yet raised. Raised applications
    // carry their money through the other layers — certified sits in committed
    // receivables, draft/submitted projects its own amount due below — so a
    // raised slot projecting an S-curve share too would double-load the
    // outlook. Each slot carries its application-window date so the projection
    // knows whether the slot is still achievable or was missed.
    db.prepare(`SELECT v.project_id AS pid, v.date,
                       (SELECT MIN(v2.date) FROM valuation_schedule_entries v2
                         WHERE v2.project_id = v.project_id AND v2.app_number = v.app_number
                           AND v2.entry_type = 'application') AS app_date
                  FROM valuation_schedule_entries v
                 WHERE v.entry_type = 'final_payment' AND v.date > ?
                   AND (v.app_number IS NULL OR v.app_number > COALESCE((
                         SELECT MAX(a.app_number) FROM applications_for_payment a
                          WHERE a.project_id = v.project_id AND a.direction = 'outgoing'), 0))
                 ORDER BY v.date`)
      .bind(today).all<{ pid: string; date: string; app_date: string | null }>(),
    db.prepare(`SELECT sn.project_id AS pid, COALESCE(SUM(ci.labour_rate * ci.qty), 0) AS v
                  FROM contract_items ci JOIN material_snapshots sn ON sn.id = ci.snapshot_id
                 WHERE sn.is_active = 1 AND ci.labour_rate IS NOT NULL GROUP BY sn.project_id`)
      .all<{ pid: string; v: number }>(),
    db.prepare(`SELECT project_id AS pid, COALESCE(SUM(cumulative_value), 0) AS v FROM (
                  SELECT a.project_id, a.cumulative_value,
                         ROW_NUMBER() OVER (PARTITION BY a.project_id, a.counterparty_supplier_id ORDER BY a.app_number DESC) AS rn
                    FROM applications_for_payment a
                   WHERE a.direction = 'incoming_labour' AND a.status IN ('certified','paid')
                ) WHERE rn = 1 GROUP BY project_id`).all<{ pid: string; v: number }>(),
    db.prepare(`SELECT sn.project_id AS pid,
                       COALESCE(SUM(MAX(m.total_units - COALESCE(mo.omit_qty, 0), 0) * m.cost), 0) AS v
                  FROM materials m JOIN material_snapshots sn ON sn.id = m.snapshot_id
                  LEFT JOIN material_omissions mo
                    ON mo.project_id = sn.project_id AND mo.item_key = lower(m.item)
                 WHERE sn.is_active = 1 AND m.cost IS NOT NULL
                   AND (mo.item_key IS NULL OR mo.omit_qty IS NOT NULL)
                 GROUP BY sn.project_id`)
      .all<{ pid: string; v: number }>(),
    db.prepare(`SELECT po.project_id AS pid, COALESCE(SUM(CASE WHEN COALESCE(po.order_type,'standard') != 'call_off' THEN po.total_value ELSE 0 END), 0) AS v
                  FROM purchase_orders po WHERE po.status IN ('approved','issued','pending_approval') GROUP BY po.project_id`)
      .all<{ pid: string; v: number }>(),
    db.prepare(`SELECT project_id AS pid, COALESCE(SUM(COALESCE(base_net_amount, base_gross_amount, net_amount, gross_amount, 0)), 0) AS v
                  FROM invoices WHERE status != 'dismissed' AND project_id IS NOT NULL GROUP BY project_id`)
      .all<{ pid: string; v: number }>(),
    db.prepare(`SELECT project_id AS pid, MAX(COALESCE(planned_finish, baseline_finish)) AS d
                  FROM programme_activities GROUP BY project_id`).all<{ pid: string; d: string | null }>(),
    // Manual adjustments: project-scoped view shows only that project's; the
    // portfolio view rolls up everything (incl. portfolio-level, project NULL).
    db.prepare(`SELECT id, month, direction, amount, label FROM cash_forecast_adjustments ${pid ? "WHERE project_id = ?" : ""}`)
      .bind(...(pid ? [pid] : [])).all<{ id: number; month: string; direction: "in" | "out"; amount: number; label: string }>(),
    db.prepare(`SELECT project_id AS pid, MIN(COALESCE(planned_start, baseline_start)) AS d
                  FROM programme_activities GROUP BY project_id`).all<{ pid: string; d: string | null }>(),
    // Committed POs (per PO, not per supplier): the supplier's account terms
    // set the payment lag, and the PO's own required-by date anchors WHEN the
    // invoice is assumed to arrive — a long-lead order isn't paid off today's
    // date just because it's committed today.
    db.prepare(`SELECT po.project_id AS pid, po.supplier AS supplier, s.id AS sid, s.payment_terms AS terms,
                       po.delivery_date AS delivery_date,
                       CASE WHEN COALESCE(po.order_type,'standard') != 'call_off' THEN po.total_value ELSE 0 END AS v
                  FROM purchase_orders po LEFT JOIN suppliers s ON lower(s.name) = lower(po.supplier)
                 WHERE po.status IN ('approved','issued','pending_approval')`)
      .all<{ pid: string; supplier: string; sid: number | null; terms: string | null; delivery_date: string | null; v: number }>(),
    db.prepare(`SELECT project_id AS pid, supplier_id AS sid, COALESCE(SUM(COALESCE(base_net_amount, base_gross_amount, net_amount, gross_amount, 0)), 0) AS v
                  FROM invoices WHERE status != 'dismissed' AND project_id IS NOT NULL AND supplier_id IS NOT NULL
                 GROUP BY project_id, supplier_id`).all<{ pid: string; sid: number; v: number }>(),
    // The latest outgoing application per project when it's still in flight
    // (draft/submitted): its due amount projects on its own slot's payment
    // date until certification moves it into committed receivables.
    db.prepare(`SELECT t.pid, t.app_number, t.status, t.v,
                       (SELECT v2.date FROM valuation_schedule_entries v2
                         WHERE v2.project_id = t.pid AND v2.app_number = t.app_number
                           AND v2.entry_type = 'final_payment'
                         ORDER BY v2.date DESC LIMIT 1) AS final_date
                  FROM (SELECT a.project_id AS pid, a.app_number, a.status, COALESCE(a.amount_due, 0) AS v,
                               ROW_NUMBER() OVER (PARTITION BY a.project_id ORDER BY a.app_number DESC) AS rn
                          FROM applications_for_payment a WHERE a.direction = 'outgoing') t
                 WHERE t.rn = 1 AND t.status IN ('draft', 'submitted')`)
      .all<{ pid: string; app_number: number; status: string; v: number; final_date: string | null }>(),
    // Site-group membership: a grouped site bills as ONE contract family — its
    // combined applications live on the base project — so income must compute
    // once per group (on the base) or the blocks' contracts double-count on
    // top of the combined application's money.
    db.prepare(`SELECT p.id AS pid, COALESCE(g.base_project_id, p.id) AS base
                  FROM projects p LEFT JOIN site_groups g ON g.id = p.site_group_id
                 WHERE p.deleted_at IS NULL`)
      .all<{ pid: string; base: string }>(),
  ]);
  const map = (rows: { results: Array<{ pid: string; v: number }> }) => new Map(rows.results.map((r) => [r.pid, r.v]));
  const ffaBase = map(contractTotals), vSell = map(varSell), applied = map(appliedRows);
  const lBud = map(labBudget), lCert = map(labCert), mBud = map(matBudget), committed = map(committedRows), invoiced = map(invNet);
  const finalsBy = new Map<string, Array<{ date: string; app_date: string | null }>>();
  for (const f of finals.results) { if (!finalsBy.has(f.pid)) finalsBy.set(f.pid, []); finalsBy.get(f.pid)!.push({ date: f.date, app_date: f.app_date }); }
  const progBy = new Map(progEnd.results.map((r) => [r.pid, r.d]));
  const progStartBy = new Map(progStart.results.map((r) => [r.pid, r.d]));
  const committedSupBy = new Map<string, Array<{ supplier: string; sid: number | null; terms: string | null; delivery_date: string | null; v: number }>>();
  for (const r of committedSupRows.results) {
    if (r.v <= 0.005) continue;
    if (!committedSupBy.has(r.pid)) committedSupBy.set(r.pid, []);
    committedSupBy.get(r.pid)!.push(r);
  }
  const invoicedSupBy = new Map(invoicedSupRows.results.map((r) => [`${r.pid}|${r.sid}`, r.v]));
  const inflightBy = new Map(inflightRows.results.map((r) => [r.pid, r]));
  const baseOf = new Map(groupRows.results.map((r) => [r.pid, r.base]));
  const membersByBase = new Map<string, string[]>();
  for (const r of groupRows.results) {
    if (!membersByBase.has(r.base)) membersByBase.set(r.base, []);
    membersByBase.get(r.base)!.push(r.pid);
  }

  // ── S-curve phasing over the programme ────────────────────────────────
  // Construction spend/income ramps up, peaks mid-programme and tapers — a
  // smoothstep cumulative curve, not a flat line. Weights are the curve's
  // slice for each month of the programme window, normalized over the months
  // being phased; unknown window → even weights (old behaviour).
  const sCum = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
  const monthsBetween = (a: string, b: string) =>
    (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
  const curveWeights = (months: string[], startYM: string | null, endYM: string | null): Map<string, number> => {
    const w = new Map<string, number>();
    if (!months.length) return w;
    const even = () => { for (const m of months) w.set(m, (w.get(m) ?? 0) + 1 / months.length); return w; };
    if (!startYM || !endYM || endYM <= startYM) return even();
    const N = monthsBetween(startYM, endYM) + 1;
    let sum = 0;
    for (const m of months) {
      const i = monthsBetween(startYM, m);
      const phi = i < 0 || i >= N ? 0 : sCum((i + 1) / N) - sCum(i / N);
      w.set(m, (w.get(m) ?? 0) + phi); sum += phi;
    }
    if (sum <= 1e-9) { w.clear(); return even(); }
    for (const [m, v] of w) w.set(m, v / sum);
    return w;
  };
  // Supplier account terms → whole-month payment lag (invoice month → cash month).
  const termLagMonths = (terms: string | null): number => {
    const pt = terms ? parsePaymentTerms(terms) : null;
    const days = (pt?.days ?? 45) + (pt?.eom ? 15 : 0);
    return Math.max(0, Math.round(days / 30));
  };

  const projIn = new Map<string, number>(), projOut = new Map<string, number>();
  const basis: Array<{ month: string; kind: string; detail: string; date: string | null; amount: number; adj_id?: number }> = [];
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  const push = (month: string, kind: "Projected in" | "Projected out", detail: string, date: string | null, amount: number) => {
    if (!futureMonths.includes(month) || amount < 0.005) return;
    add(kind === "Projected in" ? projIn : projOut, month, amount);
    basis.push({ month, kind, detail, date, amount: Math.round(amount * 100) / 100 });
  };

  for (const p of projects.results) {
    // Months this project is still running (programme end, else full horizon).
    const end = progBy.get(p.id)?.slice(0, 7);
    const activeMonths = futureMonths.filter((m) => !end || m <= end);
    const phaseMonths = activeMonths.length ? activeMonths : [futureMonths[0]];

    // A grouped site bills as one contract family on its BASE project: the
    // combined application carries every block's value, so income projects
    // ONCE from the base (summing the members' FFAs) and the member blocks
    // contribute no income of their own. Outflows below stay per block.
    const incomeMembers = membersByBase.get(p.id) ?? [p.id];
    const isIncomeCarrier = (baseOf.get(p.id) ?? p.id) === p.id;
    const grouped = incomeMembers.length > 1;
    const codeLabel = grouped ? `${p.code} · grouped site` : p.code;

    // ── Income: an application already raised but not yet certified projects
    //    its own due amount on its slot's payment date — it isn't in committed
    //    receivables yet, and its slot below is suppressed. amount_due is
    //    already net of retention and previously-certified. ──
    const inflight = isIncomeCarrier ? inflightBy.get(p.id) : undefined;
    if (inflight && inflight.v > 0.005) {
      // Its slot's payment month when that's still ahead; an overdue or
      // unscheduled application is expected next month once certified.
      const slotMonth = (inflight.final_date ?? "").slice(0, 7);
      const month = slotMonth >= thisMonth ? slotMonth : monthAfter(thisMonth);
      push(month, "Projected in",
        `${codeLabel} · application #${inflight.app_number} ${inflight.status === "submitted" ? "submitted — awaiting certification" : "in draft — not yet submitted"}`,
        inflight.final_date, inflight.v);
    }

    // ── Income: remaining FFA across future applications. Dates come from
    //    the valuation schedule (monthly cadence beyond it); the S-curve over
    //    the programme decides how much each application is WORTH. ──
    const ffa = isIncomeCarrier
      ? incomeMembers.reduce((s, mid) => s + (ffaBase.get(mid) ?? 0) + (vSell.get(mid) ?? 0), 0)
      : 0;
    const remainingIncome = Math.max(0, ffa - (applied.get(p.id) ?? 0));
    if (isIncomeCarrier && remainingIncome > 0.005) {
      const netFactor = 1 - (p.ret ?? 0) / 100;
      const known = finalsBy.get(p.id) ?? [];
      // Expect at least one application per remaining programme month — a
      // schedule with only its next date entered mustn't dump the whole
      // remaining FFA into that one application.
      const expectedApps = Math.max(known.length, phaseMonths.length, 1);
      // A slot is still achievable while its application-window date is ahead
      // (fortnightly cycles legitimately value AND pay inside one month). Once
      // the application date passes with nothing raised, the slot is missed and
      // its value rolls into the next achievable application.
      const entries: Array<{ month: string; date: string | null; assumed: boolean; missed: boolean }> =
        known.map((k) => ({ month: k.date.slice(0, 7), date: k.date, assumed: false, missed: k.app_date != null && k.app_date < today }));
      let cursor = monthAfter(known.length ? known[known.length - 1].date.slice(0, 7) : thisMonth);
      for (let i = known.length; i < expectedApps; i++) { entries.push({ month: cursor, date: null, assumed: true, missed: false }); cursor = monthAfter(cursor); }
      // Grouped: the S-curve spans the whole site's programme (earliest member
      // start to latest member end), since the combined applications do too.
      const incomeStart = incomeMembers
        .map((mid) => progStartBy.get(mid)?.slice(0, 7) ?? null)
        .filter((x): x is string => !!x).sort()[0] ?? null;
      const incomeEnd = incomeMembers
        .map((mid) => progBy.get(mid)?.slice(0, 7) ?? null)
        .filter((x): x is string => !!x).sort().pop() ?? null;
      const wts = curveWeights(entries.map((e) => e.month), incomeStart, incomeEnd);
      const perMonthCount = new Map<string, number>();
      for (const e of entries) perMonthCount.set(e.month, (perMonthCount.get(e.month) ?? 0) + 1);
      const suffix = p.ret ? `, net of ${p.ret}% retention` : "";
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const share = remainingIncome * ((wts.get(e.month) ?? 0) / (perMonthCount.get(e.month) ?? 1));
        let cashMonth = e.month;
        let cashDate = e.date;
        let note = "";
        if (e.missed) {
          const next = entries.slice(i + 1).find((x) => !x.missed);
          cashMonth = next?.month ?? monthAfter(thisMonth);
          // The row carries the date the cash actually arrives (the slot it
          // rolled into), not the missed slot's own date.
          cashDate = next?.date ?? null;
          if (cashMonth !== e.month) note = " — application window missed, rolls into the next application";
        }
        push(cashMonth, "Projected in",
          `${codeLabel} · projected application (S-curve share of £${Math.round(remainingIncome).toLocaleString()} remaining FFA${suffix}${e.assumed ? " — monthly cadence beyond the schedule" : ""}${note})`,
          cashDate, share * netFactor);
      }
    }

    // ── Labour: remaining BOQ burn, S-curve over the programme, paid on the
    //    weekly/fortnightly +7-days cycle (≈¾ in-month, ¼ rolls) ──
    const labRemaining = Math.max(0, (lBud.get(p.id) ?? 0) - (lCert.get(p.id) ?? 0));
    if (labRemaining > 0.005) {
      const wts = curveWeights(phaseMonths, progStartBy.get(p.id)?.slice(0, 7) ?? null, end ?? null);
      for (const m of phaseMonths) {
        const per = labRemaining * (wts.get(m) ?? 0);
        if (per < 0.005) continue;
        push(m, "Projected out", `${p.code} · projected labour (S-curve burn £${Math.round(per).toLocaleString()} this month, weekly/fortnightly apps paid +7 days)`, null, per * 0.75);
        push(monthAfter(m), "Projected out", `${p.code} · projected labour (final cycle of prior month, paid +7 days)`, null, per * 0.25);
      }
    }

    // ── Materials: committed-not-invoiced, paid at each supplier's terms.
    //    The invoice is assumed at DELIVERY, not at "now": each PO anchors on
    //    the latest of next month / its required-by date / the programme start,
    //    so a long-lead order for a project starting later in the year pays
    //    after that start rather than off today's date. ──
    const committedUninvoiced = Math.max(0, (committed.get(p.id) ?? 0) - (invoiced.get(p.id) ?? 0));
    const progStartM = progStartBy.get(p.id)?.slice(0, 7) ?? null;
    const poRows = committedSupBy.get(p.id) ?? [];
    // Net each supplier's linked invoices off that supplier's POs pro-rata.
    const bySup = new Map<string, typeof poRows>();
    for (const r of poRows) { const k = r.supplier.toLowerCase(); if (!bySup.has(k)) bySup.set(k, []); bySup.get(k)!.push(r); }
    const unPos: typeof poRows = [];
    for (const rows of bySup.values()) {
      const tot = rows.reduce((a, r) => a + r.v, 0);
      const inv = rows[0].sid != null ? invoicedSupBy.get(`${p.id}|${rows[0].sid}`) ?? 0 : 0;
      const keep = tot > 0.005 ? Math.max(0, tot - inv) / tot : 0;
      for (const r of rows) if (r.v * keep > 0.005) unPos.push({ ...r, v: r.v * keep });
    }
    if (committedUninvoiced > 0.005) {
      const supSum = unPos.reduce((a, s) => a + s.v, 0);
      if (supSum > 0.005) {
        // Per-supplier figures scaled so they reconcile with the project-level
        // netting (invoices without a supplier link reduce everything pro-rata).
        const scale = Math.min(1, committedUninvoiced / supSum);
        for (const s of unPos) {
          const lag = termLagMonths(s.terms);
          // The PO's own required-by date is the anchor when set (a deliberate
          // delivery promise beats any assumption — edit the PO date to move
          // the cash). Only a PO with NO date falls back to "next month, but
          // never before the programme start" for not-yet-started projects.
          const delivM = s.delivery_date?.slice(0, 7) ?? null;
          const anchor = delivM
            ? (delivM > thisMonth ? delivM : thisMonth)
            : [monthAfter(thisMonth), progStartM].filter((x): x is string => !!x).sort().pop()!;
          const why = delivM
            ? (delivM > thisMonth ? ` — delivery due ${anchor}` : "")
            : (anchor !== monthAfter(thisMonth) ? ` — no delivery date, held to project start ${anchor}` : "");
          const half = (s.v * scale) / 2;
          const t = s.terms ?? "no account terms — Net 45 assumed";
          push(monthAfter(anchor, lag), "Projected out", `${p.code} · ${s.supplier} — committed POs awaiting invoice (paid at ${t}${why})`, null, half);
          push(monthAfter(anchor, 1 + lag), "Projected out", `${p.code} · ${s.supplier} — committed POs awaiting invoice (paid at ${t}${why})`, null, half);
        }
      } else {
        const anchor0 = [monthAfter(thisMonth), progStartM].filter((x): x is string => !!x).sort().pop()!;
        push(anchor0, "Projected out", `${p.code} · committed POs not yet invoiced (½, invoices expected at supplier terms)`, null, committedUninvoiced / 2);
        push(monthAfter(anchor0), "Projected out", `${p.code} · committed POs not yet invoiced (½, invoices expected at supplier terms)`, null, committedUninvoiced / 2);
      }
    }
    // ── Materials: unspent budget, S-curve over the programme, paid at the
    //    project's value-weighted supplier terms (Net-45 only where unknown) ──
    const matRemaining = Math.max(0, (mBud.get(p.id) ?? 0) - (committed.get(p.id) ?? 0));
    if (matRemaining > 0.005) {
      const mix = committedSupBy.get(p.id) ?? [];
      const mixSum = mix.reduce((a, s) => a + s.v, 0);
      const lagBar = mixSum > 0.005
        ? Math.max(0, Math.round(mix.reduce((a, s) => a + s.v * termLagMonths(s.terms), 0) / mixSum))
        : 1;
      const lagNote = mixSum > 0.005
        ? `paid ≈${lagBar} month${lagBar === 1 ? "" : "s"} after the work — value-weighted from its suppliers' terms`
        : "default Net 45";
      const wts = curveWeights(phaseMonths, progStartBy.get(p.id)?.slice(0, 7) ?? null, end ?? null);
      for (const m of phaseMonths) {
        const per = matRemaining * (wts.get(m) ?? 0);
        if (per < 0.005) continue;
        push(monthAfter(m, lagBar), "Projected out", `${p.code} · projected materials (S-curve over programme, ${lagNote})`, null, per);
      }
    }
  }

  // Manual adjustments layer on top of the derived projection. They bypass
  // push() deliberately: negative amounts are allowed (they reduce the series).
  for (const a of adjRows.results) {
    if (!futureMonths.includes(a.month)) continue;
    const kind = a.direction === "in" ? "Projected in" as const : "Projected out" as const;
    add(kind === "Projected in" ? projIn : projOut, a.month, a.amount);
    basis.push({ month: a.month, kind, detail: `${a.label} · manual adjustment`, date: null, amount: Math.round(a.amount * 100) / 100, adj_id: a.id });
  }

  const r2n = (n: number) => Math.round(n * 100) / 100;
  return c.json({
    from: thisMonth,
    months: futureMonths.map((m) => ({ month: m, projected_in: r2n(projIn.get(m) ?? 0), projected_out: r2n(projOut.get(m) ?? 0) })),
    basis: basis.sort((a, b) => (a.month === b.month ? b.amount - a.amount : a.month.localeCompare(b.month))),
    assumptions: [
      "Projected applications: remaining FFA across future applications — dates from the valuation schedule (monthly beyond it), figures S-curve weighted over each project's programme, net of client retention. A raised application carries its own money instead of a slot share: certified sits in committed receivables, and a draft/submitted application projects its due amount on its slot's payment date. A slot whose application date has passed un-applied rolls its value into the next achievable application.",
      "Projected labour: remaining labour BOQ S-curve phased over the programme; weekly/fortnightly applications paid 7 days from invoice (≈¾ in-month, ¼ next).",
      "Projected materials: committed-but-uninvoiced POs invoice at assumed delivery — the PO's required-by date where set (edit the PO date to move the cash), otherwise no earlier than the project's programme start — then paid at each supplier's account terms from the approved list; unspent budget S-curve phased and paid at the project's value-weighted supplier terms (Net-45 only where unknown).",
      ...(adjRows.results.length
        ? [`Manual adjustments: ${adjRows.results.length} user-entered line${adjRows.results.length === 1 ? "" : "s"} layered on the derived projection — click a month to see or remove them.`]
        : []),
    ],
  });
});

// ── Manual outlook adjustments: add / remove a projected line ──────────────
// Forecast annotations, not commercial records — gated to the same audience
// that can see the dashboard.
reports.post("/cash-adjustments", async (c) => {
  const denied = requirePermission(c, "users.read");
  if (denied) return denied;
  const b = await c.req.json<{ project_id?: string | null; month?: string; direction?: string; amount?: number; label?: string }>()
    .catch(() => ({} as Record<string, never>));
  const month = (b.month ?? "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: "month must be YYYY-MM" }, 400);
  if (b.direction !== "in" && b.direction !== "out") return c.json({ error: "direction must be 'in' or 'out'" }, 400);
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || Math.abs(amount) < 0.01) return c.json({ error: "amount must be a non-zero number" }, 400);
  const label = (b.label ?? "").trim();
  if (!label) return c.json({ error: "label is required" }, 400);
  const r = await c.env.DB.prepare(
    "INSERT INTO cash_forecast_adjustments (project_id, month, direction, amount, label, created_by) VALUES (?,?,?,?,?,?)",
  ).bind(b.project_id || null, month, b.direction, amount, label, c.get("userEmail") ?? null).run();
  return c.json({ id: Number(r.meta.last_row_id) });
});

reports.delete("/cash-adjustments/:id", async (c) => {
  const denied = requirePermission(c, "users.read");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
  await c.env.DB.prepare("DELETE FROM cash_forecast_adjustments WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});
