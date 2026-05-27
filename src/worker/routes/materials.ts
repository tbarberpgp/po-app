import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { parseContractItems, parseMaterialsSheet, parseSummaryCostSheet, readPricingWorkbook } from "../parse-xlsx";
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
  // Parse the workbook ONCE with sheets restricted to the three we read
  // (Materials, Summary Cost Sheet, Pricing). Cuts Worker CPU ~7x vs reading
  // every sheet and prevents Cloudflare's resource-limit hit on larger files.
  const buffer = await file.arrayBuffer();
  let parsed;
  let commercials;
  let contractItems;
  try {
    const wb = readPricingWorkbook(buffer);
    parsed = parseMaterialsSheet(wb);
    commercials = parseSummaryCostSheet(wb);
    contractItems = parseContractItems(wb);
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

  // Total labour expended is the sum of certified amounts across all
  // incoming_labour AfPs that have reached 'certified' or 'paid' status.
  // We don't yet break this down by element_code (AfP lines are work-item
  // level, not element-level), so the per-row "expended" is approximated
  // pro-rata by element labour weight.
  const expendedRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(certified_amount), 0) AS total_expended
     FROM applications_for_payment
     WHERE project_id = ? AND direction = 'incoming_labour'
       AND status IN ('certified', 'paid')`,
  )
    .bind(projectId)
    .first<{ total_expended: number }>();
  const totalExpended = expendedRow?.total_expended ?? 0;
  const totalLabour = rows.results.reduce((s, r) => s + r.labour_total, 0);

  const digits = project.code.replace(/\D/g, "");
  const prjPart = (digits.slice(-4) || "0000").padStart(4, "0");
  const out = rows.results.map((r) => ({
    ...r,
    cost_code: `${prjPart}.${r.element_code}.L`,
    // Pro-rata split of expended across elements by their labour share.
    expended:
      totalLabour > 0 ? Math.round((r.labour_total / totalLabour) * totalExpended * 100) / 100 : 0,
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
               AND mlp.status = 'pending_approval') AS pending_price_count,
            -- Active substitution (if any): replacement item/manufacturer/cost
            sub.id                       AS sub_id,
            sub.kind                     AS sub_kind,
            sub.replacement_item         AS sub_item,
            sub.replacement_manufacturer AS sub_manufacturer,
            sub.replacement_supplier     AS sub_supplier,
            sub.replacement_cost         AS sub_cost,
            sub.replacement_unit         AS sub_unit,
            sub.replacement_total_units  AS sub_total_units,
            sub.replacement_product_id   AS sub_product_id,
            sub.replacement_quote_line_id AS sub_quote_line_id,
            sub.reason                   AS sub_reason,
            sub.created_at               AS sub_created_at,
            sub.created_by               AS sub_created_by
     FROM materials m
     LEFT JOIN products pr ON pr.id = m.product_id
     LEFT JOIN elements e ON e.code = m.element_code
     LEFT JOIN material_substitutions sub
            ON sub.material_id = m.id AND sub.active = 1
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

// ── Material substitutions ────────────────────────────────────────────────

type SubKind = "like_for_like" | "equivalent_spec" | "variation";

/**
 * Swap one material for another on the BOQ. Source can be a master product,
 * a supplier quote line, or freeform fields. The original material row stays
 * — only POs raised AFTER the swap pick up the replacement's defaults; the
 * BOQ allowance still draws down against the original material_id so
 * reporting stays consistent.
 *
 * Creating a new substitution while another is active auto-reverts the old
 * one (its `active` flag flips to 0, audit-trailed).
 */
materials.post("/:materialId/substitute", async (c) => {
  const denied = requirePermission(c, "materials.upload");
  if (denied) return denied;
  const materialId = Number(c.req.param("materialId"));
  if (!Number.isInteger(materialId)) return c.json({ error: "invalid material id" }, 400);

  const body = await c.req.json<{
    kind?: SubKind;
    reason?: string | null;
    notes?: string | null;
    // Replacement sources (any combination; latter overrides former)
    product_id?: number | null;
    quote_line_id?: number | null;
    // Freeform / overrides
    replacement_item?: string;
    replacement_manufacturer?: string | null;
    replacement_supplier?: string | null;
    replacement_cost?: number | null;
    replacement_unit?: string | null;
    replacement_total_units?: number | null;
  }>();

  const material = await c.env.DB.prepare(
    `SELECT m.id, m.item, m.total_units, m.pack_unit,
            s.project_id AS project_id
     FROM materials m JOIN material_snapshots s ON s.id = m.snapshot_id
     WHERE m.id = ?`,
  )
    .bind(materialId)
    .first<{ id: number; item: string; total_units: number | null; pack_unit: string | null; project_id: string }>();
  if (!material) return c.json({ error: "material not found" }, 404);

  // Resolve replacement fields from each source, then layer overrides.
  let item: string | null = null;
  let manufacturer: string | null = null;
  let supplier: string | null = null;
  let cost: number | null = null;
  let unit: string | null = null;

  if (body.product_id) {
    const p = await c.env.DB.prepare(
      `SELECT description, manufacturer, supplier, unit, unit_cost
       FROM products WHERE id = ?`,
    )
      .bind(body.product_id)
      .first<{ description: string; manufacturer: string | null; supplier: string | null; unit: string | null; unit_cost: number | null }>();
    if (!p) return c.json({ error: "product not found" }, 404);
    item = p.description;
    manufacturer = p.manufacturer;
    supplier = p.supplier;
    cost = p.unit_cost;
    unit = p.unit;
  }
  if (body.quote_line_id) {
    const q = await c.env.DB.prepare(
      `SELECT l.raw_description, l.raw_unit, l.unit_price,
              s.name AS supplier_name
       FROM supplier_quote_lines l
       JOIN supplier_quotes qq ON qq.id = l.quote_id
       JOIN suppliers s        ON s.id = qq.supplier_id
       WHERE l.id = ?`,
    )
      .bind(body.quote_line_id)
      .first<{ raw_description: string; raw_unit: string | null; unit_price: number | null; supplier_name: string }>();
    if (!q) return c.json({ error: "quote line not found" }, 404);
    item = item ?? q.raw_description;
    unit = unit ?? q.raw_unit;
    cost = cost ?? q.unit_price;
    supplier = supplier ?? q.supplier_name;
  }
  // Freeform overrides win (if provided)
  if (body.replacement_item != null) item = body.replacement_item;
  if (body.replacement_manufacturer !== undefined) manufacturer = body.replacement_manufacturer;
  if (body.replacement_supplier !== undefined) supplier = body.replacement_supplier;
  if (body.replacement_cost !== undefined) cost = body.replacement_cost;
  if (body.replacement_unit !== undefined) unit = body.replacement_unit;

  if (!item || !item.trim()) {
    return c.json({ error: "replacement_item (or a product/quote source) is required" }, 400);
  }

  const totalUnits = body.replacement_total_units ?? material.total_units;
  const kind: SubKind = body.kind ?? "like_for_like";
  const now = new Date().toISOString();
  const actor = c.get("userEmail");

  // Auto-revert any existing active substitution for this material.
  await c.env.DB.prepare(
    `UPDATE material_substitutions
     SET active = 0, reverted_at = ?, reverted_by = ?,
         reverted_reason = COALESCE(reverted_reason, 'superseded by new substitution')
     WHERE material_id = ? AND active = 1`,
  )
    .bind(now, actor, materialId)
    .run();

  const inserted = await c.env.DB.prepare(
    `INSERT INTO material_substitutions
       (material_id, project_id,
        replacement_product_id, replacement_quote_line_id,
        replacement_item, replacement_manufacturer, replacement_supplier,
        replacement_cost, replacement_unit, replacement_total_units,
        kind, reason, notes,
        active, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     RETURNING id`,
  )
    .bind(
      materialId, material.project_id,
      body.product_id ?? null, body.quote_line_id ?? null,
      item.trim(), manufacturer ?? null, supplier ?? null,
      cost ?? null, unit ?? material.pack_unit ?? null, totalUnits ?? null,
      kind, body.reason ?? null, body.notes ?? null,
      now, actor,
    )
    .first<{ id: number }>();

  return c.json({ id: inserted?.id, ok: true });
});

/** List substitution history (all rows) for a project. */
materials.get("/:projectId/substitutions", async (c) => {
  const projectId = c.req.param("projectId");
  const rows = await c.env.DB.prepare(
    `SELECT sub.*,
            m.item AS original_item,
            m.manufacturer AS original_manufacturer,
            m.cost AS original_cost,
            m.total_units AS original_total_units,
            m.total_units_unit AS original_unit
     FROM material_substitutions sub
     JOIN materials m ON m.id = sub.material_id
     WHERE sub.project_id = ?
     ORDER BY sub.created_at DESC`,
  )
    .bind(projectId)
    .all();
  return c.json(rows.results);
});

/** Revert an active substitution. */
materials.delete("/substitutions/:id", async (c) => {
  const denied = requirePermission(c, "materials.upload");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const body = await c.req
    .json<{ reason?: string }>()
    .catch(() => ({} as { reason?: string }));
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE material_substitutions
     SET active = 0, reverted_at = ?, reverted_by = ?, reverted_reason = ?
     WHERE id = ? AND active = 1`,
  )
    .bind(now, c.get("userEmail"), body.reason ?? null, id)
    .run();
  return c.json({ ok: true });
});
