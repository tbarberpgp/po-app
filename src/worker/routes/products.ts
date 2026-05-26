import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";

export const products = new Hono<{ Bindings: Env; Variables: Variables }>();

// All mutating endpoints require approvers.manage (admin+). Reads are open.
products.use("/*", async (c, next) => {
  if (c.req.method === "GET") return next();
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;
  await next();
});

/** List the master product catalogue, with derived product_code and a count
 * of how many project materials reference each product. */
products.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.*, e.name AS element_name,
            (SELECT COUNT(*) FROM materials m WHERE m.product_id = p.id) AS usage_count
     FROM products p
     JOIN elements e ON e.code = p.element_code
     ORDER BY p.element_code, p.item_no, p.variant`,
  ).all<Record<string, unknown>>();

  const out = rows.results.map((r) => ({
    ...r,
    product_code: buildProductCode(
      String(r.element_code),
      Number(r.item_no),
      (r.variant as string | null) ?? null,
    ),
  }));
  return c.json(out);
});

products.post("/", async (c) => {
  const body = await c.req.json<{
    element_code: string;
    item_no?: number;
    variant?: string | null;
    description: string;
    manufacturer?: string | null;
    supplier?: string | null;
    unit?: string | null;
    unit_cost?: number | null;
    default_resource?: string | null;
    notes?: string | null;
  }>();
  if (!body.element_code || !body.description) {
    return c.json({ error: "element_code and description are required" }, 400);
  }

  // Validate element exists
  const elem = await c.env.DB.prepare("SELECT 1 AS ok FROM elements WHERE code = ?")
    .bind(body.element_code).first();
  if (!elem) return c.json({ error: "unknown element_code" }, 400);

  // If no item_no provided, allocate next available within element (avoiding 90-99
  // which are reserved for variations).
  let item_no = body.item_no;
  if (item_no == null) {
    const max = await c.env.DB.prepare(
      "SELECT MAX(item_no) AS n FROM products WHERE element_code = ? AND item_no < 90",
    ).bind(body.element_code).first<{ n: number | null }>();
    item_no = (max?.n ?? 0) + 1;
  }

  const variant = body.variant?.trim() || null;
  const now = new Date().toISOString();
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO products
         (element_code, item_no, variant, description, manufacturer, supplier,
          unit, unit_cost, default_resource, notes, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
      .bind(
        body.element_code,
        item_no,
        variant,
        body.description.trim(),
        body.manufacturer?.trim() || null,
        body.supplier?.trim() || null,
        body.unit?.trim() || null,
        body.unit_cost ?? null,
        body.default_resource ?? "M",
        body.notes?.trim() || null,
        now,
        c.get("userEmail"),
      )
      .first<{ id: number }>();
    return c.json({ id: res!.id, item_no, variant });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) {
      return c.json({ error: `A product with code ${body.element_code}.${String(item_no).padStart(2, "0")}${variant ? "." + variant : ""} already exists` }, 409);
    }
    throw e;
  }
});

products.put("/:id", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const allowed = [
    "element_code", "item_no", "variant", "description", "manufacturer",
    "supplier", "unit", "unit_cost", "default_resource", "notes",
  ] as const;
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = ?`);
      let v = body[k];
      if (typeof v === "string") v = v.trim() || null;
      binds.push(v ?? null);
    }
  }
  if (sets.length === 0) return c.json({ error: "nothing to update" }, 400);
  binds.push(c.req.param("id"));
  try {
    await c.env.DB.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...binds).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) return c.json({ error: "Product code collision — pick a different item number/variant" }, 409);
    throw e;
  }
  return c.json({ ok: true });
});

