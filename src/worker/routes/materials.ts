import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { parseContractItems, parseMaterialsSheet, parseSummaryCostSheet } from "../parse-xlsx";
import { requirePermission } from "../auth";

export const materials = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Upload a pricing workbook for a project. Replaces the active snapshot. */
materials.post("/:projectId/upload", async (c) => {
  const denied = requirePermission(c, "materials.upload");
  if (denied) return denied;
  const projectId = c.req.param("projectId");
  const actor = c.get("userEmail");

  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?")
    .bind(projectId)
    .first();
  if (!project) return c.json({ error: "project not found" }, 404);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);

  // Parse Materials (required), Summary Cost Sheet (optional), and Pricing
  // + Costing Labour Only tabs for contract items (optional). Read once.
  const buffer = await file.arrayBuffer();
  let parsed;
  let commercials;
  let contractItems;
  try {
    parsed = parseMaterialsSheet(buffer);
    commercials = parseSummaryCostSheet(buffer);
    contractItems = parseContractItems(buffer);
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
         snapshot_id, item, type, element_code, manufacturer, pack_qty, pack_unit, cost, cost_unit,
         coverage_qty, coverage_unit, waste_pct, unit_rate, rate_unit,
         total_qty, total_qty_unit, total_units, total_units_unit, material_total_cost,
         labour_unit_cost, labour_total_cost
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      snapshotId,
      m.item,
      m.type,
      m.element_code,
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
      m.total_units,
      m.total_units_unit,
      m.material_total_cost,
      m.labour_unit_cost,
      m.labour_total_cost,
    ),
  );
  await c.env.DB.batch(stmts);

  // Persist contract items from the Pricing tab (for the AfP workflow).
  if (contractItems.length > 0) {
    const ciStmts = contractItems.map((ci) =>
      c.env.DB.prepare(
        `INSERT INTO contract_items
           (snapshot_id, item_no, section, description, qty, unit,
            sell_rate, sell_total, labour_rate, labour_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        snapshotId,
        ci.item_no,
        ci.section,
        ci.description,
        ci.qty,
        ci.unit,
        ci.sell_rate,
        ci.sell_total,
        ci.labour_rate,
        ci.labour_total,
      ),
    );
    await c.env.DB.batch(ciStmts);
  }

  // Persist project commercials if the Summary Cost Sheet was present.
  if (commercials.length > 0) {
    const commStmts = commercials.map((r) =>
      c.env.DB.prepare(
        `INSERT INTO project_commercials
           (snapshot_id, category, value, cost, gross_profit, gross_profit_pct, is_total, display_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        snapshotId,
        r.category,
        r.value,
        r.cost,
        r.gross_profit,
        r.gross_profit_pct,
        r.is_total ? 1 : 0,
        r.display_order,
      ),
    );
    await c.env.DB.batch(commStmts);
  }

  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('snapshot', ?, 'uploaded', ?, ?, ?)`,
  )
    .bind(String(snapshotId), actor, JSON.stringify({ filename: file.name, rows: parsed.length, commercials: commercials.length, contract_items: contractItems.length }), now)
    .run();

  return c.json({
    snapshot_id: snapshotId,
    rows: parsed.length,
    commercials: commercials.length,
    contract_items: contractItems.length,
  });
});

/**
 * Aggregate labour cost for the active snapshot, grouped by element code so
 * each row maps to a single cost code (PRJ.ELE.L).
 */
materials.get("/:projectId/labour-by-cost-code", async (c) => {
  const projectId = c.req.param("projectId");
  const project = await c.env.DB.prepare(
    "SELECT id, code FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<{ id: string; code: string }>();
  if (!project) return c.json({ error: "project not found" }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT m.element_code, e.name AS element_name,
            COUNT(*) AS line_count,
            COALESCE(SUM(m.labour_total_cost), 0) AS labour_total,
            COALESCE(SUM(m.material_total_cost), 0) AS material_total
     FROM materials m
     JOIN material_snapshots s ON s.id = m.snapshot_id
     LEFT JOIN elements e ON e.code = m.element_code
     WHERE s.project_id = ? AND s.is_active = 1
       AND m.element_code IS NOT NULL
     GROUP BY m.element_code, e.name
     HAVING labour_total > 0
     ORDER BY m.element_code`,
  )
    .bind(projectId)
    .all<{
      element_code: string;
      element_name: string | null;
      line_count: number;
      labour_total: number;
      material_total: number;
    }>();

  // Derive PRJ.ELE.L for each row server-side so the UI doesn't have to
  // duplicate the buildCostCode helper.
  const digits = project.code.replace(/\D/g, "");
  const prjPart = (digits.slice(-4) || "0000").padStart(4, "0");
  const out = rows.results.map((r) => ({
    ...r,
    cost_code: `${prjPart}.${r.element_code}.L`,
  }));
  return c.json(out);
});

/** Return the commercials (Value / Cost / GP / GP%) for the project's active snapshot. */
materials.get("/:projectId/commercials", async (c) => {
  const projectId = c.req.param("projectId");
  const rows = await c.env.DB.prepare(
    `SELECT c.*
     FROM project_commercials c
     JOIN material_snapshots s ON s.id = c.snapshot_id
     WHERE s.project_id = ? AND s.is_active = 1
     ORDER BY c.display_order`,
  )
    .bind(projectId)
    .all();
  return c.json(rows.results);
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
            ), 0) AS committed_qty,
            pr.element_code AS product_element_code,
            e.name        AS element_name,
            -- Latest applied live price (cheapest wins if multiple)
            (SELECT mlp.unit_price
             FROM material_live_prices mlp
             WHERE mlp.material_id = m.id
               AND mlp.project_id = ?
               AND mlp.status IN ('applied', 'approved')
             ORDER BY mlp.applied_at DESC LIMIT 1) AS live_unit_price,
            (SELECT s.name
             FROM material_live_prices mlp
             JOIN supplier_quotes q ON q.id = mlp.quote_id
             JOIN suppliers s       ON s.id = q.supplier_id
             WHERE mlp.material_id = m.id
               AND mlp.project_id = ?
               AND mlp.status IN ('applied', 'approved')
             ORDER BY mlp.applied_at DESC LIMIT 1) AS live_supplier_name,
            (SELECT COUNT(*) FROM material_live_prices mlp
             WHERE mlp.material_id = m.id
               AND mlp.project_id = ?
               AND mlp.status = 'pending_approval') AS pending_price_count
     FROM materials m
     LEFT JOIN products pr ON pr.id = m.product_id
     LEFT JOIN elements e ON e.code = m.element_code
     WHERE m.snapshot_id = ?
     ORDER BY COALESCE(m.element_code, m.type), m.item`,
  )
    .bind(projectId, projectId, projectId, projectId, snap.id)
    .all<Record<string, unknown> & { committed_qty: number; total_units: number | null }>();

  // Budget is tracked in pack units (col V) since POs are raised in pack units.
  const result = rows.results.map((r) => ({
    ...r,
    remaining_qty:
      r.total_units == null ? null : (r.total_units ?? 0) - (r.committed_qty ?? 0),
  }));
  return c.json(result);
});
