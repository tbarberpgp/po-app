import { Hono } from "hono";
import type { Env, Variables } from "../env";
import type { Role, Permission } from "../../shared/permissions";
import { normalizeRole, outranks, ROLES, can, ALL_PERMISSIONS, NON_GRANTABLE } from "../../shared/permissions";
import { requirePermission, subjectOf } from "../auth";

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
    `SELECT email, name, role, active, created_at, created_by, po_requires_approval
       FROM users ORDER BY role, email`,
  ).all<{ role: string } & Record<string, unknown>>();
  // Every grant in one pass rather than a query per user: the whole table is a
  // handful of rows, and the editor needs each user's full set to submit it
  // back (the write replaces the set, so a partial list would revoke the rest).
  const grantRows = await c.env.DB.prepare(
    "SELECT email, permission FROM user_permission_grants",
  ).all<{ email: string; permission: string }>();
  const byEmail = new Map<string, Permission[]>();
  for (const g of grantRows.results) {
    const key = g.email.toLowerCase();
    const list = byEmail.get(key) ?? [];
    list.push(g.permission as Permission);
    byEmail.set(key, list);
  }
  // Normalise legacy role strings (e.g. "procurement") for display + rank checks.
  return c.json(rows.results.map((r) => ({
    ...r,
    role: normalizeRole(r.role),
    po_requires_approval: !!r.po_requires_approval,
    grants: byEmail.get(String(r.email).toLowerCase()) ?? [],
  })));
});

/**
 * Replace a user's grant set.
 *
 * REPLACES, deliberately: the editor holds the whole set and submits the whole
 * set, so a delete-then-insert is the only shape where unticking a box actually
 * revokes. The cost is that a caller passing a partial list silently revokes the
 * rest — which is why the list route above returns every user's full set.
 *
 * Two guardrails, both of which exist so a grant can't become an escalation
 * route around the role hierarchy that `PUT /:email` enforces:
 *   – you cannot grant a permission you do not hold yourself, or users.write
 *     would be enough to award yourself everything;
 *   – you cannot grant to a user who outranks you.
 * NON_GRANTABLE permissions are dropped rather than refused, matching `can()`,
 * which would ignore them anyway.
 */
users.put("/:email/grants", async (c) => {
  const writeDenied = requirePermission(c, "users.write");
  if (writeDenied) return writeDenied;
  const actor = c.get("userEmail");
  const actorRole = c.get("userRole");
  const target = c.req.param("email").toLowerCase();
  const body = await c.req.json<{ grants?: unknown }>();
  if (!Array.isArray(body.grants)) return c.json({ error: "grants must be an array" }, 400);

  const existing = await c.env.DB.prepare(
    "SELECT email, role FROM users WHERE lower(email) = ?",
  )
    .bind(target)
    .first<{ email: string; role: Role }>();
  if (!existing) return c.json({ error: "not found" }, 404);
  if (outranks(existing.role, actorRole) && existing.role !== actorRole) {
    return c.json({ error: "Cannot modify a user with a higher role than you" }, 403);
  }

  const requested = [...new Set(body.grants.map(String))] as Permission[];
  const unknown = requested.filter((p) => !ALL_PERMISSIONS.includes(p));
  if (unknown.length) return c.json({ error: `unknown permission: ${unknown[0]}` }, 400);
  const grants = requested.filter((p) => !NON_GRANTABLE.has(p));
  // The actor's own grants count toward what they may pass on — someone granted
  // pos.edit can hand it to someone else, the same as if their role carried it.
  const held = grants.filter((p) => !can(subjectOf(c), p));
  if (held.length) {
    return c.json({ error: `You can't grant a permission you don't hold: ${held[0]}` }, 403);
  }

  const now = new Date().toISOString();
  const statements = [
    c.env.DB.prepare("DELETE FROM user_permission_grants WHERE lower(email) = ?").bind(target),
    ...grants.map((p) =>
      c.env.DB.prepare(
        `INSERT INTO user_permission_grants (email, permission, granted_at, granted_by)
         VALUES (?, ?, ?, ?)`,
      ).bind(target, p, now, actor),
    ),
  ];
  // Batched so a failure part-way can't leave the user holding neither their old
  // grants nor their new ones.
  await c.env.DB.batch(statements);

  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('user', ?, 'grants_changed', ?, ?, ?)`,
  )
    .bind(target, actor, JSON.stringify({ grants }), now)
    .run();

  return c.json({ ok: true, grants });
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
  const body = await c.req.json<{ name?: string; role?: Role; active?: boolean; po_requires_approval?: boolean }>();

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
  if (body.po_requires_approval !== undefined) {
    sets.push("po_requires_approval = ?");
    binds.push(body.po_requires_approval ? 1 : 0);
  }
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
