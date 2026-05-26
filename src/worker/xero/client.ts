// Thin wrapper around the Xero Accounting API. Auto-refreshes access tokens
// from the stored refresh_token when needed. One connection per organisation
// (single-tenant install).

import type { Env } from "../env";
import { expiresAtFromNow, refreshTokens } from "./oauth";

export type XeroConnectionRow = {
  id: number;
  tenant_id: string;
  tenant_name: string | null;
  tenant_type: string | null;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scopes: string | null;
  connected_at: string;
  connected_by: string;
};

/**
 * Load the active connection, refreshing the access token if it's within 60s of
 * expiry (or already expired). Returns the (possibly updated) row so callers
 * can use access_token + tenant_id directly. Throws if no connection exists.
 */
export async function getValidConnection(env: Env): Promise<XeroConnectionRow> {
  const conn = await env.DB.prepare("SELECT * FROM xero_connection LIMIT 1")
    .first<XeroConnectionRow>();
  if (!conn) throw new Error("not_connected");

  const expiresMs = new Date(conn.expires_at).getTime();
  const needsRefresh = expiresMs < Date.now() + 60_000;
  if (!needsRefresh) return conn;

  try {
    const fresh = await refreshTokens(env, conn.refresh_token);
    const newExpiresAt = expiresAtFromNow(fresh.expires_in);
    await env.DB.prepare(
      "UPDATE xero_connection SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ?",
    )
      .bind(fresh.access_token, fresh.refresh_token, newExpiresAt, conn.id)
      .run();
    return { ...conn, access_token: fresh.access_token, refresh_token: fresh.refresh_token, expires_at: newExpiresAt };
  } catch (e) {
    // Refresh failures usually mean the refresh_token was revoked or the
    // user disconnected the app from inside Xero. Surface a clear message.
    throw new Error(`xero_refresh_failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const API_BASE = "https://api.xero.com/api.xro/2.0";

async function xeroFetch(conn: XeroConnectionRow, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${conn.access_token}`,
      "Xero-tenant-id": conn.tenant_id,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Xero ${method} ${path} → ${res.status}: ${extractXeroError(txt)}`);
  }
  return res.json();
}

/**
 * Pull the useful bit out of a Xero error response. Xero returns deeply
 * nested validation errors like:
 *   { Elements: [ { ValidationErrors: [ { Message: "..." } ] } ] }
 * The raw JSON is huge and the actionable text is buried. Returns a
 * concatenated, human-readable error string.
 */
function extractXeroError(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody);

    // Validation exceptions on collection endpoints (most common shape)
    const validationMessages: string[] = [];
    const elements = Array.isArray(parsed?.Elements) ? parsed.Elements : [];
    for (const el of elements) {
      const errs = Array.isArray(el?.ValidationErrors) ? el.ValidationErrors : [];
      for (const e of errs) if (e?.Message) validationMessages.push(String(e.Message));
      // Sometimes line-level errors nest inside LineItems
      const lines = Array.isArray(el?.LineItems) ? el.LineItems : [];
      for (const ln of lines) {
        const lnErrs = Array.isArray(ln?.ValidationErrors) ? ln.ValidationErrors : [];
        for (const e of lnErrs) if (e?.Message) validationMessages.push(`Line: ${String(e.Message)}`);
      }
    }
    if (validationMessages.length > 0) return validationMessages.join(" · ");

    // Generic Message field
    if (typeof parsed?.Message === "string") return parsed.Message;
    if (typeof parsed?.detail === "string") return parsed.detail;
    if (typeof parsed?.error === "string") return parsed.error;
  } catch {
    /* not JSON */
  }
  return rawBody.slice(0, 600);
}

/* ── Contacts (suppliers) ───────────────────────────────────────────── */

export type XeroContact = {
  ContactID: string;
  Name: string;
  EmailAddress?: string;
  FirstName?: string;
  LastName?: string;
  Phones?: Array<{ PhoneType: string; PhoneNumber: string; PhoneAreaCode?: string }>;
  Addresses?: Array<{ AddressType: string; AddressLine1?: string; City?: string; PostalCode?: string; Country?: string }>;
  TaxNumber?: string;
  IsSupplier?: boolean;
  IsCustomer?: boolean;
  ContactStatus?: string;
  AccountsPayableTaxType?: string;
  PaymentTerms?: { Bills?: { Day?: number; Type?: string } };
};

/** Fetch all supplier contacts. Paginated by `page=` (100 per page). */
export async function listSupplierContacts(env: Env): Promise<XeroContact[]> {
  const conn = await getValidConnection(env);
  const all: XeroContact[] = [];
  for (let page = 1; page < 50; page++) {
    const body = await xeroFetch(conn, "GET", `/Contacts?where=IsSupplier==true&page=${page}`) as { Contacts?: XeroContact[] };
    const batch = body.Contacts ?? [];
    all.push(...batch);
    if (batch.length < 100) break; // last page
  }
  return all;
}

/* ── Purchase Orders ────────────────────────────────────────────────── */

export type XeroPOLine = {
  Description: string;
  Quantity: number;
  UnitAmount: number;
  TaxType?: string;        // e.g. INPUT2 for 20% VAT in the UK
  AccountCode?: string;    // optional Chart-of-Accounts code
  ItemCode?: string;
  Tracking?: Array<{ Name: string; Option: string }>;
};

export type XeroPOInput = {
  Contact: { ContactID?: string; Name?: string };
  Date: string;          // YYYY-MM-DD
  DeliveryDate?: string;
  DeliveryAddress?: string;
  Reference?: string;     // our PO number — shows on Xero PO for cross-ref
  Status?: "DRAFT" | "SUBMITTED" | "AUTHORISED";
  LineAmountTypes?: "Exclusive" | "Inclusive" | "NoTax";
  LineItems: XeroPOLine[];
  AttentionTo?: string;
  Telephone?: string;
  DeliveryInstructions?: string;
};

export type XeroPOResponse = {
  PurchaseOrderID: string;
  PurchaseOrderNumber: string;
  Status: string;
  Reference?: string;
  Total: number;
};

export async function createPurchaseOrder(env: Env, po: XeroPOInput): Promise<XeroPOResponse> {
  const conn = await getValidConnection(env);
  const body = await xeroFetch(conn, "POST", "/PurchaseOrders", { PurchaseOrders: [po] }) as {
    PurchaseOrders: XeroPOResponse[];
  };
  if (!body.PurchaseOrders?.[0]) throw new Error("Xero did not return a PurchaseOrder in the response");
  return body.PurchaseOrders[0];
}

/* ── Helpers ────────────────────────────────────────────────────────── */

/** Pull the trading address out of a Xero contact (first STREET or POBOX). */
export function contactAddressLine(c: XeroContact): string | null {
  const a = (c.Addresses ?? []).find((x) => x.AddressType === "STREET" || x.AddressType === "POBOX");
  if (!a) return null;
  return [a.AddressLine1, a.City, a.PostalCode, a.Country].filter(Boolean).join(", ");
}

/** Pull the default phone number from a Xero contact. */
export function contactPhone(c: XeroContact): string | null {
  const p = (c.Phones ?? []).find((x) => x.PhoneNumber);
  if (!p) return null;
  return [p.PhoneAreaCode, p.PhoneNumber].filter(Boolean).join(" ");
}

/** Format Xero PaymentTerms.Bills into "Net 30 days" style. */
export function formatPaymentTerms(c: XeroContact): string | null {
  const bills = c.PaymentTerms?.Bills;
  if (!bills?.Day || !bills.Type) return null;
  const t = bills.Type;
  const d = bills.Day;
  if (t === "DAYSAFTERBILLDATE") return `Net ${d} days`;
  if (t === "DAYSAFTERBILLMONTH") return `Net ${d} days EOM`;
  if (t === "OFCURRENTMONTH") return `${d} of current month`;
  if (t === "OFFOLLOWINGMONTH") return `${d} of following month`;
  return `${t} ${d}`;
}
