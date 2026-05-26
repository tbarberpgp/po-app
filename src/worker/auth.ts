import type { Context, Next } from "hono";
import type { Env, Variables } from "./env";
import type { Role } from "../shared/permissions";
import { can, type Permission } from "../shared/permissions";

/**
 * Authentication: Cloudflare Access injects the verified email in the
 * `Cf-Access-Authenticated-User-Email` request header. In local dev we
 * fall back to DEV_USER_EMAIL.
 *
 * Authorization: every authenticated request also resolves the user's role
 * from the `users` table. Unknown emails are auto-provisioned as `viewer`
 * — they can read but can't change anything until a Superadmin promotes
 * them on the Users page.
 */
export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next,
) {
  const headerEmail = c.req.header("Cf-Access-Authenticated-User-Email");
  const devEmail = c.env.DEV_USER_EMAIL;
  const email = (headerEmail ?? devEmail)?.toLowerCase();
  if (!email) {
    return c.json(
      { error: "Unauthenticated. Cloudflare Access is required in production." },
      401,
    );
  }

  const now = new Date().toISOString();
  let user = await c.env.DB.prepare(
    "SELECT email, name, role, active FROM users WHERE lower(email) = ?",
  )
    .bind(email)
    .first<{ email: string; name: string | null; role: Role; active: number }>();

  if (!user) {
    // Auto-provision unknown users as viewers — they got past Cloudflare Access
    // so we trust the identity, but they can't change anything until promoted.
    await c.env.DB.prepare(
      `INSERT INTO users (email, name, role, active, created_at, created_by)
       VALUES (?, NULL, 'viewer', 1, ?, 'auto')`,
    )
      .bind(email, now)
      .run();
    user = { email, name: null, role: "viewer", active: 1 };
  } else if (!user.active) {
    return c.json({ error: "Your account has been deactivated." }, 403);
  }

  c.set("userEmail", user.email);
  c.set("userRole", user.role);
  c.set("userName", user.name);
  await next();
}

export async function loadCurrentUser(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const email = c.get("userEmail");
  const approverRows = await c.env.DB.prepare(
    "SELECT DISTINCT tier FROM approvers WHERE lower(email) = ?",
  )
    .bind(email)
    .all<{ tier: string }>();
  const tiers = approverRows.results.map((r) => r.tier);
  return {
    email,
    name: c.get("userName") ?? null,
    role: c.get("userRole"),
    active: true,
    is_approver: tiers.length > 0,
    approver_tiers: tiers as Array<"line_manager" | "commercial_manager" | "director">,
  };
}

/** Tiny helper for route handlers: returns 403 if user lacks the permission. */
export function requirePermission(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  permission: Permission,
): Response | null {
  if (!can(c.get("userRole"), permission)) {
    return c.json({ error: `Forbidden: requires ${permission}` }, 403);
  }
  return null;
}
