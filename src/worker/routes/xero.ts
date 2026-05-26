import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  expiresAtFromNow,
  getRedirectUri,
  listTenants,
  XERO_SCOPES,
} from "../xero/oauth";
import {
  contactAddressLine,
  contactPhone,
  createPurchaseOrder,
  findContactByName,
  formatPaymentTerms,
  getValidConnection,
  listSupplierContacts,
} from "../xero/client";
import type { XeroContact, XeroPOInput } from "../xero/client";

export const xero = new Hono<{ Bindings: Env; Variables: Variables }>();

function notConfigured(env: Env): Response | null {
  if (env.XERO_CLIENT_ID && env.XERO_CLIENT_SECRET) return null;
  return new Response(
    JSON.stringify({
      error:
        "Xero is not configured. An admin needs to register an app at developer.xero.com and set XERO_CLIENT_ID + XERO_CLIENT_SECRET as worker secrets.",
    }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );
}

/** Diagnostic — returns the exact authorize URL the connect handler would
 *  redirect to, plus the redirect_uri and scope string the worker computes.
 *  Useful for debugging "invalid_scope" / "redirect_uri mismatch" errors. */
xero.get("/debug", async (c) => {
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;
  try {
    return c.json({
      configured: !!(c.env.XERO_CLIENT_ID && c.env.XERO_CLIENT_SECRET),
      client_id_prefix: c.env.XERO_CLIENT_ID?.slice(0, 6) ?? null,
      redirect_uri: getRedirectUri(c.env),
      scopes_string: XERO_SCOPES,
      scopes_array: XERO_SCOPES.split(" "),
      authorize_url_preview: buildAuthorizeUrl(c.env, "debug-state"),
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/* ── Connect / disconnect / status ─────────────────────────────────── */

xero.get("/status", async (c) => {
  const config = c.env.XERO_CLIENT_ID && c.env.XERO_CLIENT_SECRET;
  const conn = await c.env.DB.prepare(
    "SELECT tenant_id, tenant_name, tenant_type, expires_at, scopes, connected_at, connected_by FROM xero_connection LIMIT 1",
  ).first();
  return c.json({
    configured: !!config,
    connected: !!conn,
    connection: conn ?? null,
  });
});

xero.get("/connect", async (c) => {
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;
  const nc = notConfigured(c.env);
  if (nc) return nc;

  // CSRF state: random 32-char id stored in a short-lived secure cookie that
  // the callback handler verifies. Cookie is on the worker's own hostname so
  // Xero never sees it.
  const state = crypto.randomUUID().replace(/-/g, "");
  const cookie = `xero_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
  const url = buildAuthorizeUrl(c.env, state);
  // Browser-redirect, not JSON — this endpoint is hit by a link/navigation.
  return new Response(null, {
    status: 302,
    headers: { Location: url, "Set-Cookie": cookie },
  });
});

xero.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");
  const errorDesc = c.req.query("error_description");

  const baseRedirect = `${c.env.APP_BASE_URL || ""}/admin`;
  const fail = (msg: string) => new Response(null, {
    status: 302,
    headers: {
      Location: `${baseRedirect}?xero_error=${encodeURIComponent(msg)}`,
      "Set-Cookie": "xero_oauth_state=; Path=/; Max-Age=0",
    },
  });

  if (error) return fail(errorDesc ?? error);
  if (!code || !state) return fail("Missing code or state");

  // Validate CSRF state cookie.
  const cookieHeader = c.req.header("Cookie") ?? "";
  const cookieState = cookieHeader.match(/xero_oauth_state=([a-f0-9]+)/i)?.[1];
  if (!cookieState || cookieState !== state) return fail("OAuth state mismatch — try connecting again.");

  // Only admins were allowed to initiate the connect — re-check at callback too.
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;

  try {
    const tokens = await exchangeCodeForTokens(c.env, code);
    const tenants = await listTenants(tokens.access_token);
    if (tenants.length === 0) return fail("Xero returned no tenants. Make sure you selected an organisation.");
    const tenant = tenants[0]; // first/only tenant

    const expiresAt = expiresAtFromNow(tokens.expires_in);
    const now = new Date().toISOString();

    // Single-tenant install — replace any existing row.
    await c.env.DB.prepare("DELETE FROM xero_connection").run();
    await c.env.DB.prepare(
      `INSERT INTO xero_connection
         (tenant_id, tenant_name, tenant_type, access_token, refresh_token,
          expires_at, scopes, connected_at, connected_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        tenant.tenantId,
        tenant.tenantName,
        tenant.tenantType,
        tokens.access_token,
        tokens.refresh_token,
        expiresAt,
        tokens.scope ?? null,
        now,
        c.get("userEmail"),
      )
      .run();

    return new Response(null, {
      status: 302,
      headers: {
        Location: `${baseRedirect}?xero=connected`,
        "Set-Cookie": "xero_oauth_state=; Path=/; Max-Age=0",
      },
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
});

xero.post("/disconnect", async (c) => {
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;
  await c.env.DB.prepare("DELETE FROM xero_connection").run();
  return c.json({ ok: true });
});

/* ── Sync suppliers from Xero ──────────────────────────────────────── */

xero.post("/sync-suppliers", async (c) => {
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;
  const nc = notConfigured(c.env);
  if (nc) return nc;

  let contacts: XeroContact[];
  try {
    contacts = await listSupplierContacts(c.env);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Xero sync failed" }, 502);
  }

  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const c0 of contacts) {
    const name = c0.Name?.trim();
    if (!name) { skipped += 1; continue; }

    // Match strategy: prefer xero_contact_id, fall back to lowercased name.
    const existing = await c.env.DB.prepare(
      `SELECT id, name FROM suppliers
       WHERE xero_contact_id = ? OR lower(name) = lower(?)
       LIMIT 1`,
    )
      .bind(c0.ContactID, name)
      .first<{ id: number; name: string }>();

    const fields = {
      name,
      xero_contact_id: c0.ContactID,
      contact_email: c0.EmailAddress ?? null,
      contact_name:
        c0.FirstName || c0.LastName
          ? [c0.FirstName, c0.LastName].filter(Boolean).join(" ")
          : null,
      contact_phone: contactPhone(c0),
      address: contactAddressLine(c0),
      vat_number: c0.TaxNumber ?? null,
      payment_terms: formatPaymentTerms(c0),
    };

    if (existing) {
      // Update the link + any fields we just learned (don't overwrite admin
      // edits with nulls — only fill in blanks for non-name fields).
      await c.env.DB.prepare(
        `UPDATE suppliers
           SET xero_contact_id     = ?,
               xero_last_synced_at = ?,
               contact_email       = COALESCE(contact_email, ?),
               contact_name        = COALESCE(contact_name, ?),
               contact_phone       = COALESCE(contact_phone, ?),
               address             = COALESCE(address, ?),
               vat_number          = COALESCE(vat_number, ?),
               payment_terms       = COALESCE(payment_terms, ?)
         WHERE id = ?`,
      )
        .bind(
          fields.xero_contact_id,
          now,
          fields.contact_email,
          fields.contact_name,
          fields.contact_phone,
          fields.address,
          fields.vat_number,
          fields.payment_terms,
          existing.id,
        )
        .run();
      updated += 1;
    } else {
      await c.env.DB.prepare(
        `INSERT INTO suppliers
           (name, status, xero_contact_id, xero_last_synced_at,
            contact_email, contact_name, contact_phone, address,
            vat_number, payment_terms, created_at, created_by)
         VALUES (?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          fields.name,
          fields.xero_contact_id,
          now,
          fields.contact_email,
          fields.contact_name,
          fields.contact_phone,
          fields.address,
          fields.vat_number,
          fields.payment_terms,
          now,
          `xero:${actor}`,
        )
        .run();
      created += 1;
    }
  }

  return c.json({ created, updated, skipped, total_from_xero: contacts.length });
});

/* ── Push a PO into Xero ───────────────────────────────────────────── */

xero.post("/push-po/:id", async (c) => {
  const denied = requirePermission(c, "pos.push_to_xero");
  if (denied) return denied;
  const nc = notConfigured(c.env);
  if (nc) return nc;

  const id = c.req.param("id");
  try {
    const result = await pushPOToXero(c.env, id);
    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
});

/** How many approved/issued POs aren't yet successfully in Xero. Used by the
 *  PO list page to show a count + bulk-push affordance. */
xero.get("/pending-count", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n
     FROM purchase_orders
     WHERE status IN ('approved', 'issued')
       AND (xero_po_id IS NULL OR xero_sync_status = 'failed')`,
  ).first<{ n: number }>();
  return c.json({ pending: row?.n ?? 0 });
});

/** Bulk-push every approved/issued PO that isn't already synced to Xero
 *  (or whose last push failed). Runs sequentially — Xero rate-limits at
 *  60 calls/minute per org, so this is plenty for typical batch sizes. */
xero.post("/bulk-push", async (c) => {
  const denied = requirePermission(c, "pos.push_to_xero");
  if (denied) return denied;
  const nc = notConfigured(c.env);
  if (nc) return nc;

  const rows = await c.env.DB.prepare(
    `SELECT id, po_number, supplier
     FROM purchase_orders
     WHERE status IN ('approved', 'issued')
       AND (xero_po_id IS NULL OR xero_sync_status = 'failed')
     ORDER BY created_at ASC`,
  ).all<{ id: string; po_number: string; supplier: string }>();

  const results: Array<{
    po_number: string;
    supplier: string;
    ok: boolean;
    xero_po_number?: string;
    error?: string;
  }> = [];

  for (const r of rows.results) {
    try {
      const res = await pushPOToXero(c.env, r.id);
      results.push({ po_number: r.po_number, supplier: r.supplier, ok: true, xero_po_number: res.xero_po_number });
    } catch (e) {
      results.push({
        po_number: r.po_number,
        supplier: r.supplier,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return c.json({
    total: rows.results.length,
    pushed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
});

/**
 * Build a Xero PO from our DB record and submit it. Called both from the
 * /push-po/:id route and from the PO approve hook (waitUntil).
 */
export async function pushPOToXero(env: Env, poId: string): Promise<{
  ok: true;
  xero_po_id: string;
  xero_po_number: string;
}> {
  const po = await env.DB.prepare(
    `SELECT po.*, p.code AS project_code, p.name AS project_name,
            p.delivery_address      AS project_delivery_address,
            p.site_contact_name     AS project_site_contact_name,
            p.site_contact_phone    AS project_site_contact_phone,
            p.delivery_instructions AS project_delivery_instructions
     FROM purchase_orders po
     JOIN projects p ON p.id = po.project_id
     WHERE po.id = ?`,
  )
    .bind(poId)
    .first<{
      id: string; po_number: string; supplier: string; total_value: number;
      notes: string | null; delivery_date: string | null; created_at: string;
      status: string;
      project_code: string; project_name: string;
      project_delivery_address: string | null;
      project_site_contact_name: string | null;
      project_site_contact_phone: string | null;
      project_delivery_instructions: string | null;
    }>();
  if (!po) throw new Error("PO not found");
  if (po.status !== "approved" && po.status !== "issued") {
    throw new Error("Only approved or issued POs can be pushed to Xero");
  }

  const lines = await env.DB.prepare(
    "SELECT item, manufacturer, qty, unit_cost FROM po_lines WHERE po_id = ?",
  )
    .bind(poId)
    .all<{ item: string; manufacturer: string | null; qty: number; unit_cost: number }>();

  // Resolve a Xero ContactID for this PO's supplier.
  // 1. Best case — local supplier row already has xero_contact_id (synced earlier).
  // 2. Fallback — search Xero by name (exact, then Contains) and cache the ID.
  // 3. Failure — clear instruction; Xero won't accept Name alone.
  const supplierRow = await env.DB.prepare(
    "SELECT id, xero_contact_id FROM suppliers WHERE lower(name) = lower(?)",
  )
    .bind(po.supplier)
    .first<{ id: number; xero_contact_id: string | null }>();

  let contactId: string | null = supplierRow?.xero_contact_id ?? null;
  if (!contactId) {
    const found = await findContactByName(env, po.supplier);
    if (found) {
      contactId = found.ContactID;
      const now = new Date().toISOString();
      if (supplierRow) {
        await env.DB.prepare(
          "UPDATE suppliers SET xero_contact_id = ?, xero_last_synced_at = ? WHERE id = ?",
        ).bind(contactId, now, supplierRow.id).run();
      } else {
        // PO supplier wasn't in our register at all; create the row now so
        // we don't have to look it up again next time.
        await env.DB.prepare(
          `INSERT INTO suppliers (name, status, xero_contact_id, xero_last_synced_at, created_at, created_by)
           VALUES (?, 'approved', ?, ?, ?, 'auto-xero-link')`,
        ).bind(found.Name ?? po.supplier, contactId, now, now).run();
      }
    }
  }

  if (!contactId) {
    throw new Error(
      `Supplier "${po.supplier}" wasn't found in Xero. Either add them as a Contact in Xero (Business → Contacts → New) and run "Sync from Xero" on the Approved Suppliers page, or rename them to match an existing Xero contact name.`,
    );
  }

  const dateOnly = po.created_at.split("T")[0];
  const payload: XeroPOInput = {
    Contact: { ContactID: contactId },
    Date: dateOnly,
    DeliveryDate: po.delivery_date ?? undefined,
    Reference: po.po_number,
    Status: "DRAFT",
    LineAmountTypes: "Exclusive",
    DeliveryAddress: po.project_delivery_address ?? `${po.project_code} — ${po.project_name}`,
    AttentionTo: po.project_site_contact_name ?? undefined,
    Telephone: po.project_site_contact_phone ?? undefined,
    DeliveryInstructions: po.project_delivery_instructions ?? undefined,
    LineItems: lines.results.map((l) => ({
      Description: l.manufacturer ? `${l.item} — ${l.manufacturer}` : l.item,
      Quantity: l.qty,
      UnitAmount: l.unit_cost,
      TaxType: "INPUT2", // UK 20% VAT input
    })),
  };

  const now = new Date().toISOString();
  try {
    const result = await createPurchaseOrder(env, payload);
    await env.DB.prepare(
      `UPDATE purchase_orders
         SET xero_po_id       = ?,
             xero_po_number   = ?,
             xero_synced_at   = ?,
             xero_sync_status = 'synced',
             xero_sync_error  = NULL
       WHERE id = ?`,
    )
      .bind(result.PurchaseOrderID, result.PurchaseOrderNumber, now, poId)
      .run();
    return { ok: true, xero_po_id: result.PurchaseOrderID, xero_po_number: result.PurchaseOrderNumber };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare(
      `UPDATE purchase_orders
         SET xero_synced_at = ?, xero_sync_status = 'failed', xero_sync_error = ?
       WHERE id = ?`,
    )
      .bind(now, msg, poId)
      .run();
    throw e;
  }
}
