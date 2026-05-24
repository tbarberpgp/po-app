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

approvers.put("/:id", async (c) => {
  const body = await c.req.json<{ email?: string; name?: string | null; tier?: string }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.email !== undefined) {
    sets.push("email = ?");
    binds.push(body.email.toLowerCase());
  }
  if (body.name !== undefined) {
    sets.push("name = ?");
    binds.push(body.name ?? null);
  }
  if (body.tier !== undefined) {
    sets.push("tier = ?");
    binds.push(body.tier);
  }
  if (sets.length === 0) return c.json({ error: "nothing to update" }, 400);
  binds.push(c.req.param("id"));
  await c.env.DB.prepare(`UPDATE approvers SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return c.json({ ok: true });
});

approvers.delete("/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM approvers WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});
