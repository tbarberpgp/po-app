import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";
import { can } from "../../shared/permissions";
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
  createContact,
  updateContact,
  createPurchaseOrder,
  updatePurchaseOrder,
  createSalesInvoice,
  uploadAttachment,
  findContactByName,
  findProjectTracking,
  formatPaymentTerms,
  listAccounts,
  listSupplierContacts,
  resolveSalesTaxType,
} from "../xero/client";
import type { XeroContact, XeroPOInput, XeroInvoiceInput } from "../xero/client";
import { encryptToken } from "../xero/crypto";
import { recheckPaidStatus } from "../xero/paid";
import { isSandboxId } from "../sandbox";

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

// Chart-of-Accounts codes used when posting to Xero, stored in `settings`.
// Sales = revenue account for client invoices (required by Xero on AUTHORISED
// lines); PO/labour = optional expense accounts pre-coded onto pushed POs.
const ACCOUNT_FIELDS = {
  sales_account_code: "xero_sales_account_code",
  po_account_code: "xero_po_account_code",
  labour_account_code: "xero_labour_account_code",
  cis_account_code: "xero_cis_account_code",
} as const;

async function readAccountCodes(db: D1Database) {
  const rows = await db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('xero_sales_account_code','xero_po_account_code','xero_labour_account_code','xero_cis_account_code')",
  ).all<{ key: string; value: string }>();
  const m = new Map(rows.results.map((r) => [r.key, r.value]));
  return {
    sales_account_code: m.get("xero_sales_account_code") ?? null,
    po_account_code: m.get("xero_po_account_code") ?? null,
    labour_account_code: m.get("xero_labour_account_code") ?? null,
    cis_account_code: m.get("xero_cis_account_code") ?? null,
  };
}

/** Read a single settings value, trimmed; null when unset/blank. */
async function settingValue(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  const v = row?.value?.trim();
  return v ? v : null;
}

/** Xero wants the bare account code ("200"), not the dropdown label
 *  ("200 - SALES") — take the leading whitespace-delimited token. */