products.delete("/:id", async (c) => {
  const id = c.req.param("id");
  // Detach any project materials first so we don't dangle the FK.
  await c.env.DB.prepare("UPDATE materials SET product_id = NULL WHERE product_id = ?")
    .bind(id).run();
  await c.env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

/**
 * Suggestions view — distinct project materials across all active project
 * snapshots, normalised + grouped so duplicates collapse into one row. The
 * UI uses this to lift recurring materials into the master library.
 *
 * Normalisation: lowercased, alphanumerics-and-spaces only, collapsed whitespace.
 */
products.get("/suggestions", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.id AS material_id, m.item, m.manufacturer, m.type, m.cost, m.pack_unit,
            m.product_id, p.code AS project_code, p.name AS project_name, p.id AS project_id
     FROM materials m
     JOIN material_snapshots s ON s.id = m.snapshot_id AND s.is_active = 1
     JOIN projects p ON p.id = s.project_id
     WHERE p.deleted_at IS NULL`,
  ).all<{
    material_id: number; item: string; manufacturer: string | null; type: string;
    cost: number | null; pack_unit: string | null; product_id: number | null;
    project_code: string; project_name: string; project_id: string;
  }>();

  const groups = new Map<string, {
    key: string;
    sample_description: string;
    manufacturer: string | null;
    type: string;
    occurrences: number;
    avg_unit_cost: number | null;
    suppliers: string[];
    project_codes: string[];
    linked_product_id: number | null;
    material_ids: number[];
  }>();

  for (const r of rows.results) {
    const key = normaliseKey(r.item, r.manufacturer);
    const existing = groups.get(key);
    if (existing) {
      existing.occurrences += 1;
      if (r.cost != null) {
        existing.avg_unit_cost = ((existing.avg_unit_cost ?? 0) * (existing.occurrences - 1) + r.cost) / existing.occurrences;
      }
      if (!existing.project_codes.includes(r.project_code)) existing.project_codes.push(r.project_code);
      if (r.manufacturer && !existing.suppliers.includes(r.manufacturer)) existing.suppliers.push(r.manufacturer);
      if (r.product_id != null) existing.linked_product_id = r.product_id;
      existing.material_ids.push(r.material_id);
    } else {
      groups.set(key, {
        key,
        sample_description: r.item,
        manufacturer: r.manufacturer,
        type: r.type,
        occurrences: 1,
        avg_unit_cost: r.cost,
        suppliers: r.manufacturer ? [r.manufacturer] : [],
        project_codes: [r.project_code],
        linked_product_id: r.product_id,
        material_ids: [r.material_id],
      });
    }
  }

  // Sort: unlinked first, then by occurrences desc, then alphabetical.
  const result = [...groups.values()].sort((a, b) => {
    if ((a.linked_product_id == null) !== (b.linked_product_id == null)) {
      return a.linked_product_id == null ? -1 : 1;
    }
    if (a.occurrences !== b.occurrences) return b.occurrences - a.occurrences;
    return a.sample_description.localeCompare(b.sample_description);
  });
  return c.json(result);
});

/** Link a set of project materials to an existing product (or unlink with product_id=null). */
products.post("/:id/link-materials", async (c) => {
  const productId = c.req.param("id");
  const body = await c.req.json<{ material_ids: number[]; unlink?: boolean }>();
  if (!Array.isArray(body.material_ids) || body.material_ids.length === 0) {
    return c.json({ error: "material_ids[] required" }, 400);
  }
  // Validate product exists (unless unlinking)
  if (!body.unlink) {
    const exists = await c.env.DB.prepare("SELECT 1 AS ok FROM products WHERE id = ?")
      .bind(productId).first();
    if (!exists) return c.json({ error: "product not found" }, 404);
  }
  const target = body.unlink ? null : Number(productId);
  await c.env.DB.batch(
    body.material_ids.map((mid) =>
      c.env.DB.prepare("UPDATE materials SET product_id = ? WHERE id = ?").bind(target, mid),
    ),
  );
  return c.json({ ok: true, linked: body.material_ids.length });
});

/** Helpers — exported for tests if needed. */
function buildProductCode(element_code: string, item_no: number, variant: string | null): string {
  const item = String(item_no).padStart(2, "0");
  const v = variant?.trim() ? `.${variant.trim()}` : "";
  return `${element_code}.${item}${v}`;
}

function normaliseKey(name: string, manufacturer: string | null): string {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
  return `${n(name)}::${manufacturer ? n(manufacturer) : ""}`;
}
