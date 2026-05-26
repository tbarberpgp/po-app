import { Hono } from "hono";
import type { Env, Variables } from "../env";
import type { Role } from "../../shared/permissions";
import { outranks, ROLES } from "../../shared/permissions";
import { requirePermission } from "../auth";

export const users = new Hono<{ Bindings: Env; Variables: Variables }>();

users.use("/*", async (c, next) => {
  // Listing users requires users.read; mutating requires users.write. Both
  // are admin+ so we gate the whole router on .read here and check .write
  // inline on the mutating handlers.
  const denied = requirePermission(c, "users.read");
  if (denied) return denied;
  await next();
});

users.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT email, name, role, active, created_at, created_by FROM users ORDER BY role, email",
  ).all();
  return c.json(rows.results);
});

users.post("/", async (c) => {
  const writeDenied = requirePermission(c, "users.write");
  if (writeDenied) return writeDenied;
  const body = await c.req.json<{ email: string; name?: string; role: Role }>();
  if (!body.email || !body.role) return c.json({ error: "email and role required" }, 400);
  if (!ROLES.includes(body.role)) return c.json({ error: "invalid role" }, 400);

  // Only superadmin can mint other superadmins.
  if (body.role === "superadmin") {
    const denied = requirePermission(c, "users.promote_superadmin");
    if (denied) return denied;
  }

  const email = body.email.trim().toLowerCase();
  const now = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      `INSERT INTO users (email, name, role, active, created_at, created_by)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
      .bind(email, body.name?.trim() ?? null, body.role, now, c.get("userEmail"))
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) return c.json({ error: "User already exists" }, 409);
    throw e;
  }
  return c.json({ email });
});

users.put("/:email", async (c) => {
  const writeDenied = requirePermission(c, "users.write");
  if (writeDenied) return writeDenied;
  const actor = c.get("userEmail");
  const actorRole = c.get("userRole");
  const target = c.req.param("email").toLowerCase();
  const body = await c.req.json<{ name?: string; role?: Role; active?: boolean }>();

  const existing = await c.env.DB.prepare(
    "SELECT email, role FROM users WHERE lower(email) = ?",
  )
    .bind(target)
    .first<{ email: string; role: Role }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  // Guardrails:
  // - You can't act on a user who outranks you.
  // - Only a superadmin can promote anyone to superadmin or demote a superadmin.
  // - You can't lower your own role (lock-yourself-out protection).
  if (outranks(existing.role, actorRole) && existing.role !== actorRole) {
    return c.json({ error: "Cannot modify a user with a higher role than you" }, 403);
  }
  if (body.role && body.role !== existing.role) {
    if (!ROLES.includes(body.role)) return c.json({ error: "invalid role" }, 400);
    if (body.role === "superadmin" || existing.role === "superadmin") {
      const denied = requirePermission(c, "users.promote_superadmin");
      if (denied) return denied;
    }
    if (target === actor && body.role !== actorRole) {
      return c.json({ error: "You can't change your own role" }, 403);
    }
  }
  if (body.active === false && target === actor) {
    return c.json({ error: "You can't deactivate yourself" }, 403);
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) { sets.push("name = ?"); binds.push(body.name?.trim() || null); }
  if (body.role !== undefined) { sets.push("role = ?"); binds.push(body.role); }
  if (body.active !== undefined) { sets.push("active = ?"); binds.push(body.active ? 1 : 0); }
  if (sets.length === 0) return c.json({ error: "nothing to update" }, 400);
  binds.push(target);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE lower(email) = ?`)
    .bind(...binds)
    .run();
  return c.json({ ok: true });
});

users.delete("/:email", async (c) => {
  const writeDenied = requirePermission(c, "users.write");
  if (writeDenied) return writeDenied;
  const actor = c.get("userEmail");
  const target = c.req.param("email").toLowerCase();
  if (target === actor) return c.json({ error: "You can't delete yourself" }, 403);

  const existing = await c.env.DB.prepare(
    "SELECT role FROM users WHERE lower(email) = ?",
  )
    .bind(target)
    .first<{ role: Role }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  if (existing.role === "superadmin") {
    const denied = requirePermission(c, "users.promote_superadmin");
    if (denied) return denied;
  }

  await c.env.DB.prepare("DELETE FROM users WHERE lower(email) = ?").bind(target).run();
  return c.json({ ok: true });
});
