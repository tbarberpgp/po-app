import { Hono } from "hono";
import type { Env, Variables } from "../env";
import type { CreatePOInput, POLine } from "../../shared/types";
import { loadSettings, tierForApproval } from "../approval";
import { emailApprovers } from "../notify";

export const pos = new Hono<{ Bindings: Env; Variables: Variables }>();

pos.get("/", async (c) => {
  const projectId = c.req.query("project_id");
  const status = c.req.query("status");
  const where: string[] = [];
  const binds: unknown[] = [];
  if (projectId) {
    where.push("project_id = ?");
    binds.push(projectId);
  }
  if (status) {
    where.push("status = ?");
    binds.push(status);
  }
  const sql = `SELECT po.*, p.code AS project_code, p.name AS project_name
     FROM purchase_orders po
     JOIN projects p ON p.id = po.project_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY po.created_at DESC`;
  const rows = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all();
  return c.json(rows.results);
});

pos.get("/:id", async (c) => {
  const id = c.req.param("id");
  const po = await c.env.DB.prepare(
    `SELECT po.*, p.code AS project_code, p.name AS project_name
     FROM purchase_orders po
     JOIN projects p ON p.id = po.project_id
     WHERE po.id = ?`,
  )
    .bind(id)
    .first();
  if (!po) return c.json({ error: "not found" }, 404);
  const lines = await c.env.DB.prepare(
    "SELECT * FROM po_lines WHERE po_id = ? ORDER BY id",
  )
    .bind(id)
    .all();
  return c.json({ ...po, lines: lines.results });
});

pos.post("/", async (c) => {
  const body = await c.req.json<CreatePOInput>();
  const actor = c.get("userEmail");
  if (!body.project_id || !body.supplier || !body.lines?.length) {
    return c.json({ error: "project_id, supplier and at least one line are required" }, 400);
  }

  const project = await c.env.DB.prepare(
    "SELECT id, code FROM projects WHERE id = ?",
  )
    .bind(body.project_id)
    .first<{ id: string; code: string }>();
  if (!project) return c.json({ error: "project not found" }, 404);

  const snap = await c.env.DB.prepare(
    "SELECT id FROM material_snapshots WHERE project_id = ? AND is_active = 1",
  )
    .bind(project.id)
    .first<{ id: number }>();

  // Compute approval state per line
  const enriched: POLine[] = [];
  let hasUnpriced = false;
  let hasOverBudget = false;
  let total = 0;

  for (const ln of body.lines) {
    let isUnpriced = ln.material_id == null;
    let isOverBudget = false;
    let pricedQty: number | null = null;
    let committedBefore: number | null = null;
    let manufacturer = ln.manufacturer ?? null;
    let type = ln.type ?? null;

    if (ln.material_id != null && snap) {
      const mat = await c.env.DB.prepare(
        "SELECT id, item, type, manufacturer, total_qty FROM materials WHERE id = ? AND snapshot_id = ?",
      )
        .bind(ln.material_id, snap.id)
        .first<{
          id: number;
          item: string;
          type: string;
          manufacturer: string | null;
          total_qty: number | null;
        }>();
      if (!mat) {
        return c.json({ error: `material ${ln.material_id} not in active snapshot` }, 400);
      }
      manufacturer = manufacturer ?? mat.manufacturer;
      type = type ?? mat.type;
      pricedQty = mat.total_qty;

      const committedRow = await c.env.DB.prepare(
        `SELECT COALESCE(SUM(pl.qty), 0) AS q
         FROM po_lines pl
         JOIN purchase_orders po ON po.id = pl.po_id
         WHERE po.project_id = ?
           AND po.status IN ('approved', 'issued', 'pending_approval')
           AND lower(pl.item) = lower(?)
           AND pl.is_unpriced = 0`,
      )
        .bind(project.id, mat.item)
        .first<{ q: number }>();
      committedBefore = committedRow?.q ?? 0;

      if (pricedQty == null || pricedQty === 0) {
        // material exists in tab but wasn't priced for this job
        isUnpriced = true;
      } else if (committedBefore + ln.qty > pricedQty) {
        isOverBudget = true;
      }
    }

    if (isUnpriced) hasUnpriced = true;
    if (isOverBudget) hasOverBudget = true;

    const lineTotal = round2(ln.qty * ln.unit_cost);
    total += lineTotal;
    enriched.push({
      material_id: ln.material_id,
      item: ln.item,
      type,
      manufacturer,
      qty: ln.qty,
      unit: ln.unit,
      unit_cost: ln.unit_cost,
      line_total: lineTotal,
      is_unpriced: isUnpriced,
      is_over_budget: isOverBudget,
      priced_qty_at_order: pricedQty,
      committed_before: committedBefore,
    });
  }

  total = round2(total);
  const requiresApproval = hasUnpriced || hasOverBudget;
  const settings = await loadSettings(c.env.DB);
  const tier = requiresApproval ? tierForApproval(total, hasUnpriced, settings) : null;
  const reason = requiresApproval
    ? hasUnpriced && hasOverBudget
      ? "both"
      : hasUnpriced
        ? "unpriced"
        : "over_budget"
    : null;

  const status = requiresApproval ? "pending_approval" : "approved";
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const poNumber = await nextPONumber(c.env.DB, project.code);
  const approvedAt = requiresApproval ? null : now;
  const approvedBy = requiresApproval ? null : "auto";

  await c.env.DB.prepare(
    `INSERT INTO purchase_orders
       (id, po_number, project_id, supplier, status, requires_approval,
        approval_tier, approval_reason, total_value, notes, delivery_date,
        created_at, created_by, approved_at, approved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      poNumber,
      project.id,
      body.supplier,
      status,
      requiresApproval ? 1 : 0,
      tier,
      reason,
      total,
      body.notes ?? null,
      body.delivery_date ?? null,
      now,
      actor,
      approvedAt,
      approvedBy,
    )
    .run();

  await c.env.DB.batch(
    enriched.map((ln) =>
      c.env.DB.prepare(
        `INSERT INTO po_lines
           (po_id, material_id, item, type, manufacturer, qty, unit, unit_cost,
            line_total, is_unpriced, is_over_budget, priced_qty_at_order, committed_before)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        ln.material_id,
        ln.item,
        ln.type,
        ln.manufacturer,
        ln.qty,
        ln.unit,
        ln.unit_cost,
        ln.line_total,
        ln.is_unpriced ? 1 : 0,
        ln.is_over_budget ? 1 : 0,
        ln.priced_qty_at_order,
        ln.committed_before,
      ),
    ),
  );

  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('po', ?, 'created', ?, ?, ?)`,
  )
    .bind(id, actor, JSON.stringify({ po_number: poNumber, status, total }), now)
    .run();

  if (requiresApproval && tier) {
    const approvers = await c.env.DB.prepare(
      `SELECT email, name FROM approvers
       WHERE tier = ? AND (project_id = ? OR project_id IS NULL)
       ORDER BY project_id IS NULL`,
    )
      .bind(tier, project.id)
      .all<{ email: string; name: string | null }>();
    c.executionCtx.waitUntil(
      emailApprovers(
        c.env,
        {
          id,
          po_number: poNumber,
          project_id: project.id,
          supplier: body.supplier,
          status: "pending_approval",
          requires_approval: true,
          approval_tier: tier,
          approval_reason: reason,
          total_value: total,
          notes: body.notes ?? null,
          delivery_date: body.delivery_date ?? null,
          created_at: now,
          created_by: actor,
          approved_at: null,
          approved_by: null,
          rejected_at: null,
          rejected_by: null,
          rejection_reason: null,
          issued_at: null,
          lines: enriched,
        },
        { code: project.code, name: project.code },
        approvers.results,
      ),
    );
  }

  return c.json({ id, po_number: poNumber, status, requires_approval: requiresApproval });
});

pos.post("/:id/approve", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("userEmail");
  const po = await c.env.DB.prepare(
    "SELECT id, status, approval_tier FROM purchase_orders WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; status: string; approval_tier: string | null }>();
  if (!po) return c.json({ error: "not found" }, 404);
  if (po.status !== "pending_approval") {
    return c.json({ error: `cannot approve a ${po.status} PO` }, 409);
  }
  const approver = await c.env.DB.prepare(
    "SELECT 1 AS ok FROM approvers WHERE lower(email) = ? AND tier = ? LIMIT 1",
  )
    .bind(actor, po.approval_tier ?? "")
    .first();
  if (!approver) {
    return c.json({ error: "you are not an approver for this tier" }, 403);
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE purchase_orders SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?",
  )
    .bind(now, actor, id)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('po', ?, 'approved', ?, NULL, ?)`,
  )
    .bind(id, actor, now)
    .run();
  return c.json({ ok: true });
});

