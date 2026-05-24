import type { Context, Next } from "hono";
import type { Env, Variables } from "./env";

/**
 * Cloudflare Access injects the verified user email in the
 * `Cf-Access-Authenticated-User-Email` request header for any request
 * that passes through an Access-protected hostname.
 *
 * In local dev there's no Access, so we fall back to DEV_USER_EMAIL.
 */
export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next,
) {
  const headerEmail = c.req.header("Cf-Access-Authenticated-User-Email");
  const devEmail = c.env.DEV_USER_EMAIL;
  const email = headerEmail ?? devEmail;

  if (!email) {
    return c.json(
      { error: "Unauthenticated. Cloudflare Access is required in production." },
      401,
    );
  }
  c.set("userEmail", email.toLowerCase());
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
    is_approver: tiers.length > 0,
    approver_tiers: tiers as Array<"line_manager" | "commercial_manager" | "director">,
  };
}
