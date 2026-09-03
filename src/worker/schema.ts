// Optional-column detection, so the Worker can be deployed BEFORE a remote
// migration has been applied.
//
// Deploys fire from a push to main; migrations are still applied by hand
// (`npm run db:migrate:remote`). That leaves a window where new code runs
// against the old schema, and a query naming a column that doesn't exist yet
// throws. Where that query sits inside a best-effort try/catch the failure is
// silent and worse than an error: the site report simply loses its labour
// table, and nobody is told why.
//
// operatives.ts has carried a bespoke version of this for `emergency_contact`
// since migration 0059 ("removes the deploy-before-migrate footgun"); this is
// the same idea with the table and column as arguments.
//
// Only the POSITIVE result is memoised. Until the column exists we re-check —
// a cheap pragma — so the moment the migration is applied the next request
// picks it up, with no redeploy and no stale-isolate window.

import type { Env } from "./env";

const present = new Set<string>();

export async function hasColumn(env: Env, table: string, column: string): Promise<boolean> {
  const key = `${table}.${column}`;
  if (present.has(key)) return true;
  try {
    const r = await env.DB
      .prepare("SELECT 1 AS x FROM pragma_table_info(?) WHERE name = ?")
      .bind(table, column)
      .first<{ x: number }>();
    if (r) present.add(key);
  } catch { /* leave absent; re-check on the next call */ }
  return present.has(key);
}

/** True once migration 0117 has landed and sign-ins carry the operative they
 *  belong to. Callers fall back to matching on the name text until then. */
export function signinsCarryOperativeId(env: Env): Promise<boolean> {
  return hasColumn(env, "site_signins", "operative_id");
}
