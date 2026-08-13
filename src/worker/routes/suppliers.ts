import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";
import { ensureXeroContact } from "./xero";

export const suppliers = new Hono<{ Bindings: Env; Variables: Variables }>();

// Managing the supplier register is gated by suppliers.manage (admin, superadmin
// AND commercial) — not approvers.manage, which is a different concern (who signs
// off POs). Reads stay open to every authenticated user.
suppliers.use("/*", async (c, next) => {
  if (c.req.method === "GET") return next();
  const denied = requirePermission(c, "suppliers.manage");
  if (denied) return denied;
  await next();
});

/** List approved suppliers, with approved elements + a count of product-level
 * supplier entries that name them. */
suppliers.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.*,
            (SELECT COUNT(*) FROM product_suppliers ps WHERE lower(ps.supplier_name) = lower(s.name)) AS product_supplier_count
     FROM suppliers s
     ORDER BY (s.status = 'preferred') DESC, s.name`,
  ).all<Record<string, unknown>>();

  const scopes = await c.env.DB.prepare(
    "SELECT supplier_id, element_code FROM supplier_scopes",
  ).all<{ supplier_id: number; element_code: string }>();

  const scopeBySupplier = new Map<number, string[]>();
  for (const s of scopes.results) {
    const arr = scopeBySupplier.get(s.supplier_id) ?? [];
    arr.push(s.element_code);
    scopeBySupplier.set(s.supplier_id, arr);
  }

  const result = rows.results.map((r) => ({
    ...r,
    // SQLite stores booleans as 0/1 — surface them as proper JS booleans
    is_labour_supplier: Number(r.is_labour_supplier ?? 0) === 1,
    approved_elements: (scopeBySupplier.get(Number(r.id)) ?? []).sort(),
  }));
  return c.json(result);
});

suppliers.get("/:id", async (c) => {
  const id = c.req.param("id");
  const supplier = await c.env.DB.prepare("SELECT * FROM suppliers WHERE id = ?")
    .bind(id).first<Record<string, unknown>>();
  if (!supplier) return c.json({ error: "not found" }, 404);
  const scopes = await c.env.DB.prepare(
    "SELECT element_code FROM supplier_scopes WHERE supplier_id = ? ORDER BY element_code",
  ).bind(id).all<{ element_code: string }>();
  return c.json({
    ...supplier,
    is_labour_supplier: Number(supplier.is_labour_supplier ?? 0) === 1,
    approved_elements: scopes.results.map((s) => s.element_code),
  });
});

suppliers.post("/", async (c) => {
  const body = await c.req.json<{
    name: string;
    status?: string;
    scope_notes?: string | null;
    payment_terms?: string | null;
    contact_name?: string | null;
    contact_email?: string | null;
    contact_phone?: string | null;
    address?: string | null;
    vat_number?: string | null;
    utr?: string | null;
    bank_account_name?: string | null;
    bank_sort_code?: string | null;
    bank_account_number?: string | null;
    bank_name?: string | null;
    credit_limit_gbp?: number | null;
    notes?: string | null;
    is_labour_supplier?: boolean;
    cis_rate?: number | null;
    approved_elements?: string[];
  }>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const now = new Date().toISOString();
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO suppliers
         (name, status, scope_notes, payment_terms, contact_name, contact_email,
          contact_phone, address, vat_number, utr,
          bank_account_name, bank_sort_code, bank_account_number, bank_name,
          credit_limit_gbp, notes,
          is_labour_supplier, cis_rate,
          created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
      .bind(
        body.name.trim(),
        body.status ?? "approved",
        body.scope_notes?.trim() || null,
        body.payment_terms?.trim() || null,
        body.contact_name?.trim() || null,
        body.contact_email?.trim() || null,
        body.contact_phone?.trim() || null,
        body.address?.trim() || null,
        body.vat_number?.trim() || null,
        body.utr?.trim() || null,
        body.bank_account_name?.trim() || null,
        body.bank_sort_code?.trim() || null,
        body.bank_account_number?.trim() || null,
        body.bank_name?.trim() || null,
        body.credit_limit_gbp ?? null,
        body.notes?.trim() || null,
        body.is_labour_supplier ? 1 : 0,
        body.cis_rate ?? null,
        now,
        c.get("userEmail"),
      )
      .first<{ id: number }>();
    const id = res!.id;
    if (body.approved_elements?.length) {
      await c.env.DB.batch(
        body.approved_elements.map((code) =>
          c.env.DB.prepare(
            "INSERT INTO supplier_scopes (supplier_id, element_code) VALUES (?, ?)",
          ).bind(id, code),
        ),
      );
    }
    // Push the new supplier to Xero straight away (create/link its contact) so
    // suppliers made in-app land in Xero without a manual step. Best-effort: a
    // Xero hiccup (or no connection) never fails the supplier create.
    let xero_pushed = false;
    try { xero_pushed = !!(await ensureXeroContact(c.env, body.name.trim())); } catch { /* best-effort */ }
    return c.json({ id, xero_pushed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) return c.json({ error: "A supplier with that name already exists" }, 409);
    throw e;
  }
});

suppliers.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>();
  const allowed = [
    "name", "status", "scope_notes", "payment_terms", "contact_name",
    "contact_email", "contact_phone", "address", "vat_number", "utr",
    "bank_account_name", "bank_sort_code", "bank_account_number", "bank_name",
    "credit_limit_gbp", "notes", "is_labour_supplier", "cis_rate",
  ] as const;
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = ?`);
      let v = body[k];
      if (typeof v === "string") v = v.trim() || null;
      // Booleans become SQLite 0/1
      if (k === "is_labour_supplier") v = v ? 1 : 0;
      binds.push(v ?? null);
    }
  }

  if (sets.length > 0) {
    binds.push(id);
    try {
      await c.env.DB.prepare(`UPDATE suppliers SET ${sets.join(", ")} WHERE id = ?`)
        .bind(...binds).run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE")) return c.json({ error: "Another supplier already uses that name" }, 409);
      throw e;
    }
  }

  // Optional: replace approved_elements wholesale.
  if (Array.isArray(body.approved_elements)) {
    await c.env.DB.prepare("DELETE FROM supplier_scopes WHERE supplier_id = ?")
      .bind(id).run();
    const codes = body.approved_elements as string[];
    if (codes.length > 0) {
      await c.env.DB.batch(
        codes.map((code) =>
          c.env.DB.prepare(
            "INSERT INTO supplier_scopes (supplier_id, element_code) VALUES (?, ?)",
          ).bind(id, code),
        ),
      );
    }
  }

  return c.json({ ok: true });
});

suppliers.delete("/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM suppliers WHERE id = ?")
    .bind(c.req.param("id")).run();
  return c.json({ ok: true });
});
