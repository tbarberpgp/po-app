import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
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

/** List the master product catalogue, with derived product_code, a count of
 * how many project materials reference each product, and a count of alternate
 * suppliers (for the expand-row affordance in the UI). */
products.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.*, e.name AS element_name,
            (SELECT COUNT(*) FROM materials m WHERE m.product_id = p.id) AS usage_count,
            (SELECT COUNT(*) FROM product_suppliers ps WHERE ps.product_id = p.id) AS alternate_supplier_count
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
  const manufacturer = body.manufacturer?.trim() || null;
  // Supplier defaults to manufacturer when not explicitly set — covers the
  // common case (Kingspan products bought from Kingspan, Rockwool from
  // Rockwool, etc). Override by sending a non-empty `supplier`.
  const supplier = body.supplier?.trim() || manufacturer;
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
        manufacturer,
        supplier,
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

  // Supplier auto-mirrors manufacturer: if the caller passes a manufacturer
  // change but leaves supplier untouched (or sends an empty string), copy
  // the manufacturer over to keep them in sync.
  const patch = { ...body };
  if ("manufacturer" in patch) {
    const newMfr = typeof patch.manufacturer === "string" ? patch.manufacturer.trim() || null : null;
    patch.manufacturer = newMfr;
    if (!("supplier" in patch) || !patch.supplier || (typeof patch.supplier === "string" && !patch.supplier.trim())) {
      patch.supplier = newMfr;
    }
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const k of allowed) {
    if (k in patch) {
      sets.push(`${k} = ?`);
      let v = patch[k];
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

/* ── Alternate suppliers (one product → many suppliers) ──────────────── */

products.get("/:id/suppliers", async (c) => {
  const id = c.req.param("id");
  const rows = await c.env.DB.prepare(
    `SELECT * FROM product_suppliers WHERE product_id = ?
     ORDER BY is_preferred DESC, unit_cost ASC, supplier_name`,
  ).bind(id).all();
  return c.json(rows.results);
});

products.post("/:id/suppliers", async (c) => {
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;
  const productId = Number(c.req.param("id"));
  const body = await c.req.json<{
    supplier_name: string;
    unit_cost?: number | null;
    supplier_sku?: string | null;
    lead_time_days?: number | null;
    notes?: string | null;
    is_preferred?: boolean;
  }>();
  if (!body.supplier_name?.trim()) return c.json({ error: "supplier_name required" }, 400);
  const now = new Date().toISOString();
  try {
    // If marked preferred, clear any existing preferred for this product first.
    if (body.is_preferred) {
      await c.env.DB.prepare(
        "UPDATE product_suppliers SET is_preferred = 0 WHERE product_id = ?",
      ).bind(productId).run();
    }
    const res = await c.env.DB.prepare(
      `INSERT INTO product_suppliers
         (product_id, supplier_name, unit_cost, supplier_sku, lead_time_days,
          notes, is_preferred, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
      .bind(
        productId,
        body.supplier_name.trim(),
        body.unit_cost ?? null,
        body.supplier_sku?.trim() || null,
        body.lead_time_days ?? null,
        body.notes?.trim() || null,
        body.is_preferred ? 1 : 0,
        now,
        c.get("userEmail"),
      )
      .first<{ id: number }>();
    return c.json({ id: res!.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) {
      return c.json({ error: `This product already has an entry for "${body.supplier_name}"` }, 409);
    }
    throw e;
  }
});

products.put("/:id/suppliers/:sid", async (c) => {
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;
  const productId = Number(c.req.param("id"));
  const sid = Number(c.req.param("sid"));
  const body = await c.req.json<Record<string, unknown>>();

  if (body.is_preferred === true) {
    await c.env.DB.prepare(
      "UPDATE product_suppliers SET is_preferred = 0 WHERE product_id = ? AND id != ?",
    ).bind(productId, sid).run();
  }

  const allowed = ["supplier_name", "unit_cost", "supplier_sku", "lead_time_days", "notes", "is_preferred"] as const;
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = ?`);
      let v = body[k];
      if (k === "is_preferred") v = v ? 1 : 0;
      else if (typeof v === "string") v = v.trim() || null;
      binds.push(v ?? null);
    }
  }
  if (sets.length === 0) return c.json({ error: "nothing to update" }, 400);
  binds.push(sid, productId);
  await c.env.DB.prepare(
    `UPDATE product_suppliers SET ${sets.join(", ")} WHERE id = ? AND product_id = ?`,
  ).bind(...binds).run();
  return c.json({ ok: true });
});

products.delete("/:id/suppliers/:sid", async (c) => {
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;
  await c.env.DB.prepare(
    "DELETE FROM product_suppliers WHERE id = ? AND product_id = ?",
  ).bind(c.req.param("sid"), c.req.param("id")).run();
  return c.json({ ok: true });
});

/** Merge a duplicate product into another: the same material listed twice
 *  (typically once per supplier) becomes ONE heading with each supplier as an
 *  offer. The duplicate's primary supplier and alternate offers move over as
 *  product_suppliers rows (first listing of a supplier wins on conflict), every
 *  reference (project materials, quote matches, substitutions, variation
 *  lines) repoints at the survivor, and the duplicate is deleted. */
products.post("/:id/merge-into", async (c) => {
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;
  const sourceId = Number(c.req.param("id"));
  const body = await c.req.json<{ target_id?: number }>().catch(() => ({} as { target_id?: number }));
  const targetId = Number(body.target_id);
  if (!Number.isInteger(sourceId) || !Number.isInteger(targetId)) return c.json({ error: "bad product id" }, 400);
  if (sourceId === targetId) return c.json({ error: "Pick a different product to merge into." }, 400);
  const [source, target] = await Promise.all([
    c.env.DB.prepare("SELECT id, description, supplier, unit_cost FROM products WHERE id = ?").bind(sourceId)
      .first<{ id: number; description: string; supplier: string | null; unit_cost: number | null }>(),
    c.env.DB.prepare("SELECT id, description, supplier FROM products WHERE id = ?").bind(targetId)
      .first<{ id: number; description: string; supplier: string | null }>(),
  ]);
  if (!source || !target) return c.json({ error: "product not found" }, 404);

  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  // Supplier names already offering the target (primary + alternates), lowercased.
  const existing = new Set<string>([(target.supplier ?? "").toLowerCase()].filter(Boolean));
  const targetOffers = (await c.env.DB.prepare("SELECT supplier_name FROM product_suppliers WHERE product_id = ?")
    .bind(targetId).all<{ supplier_name: string }>()).results;
  for (const o of targetOffers) existing.add(o.supplier_name.toLowerCase());

  // The duplicate's PRIMARY supplier becomes an alternate offer on the target.
  if (source.supplier && !existing.has(source.supplier.toLowerCase())) {
    await c.env.DB.prepare(
      `INSERT INTO product_suppliers (product_id, supplier_name, unit_cost, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(targetId, source.supplier, source.unit_cost, now, actor).run();
    existing.add(source.supplier.toLowerCase());
  }
  // Its alternate offers move over unless the target already lists that supplier.
  const srcOffers = (await c.env.DB.prepare("SELECT id, supplier_name FROM product_suppliers WHERE product_id = ?")
    .bind(sourceId).all<{ id: number; supplier_name: string }>()).results;
  let movedOffers = 0;
  for (const o of srcOffers) {
    if (existing.has(o.supplier_name.toLowerCase())) continue; // stays on source → deleted with it
    await c.env.DB.prepare("UPDATE product_suppliers SET product_id = ? WHERE id = ?").bind(targetId, o.id).run();
    existing.add(o.supplier_name.toLowerCase());
    movedOffers++;
  }

  // Repoint every reference, then remove the duplicate (remaining offers cascade).
  const [mats, quotes2, subs, vars2] = await Promise.all([
    c.env.DB.prepare("UPDATE materials SET product_id = ? WHERE product_id = ?").bind(targetId, sourceId).run(),
    c.env.DB.prepare("UPDATE supplier_quote_lines SET matched_product_id = ? WHERE matched_product_id = ?").bind(targetId, sourceId).run(),
    c.env.DB.prepare("UPDATE material_substitutions SET replacement_product_id = ? WHERE replacement_product_id = ?").bind(targetId, sourceId).run(),
    c.env.DB.prepare("UPDATE variation_materials SET product_id = ? WHERE product_id = ?").bind(targetId, sourceId).run(),
  ]);
  await c.env.DB.prepare("DELETE FROM products WHERE id = ?").bind(sourceId).run();
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('product', ?, 'merged', ?, ?, ?)`,
  ).bind(String(targetId), actor, JSON.stringify({
    merged_product_id: sourceId, merged_description: source.description,
    moved_offers: movedOffers, relinked_materials: mats.meta.changes ?? 0,
    relinked_quote_lines: quotes2.meta.changes ?? 0, relinked_substitutions: subs.meta.changes ?? 0,
    relinked_variation_lines: vars2.meta.changes ?? 0,
  }), now).run();
  return c.json({
    ok: true, target_id: targetId,
    moved_offers: movedOffers, relinked_materials: mats.meta.changes ?? 0,
  });
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
    substitution_ids: number[];
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
        substitution_ids: [],
      });
    }
  }

  // Freeform substitutions are products being used on jobs that aren't (yet) in
  // the master library — surface them as suggestions too. Sourced from a master
  // product (replacement_product_id set) means already catalogued, so it lands
  // as a "linked" row. Merge into the same groups so a subbed-in product that
  // also appears as a priced material on another job collapses into one row.
  const subs = await c.env.DB.prepare(
    `SELECT sub.id AS substitution_id, sub.replacement_item AS item,
            sub.replacement_manufacturer AS manufacturer, sub.replacement_cost AS cost,
            sub.replacement_product_id AS product_id, m.type AS type,
            p.code AS project_code
     FROM material_substitutions sub
     JOIN materials m ON m.id = sub.material_id
     JOIN projects p ON p.id = sub.project_id
     WHERE sub.active = 1 AND p.deleted_at IS NULL`,
  ).all<{
    substitution_id: number; item: string; manufacturer: string | null;
    cost: number | null; product_id: number | null; type: string | null; project_code: string;
  }>();

  for (const r of subs.results) {
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
      existing.substitution_ids.push(r.substitution_id);
    } else {
      groups.set(key, {
        key,
        sample_description: r.item,
        manufacturer: r.manufacturer,
        type: r.type ?? "—",
        occurrences: 1,
        avg_unit_cost: r.cost,
        suppliers: r.manufacturer ? [r.manufacturer] : [],
        project_codes: [r.project_code],
        linked_product_id: r.product_id,
        material_ids: [],
        substitution_ids: [r.substitution_id],
      });
    }
  }

  // Dismissed suggestions are stored (in global settings) as a map of
  // normalised key → the project codes it was dismissed against. A dismissed
  // suggestion is hidden only while it appears solely in those projects; if it
  // turns up in a NEW project, it resurfaces automatically. (Legacy entries
  // with an empty project list stay hidden unconditionally.)
  const dismissedRow = await c.env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'dismissed_suggestion_keys'",
  ).first<{ value: string }>();
  const dismissed = parseDismissed(dismissedRow?.value);

  // Sort: unlinked first, then by occurrences desc, then alphabetical.
  const result = [...groups.values()].filter((g) => {
    const against = dismissed[g.key];
    if (against === undefined) return true;          // never dismissed → show
    if (against.length === 0) return false;          // legacy/unconditional → hide
    // Resurface if the suggestion now appears in a project it wasn't dismissed against.
    return g.project_codes.some((pc) => !against.includes(pc));
  }).sort((a, b) => {
    if ((a.linked_product_id == null) !== (b.linked_product_id == null)) {
      return a.linked_product_id == null ? -1 : 1;
    }
    if (a.occurrences !== b.occurrences) return b.occurrences - a.occurrences;
    return a.sample_description.localeCompare(b.sample_description);
  });
  return c.json(result);
});

