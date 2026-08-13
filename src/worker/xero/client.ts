// Thin wrapper around the Xero Accounting API. Auto-refreshes access tokens
// from the stored refresh_token when needed. One connection per organisation
// (single-tenant install).

import type { Env } from "../env";
import { expiresAtFromNow, refreshTokens } from "./oauth";
import { decryptToken, encryptToken } from "./crypto";

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

  // Decrypt the at-rest tokens in place so the rest of the code (and the row we
  // return) works with plaintext. A legacy pre-encryption row decrypts to
  // itself (dual-read) and gets re-stored encrypted on its next refresh.
  conn.access_token = await decryptToken(env, conn.access_token);
  conn.refresh_token = await decryptToken(env, conn.refresh_token);

  const expiresMs = new Date(conn.expires_at).getTime();
  if (expiresMs >= Date.now() + 60_000) return conn;

  try {
    return await forceRefresh(env, conn);
  } catch {
    // Refresh failures usually mean the refresh_token was revoked or the app
    // was disconnected from inside Xero — the connection must be re-authorised.
    throw new Error(XERO_RECONNECT_MESSAGE);
  }
}

/** Exchange the stored refresh_token for a fresh access token (regardless of the
 *  current token's expiry) and persist it. Used proactively near expiry and
 *  reactively when Xero 401s a token it invalidated before our recorded expiry. */
async function forceRefresh(env: Env, conn: XeroConnectionRow): Promise<XeroConnectionRow> {
  const fresh = await refreshTokens(env, conn.refresh_token);
  const newExpiresAt = expiresAtFromNow(fresh.expires_in);
  // Store encrypted; hand plaintext back to callers. This is also what migrates
  // a legacy plaintext row to ciphertext — the first refresh after deploy.
  await env.DB.prepare(
    "UPDATE xero_connection SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ?",
  ).bind(
    await encryptToken(env, fresh.access_token),
    await encryptToken(env, fresh.refresh_token),
    newExpiresAt,
    conn.id,
  ).run();
  return { ...conn, access_token: fresh.access_token, refresh_token: fresh.refresh_token, expires_at: newExpiresAt };
}

const API_BASE = "https://api.xero.com/api.xro/2.0";

/** When a refresh can't recover the connection, callers surface this verbatim. */
export const XERO_RECONNECT_MESSAGE =
  "Xero needs reconnecting — an admin can do this at Admin → Xero (Disconnect, then Connect).";