pos.post("/:id/reject", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("userEmail");
  const body = await c.req.json<{ reason?: string }>();
  const po = await c.env.DB.prepare(
    "SELECT id, status, approval_tier FROM purchase_orders WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; status: string; approval_tier: string | null }>();
  if (!po) return c.json({ error: "not found" }, 404);
  if (po.status !== "pending_approval") {
    return c.json({ error: `cannot reject a ${po.status} PO` }, 409);
  }
  const approver = await c.env.DB.prepare(
    "SELECT 1 AS ok FROM approvers WHERE lower(email) = ? AND tier = ? LIMIT 1",
  )
    .bind(actor, po.approval_tier ?? "")
    .first();
  if (!approver) {
    return c.json({ error: "you are not an approver for this tier" }, 403);
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE purchase_orders
       SET status = 'rejected', rejected_at = ?, rejected_by = ?, rejection_reason = ?
       WHERE id = ?`,
  )
    .bind(now, actor, body.reason ?? null, id)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('po', ?, 'rejected', ?, ?, ?)`,
  )
    .bind(id, actor, JSON.stringify({ reason: body.reason ?? null }), now)
    .run();
  return c.json({ ok: true });
});

pos.post("/:id/issue", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("userEmail");
  const po = await c.env.DB.prepare("SELECT id, status, created_by FROM purchase_orders WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string; created_by: string }>();
  if (!po) return c.json({ error: "not found" }, 404);
  if (po.status !== "approved") {
    return c.json({ error: `cannot issue a ${po.status} PO` }, 409);
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE purchase_orders SET status = 'issued', issued_at = ? WHERE id = ?",
  )
    .bind(now, id)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('po', ?, 'issued', ?, NULL, ?)`,
  )
    .bind(id, actor, now)
    .run();
  return c.json({ ok: true });
});

async function nextPONumber(db: D1Database, projectCode: string): Promise<string> {
  const prefix = `PO-${projectCode}-`;
  const row = await db
    .prepare(
      `SELECT po_number FROM purchase_orders
       WHERE po_number LIKE ?
       ORDER BY po_number DESC LIMIT 1`,
    )
    .bind(`${prefix}%`)
    .first<{ po_number: string }>();
  let next = 1;
  if (row) {
    const seq = Number(row.po_number.slice(prefix.length));
    if (Number.isFinite(seq)) next = seq + 1;
  }
  return `${prefix}${String(next).padStart(4, "0")}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