/** Dismiss a suggestion (by normalised key) so it stops appearing — until the
 *  same material turns up in a project it wasn't dismissed against. */
products.post("/suggestions/dismiss", async (c) => {
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;
  const body = await c.req.json<{ key: string; project_codes?: string[] }>().catch(() => null);
  if (!body?.key) return c.json({ error: "key required" }, 400);
  const row = await c.env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'dismissed_suggestion_keys'",
  ).first<{ value: string }>();
  const dismissed = parseDismissed(row?.value);
  // Record the projects it currently spans, so a future new project resurfaces it.
  dismissed[body.key] = Array.isArray(body.project_codes) ? body.project_codes : [];
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('dismissed_suggestion_keys', ?)",
  ).bind(JSON.stringify(dismissed)).run();
  return c.json({ ok: true, dismissed: Object.keys(dismissed).length });
});

/** Restore all previously dismissed suggestions. */
products.post("/suggestions/restore", async (c) => {
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;
  await c.env.DB.prepare("DELETE FROM settings WHERE key = 'dismissed_suggestion_keys'").run();
  return c.json({ ok: true });
});

/**
 * AI product research — given a product name/SKU/description, ask Claude to
 * fill in the missing fields (element code, manufacturer, variant, unit,
 * typical UK trade price). Returns the structured suggestion; the client
 * uses it to pre-fill the New Product form.
 *
 * The element list is loaded from D1 on every call so Claude can only
 * suggest codes that actually exist (no hallucinated elements).
 */
