import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";

// Variations register. A variation is a project-level cost-centre, separate from
// the contract: a sell value to the client plus material line items (pulled from
// the project Materials list or the global Product Library) and labour line
// items. POs and application lines link back to a variation (variation_id) so
// spend and margin can be tracked per variation. Forecast Final Account =
// contract value + Σ variation sell values.
export const variations = new Hono<{ Bindings: Env; Variables: Variables }>();

type VariationRow = {
  id: number; variation_no: number; description: string; status: string;
  sell_value: number; notes: string | null; created_at: string; created_by: string;
  approved_at: string | null; approved_by: string | null; labour_absorbed: number;
};
type MaterialRow = {
  id: number; variation_id: number; product_id: number | null; material_id: number | null;
  description: string; manufacturer: string | null; qty: number; unit: string | null;
  unit_rate: number; value: number;
};
type LabourRow = { id: number; variation_id: number; description: string; value: number };

type MaterialInput = {
  product_id?: number | null;
  material_id?: number | null;
  description: string;
  manufacturer?: string | null;
  qty?: number;
  unit?: string | null;
  unit_rate?: number;
};
type LabourInput = { description: string; qty?: number; unit_rate?: number; value?: number };

/** True if `email` is a director-tier approver, project-scoped or global. */
async function isDirectorApprover(db: D1Database, email: string, projectId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 FROM approvers
     WHERE email = ? AND tier = 'director' AND (project_id IS NULL OR project_id = ?) LIMIT 1`,
  ).bind(email, projectId).first();
  return !!row;
}

/** List a project's variations with their material + labour lines and budgets. */
variations.get("/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const vs = await c.env.DB.prepare(
    `SELECT id, variation_no, description, status, sell_value, notes, created_at, created_by,
            approved_at, approved_by, labour_absorbed
     FROM variations WHERE project_id = ? ORDER BY variation_no`,
  ).bind(projectId).all<VariationRow>();
  if (vs.results.length === 0) return c.json([]);

  const ids = vs.results.map((v) => v.id);
  const ph = ids.map(() => "?").join(",");
  const mats = await c.env.DB.prepare(
    `SELECT * FROM variation_materials WHERE variation_id IN (${ph})`,
  ).bind(...ids).all<MaterialRow>();
  const labs = await c.env.DB.prepare(
    `SELECT * FROM variation_labour WHERE variation_id IN (${ph})`,
  ).bind(...ids).all<LabourRow>();
  // Material spend = committed POs linked to the variation.
  const spend = await c.env.DB.prepare(
    `SELECT variation_id, COALESCE(SUM(total_value), 0) AS spent
     FROM purchase_orders
     WHERE variation_id IN (${ph}) AND status IN ('approved', 'issued', 'pending_approval')
     GROUP BY variation_id`,
  ).bind(...ids).all<{ variation_id: number; spent: number }>();
  const spentByVar = new Map(spend.results.map((r) => [r.variation_id, r.spent ?? 0]));

  // Certified actuals per variation: revenue from the client's latest certified
  // (outgoing) application and labour spend from each subbie's latest certified
  // labour application. "Latest per (direction, supplier) stream" reads the
  // cumulative figure once — earlier periods are superseded, not summed.
  const actuals = await c.env.DB.prepare(
    `SELECT al.variation_id AS vid, a.direction AS direction,
            COALESCE(SUM(al.cumulative_value), 0) AS v
     FROM afp_lines al
     JOIN applications_for_payment a ON a.id = al.afp_id
     WHERE al.variation_id IN (${ph})
       AND a.status IN ('certified', 'paid')
       AND a.app_number = (
         SELECT MAX(a2.app_number) FROM applications_for_payment a2
         WHERE a2.project_id = a.project_id
           AND a2.direction = a.direction
           AND COALESCE(a2.counterparty_supplier_id, -1) = COALESCE(a.counterparty_supplier_id, -1)
           AND a2.status IN ('certified', 'paid')
       )
     GROUP BY al.variation_id, a.direction`,
  ).bind(...ids).all<{ vid: number; direction: string; v: number }>();
  const revenueByVar = new Map<number, number>();
  const labourSpentByVar = new Map<number, number>();
  for (const r of actuals.results) {
    const map = r.direction === "outgoing" ? revenueByVar : labourSpentByVar;
    map.set(r.vid, (map.get(r.vid) ?? 0) + (r.v ?? 0));
  }

  // Variation APPLIED revenue: the variation-tagged lines on the latest
  // non-draft outgoing application (what we've claimed, certified or not).
  const applied = await c.env.DB.prepare(
    `SELECT al.variation_id AS vid, COALESCE(SUM(al.cumulative_value), 0) AS v
     FROM afp_lines al
     JOIN applications_for_payment a ON a.id = al.afp_id
     WHERE al.variation_id IN (${ph})
       AND a.direction = 'outgoing'
       AND a.status IN ('submitted', 'pending_approval', 'certified', 'paid')
       AND a.app_number = (
         SELECT MAX(a2.app_number) FROM applications_for_payment a2
         WHERE a2.project_id = a.project_id AND a2.direction = 'outgoing'
           AND a2.status IN ('submitted', 'pending_approval', 'certified', 'paid')
       )
     GROUP BY al.variation_id`,
  ).bind(...ids).all<{ vid: number; v: number }>();
  const appliedByVar = new Map(applied.results.map((r) => [r.vid, r.v ?? 0]));

  const byVar = <T extends { variation_id: number }>(rows: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of rows) (m.get(r.variation_id) ?? m.set(r.variation_id, []).get(r.variation_id)!).push(r);
    return m;
  };
  const matsByVar = byVar(mats.results);
  const labsByVar = byVar(labs.results);

  const out = vs.results.map((v) => {
    const materials = matsByVar.get(v.id) ?? [];
    const labour = labsByVar.get(v.id) ?? [];
    const absorbed = !!v.labour_absorbed;
    return {
      ...v,
      labour_absorbed: absorbed,
      materials,
      labour,
      material_budget: materials.reduce((s, m) => s + (m.value ?? 0), 0),
      // Absorbed labour is done within the existing contract labour allowance,
      // so it costs the project nothing — the budget (and thus margin/FFC) is £0.
      labour_budget: absorbed ? 0 : labour.reduce((s, l) => s + (l.value ?? 0), 0),
      material_spent: spentByVar.get(v.id) ?? 0,
      revenue_certified: revenueByVar.get(v.id) ?? 0,
      revenue_applied: appliedByVar.get(v.id) ?? 0,
      labour_spent: labourSpentByVar.get(v.id) ?? 0,
    };
  });
  return c.json(out);
});

/** Create a variation with material + labour lines. */
variations.post("/:projectId", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const projectId = c.req.param("projectId");
  const body = await c.req.json<{
    description: string; sell_value?: number; notes?: string;
    materials?: MaterialInput[]; labour?: LabourInput[]; labour_absorbed?: boolean;
  }>().catch(() => null);
  if (!body || !body.description?.trim()) return c.json({ error: "description required" }, 400);

  const nextN = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(variation_no), 0) + 1 AS n FROM variations WHERE project_id = ?",
  ).bind(projectId).first<{ n: number }>();
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  const ins = await c.env.DB.prepare(
    `INSERT INTO variations (project_id, variation_no, description, status, sell_value, notes, created_at, created_by, labour_absorbed)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(projectId, nextN!.n, body.description.trim(), body.sell_value ?? 0, body.notes?.trim() || null, now, actor, body.labour_absorbed ? 1 : 0)
    .first<{ id: number }>();
  const vid = ins!.id;

  const stmts: D1PreparedStatement[] = [];
  for (const m of body.materials ?? []) {
    if (!m.description?.trim()) continue;
    const qty = m.qty ?? 0, rate = m.unit_rate ?? 0;
    stmts.push(c.env.DB.prepare(
      `INSERT INTO variation_materials
         (variation_id, product_id, material_id, description, manufacturer, qty, unit, unit_rate, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(vid, m.product_id ?? null, m.material_id ?? null, m.description.trim(),
      m.manufacturer ?? null, qty, m.unit ?? null, rate, Math.round(qty * rate * 100) / 100));
  }
  for (const l of body.labour ?? []) {
    if (!l.description?.trim()) continue;
    const qty = l.qty ?? 1, rate = l.unit_rate ?? l.value ?? 0;
    stmts.push(c.env.DB.prepare(
      "INSERT INTO variation_labour (variation_id, description, qty, unit_rate, value) VALUES (?, ?, ?, ?, ?)",
    ).bind(vid, l.description.trim(), qty, rate, Math.round(qty * rate * 100) / 100));
  }
  if (stmts.length > 0) await c.env.DB.batch(stmts);

  return c.json({ id: vid, variation_no: nextN!.n });
});

/** Update a variation — header fields and/or replace its material/labour lines. */
variations.patch("/:id", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    description?: string; sell_value?: number; status?: string; notes?: string;
    materials?: MaterialInput[]; labour?: LabourInput[]; labour_absorbed?: boolean;
  }>().catch(() => null);
  if (!body) return c.json({ error: "bad request" }, 400);

  const sets: string[] = []; const vals: unknown[] = [];
  if (body.description != null) { sets.push("description = ?"); vals.push(body.description.trim()); }
  if (body.sell_value != null) { sets.push("sell_value = ?"); vals.push(body.sell_value); }
  if (body.status != null) { sets.push("status = ?"); vals.push(body.status); }
  if (body.notes !== undefined) { sets.push("notes = ?"); vals.push(body.notes?.trim() || null); }
  if (body.labour_absorbed !== undefined) { sets.push("labour_absorbed = ?"); vals.push(body.labour_absorbed ? 1 : 0); }
  // Any change to the variation's financial content re-opens approval: the
  // revised budget must be signed off again before it can be expended.
  if (body.sell_value != null || body.materials != null || body.labour != null || body.labour_absorbed !== undefined) {
    sets.push("approved_at = NULL", "approved_by = NULL");
  }
  if (sets.length > 0) {
    vals.push(id);
    await c.env.DB.prepare(`UPDATE variations SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
  }

  // Replace material lines when provided.
  if (body.materials) {
    await c.env.DB.prepare("DELETE FROM variation_materials WHERE variation_id = ?").bind(id).run();
    const stmts = body.materials.filter((m) => m.description?.trim()).map((m) => {
      const qty = m.qty ?? 0, rate = m.unit_rate ?? 0;
      return c.env.DB.prepare(
        `INSERT INTO variation_materials
           (variation_id, product_id, material_id, description, manufacturer, qty, unit, unit_rate, value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, m.product_id ?? null, m.material_id ?? null, m.description.trim(),
        m.manufacturer ?? null, qty, m.unit ?? null, rate, Math.round(qty * rate * 100) / 100);
    });
    if (stmts.length > 0) await c.env.DB.batch(stmts);
  }
  // Replace labour lines when provided.
  if (body.labour) {
    await c.env.DB.prepare("DELETE FROM variation_labour WHERE variation_id = ?").bind(id).run();
    const stmts = body.labour.filter((l) => l.description?.trim()).map((l) => {
      const qty = l.qty ?? 1, rate = l.unit_rate ?? l.value ?? 0;
      return c.env.DB.prepare("INSERT INTO variation_labour (variation_id, description, qty, unit_rate, value) VALUES (?, ?, ?, ?, ?)")
        .bind(id, l.description.trim(), qty, rate, Math.round(qty * rate * 100) / 100);
    });
    if (stmts.length > 0) await c.env.DB.batch(stmts);
  }
  return c.json({ ok: true });
});

/** Director sign-off: authorise a variation's new budget for expenditure. */
variations.post("/:id/approve", async (c) => {
  const id = Number(c.req.param("id"));
  const v = await c.env.DB.prepare(
    "SELECT id, project_id FROM variations WHERE id = ?",
  ).bind(id).first<{ id: number; project_id: string }>();
  if (!v) return c.json({ error: "not found" }, 404);
  const email = c.get("userEmail");
  if (!(await isDirectorApprover(c.env.DB, email, v.project_id))) {
    return c.json({ error: "Only a director-tier approver can approve a variation" }, 403);
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE variations SET approved_at = ?, approved_by = ? WHERE id = ?",
  ).bind(now, email, id).run();
  return c.json({ ok: true, approved_at: now, approved_by: email });
});

/** Delete a variation (cascades to its material + labour lines). */
variations.delete("/:id", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  await c.env.DB.prepare("DELETE FROM variations WHERE id = ?")
    .bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});
