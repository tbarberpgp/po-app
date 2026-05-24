import { Hono } from "hono";
import type { Env, Variables } from "../env";

export const approvers = new Hono<{ Bindings: Env; Variables: Variables }>();

approvers.get("/", async (c) => {
  const projectId = c.req.query("project_id");
  const rows = projectId
    ? await c.env.DB.prepare(
        "SELECT * FROM approvers WHERE project_id = ? OR project_id IS NULL ORDER BY tier",
      )
        .bind(projectId)
        .all()
    : await c.env.DB.prepare("SELECT * FROM approvers ORDER BY project_id, tier").all();
  return c.json(rows.results);
});

approvers.post("/", async (c) => {
  const body = await c.req.json<{
    project_id?: string | null;
    tier: "line_manager" | "commercial_manager" | "director";
    email: string;
    name?: string;
  }>();
  if (!body.tier || !body.email) return c.json({ error: "tier and email are required" }, 400);
  const res = await c.env.DB.prepare(
    "INSERT INTO approvers (project_id, tier, email, name) VALUES (?, ?, ?, ?) RETURNING id",
  )
    .bind(body.project_id ?? null, body.tier, body.email.toLowerCase(), body.name ?? null)
    .first<{ id: number }>();
  return c.json({ id: res!.id });
});

approvers.delete("/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM approvers WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});