products.post("/research", async (c) => {
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;

  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json(
      {
        error:
          "Product research is disabled in this environment. Set the ANTHROPIC_API_KEY secret via `wrangler secret put ANTHROPIC_API_KEY` to enable.",
      },
      503,
    );
  }

  const body = await c.req.json<{ query: string }>();
  const query = body.query?.trim();
  if (!query) return c.json({ error: "query is required" }, 400);

  // Pull current elements so Claude's choices are bounded by what exists.
  const elements = await c.env.DB.prepare(
    "SELECT code, name, notes FROM elements ORDER BY code",
  ).all<{ code: string; name: string; notes: string | null }>();

  const elementsContext = elements.results
    .map((e) => `  ${e.code} — ${e.name}${e.notes ? `: ${e.notes}` : ""}`)
    .join("\n");

  const systemPrompt = `You are an expert in UK roofing, cladding and building-envelope procurement. Given a description of a construction material or product, return structured details so it can be added to a master product catalogue.

Allocate the product to one of these element codes (use the closest match — never invent a code):
${elementsContext}

Pricing guidance: estimate typical UK trade prices in GBP (excluding VAT). Be conservative — if you're unsure, mark confidence "low" and explain in notes. Common units: m² (cladding, insulation, membranes), lm/m (gutters, flashings, trims), ea/nr (fixings, brackets, rooflights), Roll (membranes, tapes), Box (fasteners).

Variant guidance: use a short alphanumeric flag (e.g. "KS1000-80", "ANTH", "100mm", "M8-50") only when the description names a clear distinguishing variant. Leave blank otherwise.`;

  const client = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });

  // Claude rejects `thinking` and `output_config.effort` when tool_choice
  // forces a specific tool. We need structured output here so we keep the
  // forced tool_choice and drop the thinking knobs.
  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    system: systemPrompt,
    tools: [
      {
        name: "suggest_product",
        description:
          "Return structured product details for the master cost-coded catalogue.",
        input_schema: {
          type: "object" as const,
          properties: {
            element_code: {
              type: "string",
              description:
                "2-digit element code from the provided list (e.g. '21', '31', '60'). Must exactly match one of the codes shown.",
            },
            manufacturer: {
              type: "string",
              description:
                "Manufacturer brand name (e.g. 'Kingspan', 'Trespa', 'Rockwool', 'Alumasc'). Empty string if unknown / generic.",
            },
            variant: {
              type: "string",
              description:
                "Short alphanumeric variant flag for size/colour/spec (e.g. 'KS1000-80'). Empty string if no clear variant.",
            },
            description: {
              type: "string",
              description:
                "Cleaned, standardised product description (e.g. 'Kingspan KS1000 RW 80mm composite roof panel').",
            },
            unit: {
              type: "string",
              description:
                "Typical unit of sale: 'm²', 'lm', 'ea', 'Roll', 'Box', 'bag', 'drum', etc.",
            },
            estimated_unit_cost_gbp: {
              type: "number",
              description:
                "Estimated UK trade price in GBP excluding VAT, per the unit above. 0 if unknown.",
            },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
              description:
                "How confident you are in this suggestion overall.",
            },
            notes: {
              type: "string",
              description:
                "Any caveats, alternatives, or context worth surfacing to the user (e.g. 'Available in 60–120mm thicknesses; price varies').",
            },
          },
          required: ["element_code", "description", "confidence"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "suggest_product" },
    messages: [
      {
        role: "user",
        content: `Research this product and fill in the structured fields:\n\n${query}`,
      },
    ],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    return c.json({ error: "Claude did not return structured output" }, 502);
  }

  // Validate the element code is one we actually have. If the model picked an
  // unknown code, drop it so the UI re-prompts the user.
  const suggestion = toolUse.input as {
    element_code?: string;
    [k: string]: unknown;
  };
  if (
    suggestion.element_code &&
    !elements.results.some((e) => e.code === suggestion.element_code)
  ) {
    delete suggestion.element_code;
  }

  return c.json({
    suggestion,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  });
});

