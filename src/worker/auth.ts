import type { Context, Next } from "hono";
import type { Env, Variables } from "./env";
import type { Role } from "../shared/permissions";
import { can, normalizeRole, type Permission } from "../shared/permissions";

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
  let user: { email: string; name: string | null; role: Role; active: number } | null = null;
  let tableMissing = false;
  try {
    user = await c.env.DB.prepare(
      "SELECT email, name, role, active FROM users WHERE lower(email) = ?",
    )
      .bind(email)
      .first<{ email: string; name: string | null; role: Role; active: number }>();
  } catch (e) {
    // The users table doesn't exist yet — migration 0005 hasn't been
    // applied to this database. Fall back to the bootstrap behaviour
    // (bootstrap email = superadmin, everyone else = viewer) so the app
    // is usable until the migration runs.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/no such table: users/i.test(msg)) throw e;
    tableMissing = true;
    console.warn("users table missing — using bootstrap fallback. Apply migration 0005.");
  }

  const BOOTSTRAP_SUPERADMIN = "tbarber@powergridprojects.net";

  if (!user) {
    if (tableMissing) {
      // Pre-migration: don't try to INSERT, just synthesize a session.
      user = {
        email,
        name: null,
        role: email === BOOTSTRAP_SUPERADMIN ? "superadmin" : "viewer",
        active: 1,
      };
    } else {
      // Auto-provision unknown users as viewers.
      try {
        await c.env.DB.prepare(
          `INSERT INTO users (email, name, role, active, created_at, created_by)
           VALUES (?, NULL, 'viewer', 1, ?, 'auto')`,
        )
          .bind(email, now)
          .run();
      } catch (e) {
        console.warn("user auto-provision failed", e);
      }
      user = { email, name: null, role: "viewer", active: 1 };
    }
  } else if (!user.active) {
    return c.json({ error: "Your account has been deactivated." }, 403);
  }

  c.set("userEmail", user.email);
  // Normalise legacy role strings (e.g. "procurement" → "commercial") so the
  // rest of the app only ever sees the current Role union.
  c.set("userRole", normalizeRole(user.role));
  c.set("userName", user.name);
  await next();
}

/**
 * May this user give a held payable its final sign-off and let it into Xero?
 * Covers both routes money leaves by — supplier invoices and subcontractor
 * labour certificates — against one list.
 *
 * Checked by email against `release_approvers`, NOT by role: no role draws the
 * line in the right place. The releasers are a subset of `superadmin` and not
 * all of it, and one of them (adouty) also approves payables at stage one — so
 * a permission check would either miss a releaser or hand the second signature
 * to people who are only meant to have the first. Only a named list can say
 * who signs off.
 */
export async function isReleaseApprover(
  env: Env,
  email: string | null | undefined,
): Promise<boolean> {
  if (!email) return false;
  try {
    const row = await env.DB.prepare(
      "SELECT 1 AS ok FROM release_approvers WHERE lower(email) = ?",
    )
      .bind(email.toLowerCase())
      .first<{ ok: number }>();
    return !!row;
  } catch (e) {
    // Table missing — migration 0118 hasn't been applied to this database.
    // Fail CLOSED. The open fallback would hand the release back to everyone
    // who can approve, which is the single thing this gate exists to stop.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/no such table: release_approvers/i.test(msg)) throw e;
    console.warn("release_approvers missing — releases blocked. Apply migration 0118.");
    return false;
  }
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
    can_release_payables: await isReleaseApprover(c.env, email),
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