async function xeroFetch(
  env: Env,
  conn: XeroConnectionRow,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
) {
  const send = (token: string) => fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Xero-tenant-id": conn.tenant_id,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let res = await send(conn.access_token);
  // 401 = Xero rejected the access token (it can invalidate one before our
  // recorded expiry). Force a refresh and retry once; if that can't recover,
  // the connection genuinely needs re-authorising.
  if (res.status === 401) {
    let refreshed: XeroConnectionRow;
    try {
      refreshed = await forceRefresh(env, conn);
    } catch {
      throw new Error(XERO_RECONNECT_MESSAGE);
    }
    res = await send(refreshed.access_token);
    if (res.status === 401) throw new Error(XERO_RECONNECT_MESSAGE);
  }
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

/**
 * Attach a file to a Xero object (POST /{Endpoint}/{Guid}/Attachments/{FileName}).
 * Used to ride the source document — the supplier-invoice PDF or the labour
 * application — along with the bill so the accountant sees the original in Xero.
 * Sends a raw binary body, so it can't use xeroFetch (which JSON-encodes), but
 * reuses the same 401 → refresh → retry recovery. Requires the
 * `accounting.attachments` scope; call sites treat failures as non-fatal.
 */
export async function uploadAttachment(
  env: Env,
  endpoint: "Invoices" | "PurchaseOrders",
  guid: string,
  fileName: string,
  contentType: string,
  body: ArrayBuffer,
): Promise<void> {
  const conn = await getValidConnection(env);
  // Xero wants a plain filename with an extension; strip any path separators.
  const safeName = fileName.replace(/[\\/]/g, "_").slice(-200) || "document";
  const path = `/${endpoint}/${guid}/Attachments/${encodeURIComponent(safeName)}`;
  const send = (token: string) => fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Xero-tenant-id": conn.tenant_id,
      Accept: "application/json",
      "Content-Type": contentType || "application/octet-stream",
    },
    body,
  });
  let res = await send(conn.access_token);
  if (res.status === 401) {
    let refreshed: XeroConnectionRow;
    try { refreshed = await forceRefresh(env, conn); } catch { throw new Error(XERO_RECONNECT_MESSAGE); }
    res = await send(refreshed.access_token);
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Xero attach ${path} → ${res.status}: ${extractXeroError(txt)}`);
  }
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
    const body = await xeroFetch(env, conn, "GET", `/Contacts?where=IsSupplier==true&page=${page}`) as { Contacts?: XeroContact[] };
    const batch = body.Contacts ?? [];
    all.push(...batch);
    if (batch.length < 100) break; // last page
  }
  return all;
}

/**
 * Look up a single Xero contact by name. Tries an exact-name `where`
 * filter first, then falls back to a Contains search for "Alumasc Ltd"
 * vs "Alumasc"-style mismatches. Returns null when no match is found.
 */
export async function findContactByName(env: Env, name: string): Promise<XeroContact | null> {
  const conn = await getValidConnection(env);
  const safe = name.replace(/"/g, '\\"');

  // 1. Exact match — covers the common case where local name === Xero name.
  try {
    const body = await xeroFetch(
      env,
      conn,
      "GET",
      `/Contacts?where=${encodeURIComponent(`Name="${safe}"`)}`,
    ) as { Contacts?: XeroContact[] };
    if (body.Contacts && body.Contacts.length > 0) return body.Contacts[0];
  } catch { /* fall through to contains */ }

  // 2. Contains match — handles "Alumasc" ↔ "Alumasc Ltd" etc.
  try {
    const body = await xeroFetch(
      env,
      conn,
      "GET",
      `/Contacts?where=${encodeURIComponent(`Name.Contains("${safe}")`)}`,
    ) as { Contacts?: XeroContact[] };
    if (body.Contacts && body.Contacts.length > 0) return body.Contacts[0];
  } catch { /* ignore */ }

  return null;
}

/** Create a supplier contact in Xero from our register fields, returning the new
 *  contact (with its ContactID). Callers should check findContactByName first —
 *  Xero rejects a second contact with the same Name. */
export type XeroContactInput = {
  name: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  vatNumber?: string | null;
  bankSortCode?: string | null;
  bankAccountNumber?: string | null;
};

/** UK BACS: the writable BankAccountDetails field is a single free string, so
 *  combine sort code + account number (the structured BatchPayments object is
 *  read-only via the API). Returns null when there's nothing to push. */
function bankDetailsString(input: XeroContactInput): string | null {
  const s = [input.bankSortCode, input.bankAccountNumber].map((v) => (v ?? "").trim()).filter(Boolean).join(" ");
  return s || null;
}

function contactPayload(input: XeroContactInput): Record<string, unknown> {
  const parts = (input.contactName ?? "").trim().split(/\s+/).filter(Boolean);
  const bank = bankDetailsString(input);
  return {
    Name: input.name,
    ...(input.email ? { EmailAddress: input.email } : {}),
    ...(parts.length ? { FirstName: parts[0] } : {}),
    ...(parts.length > 1 ? { LastName: parts.slice(1).join(" ") } : {}),
    ...(input.phone ? { Phones: [{ PhoneType: "DEFAULT", PhoneNumber: input.phone }] } : {}),
    ...(input.address ? { Addresses: [{ AddressType: "STREET", AddressLine1: input.address }] } : {}),
    ...(input.vatNumber ? { TaxNumber: input.vatNumber } : {}),
    ...(bank ? { BankAccountDetails: bank } : {}),
  };
}

export async function createContact(env: Env, input: XeroContactInput): Promise<XeroContact> {
  const conn = await getValidConnection(env);
  // NB: IsSupplier is read-only in Xero — a contact only joins the Suppliers list
  // once a bill/PO is raised against it, so we don't bother sending it.
  const body = await xeroFetch(env, conn, "POST", "/Contacts", { Contacts: [contactPayload(input)] }) as { Contacts?: XeroContact[] };
  if (!body.Contacts?.[0]) throw new Error("Xero did not return the created contact");
  return body.Contacts[0];
}

/** Update an existing Xero contact (by ContactID) — a POST to /Contacts with a
 *  ContactID upserts. Used to sync details (incl. bank) onto a contact that was
 *  already created, so re-pushing a supplier pushes its latest bank/VAT/address. */
export async function updateContact(env: Env, contactId: string, input: XeroContactInput): Promise<XeroContact> {
  const conn = await getValidConnection(env);
  const body = await xeroFetch(env, conn, "POST", "/Contacts", {
    Contacts: [{ ContactID: contactId, ...contactPayload(input) }],
  }) as { Contacts?: XeroContact[] };
  if (!body.Contacts?.[0]) throw new Error("Xero did not return the updated contact");
  return body.Contacts[0];
}

/* ── Chart of Accounts ──────────────────────────────────────────────── */

export type XeroAccount = { Code?: string; Name?: string; Type?: string; Status?: string; Class?: string };

/** Active chart-of-accounts entries that carry a code (codes are what Xero
 *  needs on invoice/PO lines). Returned sorted by code for the Admin selects. */
export async function listAccounts(env: Env): Promise<Array<{ code: string; name: string; type: string; class: string }>> {
  const conn = await getValidConnection(env);
  const body = await xeroFetch(env, conn, "GET", `/Accounts?where=${encodeURIComponent('Status=="ACTIVE"')}`) as { Accounts?: XeroAccount[] };
  return (body.Accounts ?? [])
    .filter((a) => a.Code)
    .map((a) => ({ code: String(a.Code), name: a.Name ?? "", type: a.Type ?? "", class: a.Class ?? "" }))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
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
  const body = await xeroFetch(env, conn, "POST", "/PurchaseOrders", { PurchaseOrders: [po] }) as {
    PurchaseOrders: XeroPOResponse[];
  };
  if (!body.PurchaseOrders?.[0]) throw new Error("Xero did not return a PurchaseOrder in the response");
  return body.PurchaseOrders[0];
}

/** Update an existing Xero purchase order in place (POST to the element URL with
 *  the PurchaseOrderID), so an amended PO re-syncs instead of duplicating. */
export async function updatePurchaseOrder(env: Env, xeroPoId: string, po: XeroPOInput): Promise<XeroPOResponse> {
  const conn = await getValidConnection(env);
  const body = await xeroFetch(env, conn, "POST", `/PurchaseOrders/${xeroPoId}`, {
    PurchaseOrders: [{ ...po, PurchaseOrderID: xeroPoId }],
  }) as { PurchaseOrders: XeroPOResponse[] };
  if (!body.PurchaseOrders?.[0]) throw new Error("Xero did not return a PurchaseOrder in the response");
  return body.PurchaseOrders[0];
}

/* ── Sales invoices (ACCREC) ────────────────────────────────────────── */

export type XeroInvoiceLine = {
  Description: string;
  Quantity: number;
  UnitAmount: number;
  AccountCode?: string;    // revenue/sales account in the chart of accounts
  TaxType?: string;        // OUTPUT2 = UK 20% VAT output; NONE = no VAT
  Tracking?: Array<{ Name: string; Option: string }>;
};

export type XeroInvoiceInput = {
  Type: "ACCREC" | "ACCPAY";   // ACCREC = sales invoice (client); ACCPAY = bill (subbie)
  Contact: { ContactID?: string; Name?: string };
  Date: string;            // YYYY-MM-DD
  DueDate?: string;
  Reference?: string;      // our app number — shows on the Xero invoice
  Status?: "DRAFT" | "SUBMITTED" | "AUTHORISED";
  LineAmountTypes?: "Exclusive" | "Inclusive" | "NoTax";
  /** ISO code (GBP/EUR/USD…). Omitted, Xero books the amounts in the org's
   *  BASE currency — so a €2,600 bill silently becomes £2,600. Always send it
   *  when the document isn't in the base currency. */
  CurrencyCode?: string;
  LineItems: XeroInvoiceLine[];
};

export type XeroInvoiceResponse = {
  InvoiceID: string;
  InvoiceNumber: string;
  Status: string;
  Reference?: string;
  Total: number;
};

export async function createSalesInvoice(env: Env, invoice: XeroInvoiceInput): Promise<XeroInvoiceResponse> {
  const conn = await getValidConnection(env);
  const body = await xeroFetch(env, conn, "POST", "/Invoices", { Invoices: [invoice] }) as {
    Invoices: XeroInvoiceResponse[];
  };
  if (!body.Invoices?.[0]) throw new Error("Xero did not return an Invoice in the response");
  return body.Invoices[0];
}

/* ── Reading an invoice/bill back (used by the paid-status webhook) ────── */

export type XeroInvoiceFull = {
  InvoiceID: string;
  InvoiceNumber?: string;
  Type: "ACCREC" | "ACCPAY";        // ACCREC = sales invoice (money in); ACCPAY = bill (money out)
  Status: string;                   // DRAFT | SUBMITTED | AUTHORISED | PAID | VOIDED | DELETED
  Reference?: string;
  AmountDue?: number;
  AmountPaid?: number;
  Total?: number;
  FullyPaidOnDate?: string;         // Xero MS-date, e.g. "/Date(1718...+0000)/"
  Contact?: { ContactID?: string; Name?: string };
  /** The invoice's own currency, and Xero's rate for converting it into the
   *  organisation's BASE currency (base = amount x CurrencyRate). Xero sets the
   *  rate when the bill is created, which is why we read it back rather than
   *  sourcing a rate ourselves. */
  CurrencyCode?: string;
  CurrencyRate?: number;
};

/** Fetch a single invoice (ACCREC or ACCPAY) by its Xero InvoiceID. */
export async function getInvoice(env: Env, invoiceId: string): Promise<XeroInvoiceFull | null> {
  const conn = await getValidConnection(env);
  const body = await xeroFetch(env, conn, "GET", `/Invoices/${encodeURIComponent(invoiceId)}`) as {
    Invoices?: XeroInvoiceFull[];
  };
  return body.Invoices?.[0] ?? null;
}

/** List invoices/bills matching a Xero `where` clause, paginated. `modifiedSince`
 *  uses the If-Modified-Since header to bound the result to recent changes. */
export async function listInvoices(
  env: Env,
  where: string,
  opts?: { modifiedSince?: Date; maxPages?: number; summaryOnly?: boolean },
): Promise<XeroInvoiceFull[]> {
  const conn = await getValidConnection(env);
  const maxPages = opts?.maxPages ?? 20;
  const headers: Record<string, string> = {};
  if (opts?.modifiedSince) {
    // Xero expects a UTC datetime with no milliseconds/zone suffix.
    headers["If-Modified-Since"] = opts.modifiedSince.toISOString().replace(/\.\d+Z$/, "");
  }
  const all: XeroInvoiceFull[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const q = new URLSearchParams();
    if (where) q.set("where", where);
    q.set("page", String(page));
    if (opts?.summaryOnly) q.set("summaryOnly", "true");
    const body = await xeroFetch(env, conn, "GET", `/Invoices?${q.toString()}`, undefined, headers) as {
      Invoices?: XeroInvoiceFull[];
    };
    const batch = body.Invoices ?? [];
    all.push(...batch);
    if (batch.length < 100) break; // last page
  }
  return all;
}

/** Parse Xero's "/Date(ms+offset)/" format into an ISO string. Returns null if
 *  the value is missing or unparseable. */
export function parseXeroDate(v: string | undefined | null): string | null {
  if (!v) return null;
  const m = /\/Date\((\d+)/.exec(v);
  if (m) return new Date(Number(m[1])).toISOString();
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Is this invoice fully paid (and not voided/deleted)? */
export function isInvoicePaid(inv: XeroInvoiceFull): boolean {
  if (inv.Status === "VOIDED" || inv.Status === "DELETED") return false;
  if (inv.Status === "PAID") return true;
  // Belt-and-braces: AUTHORISED invoice with nothing left to pay.
  return typeof inv.AmountDue === "number" && inv.AmountDue <= 0 &&
    (typeof inv.Total !== "number" || inv.Total > 0);
}

/* ── Tracking categories (used to tag invoices to the Xero project) ──── */

export type XeroTrackingOption = { TrackingOptionID: string; Name: string; Status?: string };
export type XeroTrackingCategory = {
  TrackingCategoryID: string; Name: string; Status?: string; Options?: XeroTrackingOption[];
};

/** Fetch all tracking categories (+ their options) for the connected org. */
export async function listTrackingCategories(env: Env): Promise<XeroTrackingCategory[]> {
  const conn = await getValidConnection(env);
  const body = await xeroFetch(env, conn, "GET", "/TrackingCategories") as { TrackingCategories?: XeroTrackingCategory[] };
  return body.TrackingCategories ?? [];
}

/* ── Tax rates (so client invoices can use the org's reverse-charge type) ── */

export type XeroTaxRate = { Name: string; TaxType: string; Status?: string; EffectiveRate?: number };

/** Fetch the org's tax rates. Needs the accounting.settings(.read) scope. */
export async function listTaxRates(env: Env): Promise<XeroTaxRate[]> {
  const conn = await getValidConnection(env);
  const body = await xeroFetch(env, conn, "GET", "/TaxRates") as { TaxRates?: XeroTaxRate[] };
  return (body.TaxRates ?? []).map((t) => ({
    Name: t.Name, TaxType: t.TaxType, Status: t.Status, EffectiveRate: t.EffectiveRate,
  }));
}

/**
 * Resolve the Xero sales-side (output / "VAT on Income") TaxType for a project's
 * VAT selection, so client invoices match what the project is set to:
 *   • 20%  → OUTPUT2 (Xero's built-in standard-rate output code; no lookup)
 *   • 0%   → the org's CIS Domestic Reverse Charge income rate. Reverse-charge
 *            codes are org-specific, so we match Xero's auto-created rate by name
 *            ("…Reverse Charge…(VAT on Income)"), preferring the 20% one.
 *   • else → an income rate whose effective rate equals the selection (e.g. 5%).
 * Returns null if it can't be resolved (e.g. the accounting.settings scope isn't
 * granted, so /TaxRates 401s) — the caller decides the fallback.
 */
export async function resolveSalesTaxType(env: Env, vatPct: number): Promise<string | null> {
  if (vatPct === 20) return "OUTPUT2";
  let rates: XeroTaxRate[];
  try {
    rates = await listTaxRates(env);
  } catch {
    return null; // scope not granted / API error — let the caller fall back
  }
  const isIncome = (r: XeroTaxRate) => /income|sales/i.test(r.Name);
  if (vatPct === 0) {
    const reverse = rates.filter((r) => /reverse\s*charge/i.test(r.Name));
    const income = reverse.filter(isIncome);
    const pick = income.find((r) => /\b20\b/.test(r.Name)) ?? income[0] ?? reverse[0];
    return pick?.TaxType ?? null;
  }
  const byRate = rates.filter((r) => isIncome(r) && Math.round(r.EffectiveRate ?? -1) === vatPct);
  return byRate[0]?.TaxType ?? null;
}

/**
 * Find the tracking {category, option} that matches a project code. Xero
 * customers commonly set up a "Project" tracking category whose options are
 * the project codes; we auto-match by option name (case-insensitive, trimmed).
 * Returns the {Name, Option} pair ready to attach to an invoice line, or null
 * if no active option matches (so the caller can still raise the invoice).
 */
export async function findProjectTracking(
  env: Env,
  projectCode: string,
): Promise<{ Name: string; Option: string } | null> {
  const want = projectCode.trim().toLowerCase();
  if (!want) return null;
  const cats = await listTrackingCategories(env);
  for (const cat of cats) {
    if (cat.Status && cat.Status !== "ACTIVE") continue;
    for (const opt of cat.Options ?? []) {
      if (opt.Status && opt.Status !== "ACTIVE") continue;
      if (opt.Name.trim().toLowerCase() === want) {
        return { Name: cat.Name, Option: opt.Name };
      }
    }
  }
  return null;
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