/** Link project materials and/or substitutions to an existing product (or
 *  unlink with unlink=true). Substitutions link via their replacement_product_id
 *  so a promoted substitution stops re-appearing as a suggestion. */
products.post("/:id/link-materials", async (c) => {
  const productId = c.req.param("id");
  const body = await c.req.json<{ material_ids?: number[]; substitution_ids?: number[]; unlink?: boolean }>();
  const materialIds = Array.isArray(body.material_ids) ? body.material_ids : [];
  const substitutionIds = Array.isArray(body.substitution_ids) ? body.substitution_ids : [];
  if (materialIds.length === 0 && substitutionIds.length === 0) {
    return c.json({ error: "material_ids[] or substitution_ids[] required" }, 400);
  }
  // Validate product exists (unless unlinking)
  if (!body.unlink) {
    const exists = await c.env.DB.prepare("SELECT 1 AS ok FROM products WHERE id = ?")
      .bind(productId).first();
    if (!exists) return c.json({ error: "product not found" }, 404);
  }
  const target = body.unlink ? null : Number(productId);
  const stmts = [
    ...materialIds.map((mid) =>
      c.env.DB.prepare("UPDATE materials SET product_id = ? WHERE id = ?").bind(target, mid)),
    ...substitutionIds.map((sid) =>
      c.env.DB.prepare("UPDATE material_substitutions SET replacement_product_id = ? WHERE id = ?").bind(target, sid)),
  ];
  if (stmts.length > 0) await c.env.DB.batch(stmts);
  return c.json({ ok: true, linked: materialIds.length + substitutionIds.length });
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

/**
 * Parse the dismissed-suggestions setting into a map of key → project codes it
 * was dismissed against. Tolerates the legacy format (a plain array of keys) by
 * mapping each to an empty project list (= hidden unconditionally).
 */
function parseDismissed(value: string | undefined | null): Record<string, string[]> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return Object.fromEntries((parsed as string[]).map((k) => [k, []]));
    if (parsed && typeof parsed === "object") return parsed as Record<string, string[]>;
  } catch { /* ignore bad json */ }
  return {};
}
