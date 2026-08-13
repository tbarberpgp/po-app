import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";

// Company-owned / purchased plant — an org-level master register (like the
// operatives register). An item is on at most one site at a time and is
// transferred between sites rather than re-bought. Statutory test/retest dates
// (LOLER, PAT, service, insurance…) carry a valid / expiring / expired status.
export const ownedPlant = new Hono<{ Bindings: Env; Variables: Variables }>();

// Reads open to any authed user; mutations need projects.edit.
ownedPlant.use("/*", async (c, next) => {
  if (c.req.method === "GET") return next();
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  await next();
});

/** valid | expiring (≤30 days) | expired | none — statutory test status. */
function testStatus(expiry: string | null): "valid" | "expiring" | "expired" | "none" {
  if (!expiry) return "none";
  const exp = new Date(expiry + "T00:00:00").getTime();
  if (Number.isNaN(exp)) return "none";
  const now = Date.now();
  if (exp < now) return "expired";
  if (exp < now + 30 * 86_400_000) return "expiring";
  return "valid";
}
function worst(statuses: string[]): "valid" | "expiring" | "expired" | "none" {
  if (statuses.includes("expired")) return "expired";
  if (statuses.includes("expiring")) return "expiring";
  if (statuses.includes("valid")) return "valid";
  return "none";
}

/** Attach each item's test records (status-tagged) + worst status. */
async function withTests(c: { env: Env }, rows: Array<Record<string, unknown>>) {
  const ids = rows.map((r) => r.id as string);
  const byPlant = new Map<string, Array<Record<string, unknown>>>();
  if (ids.length) {
    try {
      const tests = await c.env.DB.prepare(
        `SELECT id, plant_id, test_type, tested_on, expiry_date, file_key, notes
           FROM owned_plant_tests WHERE plant_id IN (${ids.map(() => "?").join(",")})
          ORDER BY (expiry_date IS NULL), expiry_date`,
      ).bind(...ids).all<Record<string, unknown>>();
      for (const t of tests.results) {
        const arr = byPlant.get(t.plant_id as string) ?? [];
        arr.push({ ...t, status: testStatus(t.expiry_date as string | null) });
        byPlant.set(t.plant_id as string, arr);
      }
    } catch { /* pre-migration: owned_plant_tests absent — treat as no tests */ }
  }
  return rows.map((r) => {
    const tests = byPlant.get(r.id as string) ?? [];
    return { ...r, tests, test_status: worst(tests.map((t) => t.status as string)) };
  });
}

// ── Register list (master) ──────────────────────────────────────────────────
// The list GETs swallow a missing-table error (pre-migration 0045) and return
// an empty register, so the Plant page and project Plant tab never 500.
ownedPlant.get("/", async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      `SELECT op.id, op.asset_no, op.name, op.category, op.supplier, op.notes,
              op.assigned_project_id, op.assigned_at, op.assigned_by, op.archived_at,
              op.created_at, op.created_by, p.code AS assigned_project_code
         FROM owned_plant op LEFT JOIN projects p ON p.id = op.assigned_project_id
        WHERE op.archived_at IS NULL
        ORDER BY op.name COLLATE NOCASE`,
    ).all<Record<string, unknown>>();
    return c.json(await withTests(c, rows.results));
  } catch (e) {
    console.warn("owned_plant list skipped (pre-0045):", e instanceof Error ? e.message : e);
    return c.json([]);
  }
});

// Owned plant currently transferred to one site (project Plant tab).
ownedPlant.get("/by-project/:projectId", async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      `SELECT op.id, op.asset_no, op.name, op.category, op.supplier, op.notes,
              op.assigned_project_id, op.assigned_at, op.assigned_by, op.archived_at,
              op.created_at, op.created_by
         FROM owned_plant op
        WHERE op.archived_at IS NULL AND op.assigned_project_id = ?
        ORDER BY op.name COLLATE NOCASE`,
    ).bind(c.req.param("projectId")).all<Record<string, unknown>>();
    return c.json(await withTests(c, rows.results));
  } catch (e) {
    console.warn("owned_plant by-project skipped (pre-0045):", e instanceof Error ? e.message : e);
    return c.json([]);
  }
});

ownedPlant.post("/", async (c) => {
  const b = await c.req.json<{ name?: string; asset_no?: string; category?: string; supplier?: string; notes?: string; assigned_project_id?: string | null }>();
  if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const proj = b.assigned_project_id || null;
  await c.env.DB.prepare(
    `INSERT INTO owned_plant (id, asset_no, name, category, supplier, notes, assigned_project_id, assigned_at, assigned_by, created_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, b.asset_no?.trim() || null, b.name.trim(), b.category?.trim() || null,
    b.supplier?.trim() || null, b.notes?.trim() || null,
    proj, proj ? now : null, proj ? c.get("userEmail") : null, now, c.get("userEmail"),
  ).run();
  return c.json({ id });
});

ownedPlant.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<Record<string, unknown>>();
  const allowed = ["asset_no", "name", "category", "supplier", "notes"] as const;
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const k of allowed) {
    if (k in b) {
      let v = b[k];
      if (typeof v === "string") v = v.trim() || null;
      sets.push(`${k} = ?`);
      binds.push(v ?? null);
    }
  }
  if (!sets.length) return c.json({ ok: true });
  binds.push(id);
  await c.env.DB.prepare(`UPDATE owned_plant SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  return c.json({ ok: true });
});

// Transfer to a site (project_id set) or return to the yard (project_id null).
ownedPlant.post("/:id/assign", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<{ project_id?: string | null }>();
  const now = new Date().toISOString();
  if (b.project_id) {
    await c.env.DB.prepare(
      "UPDATE owned_plant SET assigned_project_id = ?, assigned_at = ?, assigned_by = ? WHERE id = ?",
    ).bind(b.project_id, now, c.get("userEmail"), id).run();
  } else {
    await c.env.DB.prepare(
      "UPDATE owned_plant SET assigned_project_id = NULL, assigned_at = NULL, assigned_by = NULL WHERE id = ?",
    ).bind(id).run();
  }
  return c.json({ ok: true });
});

ownedPlant.delete("/:id", async (c) => {
  await c.env.DB.prepare("UPDATE owned_plant SET archived_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), c.req.param("id")).run();
  return c.json({ ok: true });
});

// ── Test / retest records ─────────────────────────────────────────────────
// "/tests/:testId" (2 segments) is registered alongside "/:id/tests" (also 2)
// but a different leading literal, so there's no route collision.
ownedPlant.post("/:id/tests", async (c) => {
  const plantId = c.req.param("id");
  const b = await c.req.json<{ test_type?: string; tested_on?: string; expiry_date?: string; notes?: string }>();
  if (!b.test_type?.trim()) return c.json({ error: "test_type required" }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO owned_plant_tests (id, plant_id, test_type, tested_on, expiry_date, file_key, notes, created_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, plantId, b.test_type.trim(), b.tested_on || null, b.expiry_date || null,
    null, b.notes?.trim() || null, new Date().toISOString(), c.get("userEmail"),
  ).run();
  return c.json({ id });
});

ownedPlant.delete("/tests/:testId", async (c) => {
  await c.env.DB.prepare("DELETE FROM owned_plant_tests WHERE id = ?").bind(c.req.param("testId")).run();
  return c.json({ ok: true });
});
