import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { parseMaterialsSheet } from "../parse-xlsx";

export const materials = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Upload a pricing workbook for a project. Replaces the active snapshot. */
materials.post("/:projectId/upload", async (c) => {
  const projectId = c.req.param("projectId");
  const actor = c.get("userEmail");

  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?")
    .bind(projectId)
    .first();
  if (!project) return c.json({ error: "project not found" }, 404);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);

  let parsed;
  try {
    parsed = parseMaterialsSheet(await file.arrayBuffer());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "parse failed" }, 400);
  }
  if (parsed.length === 0) return c.json({ error: "No material rows found" }, 400);

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE material_snapshots SET is_active = 0 WHERE project_id = ? AND is_active = 1",
  )
    .bind(projectId)
    .run();
  const snap = await c.env.DB.prepare(
    `INSERT INTO material_snapshots (project_id, uploaded_at, uploaded_by, filename, is_active)
     VALUES (?, ?, ?, ?, 1) RETURNING id`,
  )
    .bind(projectId, now, actor, file.name)
    .first<{ id: number }>();
  const snapshotId = snap!.id;

  // Batch insert in chunks (D1 has param limits).
  const stmts = parsed.map((m) =>
    c.env.DB.prepare(
      `INSERT INTO materials (
         snapshot_id, item, type, manufacturer, pack_qty, pack_unit, cost, cost_unit,
         coverage_qty, coverage_unit, waste_pct, unit_rate, rate_unit,
         total_qty, total_qty_unit, material_total_cost
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      snapshotId,
      m.item,
      m.type,
      m.manufacturer,
      m.pack_qty,
      m.pack_unit,
      m.cost,
      m.cost_unit,
      m.coverage_qty,
      m.coverage_unit,
      m.waste_pct,
      m.unit_rate,
      m.rate_unit,
      m.total_qty,
      m.total_qty_unit,
      m.material_total_cost,
    ),
  );
  await c.env.DB.batch(stmts);

  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('snapshot', ?, 'uploaded', ?, ?, ?)`,
  )
    .bind(String(snapshotId), actor, JSON.stringify({ filename: file.name, rows: parsed.length }), now)
    .run();

  return c.json({ snapshot_id: snapshotId, rows: parsed.length });
});

/**
 * List materials for the project's active snapshot, with committed quantities
 * (sum of approved/issued PO line qty for the same item name) and remaining allowance.
 */
materials.get("/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const snap = await c.env.DB.prepare(
    "SELECT id FROM material_snapshots WHERE project_id = ? AND is_active = 1",
  )
    .bind(projectId)
    .first<{ id: number }>();
  if (!snap) return c.json([]);

  const rows = await c.env.DB.prepare(
    `SELECT m.*,
            COALESCE((
              SELECT SUM(pl.qty)
              FROM po_lines pl
              JOIN purchase_orders po ON po.id = pl.po_id
              WHERE po.project_id = ?
                AND po.status IN ('approved', 'issued', 'pending_approval')
                AND lower(pl.item) = lower(m.item)
                AND pl.is_unpriced = 0
            ), 0) AS committed_qty
     FROM materials m
     WHERE m.snapshot_id = ?
     ORDER BY m.type, m.item`,
  )
    .bind(projectId, snap.id)
    .all<Record<string, unknown> & { committed_qty: number; total_qty: number | null }>();

  const result = rows.results.map((r) => ({
    ...r,
    remaining_qty: r.total_qty == null ? null : (r.total_qty ?? 0) - (r.committed_qty ?? 0),
  }));
  return c.json(result);
});