function accountCodeOnly(v: string | null | undefined): string | null {
  const c = (v ?? "").trim().split(/\s+/)[0];
  return c || null;
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
  // Only admins (approvers.manage) see tenant / scopes / connected-by detail;
  // every signed-in user still gets the configured/connected booleans the UI needs.
  const canSeeDetail = can(c.get("userRole"), "approvers.manage");
  return c.json({
    configured: !!config,
    connected: !!conn,
    connection: canSeeDetail ? (conn ?? null) : null,
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

    // Encrypt the tokens before they touch D1 (at-rest protection — see
    // xero/crypto.ts). listTenants above already used the plaintext token.
    const encAccess = await encryptToken(c.env, tokens.access_token);
    const encRefresh = await encryptToken(c.env, tokens.refresh_token);

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
        encAccess,
        encRefresh,
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

  // ── Two-way: push local edits UP first ───────────────────────────────
  // "Sync with Xero" writes each linked supplier's current details (incl. bank)
  // to its Xero contact, so local edits (e.g. bank details) reach Xero, then we
  // pull anything new down. Best-effort per supplier — a failure on one doesn't
  // abort the sync.
  let pushed = 0;
  const pushFailures: string[] = [];
  const linked = await c.env.DB.prepare(
    `SELECT id, name, xero_contact_id, contact_name, contact_email, contact_phone, address, vat_number,
            bank_sort_code, bank_account_number
       FROM suppliers WHERE xero_contact_id IS NOT NULL AND xero_contact_id != ''`,
  ).all<{
    id: number; name: string; xero_contact_id: string; contact_name: string | null;
    contact_email: string | null; contact_phone: string | null; address: string | null;
    vat_number: string | null; bank_sort_code: string | null; bank_account_number: string | null;
  }>();
  for (const s of linked.results) {
    try {
      await updateContact(c.env, s.xero_contact_id, {
        name: s.name, contactName: s.contact_name, email: s.contact_email, phone: s.contact_phone,
        address: s.address, vatNumber: s.vat_number,
        bankSortCode: s.bank_sort_code, bankAccountNumber: s.bank_account_number,
      });
      pushed += 1;
    } catch (e) {
      pushFailures.push(`${s.name}: ${e instanceof Error ? e.message : "push failed"}`);
    }
  }

  // ── Pull DOWN from Xero ───────────────────────────────────────────────
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

  return c.json({ created, updated, skipped, total_from_xero: contacts.length, pushed, push_failed: pushFailures });
});

/** Ensure a supplier (by name) exists as a Xero contact and is linked locally.
 *  Re-uses an existing Xero contact of the same name, else creates one, then
 *  caches the ContactID on the local suppliers row (creating that row if it's
 *  somehow absent). Returns the ContactID, or null if Xero isn't configured.
 *  Throws if Xero is configured but the API call fails — callers wanting
 *  best-effort behaviour (e.g. on supplier create) should catch. */
export async function ensureXeroContact(env: Env, name: string): Promise<string | null> {
  const n = (name ?? "").trim();
  if (!n) return null;
  if (notConfigured(env)) return null;
  const row = await env.DB.prepare(
    `SELECT id, xero_contact_id, contact_name, contact_email, contact_phone, address, vat_number,
            bank_sort_code, bank_account_number
       FROM suppliers WHERE lower(name) = lower(?)`,
  ).bind(n).first<{
    id: number; xero_contact_id: string | null; contact_name: string | null;
    contact_email: string | null; contact_phone: string | null; address: string | null; vat_number: string | null;
    bank_sort_code: string | null; bank_account_number: string | null;
  }>();
  if (row?.xero_contact_id) return row.xero_contact_id;

  const found = await findContactByName(env, n);
  const contact = found ?? await createContact(env, {
    name: n,
    contactName: row?.contact_name ?? null,
    email: row?.contact_email ?? null,
    phone: row?.contact_phone ?? null,
    address: row?.address ?? null,
    vatNumber: row?.vat_number ?? null,
    bankSortCode: row?.bank_sort_code ?? null,
    bankAccountNumber: row?.bank_account_number ?? null,
  });
  const now = new Date().toISOString();
  if (row) {
    await env.DB.prepare("UPDATE suppliers SET xero_contact_id = ?, xero_last_synced_at = ? WHERE id = ?")
      .bind(contact.ContactID, now, row.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO suppliers (name, status, xero_contact_id, xero_last_synced_at, created_at, created_by)
         VALUES (?, 'approved', ?, ?, ?, 'auto-xero-link')
       ON CONFLICT(name) DO UPDATE SET xero_contact_id = excluded.xero_contact_id, xero_last_synced_at = excluded.xero_last_synced_at`,
    ).bind(n, contact.ContactID, now, now).run();
  }
  return contact.ContactID;
}

/* ── Push a single supplier INTO Xero (create the contact) ─────────── */

xero.post("/push-supplier/:id", async (c) => {
  // Managing the supplier register (incl. pushing to Xero) is suppliers.manage —
  // which Commercial holds — not approvers.manage (PO sign-off).
  const denied = requirePermission(c, "suppliers.manage");
  if (denied) return denied;
  const nc = notConfigured(c.env);
  if (nc) return nc;

  const id = Number(c.req.param("id"));
  const sup = await c.env.DB.prepare(
    `SELECT id, name, xero_contact_id, contact_name, contact_email, contact_phone, address, vat_number,
            bank_sort_code, bank_account_number
       FROM suppliers WHERE id = ?`,
  ).bind(id).first<{
    id: number; name: string; xero_contact_id: string | null;
    contact_name: string | null; contact_email: string | null; contact_phone: string | null;
    address: string | null; vat_number: string | null;
    bank_sort_code: string | null; bank_account_number: string | null;
  }>();
  if (!sup) return c.json({ error: "supplier not found" }, 404);

  const contactInput = {
    name: sup.name,
    contactName: sup.contact_name,
    email: sup.contact_email,
    phone: sup.contact_phone,
    address: sup.address,
    vatNumber: sup.vat_number,
    bankSortCode: sup.bank_sort_code,
    bankAccountNumber: sup.bank_account_number,
  };
  const now = new Date().toISOString();
  try {
    // (Re-)push syncs the supplier's current details (incl. bank) to Xero:
    //  - already linked → update that contact;
    //  - a contact with this name exists → link to it AND update its details;
    //  - otherwise create it. So re-pushing an already-linked supplier now
    //    pushes bank info that wasn't sent on the first create.
    let contact;
    let created = false;
    if (sup.xero_contact_id) {
      contact = await updateContact(c.env, sup.xero_contact_id, contactInput);
    } else {
      const existing = await findContactByName(c.env, sup.name);
      if (existing) contact = await updateContact(c.env, existing.ContactID, contactInput);
      else { contact = await createContact(c.env, contactInput); created = true; }
    }
    await c.env.DB.prepare(
      "UPDATE suppliers SET xero_contact_id = ?, xero_last_synced_at = ? WHERE id = ?",
    ).bind(contact.ContactID, now, id).run();
    return c.json({ ok: true, created, synced: true, xero_contact_id: contact.ContactID, name: contact.Name });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Xero push failed" }, 502);
  }
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
    if ("skipped" in result) {
      return c.json({ ok: true, skipped: true, message: "Framework agreements aren't pushed to Xero — push the individual call-offs raised against this framework instead." });
    }
    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
});

/** This period's CIS-liable labour for a certificate: certified net less this
 *  period's expense movement (expense-section lines sit outside CIS). Exported
 *  so the certificate view shows the same deduction the Xero bill will carry. */
export async function cisLabourBase(
  env: Env,
  afp: { id: number; project_id: string; app_number: number; counterparty_supplier_id: number | null },
  net: number,
): Promise<number> {
  const certExpr = "COALESCE(contract_value,0) * COALESCE(certified_percent, percent_complete, 0) / 100.0";
  const expenseWhere = "(lower(COALESCE(section,'')) LIKE '%expense%' OR category = 'expenses')";
  try {
    const cur = await env.DB.prepare(
      `SELECT COALESCE(SUM(${certExpr}),0) AS v FROM afp_lines WHERE afp_id = ? AND ${expenseWhere}`,
    ).bind(afp.id).first<{ v: number }>();
    const prev = await env.DB.prepare(
      `SELECT COALESCE(SUM(${certExpr}),0) AS v FROM afp_lines
        WHERE ${expenseWhere} AND afp_id = (
          SELECT id FROM applications_for_payment
           WHERE project_id = ? AND direction = 'incoming_labour'
             AND counterparty_supplier_id IS ? AND app_number < ?
             AND status IN ('certified','paid')
           ORDER BY app_number DESC LIMIT 1)`,
    ).bind(afp.project_id, afp.counterparty_supplier_id, afp.app_number).first<{ v: number }>();
    const expensesThisPeriod = Math.max(0, (cur?.v ?? 0) - (prev?.v ?? 0));
    return Math.max(0, net - expensesThisPeriod);
  } catch {
    // Lines unavailable — deduct on the full net rather than skipping CIS.
    return net;
  }
}

/** Push a certified labour certificate to Xero as a live bill to the subbie. */
xero.post("/push-afp/:id", async (c) => {
  const denied = requirePermission(c, "pos.push_to_xero");
  if (denied) return denied;
  const nc = notConfigured(c.env);
  if (nc) return nc;
  try {
    const result = await pushAfpToXero(c.env, Number(c.req.param("id")));
    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
});

/** Create a live (AUTHORISED) ACCREC sales invoice for a certified client
 *  application, tagged to the matching Xero project tracking option. */
xero.post("/push-invoice/:id", async (c) => {
  const denied = requirePermission(c, "pos.push_to_xero");
  if (denied) return denied;
  const nc = notConfigured(c.env);
  if (nc) return nc;
  try {
    const result = await pushAfpInvoiceToXero(c.env, Number(c.req.param("id")));
    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
});

/** Read / write the Xero sales (revenue) account code used when raising client
 *  invoices. Stored in the settings table; an account code is required by Xero
 *  on every AUTHORISED invoice line. */
xero.get("/invoice-config", async (c) => {
  const denied = requirePermission(c, "pos.push_to_xero");
  if (denied) return denied;
  return c.json(await readAccountCodes(c.env.DB));
});

xero.post("/invoice-config", async (c) => {
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;
  type AccountBody = Partial<Record<keyof typeof ACCOUNT_FIELDS, string>>;
  const body = await c.req.json<AccountBody>().catch(() => ({} as AccountBody));
  // Only touch the codes actually supplied; blank clears that one.
  for (const [field, key] of Object.entries(ACCOUNT_FIELDS) as Array<[keyof typeof ACCOUNT_FIELDS, string]>) {
    if (!(field in body)) continue;
    const code = accountCodeOnly(body[field]) ?? "";
    if (!code) {
      await c.env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
    } else {
      await c.env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).bind(key, code).run();
    }
  }
  return c.json(await readAccountCodes(c.env.DB));
});

/** Live chart of accounts from Xero, to populate the Admin account-code selects.
 *  Degrades gracefully (200 + empty list + reason) so the UI can fall back to a
 *  free-text code box when Xero isn't connected or the call fails. */
xero.get("/accounts", async (c) => {
  const denied = requirePermission(c, "approvers.manage");
  if (denied) return denied;
  try {
    return c.json({ accounts: await listAccounts(c.env) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ accounts: [], error: msg === "not_connected" ? "not_connected" : msg });
  }
});

/** Manual backstop for missed webhooks — re-pull paid status from Xero for our
 *  invoiced client applications (by id) and recently-paid supplier bills (by
 *  Reference). Returns how many were checked / newly marked paid. */
xero.post("/recheck-paid", async (c) => {
  const denied = requirePermission(c, "pos.push_to_xero");
  if (denied) return denied;
  const nc = notConfigured(c.env);
  if (nc) return nc;
  try {
    return c.json(await recheckPaidStatus(c.env));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/** How many approved/issued POs aren't yet successfully in Xero. Used by the
 *  PO list page to show a count + bulk-push affordance. */
xero.get("/pending-count", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n
     FROM purchase_orders
     WHERE status IN ('approved', 'issued')
       AND (xero_po_id IS NULL OR xero_sync_status = 'failed')
       AND COALESCE(order_type, 'standard') != 'framework'
       AND project_id != 'sandbox'`,
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
       AND COALESCE(order_type, 'standard') != 'framework'
       AND project_id != 'sandbox'
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
      if ("skipped" in res) continue; // frameworks aren't pushed (also excluded from the query above)
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
// POs are now reconciled in-app (invoice ⇄ PO ⇄ delivery 3-way match); Xero only
// receives approved supplier invoices for payment. Flip this to re-enable the
// legacy PO push if ever needed.
const PUSH_POS_TO_XERO = false;

export async function pushPOToXero(env: Env, poId: string): Promise<
  | { ok: true; xero_po_id: string; xero_po_number: string }
  | { ok: true; skipped: true; reason: string }
> {
  if (!PUSH_POS_TO_XERO) {
    return { ok: true, skipped: true, reason: "PO push to Xero is retired — POs are reconciled in-app; only approved invoices are pushed to Xero for payment." };
  }
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
      id: string; project_id: string; po_number: string; supplier: string; total_value: number;
      notes: string | null; delivery_date: string | null; created_at: string;
      status: string; xero_po_id: string | null;
      project_code: string; project_name: string;
      project_delivery_address: string | null;
      project_site_contact_name: string | null;
      project_site_contact_phone: string | null;
      project_delivery_instructions: string | null;
      order_type: string | null;
    }>();
  if (!po) throw new Error("PO not found");
  // Sandbox/demo project: never write to the live Xero org. Reported as skipped
  // so the demo "push" still succeeds in-app without creating a real PO.
  if (isSandboxId(po.project_id)) return { ok: true, skipped: true, reason: "sandbox" };
  // Framework POs are agreements/reservations, not orders a supplier invoices
  // against — pushing one would create a phantom Xero PO and double-count the
  // call-offs drawn from it. The call-offs are the real orders and push as usual.
  if (po.order_type === "framework") return { ok: true, skipped: true, reason: "framework" };
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
  // Link to (or CREATE) the supplier's Xero contact and cache the id. Creating
  // it on the fly means a supplier made in-app no longer blocks its PO push.
  let contactId: string | null;
  try {
    contactId = await ensureXeroContact(env, po.supplier);
  } catch (e) {
    throw new Error(`Couldn't add supplier "${po.supplier}" to Xero: ${e instanceof Error ? e.message : "Xero error"}`);
  }
  if (!contactId) {
    throw new Error(`Xero isn't connected — connect it (Admin → Xero) before pushing "${po.supplier}".`);
  }

  const dateOnly = po.created_at.split("T")[0];
  const poAccount = accountCodeOnly(await settingValue(env.DB, "xero_po_account_code")); // optional expense account
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
      ...(poAccount ? { AccountCode: poAccount } : {}),
    })),
  };

  const now = new Date().toISOString();
  try {
    // Already linked → update that Xero PO in place (an amend re-syncs rather
    // than creating a duplicate); otherwise create a fresh draft.
    const result = po.xero_po_id
      ? await updatePurchaseOrder(env, po.xero_po_id, payload)
      : await createPurchaseOrder(env, payload);
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

/**
 * Push a certified incoming-labour AfP (a payment certificate) to Xero as a
 * DRAFT ACCPAY BILL addressed to the subcontractor — the "approve for payment"
 * step is the go-ahead, and the accountant authorises the draft in Xero (it no
 * longer lands straight in the pay run). The bill line is the certified amount
 * due ex-VAT (this period, after retention); Xero computes the VAT from the tax
 * type, and the source application PDF is attached if one was uploaded. Stores
 * the Xero cross-reference on the AfP. Called from /push-afp/:id once the
 * certificate has been approved for payment.
 */
export async function pushAfpToXero(env: Env, afpId: number): Promise<
  | { ok: true; xero_po_id: string; xero_po_number: string }
  | { ok: true; skipped: true; reason: string }
> {
  const afp = await env.DB.prepare(
    `SELECT a.id, a.project_id, a.app_number, a.direction, a.status, a.period_end, a.vat_pct,
            a.amount_due, a.certified_amount, a.counterparty_supplier_id,
            a.pay_approved_at, a.source_file_key, a.source_file_name, a.source_file_type,
            a.xero_po_id, a.xero_po_number,
            p.code AS project_code, p.name AS project_name
     FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
     WHERE a.id = ?`,
  ).bind(afpId).first<{
    id: number; project_id: string; app_number: number; direction: string; status: string;
    period_end: string; vat_pct: number; amount_due: number | null;
    certified_amount: number | null; counterparty_supplier_id: number | null;
    pay_approved_at: string | null; source_file_key: string | null;
    source_file_name: string | null; source_file_type: string | null;
    xero_po_id: string | null; xero_po_number: string | null;
    project_code: string; project_name: string;
  }>();
  if (!afp) throw new Error("Application not found");
  // Sandbox/demo project never writes to the live Xero org (return, not a failure).
  if (isSandboxId(afp.project_id)) return { ok: true, skipped: true, reason: "sandbox" };

  // Wrap EVERYTHING (validation + the Xero call) so ANY failure is recorded on
  // the certificate as xero_sync_status='failed' with the reason — including the
  // early checks like an unmatched subbie contact. Otherwise those throws were
  // swallowed to a console warning on the auto-push-at-certify path, leaving the
  // certificate looking un-pushed with no visible reason and no retry prompt.
  const now = new Date().toISOString();
  try {
    if (afp.direction !== "incoming_labour") throw new Error("Only labour certificates push to Xero as bills");
    if (afp.status !== "certified" && afp.status !== "paid") throw new Error("Only certified labour certificates can be pushed");
    if (!afp.pay_approved_at) throw new Error("Approve this labour certificate for payment before pushing to Xero");
    if (!afp.counterparty_supplier_id) throw new Error("Assign the subcontractor before pushing to Xero");
    if (afp.xero_po_id) {
      throw new Error(`This certificate is already in Xero as bill ${afp.xero_po_number ?? afp.xero_po_id} — void that bill in Xero first if you need to re-push.`);
    }

    const net = afp.certified_amount ?? afp.amount_due ?? 0;
    if (net <= 0) throw new Error("Nothing to push — the certified amount is zero");

    // Resolve the subbie's Xero contact (same approach as the PO push).
    const supplierRow = await env.DB.prepare(
      "SELECT id, name, xero_contact_id, cis_rate FROM suppliers WHERE id = ?",
    ).bind(afp.counterparty_supplier_id).first<{ id: number; name: string; xero_contact_id: string | null; cis_rate: number | null }>();
    if (!supplierRow) throw new Error("Subcontractor not found");

    let contactId: string | null = supplierRow.xero_contact_id ?? null;
    if (!contactId) {
      const found = await findContactByName(env, supplierRow.name);
      if (found) {
        contactId = found.ContactID;
        await env.DB.prepare("UPDATE suppliers SET xero_contact_id = ?, xero_last_synced_at = ? WHERE id = ?")
          .bind(contactId, new Date().toISOString(), supplierRow.id).run();
      }
    }
    if (!contactId) {
      throw new Error(
        `Subcontractor "${supplierRow.name}" wasn't found in Xero. Add them as a Contact in Xero (Business → Contacts → New) and run "Sync from Xero" on the Approved Suppliers page, or rename them to match an existing Xero contact name.`,
      );
    }

    // Push as a DRAFT ACCPAY bill (not straight into the pay run): the app's
    // "approve for payment" step is the go-ahead, and the accountant authorises
    // the draft in Xero. Code it to the configured labour expense account so the
    // draft lands fully coded (Admin → Xero).
    const labourAccount = accountCodeOnly(await settingValue(env.DB, "xero_labour_account_code"));
    if (!labourAccount) {
      throw new Error("Set a Xero labour account code in Admin → Xero before pushing labour bills so the draft bill is coded to an expense account.");
    }
    // CIS: the subcontractor's deduction rate applies to the labour element of
    // this period's certified net (expense lines are outside CIS). Shown as a
    // negative line so the draft bill nets to the amount actually payable.
    const cisRate = supplierRow.cis_rate != null && supplierRow.cis_rate > 0 ? supplierRow.cis_rate : 0;
    let cisAmount = 0;
    let cisAccount: string | null = null;
    if (cisRate > 0) {
      cisAccount = accountCodeOnly(await settingValue(env.DB, "xero_cis_account_code"));
      if (!cisAccount) {
        throw new Error(`${supplierRow.name} has a ${cisRate}% CIS rate — set a Xero CIS deduction account code in Admin → Xero before pushing their bills.`);
      }
      const base = await cisLabourBase(env, afp, net);
      cisAmount = Math.round(base * cisRate) / 100;
    }

    // Net 30 from today: a sensible default for a subcontractor payment; the
    // due date can be adjusted on the bill in Xero if terms differ.
    const dueDate = new Date(Date.now() + 30 * 86_400_000).toISOString().split("T")[0];
    const payload: XeroInvoiceInput = {
      Type: "ACCPAY",
      Contact: { ContactID: contactId },
      Date: new Date().toISOString().split("T")[0],
      DueDate: dueDate,
      Reference: `${afp.project_code} Labour Cert #${afp.app_number}`,
      Status: "DRAFT",
      LineAmountTypes: "Exclusive",
      LineItems: [
        {
          Description: `Labour certificate #${afp.app_number} — ${afp.project_code} ${afp.project_name} — period ending ${afp.period_end}`,
          Quantity: 1,
          UnitAmount: net,
          AccountCode: labourAccount,
          TaxType: afp.vat_pct === 0 ? "NONE" : "INPUT2",
        },
        // CIS is deducted from the payment, not the VATable value — VAT (if
        // any) stays calculated on the full labour line above.
        ...(cisAmount > 0 ? [{
          Description: `CIS deduction @ ${cisRate}% (labour element)`,
          Quantity: 1,
          UnitAmount: -cisAmount,
          AccountCode: cisAccount!,
          TaxType: "NONE",
        }] : []),
      ],
    };

    // Bills and sales invoices share Xero's /Invoices endpoint; the Type field
    // makes this a payable. Store the invoice ref in the existing xero_po_*
    // columns (the AfP's single "labour push" slot).
    const result = await createSalesInvoice(env, payload);
    // DRAFT bills come back with no InvoiceNumber — bind null, not undefined
    // (D1 rejects undefined, which used to fail HERE, after the bill already
    // existed in Xero, leaving an orphaned draft and a 'failed' status).
    await env.DB.prepare(
      `UPDATE applications_for_payment
         SET xero_po_id = ?, xero_po_number = ?, xero_synced_at = ?,
             xero_sync_status = 'synced', xero_sync_error = NULL
       WHERE id = ?`,
    ).bind(result.InvoiceID ?? null, result.InvoiceNumber ?? null, now, afpId).run();

    // Ride the source application document (if one was uploaded) to the bill so
    // the accountant sees the original. Best-effort — needs accounting.attachments.
    if (afp.source_file_key) {
      try {
        const obj = await env.R2.get(afp.source_file_key);
        if (obj) {
          await uploadAttachment(env, "Invoices", result.InvoiceID,
            afp.source_file_name || `labour-cert-${afp.app_number}.pdf`,
            afp.source_file_type || "application/pdf", await obj.arrayBuffer());
        }
      } catch (e) {
        console.warn(`Xero attachment for AfP ${afpId} failed:`, e instanceof Error ? e.message : e);
      }
    }
    return { ok: true, xero_po_id: result.InvoiceID, xero_po_number: result.InvoiceNumber };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare(
      `UPDATE applications_for_payment
         SET xero_synced_at = ?, xero_sync_status = 'failed', xero_sync_error = ?
       WHERE id = ?`,
    ).bind(now, msg, afpId).run();
    throw e;
  }
}

/**
 * Create a live (AUTHORISED) ACCREC sales invoice in Xero for a certified
 * OUTGOING client application. The invoice is addressed to the project's
 * client contact, valued at the certified amount due ex-VAT (Xero adds the VAT
 * from the tax type), and tagged to the Xero project via the tracking option
 * whose name matches the project code (auto-matched). Stores the Xero invoice
 * cross-reference on the AfP. Called by /push-invoice/:id.
 */
export async function pushAfpInvoiceToXero(env: Env, afpId: number): Promise<
  | { ok: true; xero_invoice_id: string; xero_invoice_number: string; tracked: boolean }
  | { ok: true; skipped: true; reason: string }
> {
  const afp = await env.DB.prepare(
    `SELECT a.id, a.project_id, a.app_number, a.direction, a.status, a.period_end, a.vat_pct,
            a.amount_due, a.certified_amount,
            p.code AS project_code, p.name AS project_name, p.client AS project_client
     FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
     WHERE a.id = ?`,
  ).bind(afpId).first<{
    id: number; project_id: string; app_number: number; direction: string; status: string;
    period_end: string; vat_pct: number; amount_due: number | null;
    certified_amount: number | null;
    project_code: string; project_name: string; project_client: string | null;
  }>();
  if (!afp) throw new Error("Application not found");
  // Sandbox/demo project never writes to the live Xero org.
  if (isSandboxId(afp.project_id)) return { ok: true, skipped: true, reason: "sandbox" };
  if (afp.direction !== "outgoing") throw new Error("Only client applications are invoiced to Xero");
  if (afp.status !== "certified" && afp.status !== "paid") {
    throw new Error("Only certified client applications can be invoiced");
  }
  if (!afp.project_client) {
    throw new Error("This project has no client set — add the client name on the project before invoicing.");
  }

  const net = afp.certified_amount ?? afp.amount_due ?? 0;
  if (net <= 0) throw new Error("Nothing to invoice — the certified amount is zero");

  // Sales/revenue account code (Xero requires one on every AUTHORISED line).
  const acctRow = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'xero_sales_account_code'",
  ).first<{ value: string }>();
  const accountCode = accountCodeOnly(acctRow?.value);
  if (!accountCode) {
    throw new Error(
      "Set the Xero sales account code first (Admin → Xero integration). Xero requires a revenue account on every invoice line.",
    );
  }

  // Resolve the client's Xero contact by name.
  const found = await findContactByName(env, afp.project_client);
  if (!found) {
    throw new Error(
      `Client "${afp.project_client}" wasn't found in Xero. Add them as a Contact in Xero (Business → Contacts → New), or rename the project's client to match an existing Xero contact name.`,
    );
  }

  // Auto-match the Xero project tracking option by project code (best-effort).
  // Requires the accounting.settings scope; if the connection wasn't granted it
  // (or the lookup fails), skip tracking rather than block the whole invoice.
  let tracking: { Name: string; Option: string } | null = null;
  try {
    tracking = await findProjectTracking(env, afp.project_code);
  } catch (e) {
    console.warn("Xero tracking lookup skipped:", e instanceof Error ? e.message : e);
  }

  // DueDate = the application's contractual final date for payment, taken from
  // the uploaded valuation schedule (entry_type 'final_payment' for this app
  // number). Falls back to Net 30 from today if the schedule has no entry.
  let dueDate = new Date(Date.now() + 30 * 86_400_000).toISOString().split("T")[0];
  if (afp.app_number != null) {
    const f = await env.DB.prepare(
      `SELECT date FROM valuation_schedule_entries
        WHERE project_id = ? AND app_number = ? AND entry_type = 'final_payment'
        ORDER BY date DESC LIMIT 1`,
    ).bind(afp.project_id, afp.app_number).first<{ date: string }>();
    if (f?.date) dueDate = f.date.slice(0, 10);
  }

  // Client-invoice VAT follows the project's VAT selection (afp.vat_pct, copied
  // from the project's client_vat_pct). In this app the "0%" option means CIS
  // Domestic Reverse Charge — NOT "no VAT" — so it must post under the org's
  // reverse-charge tax type. resolveSalesTaxType auto-detects the right output
  // tax type from the org's own Xero tax rates (20% → OUTPUT2; 0% → the
  // reverse-charge income rate; etc.). The fallback only ever applies if the
  // accounting.settings scope isn't granted, so invoicing is never blocked.
  let lineTaxType = await resolveSalesTaxType(env, afp.vat_pct);
  if (!lineTaxType) lineTaxType = afp.vat_pct === 0 ? "NONE" : "OUTPUT2";

  const payload: XeroInvoiceInput = {
    Type: "ACCREC",
    Contact: { ContactID: found.ContactID },
    Date: new Date().toISOString().split("T")[0],
    DueDate: dueDate,
    Reference: `${afp.project_code} Application #${afp.app_number}`,
    Status: "AUTHORISED",
    LineAmountTypes: "Exclusive",
    LineItems: [{
      Description: `Application for payment #${afp.app_number} — ${afp.project_code} ${afp.project_name} — period ending ${afp.period_end}`,
      Quantity: 1,
      UnitAmount: net,
      AccountCode: accountCode,
      TaxType: lineTaxType,
      ...(tracking ? { Tracking: [tracking] } : {}),
    }],
  };

  const now = new Date().toISOString();
  try {
    const result = await createSalesInvoice(env, payload);
    await env.DB.prepare(
      `UPDATE applications_for_payment
         SET xero_invoice_id = ?, xero_invoice_number = ?, xero_invoice_synced_at = ?,
             xero_invoice_status = 'synced', xero_invoice_error = NULL
       WHERE id = ?`,
    ).bind(result.InvoiceID ?? null, result.InvoiceNumber ?? null, now, afpId).run();
    return { ok: true, xero_invoice_id: result.InvoiceID, xero_invoice_number: result.InvoiceNumber, tracked: !!tracking };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare(
      `UPDATE applications_for_payment
         SET xero_invoice_synced_at = ?, xero_invoice_status = 'failed', xero_invoice_error = ?
       WHERE id = ?`,
    ).bind(now, msg, afpId).run();
    throw e;
  }
}
