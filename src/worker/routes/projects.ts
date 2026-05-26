import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";

export const projects = new Hono<{ Bindings: Env; Variables: Variables }>();

projects.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.*, s.id AS active_snapshot_id
     FROM projects p
     LEFT JOIN material_snapshots s ON s.project_id = p.id AND s.is_active = 1
     WHERE p.deleted_at IS NULL
     ORDER BY p.created_at DESC`,
  ).all();
  return c.json(rows.results);
});

projects.post("/", async (c) => {
  const denied = requirePermission(c, "projects.create");
  if (denied) return denied;
  const body = await c.req.json<{ code: string; name: string; client?: string }>();
  if (!body.code || !body.name) {
    return c.json({ error: "code and name are required" }, 400);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  try {
    await c.env.DB.prepare(
      `INSERT INTO projects (id, code, name, client, currency, created_at, created_by)
       VALUES (?, ?, ?, ?, 'GBP', ?, ?)`,
    )
      .bind(id, body.code.trim(), body.name.trim(), body.client?.trim() ?? null, now, actor)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) return c.json({ error: "Project code already exists" }, 409);
    throw e;
  }
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('project', ?, 'created', ?, ?, ?)`,
  )
    .bind(id, actor, JSON.stringify({ code: body.code, name: body.name }), now)
    .run();
  return c.json({ id });
});

projects.get("/:id", async (c) => {
  const id = c.req.param("id");
  const project = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(id)
    .first();
  if (!project) return c.json({ error: "not found" }, 404);
  const snapshot = await c.env.DB.prepare(
    "SELECT * FROM material_snapshots WHERE project_id = ? AND is_active = 1",
  )
    .bind(id)
    .first();
  return c.json({ project, active_snapshot: snapshot });
});

projects.delete("/:id", async (c) => {
  const denied = requirePermission(c, "projects.delete");
  if (denied) return denied;

  const id = c.req.param("id");
  const actor = c.get("userEmail");
  const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }));
  const reason = (body.reason ?? "").trim();
  if (!reason) return c.json({ error: "deletion reason is required" }, 400);

  const project = await c.env.DB.prepare(
    "SELECT id, code FROM projects WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(id)
    .first<{ id: string; code: string }>();
  if (!project) return c.json({ error: "not found" }, 404);

  const now = new Date().toISOString();
  // Rename the code so the original is free for a fresh project (unique constraint).
  // The full original code stays visible in the audit_log details.
  const freedCode = `${project.code}#deleted-${Date.now()}`;
  await c.env.DB.prepare(
    `UPDATE projects
       SET deleted_at = ?, deleted_by = ?, deletion_reason = ?, code = ?
       WHERE id = ?`,
  )
    .bind(now, actor, reason, freedCode, id)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('project', ?, 'deleted', ?, ?, ?)`,
  )
    .bind(id, actor, JSON.stringify({ reason, original_code: project.code }), now)
    .run();
  return c.json({ ok: true });
});

projects.put("/:id", async (c) => {
  const denied = requirePermission(c, "projects.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    client?: string | null;
    delivery_address?: string | null;
    site_contact_name?: string | null;
    site_contact_phone?: string | null;
    delivery_instructions?: string | null;
  }>();
  const allowed = [
    "name",
    "client",
    "delivery_address",
    "site_contact_name",
    "site_contact_phone",
    "delivery_instructions",
  ] as const;
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = ?`);
      const v = (body as Record<string, unknown>)[k];
      binds.push(typeof v === "string" ? v.trim() || null : v ?? null);
    }
  }
  if (sets.length === 0) return c.json({ error: "nothing to update" }, 400);
  binds.push(id);
  await c.env.DB.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('project', ?, 'updated', ?, ?, ?)`,
  )
    .bind(id, c.get("userEmail"), JSON.stringify(body), new Date().toISOString())
    .run();
  return c.json({ ok: true });
});

projects.get("/:id/summary", async (c) => {
  const id = c.req.param("id");
  // Spend that's outside the priced BOQ — sum of unpriced PO lines on this project
  // that are still in play (not rejected).
  const unpriced = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(pl.line_total), 0) AS v
     FROM po_lines pl
     JOIN purchase_orders po ON po.id = pl.po_id
     WHERE po.project_id = ?
       AND po.status IN ('approved', 'issued', 'pending_approval')
       AND pl.is_unpriced = 1`,
  )
    .bind(id)
    .first<{ v: number }>();

  const counts = await c.env.DB.prepare(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(total_value), 0) AS v
     FROM purchase_orders WHERE project_id = ? GROUP BY status`,
  )
    .bind(id)
    .all<{ status: string; n: number; v: number }>();

  return c.json({
    unpriced_spend: unpriced?.v ?? 0,
    by_status: counts.results,
  });
});
