import { Hono } from "hono";
import type { Env, Variables } from "../env";

export const projects = new Hono<{ Bindings: Env; Variables: Variables }>();

projects.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.*, s.id AS active_snapshot_id
     FROM projects p
     LEFT JOIN material_snapshots s ON s.project_id = p.id AND s.is_active = 1
     ORDER BY p.created_at DESC`,
  ).all();
  return c.json(rows.results);
});

projects.post("/", async (c) => {
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
  const project = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?")
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
