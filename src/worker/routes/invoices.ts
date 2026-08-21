// Accounts / invoices workpiece — a Dext-style inbox. Invoices arrive by email
// (invoices@) or manual upload, Claude reads them, they sit in a review queue,
// then are routed to a PROJECT (job-costed) or OVERHEADS (nominal-coded,
// admin-only) and pushed to Xero as a DRAFT Bill (ACCPAY) for the accountant.
import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";
import { can } from "../../shared/permissions";
import { ensureXeroContact } from "./xero";
import { createSalesInvoice, getInvoice, uploadAttachment } from "../xero/client";
import { nextPONumber } from "./pos";
import { aliasMap, learnAliases, normText } from "../matchMemory";
import { fuzzyFindPo } from "../poRef";
import { pickProjectByAddress, type AddrProject } from "../addrMatch";
import { siteScope } from "./operations";
import { loadSettings, tierForApproval } from "../approval";

export const invoices = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Overhead invoices reveal the company cost base, so viewing/routing them is
 *  admin-only (approvers.manage = admin + superadmin). */
function isAdmin(c: Parameters<typeof requirePermission>[0]): boolean {
  return can(c.get("userRole"), "approvers.manage");
}

/* ── Extraction ──────────────────────────────────────────────────────── */

export type ExtractedInvoice = {
  supplier_name: string | null;
  invoice_number: string | null;
  po_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  payment_terms: string | null;
  supplier_address: string | null;
  supplier_vat_number: string | null;
  supplier_email: string | null;
  supplier_phone: string | null;
  bank_name: string | null;
  bank_sort_code: string | null;
  bank_account_number: string | null;
  bank_account_name: string | null;
  delivery_address: string | null;
  /** ISO-4217 code, normalised (see normaliseCurrency). */
  currency: string | null;
  net_amount: number | null;
  vat_amount: number | null;
  gross_amount: number | null;
  lines: Array<{ description: string; quantity: number | null; unit_price: number | null; amount: number | null }>;
};

/** Fold whatever the reader saw — "£", "Euro", "usd", "GBP " — into a clean
 *  ISO-4217 code. The currency decides what the figures MEAN (and what Xero
 *  books), so a symbol must never be stored as-is or silently read as sterling.
 *  Returns null when there's nothing recognisable, letting callers decide the
 *  fallback rather than guessing sterling here. */
export function normaliseCurrency(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  if (/^[A-Za-z]{3}$/.test(t)) return t.toUpperCase();
  const low = t.toLowerCase();
  const bySymbol: Array<[RegExp, string]> = [
    [/£|gbp|sterling|pound/, "GBP"],
    [/€|eur\b|euro/, "EUR"],
    [/\$|usd|us dollar|dollar/, "USD"],   // after £/€ so "€" can't fall through
    [/zł|pln|zloty/, "PLN"],
    [/chf|swiss franc/, "CHF"],
    [/₹|inr/, "INR"],
    [/¥|jpy|yen/, "JPY"],
  ];
  for (const [re, code] of bySymbol) if (re.test(low)) return code;
  return null;
}

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

const INVOICE_TOOL = {
  name: "extract_invoice",
  description: "Extract the header and line items from a supplier invoice / bill.",
  input_schema: {
    type: "object" as const,
    properties: {
      supplier_name: { type: "string", description: "The supplier / vendor issuing the invoice (who we pay)." },
      invoice_number: { type: "string", description: "The supplier's OWN invoice / reference number." },
      po_number: { type: "string", description: "OUR purchase order (PO) number the invoice is raised against, if the invoice quotes one — e.g. 'PO-26001-0014', 'Order No 26001-0014', 'Your Ref: 26001'. This is the customer's PO, NOT the supplier's own invoice number. Null if none is shown." },
      invoice_date: { type: "string", description: "Invoice date as YYYY-MM-DD." },
      due_date: { type: "string", description: "Payment due date as YYYY-MM-DD if shown." },
      payment_terms: { type: "string", description: "Payment terms as written on the invoice, if shown — e.g. '30 Days End Of Month', 'Net 14', '28 days from invoice'. Null if none." },
      supplier_address: { type: "string", description: "The supplier's OWN address (letterhead / registered office / remit-to) — NOT the delivery address." },
      supplier_vat_number: { type: "string", description: "The supplier's VAT registration number if shown, e.g. 'GB 123 4567 89'." },
      supplier_email: { type: "string", description: "The supplier's contact / accounts / remittance email address if shown." },
      supplier_phone: { type: "string", description: "The supplier's phone number if shown." },
      bank_name: { type: "string", description: "Bank name from the supplier's printed payment details, if any." },
      bank_sort_code: { type: "string", description: "Sort code from the supplier's printed payment details, e.g. '12-34-56'." },
      bank_account_number: { type: "string", description: "Bank account number from the supplier's printed payment details." },
      bank_account_name: { type: "string", description: "Account name from the supplier's printed payment details." },
      delivery_address: { type: "string", description: "The delivery / ship-to / site address the goods went to, if shown — NOT the supplier's own address and NOT our invoicing address." },
      currency: { type: "string", description: "The currency the invoice is DENOMINATED in, as an ISO-4217 code (GBP, EUR, USD, PLN...). Read it from the symbol or code printed beside the totals (\u00a3 = GBP, \u20ac = EUR, $ = USD) — do NOT assume GBP just because the supplier looks British, and do not confuse a supplier's foreign address with the invoice currency. Empty string only if genuinely nothing is shown." },
      net_amount: { type: "number", description: "Total net (ex-VAT) amount." },
      vat_amount: { type: "number", description: "Total VAT amount." },
      gross_amount: { type: "number", description: "Total gross (inc-VAT) amount payable." },
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            quantity: { type: "number" },
            unit_price: { type: "number" },
            amount: { type: "number", description: "Net line amount." },
          },
          required: ["description"],
        },
      },
    },
    required: [],
  },
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => { const s = (v == null ? "" : String(v)).trim(); return s || null; };

/** Read a PDF or image invoice with Claude and return structured fields. */
export async function extractInvoice(
  env: Env,
  file: { buffer: ArrayBuffer; name: string; type: string },
): Promise<ExtractedInvoice> {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured (needed to read invoices)");
  const lower = file.name.toLowerCase();
  const isPdf = file.type === "application/pdf" || lower.endsWith(".pdf");
  const imgType = /image\/(png|jpe?g|gif|webp)/.test(file.type)
    ? file.type
    : lower.endsWith(".png") ? "image/png"
    : /\.jpe?g$/.test(lower) ? "image/jpeg"
    : lower.endsWith(".webp") ? "image/webp"
    : lower.endsWith(".gif") ? "image/gif"
    : null;
  if (!isPdf && !imgType) throw new Error("Upload the invoice as a PDF or image (JPG/PNG).");

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const source = isPdf
    ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: bufToBase64(file.buffer) } }
    : { type: "image" as const, source: { type: "base64" as const, media_type: imgType as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: bufToBase64(file.buffer) } };

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 3072,
    system: "You are a UK construction accounts clerk reading a supplier invoice or bill (money OUT — something we owe). Extract the supplier (who we pay), the supplier's invoice number, and — separately — OUR purchase-order number if the invoice quotes one (labelled PO, Order No, or Your Ref); dates; the net / VAT / gross totals; and the line items. Also capture the supplier's own details where printed (address, VAT number, email, phone, bank/payment details) and the delivery / ship-to address — keep the supplier's own address and the delivery address strictly separate. Numbers must be plain — no £ or commas. Prefer the net (ex-VAT) figure for line amounts.",
    tools: [INVOICE_TOOL],
    tool_choice: { type: "tool", name: "extract_invoice" },
    messages: [{ role: "user", content: [source, { type: "text", text: "Extract this invoice via extract_invoice." }] }],
  });
  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const r = (toolUse?.input ?? {}) as Record<string, unknown>;
  const rawLines = Array.isArray(r.lines) ? (r.lines as Array<Record<string, unknown>>) : [];
  return {
    supplier_name: str(r.supplier_name),
    invoice_number: str(r.invoice_number),
    po_number: str(r.po_number),
    invoice_date: str(r.invoice_date),
    due_date: str(r.due_date),
    payment_terms: str(r.payment_terms),
    supplier_address: str(r.supplier_address),
    supplier_vat_number: str(r.supplier_vat_number),
    supplier_email: str(r.supplier_email),
    supplier_phone: str(r.supplier_phone),
    bank_name: str(r.bank_name),
    bank_sort_code: str(r.bank_sort_code),
    bank_account_number: str(r.bank_account_number),
    bank_account_name: str(r.bank_account_name),
    delivery_address: str(r.delivery_address),
    currency: normaliseCurrency(str(r.currency)) ?? "GBP",
    net_amount: num(r.net_amount),
    vat_amount: num(r.vat_amount),
    gross_amount: num(r.gross_amount),
    lines: rawLines.map((l) => ({
      description: str(l.description) ?? "",
      quantity: num(l.quantity),
      unit_price: num(l.unit_price),
      amount: num(l.amount),
    })).filter((l) => l.description),
  };
}

/** Derive the live project a PO reference points at, e.g. "PO-26002-0003" (or
 *  "PO 26002 0003", "PO-26002-0003-C1") → the 26002 project. The project code is
 *  embedded in our PO numbers, so an invoice can still be coded to its project
 *  even when the exact PO has since been deleted. Returns { id, code } or null. */
/**
 * Derive a due date from the invoice date + printed payment terms when the
 * invoice doesn't state one ("Payment Terms - 30 Days End Of Month" → last day
 * of the invoice month + 30 days). Understands the common UK forms:
 *   "N days end of month" / "N days from end of month" / "EOM + N"
 *   "end of month" (no N)
 *   "N days" / "net N" / "N days from invoice/date"
 * Returns YYYY-MM-DD or null when the terms don't parse.
 */
export function dueDateFromTerms(invoiceDate: string | null | undefined, terms: string | null | undefined): string | null {
  const d = String(invoiceDate ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  const t = String(terms ?? "").toLowerCase();
  if (!d || !t.trim()) return null;
  const y = Number(d[1]), mo = Number(d[2]), day = Number(d[3]);
  const fmt = (dt: Date) => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  const endOfMonth = new Date(Date.UTC(y, mo, 0)); // day 0 of next month
  const eom = /end\s*of\s*(the\s*)?month|e\.?o\.?m\.?/.test(t);
  const days = t.match(/(\d{1,3})\s*days?/) ?? t.match(/net\s*(\d{1,3})/);
  if (eom) {
    const n = days ? Number(days[1]) : 0;
    const due = new Date(endOfMonth);
    due.setUTCDate(due.getUTCDate() + n);
    return fmt(due);
  }
  if (days) {
    const due = new Date(Date.UTC(y, mo - 1, day + Number(days[1])));
    return fmt(due);
  }
  return null;
}

async function projectFromPoRef(env: Env, ref: string | null | undefined): Promise<{ id: string; code: string } | null> {
  const m = String(ref ?? "").trim().match(/^\s*PO[-\s]?(.+?)[-\s]\d{3,}/i);
  const code = m ? m[1].trim() : null;
  if (!code) return null;
  return (await env.DB.prepare("SELECT id, code FROM projects WHERE code = ? AND deleted_at IS NULL LIMIT 1")
    .bind(code).first<{ id: string; code: string }>()) ?? null;
}

/** The extraction metadata kept on the invoice row — the supplier's own
 *  details plus the delivery address; everything beyond the accounting
 *  columns. Null when the read produced none of it. */
function extractedMetaJson(ex: ExtractedInvoice | null): string | null {
  if (!ex) return null;
  const meta = {
    supplier_address: ex.supplier_address,
    supplier_vat_number: ex.supplier_vat_number,
    supplier_email: ex.supplier_email,
    supplier_phone: ex.supplier_phone,
    payment_terms: ex.payment_terms,
    bank_name: ex.bank_name,
    bank_sort_code: ex.bank_sort_code,
    bank_account_number: ex.bank_account_number,
    bank_account_name: ex.bank_account_name,
    delivery_address: ex.delivery_address,
  };
  return Object.values(meta).some((v) => v != null) ? JSON.stringify(meta) : null;
}
type InvoiceMeta = Partial<Record<"supplier_address" | "supplier_vat_number" | "supplier_email" | "supplier_phone"
  | "payment_terms" | "bank_name" | "bank_sort_code" | "bank_account_number" | "bank_account_name" | "delivery_address", string | null>>;

/** Find an approved supplier for the extracted details — exact name first,
 *  then VAT number (suppliers invoice under trading names; the VAT number is
 *  the stable identity). */
export async function findSupplier(env: Env, name: string | null, vat: string | null): Promise<number | null> {
  if (name?.trim()) {
    const m = await env.DB.prepare("SELECT id FROM suppliers WHERE lower(name) = lower(?) LIMIT 1")
      .bind(name.trim()).first<{ id: number }>();
    if (m) return m.id;
  }
  const digits = (vat ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^GB/, "");
  if (digits.length >= 7) {
    const rows = await env.DB.prepare("SELECT id, vat_number FROM suppliers WHERE vat_number IS NOT NULL AND vat_number != ''")
      .all<{ id: number; vat_number: string }>();
    const hit = rows.results.find((r) => r.vat_number.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^GB/, "") === digits);
    if (hit) return hit.id;
  }
  return null;
}

/** Fallback project coding from the delivery / ship-to address on the invoice
 *  (used only when no PO reference resolves). Site-group members collapse to
 *  the group's base project. */
async function projectFromDeliveryAddress(env: Env, addr: string | null | undefined): Promise<{ id: string; code: string } | null> {
  if (!addr?.trim()) return null;
  const rows = (await env.DB.prepare(
    "SELECT id, code, name, delivery_address, site_group_id FROM projects WHERE deleted_at IS NULL AND id != 'sandbox'",
  ).all<AddrProject>()).results;
  const pick = pickProjectByAddress(addr, rows);
  if (!pick) return null;
  if (pick.site_group_id) {
    const base = await env.DB.prepare(
      "SELECT p.id, p.code FROM site_groups g JOIN projects p ON p.id = g.base_project_id WHERE g.id = ? AND p.deleted_at IS NULL",
    ).bind(pick.site_group_id).first<{ id: string; code: string }>();
    if (base) return base;
  }
  return { id: pick.id, code: pick.code };
}

/**
 * Resolve a quoted PO reference to a live PO, tolerating supplier mangling —
 * an extra digit in the project code ("PO-262002-0004"), block suffixes
 * ("-C1", "BLOCK C"), spacing and case. Exact normalized match first (longest
 * wins so call-off numbers beat their parent), then repair the code segment by
 * single-character deletion against live project codes and match the numeric
 * sequence against that project's POs.
 */
export async function resolvePoRef(
  env: Env, ref: string | null | undefined,
): Promise<{ id: string; po_number: string; project_id: string; project_code: string } | null> {
  const raw = String(ref ?? "").trim();
  if (!raw) return null;
  const pos = (await env.DB.prepare(
    `SELECT po.id, po.po_number, po.project_id, p.code AS project_code
       FROM purchase_orders po JOIN projects p ON p.id = po.project_id
      WHERE po.status != 'deleted' AND p.deleted_at IS NULL`,
  ).all<{ id: string; po_number: string; project_id: string; project_code: string }>()).results;
  return fuzzyFindPo(raw, pos);
}

/** Store the file in R2, extract, and create an inbox invoice row. Shared by the
 *  manual-upload endpoint and the invoices@ inbound-email handler. */
export async function ingestInvoice(
  env: Env,
  args: { file: { buffer: ArrayBuffer; name: string; type: string }; source: "upload" | "email"; sender?: string | null; subject?: string | null; actor: string },
): Promise<{ id: number | null; extracted: boolean; skipped?: "signature_image" | "duplicate"; duplicate_of?: number }> {
  const now = new Date().toISOString();

  let ex: ExtractedInvoice | null = null;
  let extractError: string | null = null;
  try { ex = await extractInvoice(env, args.file); }
  catch (e) { extractError = e instanceof Error ? e.message : "extraction failed"; }

  // Emailed images that READ clean but contain no invoice substance (no
  // number, no amounts, no lines) are signature logos and photos riding along
  // on the email — drop them. PDFs, manual uploads and extraction FAILURES
  // (which need human eyes) always come through.
  const lowerName = (args.file.name || "").toLowerCase();
  const isPdfFile = args.file.type === "application/pdf" || lowerName.endsWith(".pdf");
  if (args.source === "email" && !isPdfFile && ex && !extractError) {
    const substance = ex.invoice_number || ex.gross_amount != null || ex.net_amount != null || (ex.lines?.length ?? 0) > 0;
    if (!substance) return { id: null, extracted: true, skipped: "signature_image" };
  }

  // The same invoice arriving twice (re-forwarded email, double upload) must
  // not create two payable rows — supplier + their invoice number is identity;
  // without a number, supplier + gross + date stands in.
  if (ex?.supplier_name) {
    let dupe: { id: number } | null = null;
    if (ex.invoice_number) {
      dupe = (await env.DB.prepare(
        "SELECT id FROM invoices WHERE lower(supplier_name) = lower(?) AND lower(COALESCE(invoice_number,'')) = lower(?) LIMIT 1",
      ).bind(ex.supplier_name.trim(), ex.invoice_number.trim()).first<{ id: number }>()) ?? null;
    } else if (ex.gross_amount != null && ex.invoice_date) {
      dupe = (await env.DB.prepare(
        "SELECT id FROM invoices WHERE lower(supplier_name) = lower(?) AND gross_amount = ? AND invoice_date = ? LIMIT 1",
      ).bind(ex.supplier_name.trim(), ex.gross_amount, ex.invoice_date).first<{ id: number }>()) ?? null;
    }
    if (dupe) return { id: dupe.id, extracted: true, skipped: "duplicate", duplicate_of: dupe.id };
  }

  const fileKey = `invoices/${crypto.randomUUID()}-${(args.file.name || "invoice").replace(/[^\w.\-]+/g, "_").slice(0, 80)}`;
  await env.R2.put(fileKey, args.file.buffer, { httpMetadata: { contentType: args.file.type || "application/octet-stream" } });

  // Try to match the extracted supplier to an approved supplier (name, then VAT number).
  const supplierId = ex ? await findSupplier(env, ex.supplier_name, ex.supplier_vat_number) : null;

  // Resolve the quoted PO reference to a live order (fuzzy — survives supplier
  // typos and suffixes) so the invoice arrives already coded to its project
  // WITH the PO match stored. Falls back to project-only when the exact PO was
  // later deleted (the project code is still embedded in the PO number).
  const refPo = ex?.po_number ? await resolvePoRef(env, ex.po_number) : null;
  let proj = refPo
    ? { id: refPo.project_id, code: refPo.project_code }
    : (ex?.po_number ? await projectFromPoRef(env, ex.po_number) : null);
  // No usable PO reference — fall back to the delivery address printed on the
  // invoice, matched against each project's delivery address.
  if (!proj && ex?.delivery_address) proj = await projectFromDeliveryAddress(env, ex.delivery_address);

  const res = await env.DB.prepare(
    `INSERT INTO invoices
       (status, supplier_id, supplier_name, invoice_number, extracted_po_ref, invoice_date, due_date, currency,
        net_amount, vat_amount, gross_amount, lines_json,
        file_key, file_type, file_name, source, sender_email, subject, extract_error,
        kind, project_id, matched_po_id,
        received_at, created_at, created_by, extracted_meta_json)
     VALUES ('inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  ).bind(
    supplierId, ex?.supplier_name ?? null, ex?.invoice_number ?? null, ex?.po_number ?? null, ex?.invoice_date ?? null,
    ex?.due_date ?? dueDateFromTerms(ex?.invoice_date, ex?.payment_terms), ex?.currency ?? "GBP",
    ex?.net_amount ?? null, ex?.vat_amount ?? null, ex?.gross_amount ?? null, ex ? JSON.stringify(ex.lines) : null,
    fileKey, args.file.type || null, args.file.name || null, args.source, args.sender ?? null, args.subject ?? null, extractError,
    proj ? "project" : null, proj?.id ?? null, refPo?.id ?? null,
    now, now, args.actor, extractedMetaJson(ex),
  ).first<{ id: number }>();
  return { id: res!.id, extracted: !!ex };
}

/* ── Routes ──────────────────────────────────────────────────────────── */

/** List invoices. Non-admins never see overheads. */
/** Parse free-text account payment terms ("Net 60 days EOM", "30 days", "COD")
 *  into a rule. EOM terms run from the end of the invoice month; plain terms
 *  from the invoice date. Null when the text carries no readable day count. */
export function parsePaymentTerms(text: string | null | undefined): { days: number; eom: boolean } | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/\b(cod|cash on delivery|pro\s*-?\s*forma|on receipt|immediate)\b/.test(t)) return { days: 0, eom: false };
  const m = /(\d{1,3})/.exec(t);
  if (!m) return null;
  const eom = /\beom\b|end of (the )?month|month[\s-]?end/.test(t);
  return { days: Number(m[1]), eom };
}

/** The date an invoice SHOULD fall due under the supplier's account terms. */
export function expectedDueDate(invoiceDate: string, terms: { days: number; eom: boolean }): string {
  const d = new Date(invoiceDate.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return invoiceDate.slice(0, 10);
  // EOM: the clock starts at the end of the invoice month (day 0 of the next
  // month), so "Net 60 days EOM" on a 24 Jun invoice runs 30 Jun + 60d = 29 Aug.
  if (terms.eom) { d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); }
  d.setUTCDate(d.getUTCDate() + terms.days);
  return d.toISOString().slice(0, 10);
}

/** Derive the account-terms cross-check for an invoice row: the due date the
 *  supplier's terms imply, and whether the invoice's own due date disagrees by
 *  more than 3 days — Alumasc-style "billed on 30 days, account is 60 EOM". */
function withTermsCheck<T extends Record<string, unknown>>(row: T): T {
  const terms = parsePaymentTerms(row.supplier_payment_terms as string | null);
  const invDate = row.invoice_date as string | null;
  const expected = terms && invDate ? expectedDueDate(invDate, terms) : null;
  let mismatch = false;
  const due = row.due_date as string | null;
  if (expected && due) {
    const a = Date.parse(due.slice(0, 10)), b = Date.parse(expected);
    if (!Number.isNaN(a) && !Number.isNaN(b)) mismatch = Math.abs(a - b) / 86_400_000 > 3;
  }
  return { ...row, expected_due_date: expected, terms_mismatch: mismatch };
}

invoices.get("/", async (c) => {
  const denied = requirePermission(c, "commercial.view");
  if (denied) return denied;
  const status = c.req.query("status");
  const admin = isAdmin(c);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) { where.push("i.status = ?"); binds.push(status); }
  if (!admin) { where.push("(i.kind IS NULL OR i.kind != 'overhead')"); }
  const rows = await c.env.DB.prepare(
    `SELECT i.*, p.code AS project_code, p.name AS project_name, s.name AS matched_supplier_name,
            s.payment_terms AS supplier_payment_terms
       FROM invoices i
       LEFT JOIN projects p ON p.id = i.project_id
       LEFT JOIN suppliers s ON s.id = i.supplier_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY i.received_at DESC, i.id DESC`,
  ).bind(...binds).all();
  return c.json(rows.results.map((r) => withTermsCheck(r as Record<string, unknown>)));
});

invoices.get("/:id", async (c) => {
  const denied = requirePermission(c, "commercial.view");
  if (denied) return denied;
  const inv = await c.env.DB.prepare(
    `SELECT i.*, p.code AS project_code, p.name AS project_name, s.name AS matched_supplier_name,
            s.payment_terms AS supplier_payment_terms
       FROM invoices i LEFT JOIN projects p ON p.id = i.project_id LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.id = ?`,
  ).bind(c.req.param("id")).first<Record<string, unknown>>();
  if (!inv) return c.json({ error: "not found" }, 404);
  if (inv.kind === "overhead" && !isAdmin(c)) return c.json({ error: "Forbidden: overheads are admin-only" }, 403);
  return c.json(withTermsCheck(inv));
});

/** Serve the original invoice file from R2. Inline by default (so the preview /
 *  "Open" shows it rather than downloading); ?download=1 forces a save. Either
 *  way the file is named properly, not the "file" URL segment. */
invoices.get("/:id/file", async (c) => {
  const denied = requirePermission(c, "commercial.view");
  if (denied) return denied;
  const inv = await c.env.DB.prepare("SELECT file_key, file_name, file_type, kind FROM invoices WHERE id = ?")
    .bind(c.req.param("id")).first<{ file_key: string | null; file_name: string | null; file_type: string | null; kind: string | null }>();
  if (!inv?.file_key) return c.json({ error: "no file" }, 404);
  if (inv.kind === "overhead" && !isAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const obj = await c.env.R2.get(inv.file_key);
  if (!obj) return c.json({ error: "not found" }, 404);
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  // Force a real content-type so the browser renders inline instead of
  // downloading — R2 / an email attachment may have stored "octet-stream" (or
  // nothing), which browsers always download regardless of Content-Disposition.
  const name = (inv.file_name || "").toLowerCase();
  const byExt =
    name.endsWith(".pdf") ? "application/pdf" :
    name.endsWith(".png") ? "image/png" :
    /\.jpe?g$/.test(name) ? "image/jpeg" :
    name.endsWith(".gif") ? "image/gif" :
    name.endsWith(".webp") ? "image/webp" :
    name.endsWith(".heic") ? "image/heic" : null;
  let ct = inv.file_type || h.get("content-type") || "";
  if (!ct || /octet-stream/i.test(ct)) ct = byExt || "application/pdf";
  h.set("content-type", ct);
  const safeName = (inv.file_name || `invoice-${c.req.param("id")}`).replace(/["\\\r\n]/g, "_");
  const disposition = c.req.query("download") ? "attachment" : "inline";
  h.set("content-disposition", `${disposition}; filename="${safeName}"`);
  return new Response(obj.body, { headers: h });
});

/** Manual upload of an invoice (multipart form: file). */
invoices.post("/upload", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  try {
    const r = await ingestInvoice(c.env, {
      file: { buffer: await file.arrayBuffer(), name: file.name, type: file.type },
      source: "upload", actor: c.get("userEmail"),
    });
    if (r.skipped === "duplicate") {
      return c.json({ error: `This invoice is already in the system (same supplier and invoice number) — see invoice #${r.duplicate_of}.`, duplicate_of: r.duplicate_of }, 409);
    }
    return c.json(r);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "upload failed" }, 500);
  }
});

/** Edit / route an invoice: amounts, supplier, project vs overhead + nominal. */
invoices.patch("/:id", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const cur = await c.env.DB.prepare("SELECT kind FROM invoices WHERE id = ?").bind(id).first<{ kind: string | null }>();
  if (!cur) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<Record<string, unknown>>();
  // Routing an invoice to (or leaving it on) overheads is admin-only.
  if ((body.kind === "overhead" || cur.kind === "overhead") && !isAdmin(c)) {
    return c.json({ error: "Forbidden: overhead coding is admin-only" }, 403);
  }
  const allowed = ["kind", "project_id", "nominal_code", "supplier_id", "supplier_name",
    "invoice_number", "invoice_date", "due_date", "net_amount", "vat_amount", "gross_amount", "notes", "status"] as const;
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
  // Routing to a project clears the overhead nominal, and vice-versa.
  if (body.kind === "project") { sets.push("nominal_code = NULL"); }
  if (body.kind === "overhead") { sets.push("project_id = NULL"); }
  if (sets.length === 0) return c.json({ ok: true });
  binds.push(id);
  await c.env.DB.prepare(`UPDATE invoices SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  return c.json({ ok: true });
});

invoices.post("/:id/dismiss", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  await c.env.DB.prepare("UPDATE invoices SET status = 'dismissed' WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

/** Re-run Claude extraction on the stored file — re-reads the supplier, PO ref,
 *  amounts and lines from the document (e.g. to pick up the PO number on an
 *  invoice ingested before PO-ref capture). Leaves the coding (kind/project)
 *  and Xero state alone. */
invoices.post("/:id/reextract", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const inv = await c.env.DB.prepare("SELECT file_key, file_type, file_name, status FROM invoices WHERE id = ?")
    .bind(id).first<{ file_key: string | null; file_type: string | null; file_name: string | null; status: string }>();
  if (!inv?.file_key) return c.json({ error: "No stored file to re-read." }, 404);
  if (inv.status === "pushed") return c.json({ error: "Already pushed to Xero — can't re-read." }, 409);
  const obj = await c.env.R2.get(inv.file_key);
  if (!obj) return c.json({ error: "Stored file is missing." }, 404);
  try {
    const ex = await extractInvoice(c.env, { buffer: await obj.arrayBuffer(), name: inv.file_name ?? "invoice", type: inv.file_type ?? "" });
    const supplierId = await findSupplier(c.env, ex.supplier_name, ex.supplier_vat_number);
    // Also resolve the quoted PO ref (fuzzy) to code the project AND store the
    // PO match — but never clobber an existing coding/match a user already set.
    const refPo = await resolvePoRef(c.env, ex.po_number);
    let proj: { id: string } | null = refPo ? { id: refPo.project_id } : await projectFromPoRef(c.env, ex.po_number);
    if (!proj && ex.delivery_address) proj = await projectFromDeliveryAddress(c.env, ex.delivery_address);
    await c.env.DB.prepare(
      `UPDATE invoices SET supplier_id = COALESCE(?, supplier_id), supplier_name = ?, invoice_number = ?, extracted_po_ref = ?,
         invoice_date = ?, due_date = ?, currency = ?, net_amount = ?, vat_amount = ?, gross_amount = ?, lines_json = ?, extracted_meta_json = ?,
         kind = COALESCE(kind, ?), project_id = COALESCE(project_id, ?), matched_po_id = COALESCE(matched_po_id, ?), extract_error = NULL
       WHERE id = ?`,
    ).bind(
      supplierId, ex.supplier_name, ex.invoice_number, ex.po_number, ex.invoice_date,
      ex.due_date ?? dueDateFromTerms(ex.invoice_date, ex.payment_terms), ex.currency ?? "GBP",
      ex.net_amount, ex.vat_amount, ex.gross_amount, JSON.stringify(ex.lines), extractedMetaJson(ex),
      proj ? "project" : null, proj?.id ?? null, refPo?.id ?? null, id,
    ).run();
    return c.json({ ok: true, po_number: ex.po_number });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Re-read failed." }, 500);
  }
});

/** Create (or link) an approved supplier from the invoice's extracted details
 *  — name plus the address, VAT number, contact, payment terms and bank
 *  details read off the document — and link the invoice to it. Same
 *  permission as the suppliers register itself. */
invoices.post("/:id/create-supplier", async (c) => {
  const denied = requirePermission(c, "suppliers.manage");
  if (denied) return denied;
  const id = c.req.param("id");
  const inv = await c.env.DB.prepare("SELECT supplier_id, supplier_name, extracted_meta_json FROM invoices WHERE id = ?")
    .bind(id).first<{ supplier_id: number | null; supplier_name: string | null; extracted_meta_json: string | null }>();
  if (!inv) return c.json({ error: "not found" }, 404);
  if (inv.supplier_id) return c.json({ error: "Already linked to a supplier." }, 409);
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
  const name = (body.name ?? inv.supplier_name ?? "").trim();
  if (!name) return c.json({ error: "No supplier name on the invoice." }, 400);
  let meta: InvoiceMeta = {};
  try { meta = inv.extracted_meta_json ? (JSON.parse(inv.extracted_meta_json) as InvoiceMeta) : {}; } catch { /* unreadable meta = create with name only */ }

  // Already on the register under this name / VAT number? Link, don't duplicate.
  const existing = await findSupplier(c.env, name, meta.supplier_vat_number ?? null);
  if (existing) {
    await c.env.DB.prepare("UPDATE invoices SET supplier_id = ? WHERE id = ?").bind(existing, id).run();
    return c.json({ id: existing, linked_existing: true, captured: [] as string[] });
  }

  const fields: Record<string, string | null> = {
    payment_terms: meta.payment_terms ?? null,
    contact_email: meta.supplier_email ?? null,
    contact_phone: meta.supplier_phone ?? null,
    address: meta.supplier_address ?? null,
    vat_number: meta.supplier_vat_number ?? null,
    bank_name: meta.bank_name ?? null,
    bank_sort_code: meta.bank_sort_code ?? null,
    bank_account_number: meta.bank_account_number ?? null,
    bank_account_name: meta.bank_account_name ?? null,
  };
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO suppliers (name, status, payment_terms, contact_email, contact_phone, address, vat_number,
          bank_name, bank_sort_code, bank_account_number, bank_account_name, created_at, created_by)
       VALUES (?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(name, fields.payment_terms, fields.contact_email, fields.contact_phone, fields.address, fields.vat_number,
      fields.bank_name, fields.bank_sort_code, fields.bank_account_number, fields.bank_account_name,
      new Date().toISOString(), c.get("userEmail")).first<{ id: number }>();
    await c.env.DB.prepare("UPDATE invoices SET supplier_id = ? WHERE id = ?").bind(res!.id, id).run();
    return c.json({ id: res!.id, linked_existing: false, captured: Object.keys(fields).filter((k) => fields[k]) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "couldn't create the supplier" }, 400);
  }
});

/** Leading product-code token of a line, normalised for matching
 *  ("SAVBRF - Euroroof…" → "SAVBRF"). Mirrors the operations/client matcher. */
function invMaterialCode(s: string): string {
  const first = (s || "").trim().split(/\s+/)[0] || "";
  return first.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function nameTokenSet(s: string): Set<string> {
  return new Set((s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !["ltd", "limited", "the", "and"].includes(t)));
}

/** Sentinel po_line_id meaning "explicitly a service/misc charge, not a
 *  product line" — a human picked this deliberately, so it counts as matched
 *  (no "no_po_line" flag) but is excluded from qty/value variance checks: a
 *  £0 service line has nothing to deliver and nothing to compare a total against. */
export const SERVICE_CHARGE_LINE_ID = -1;

type InvLine = { description?: string; qty?: number | null; quantity?: number | null; unit_price?: number | null; amount?: number | null; account_code?: string | null; po_line_id?: number | null };

/** 3-way match: reconcile an invoice against its PO and the deliveries logged
 *  against that PO. Finds the PO (stored match, else suggested from item codes +
 *  supplier), matches each invoice line to a PO line, pulls the delivered qty,
 *  and flags variances (billed-not-received, price, over-qty). Read-only. */
/**
 * The 3-way reconciliation for one invoice: choose a PO (stored → quoted PO
 * ref, fuzzy → item/supplier heuristics), link invoice lines to PO lines, and
 * derive flags per line plus an overall match_status:
 *   no_po   → no PO could be associated at all
 *   partial → PO chosen but some lines aren't linked to a PO line
 *   flagged → all lines linked but with variances (price/total/delivery/qty)
 *   ok      → all three legs agree (PO matched, lines linked, delivered, priced)
 * Shared by the GET endpoint and the approval gate.
 */
async function computeInvoiceMatch(env: Env, inv: Record<string, unknown>) {
  let invLines: InvLine[] = [];
  try { invLines = inv.lines_json ? JSON.parse(String(inv.lines_json)) : []; } catch { /* none */ }

  // Candidate POs across live projects (not deleted, not framework) with lines.
  const pos = (await env.DB.prepare(
    `SELECT po.id, po.po_number, po.supplier, po.project_id, po.order_type, po.total_value, p.code AS project_code
       FROM purchase_orders po JOIN projects p ON p.id = po.project_id
      WHERE po.status != 'deleted' AND po.order_type != 'framework' AND p.deleted_at IS NULL
      ORDER BY p.code, po.po_number`,
  ).all<{ id: string; po_number: string; supplier: string | null; project_id: string; order_type: string | null; total_value: number | null; project_code: string }>()).results;
  const poIds = pos.map((p) => p.id);
  const allLines = poIds.length ? (await env.DB.prepare(
    `SELECT id, po_id, item, qty, unit, unit_cost FROM po_lines WHERE po_id IN (${poIds.map(() => "?").join(",")})`,
  ).bind(...poIds).all<{ id: number; po_id: string; item: string; qty: number; unit: string; unit_cost: number }>()).results : [];

  // Rank POs: item-code hits + supplier-name overlap.
  const invCodes = new Set(invLines.map((l) => invMaterialCode(l.description ?? "")).filter((x) => x.length >= 3));
  const invSup = nameTokenSet(String(inv.supplier_name ?? ""));
  const ranked = pos.map((po) => {
    const codes = new Set(allLines.filter((l) => l.po_id === po.id).map((l) => invMaterialCode(l.item)));
    let hits = 0; for (const cd of invCodes) if (codes.has(cd)) hits++;
    const ct = nameTokenSet(po.supplier ?? "");
    let sup = 0; for (const t of invSup) if (ct.has(t)) sup++;
    return { po, hits, supMatch: invSup.size ? sup / invSup.size : 0 };
  }).filter((r) => r.hits > 0 || r.supMatch >= 0.5).sort((a, b) => (b.hits - a.hits) || (b.supMatch - a.supMatch));

  // Direct hit: if the invoice quotes OUR PO number, that's the definitive match
  // — far more reliable than the item-code / supplier-name heuristics. Exact
  // normalized compare first, then the fuzzy resolver (supplier typos/suffixes).
  const normPo = (s: string | null | undefined) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^PO/, "");
  const poRef = normPo(inv.extracted_po_ref as string | null);
  let directPo = poRef.length >= 4 ? pos.find((p) => normPo(p.po_number) === poRef) ?? null : null;
  if (!directPo && poRef.length >= 4) {
    const fuzzy = await resolvePoRef(env, inv.extracted_po_ref as string | null);
    if (fuzzy) directPo = pos.find((p) => p.id === fuzzy.id) ?? null;
  }
  // Surface the quoted PO ref + whether it resolved to a live order, so the UI can
  // explain "invoice quotes PO-X but that's not a live order" (deleted / not raised).
  const poRefOut = inv.extracted_po_ref ? { quoted: String(inv.extracted_po_ref), matched: !!directPo } : null;

  const chosenId = (inv.matched_po_id as string | null) || directPo?.id || ranked[0]?.po.id || null;
  const chosen = pos.find((p) => p.id === chosenId) || null;
  const rankedSug = ranked.slice(0, 5).map((r) => ({ id: r.po.id, po_number: r.po.po_number, supplier: r.po.supplier, project_code: r.po.project_code, hits: r.hits }));
  // Suggestions, in priority order: the direct PO-ref hit, then item-code /
  // supplier ranked hits, then every live PO on the invoice's coded project, then
  // EVERY other live PO. The heuristics only decide the ORDER, never what's
  // reachable — an invoice is routinely coded to one project while the right PO
  // sits on a sibling job (a 26001 order billed on a 26003-coded invoice), and
  // capping the list to the top guesses made that PO unpickable with no way back.
  // `group` tells the UI which bucket each one came from so it can label them.
  type Sug = { id: string; po_number: string; supplier: string | null; project_code: string; hits: number; group: "quoted" | "likely" | "project" | "other" };
  const seen = new Set<string>();
  const suggested: Sug[] = [];
  const pushSug = (s: Sug) => { if (seen.has(s.id)) return; seen.add(s.id); suggested.push(s); };
  // True item-hit count for every scored PO, so one surfacing outside the ranked
  // bucket still reports the matches it genuinely has — this was hardcoded to 0
  // there, hiding the strongest signal the user has for picking the right order.
  const hitsById = new Map(ranked.map((r) => [r.po.id, r.hits]));
  const asSug = (p: (typeof pos)[number], group: Sug["group"]): Sug =>
    ({ id: p.id, po_number: p.po_number, supplier: p.supplier, project_code: p.project_code, hits: hitsById.get(p.id) ?? 0, group });
  if (directPo) pushSug(asSug(directPo, "quoted"));
  for (const s of rankedSug) pushSug({ ...s, group: "likely" });
  if (inv.project_id) {
    for (const p of pos) if (p.project_id === inv.project_id) pushSug(asSug(p, "project"));
  }
  for (const p of pos) pushSug(asSug(p, "other"));

  if (!chosen) {
    return { matched_po: null, suggested, deliveries: [], lines: invLines.map((l) => ({ description: l.description ?? "", qty: l.qty ?? null, unit_price: l.unit_price ?? null, amount: l.amount ?? null, po_line_id: null, po_line_item: null, po_qty: null, po_unit_cost: null, delivered_qty: null, flags: ["no_po_line"] })), match_status: "no_po" as const, po_ref: poRefOut };
  }

  const poLines = allLines.filter((l) => l.po_id === chosen.id);
  const delivered = (await env.DB.prepare(
    `SELECT po_line_id, SUM(received_qty) AS dq FROM site_deliveries WHERE po_id = ? AND po_line_id IS NOT NULL GROUP BY po_line_id`,
  ).bind(chosen.id).all<{ po_line_id: number; dq: number | null }>()).results;
  const dqByLine = new Map(delivered.map((d) => [d.po_line_id, d.dq ?? 0]));
  // A whole-order check-in (no specific line, not flagged as a part-load)
  // asserts the entire PO arrived — it covers every line in full even though
  // it can't contribute per-line quantities.
  const wholePoDelivered = !!(await env.DB.prepare(
    "SELECT 1 AS x FROM site_deliveries WHERE po_id = ? AND po_line_id IS NULL AND completes_po = 1 LIMIT 1",
  ).bind(chosen.id).first());
  // The actual delivery records behind those quantities — so the invoice view
  // can show WHICH tickets satisfied the delivered leg, not just the numbers.
  const deliveryRows = (await env.DB.prepare(
    `SELECT id, description, po_line_id, received_qty, received_unit, delivered_at, ticket_key, created_by
       FROM site_deliveries WHERE po_id = ? ORDER BY delivered_at DESC, id DESC LIMIT 40`,
  ).bind(chosen.id).all<{ id: number; description: string | null; po_line_id: number | null; received_qty: number | null;
    received_unit: string | null; delivered_at: string | null; ticket_key: string | null; created_by: string | null }>()).results;
  const deliveries = deliveryRows.map((d) => ({
    id: d.id, description: d.description, po_line_id: d.po_line_id, received_qty: d.received_qty,
    received_unit: d.received_unit, delivered_at: d.delivered_at, created_by: d.created_by,
    ticket_key: d.ticket_key,
    ticket_url: d.ticket_key ? `/api/operations/file?key=${encodeURIComponent(d.ticket_key)}` : null,
  }));

  // Learned aliases for this supplier: wording corrections humans made before.
  const aliases = await aliasMap(env.DB, "invoice_line", inv.supplier_name as string | null);
  // The leading-code fallback must not stack several invoice lines onto one PO
  // line when they share a code prefix (three "M20 …" lines): exact wording
  // wins first, and a code hit can't claim a line another line already took.
  // Stored links, aliases and exact matches MAY share a line — schemes bill
  // several invoice lines against one priced line legitimately.
  const takenByCode = new Set<number>();
  const lines = invLines.map((il) => {
    if (il.po_line_id === SERVICE_CHARGE_LINE_ID) {
      const invQty = typeof il.qty === "number" ? il.qty : null;
      return { description: il.description ?? "", qty: invQty, unit_price: il.unit_price ?? null, amount: il.amount ?? null,
        po_line_id: SERVICE_CHARGE_LINE_ID, po_line_item: "Service charge", po_qty: null, po_unit: null, po_unit_cost: null,
        po_line_total: null, invoice_line_total: typeof il.amount === "number" ? il.amount : null,
        delivered_qty: null, flags: [] as string[] };
    }
    const code = invMaterialCode(il.description ?? "");
    let pl = il.po_line_id ? poLines.find((p) => p.id === il.po_line_id) : null;
    if (!pl) {
      const learned = aliases.get(normText(il.description));
      if (learned) pl = poLines.find((p) => normText(p.item) === learned) || null;
    }
    if (!pl) pl = poLines.find((p) => normText(p.item) === normText(il.description)) || null;
    if (!pl && code.length >= 3) pl = poLines.find((p) => invMaterialCode(p.item) === code && !takenByCode.has(p.id)) || null;
    if (pl) takenByCode.add(pl.id);
    const invQty = typeof il.qty === "number" ? il.qty : null;
    const dq = pl
      ? (wholePoDelivered ? Math.max(dqByLine.get(pl.id) ?? 0, pl.qty ?? invQty ?? 0) : (dqByLine.get(pl.id) ?? 0))
      : null;
    const invTotal = typeof il.amount === "number" ? il.amount
      : (invQty != null && typeof il.unit_price === "number" ? invQty * il.unit_price : null);
    const poTotal = pl && pl.qty != null && pl.unit_cost != null ? pl.qty * pl.unit_cost : null;
    const flags: string[] = [];
    if (!pl) flags.push("no_po_line");
    else {
      // Goods outstanding: judged against the billed qty when the invoice has
      // one, else against the PO line itself (a lump-sum bill for a line whose
      // goods haven't arrived is exactly what the 3-way is for).
      if ((invQty != null && (dq ?? 0) + 0.001 < invQty)
        || (invQty == null && pl.qty != null && pl.qty > 0 && (dq ?? 0) + 0.001 < pl.qty)) flags.push("not_delivered");
      // VALUE FIRST: when both line totals are known, their agreement is the
      // strongest signal — schemes bill different measures (204 m² roofing area
      // billed as one sum against a 166 m² PO line) where per-unit deltas are
      // pure noise. Totals agreeing (±1%) means the money is right; only when
      // they diverge do the rate/qty comparisons add anything.
      const totalsKnown = invTotal != null && poTotal != null && poTotal > 0;
      const totalsAgree = totalsKnown && Math.abs(invTotal! - poTotal!) <= Math.max(1, poTotal! * 0.01);
      const unitsComparable = invQty != null && pl.qty != null && invQty > 1.001 && pl.qty > 1.001;
      if (totalsKnown && !totalsAgree) {
        flags.push("total_variance");
        if (unitsComparable && typeof il.unit_price === "number" && typeof pl.unit_cost === "number" && pl.unit_cost > 0 && Math.abs(il.unit_price - pl.unit_cost) > 0.01) flags.push("price_variance");
        if (invQty != null && pl.qty != null && invQty > pl.qty + 0.001) flags.push("over_qty");
      } else if (!totalsKnown) {
        if (typeof il.unit_price === "number" && typeof pl.unit_cost === "number" && pl.unit_cost > 0 && Math.abs(il.unit_price - pl.unit_cost) > 0.01) flags.push("price_variance");
        if (invQty != null && pl.qty != null && invQty > pl.qty + 0.001) flags.push("over_qty");
      }
    }
    return { description: il.description ?? "", qty: invQty, unit_price: il.unit_price ?? null, amount: il.amount ?? null,
      po_line_id: pl?.id ?? null, po_line_item: pl?.item ?? null, po_qty: pl?.qty ?? null, po_unit: pl?.unit ?? null, po_unit_cost: pl?.unit_cost ?? null,
      po_line_total: poTotal, invoice_line_total: invTotal,
      delivered_qty: dq, flags };
  });
  const allMatched = lines.length > 0 && lines.every((l) => l.po_line_id);
  const anyFlags = lines.some((l) => l.flags.length);

  // Billed-to-date on this PO across OTHER invoices — so an invoice that takes
  // the PO over its total value is visible (per-item checks alone miss it).
  const others = await env.DB.prepare(
    "SELECT COALESCE(SUM(net_amount), 0) AS s FROM invoices WHERE matched_po_id = ? AND id != ? AND status != 'dismissed'",
  ).bind(chosen.id, inv.id).first<{ s: number }>();

  return {
    matched_po: { id: chosen.id, po_number: chosen.po_number, supplier: chosen.supplier, project_id: chosen.project_id, project_code: chosen.project_code, total: chosen.total_value ?? null, is_stored: !!inv.matched_po_id },
    suggested,
    deliveries,
    lines,
    // The chosen PO's own lines, so the UI can offer a per-invoice-line PO-line
    // picker to correct/set the match when the auto-match got it wrong or missed.
    po_lines: poLines.map((p) => ({ id: p.id, item: p.item, qty: p.qty, unit: p.unit, unit_cost: p.unit_cost })),
    po_billed_other: others?.s ?? 0,
    match_status: (!allMatched ? "partial" : anyFlags ? "flagged" : "ok") as "partial" | "flagged" | "ok",
    po_ref: poRefOut,
  };
}

invoices.get("/:id/match", async (c) => {
  const denied = requirePermission(c, "commercial.view");
  if (denied) return denied;
  const inv = await c.env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(c.req.param("id")).first<Record<string, unknown>>();
  if (!inv) return c.json({ error: "not found" }, 404);
  return c.json(await computeInvoiceMatch(c.env, inv));
});

/** Persist the chosen PO and per-line PO-line mappings for an invoice. */
invoices.post("/:id/match", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  let body: { po_id?: string | null; line_po_ids?: Array<number | null> } = {};
  try { body = await c.req.json(); } catch { /* none */ }
  const inv = await c.env.DB.prepare("SELECT lines_json, supplier_name FROM invoices WHERE id = ?").bind(c.req.param("id")).first<{ lines_json: string | null; supplier_name: string | null }>();
  if (!inv) return c.json({ error: "not found" }, 404);
  let lines: InvLine[] = [];
  try { lines = inv.lines_json ? JSON.parse(inv.lines_json) : []; } catch { /* none */ }
  if (Array.isArray(body.line_po_ids)) {
    lines = lines.map((l, i) => ({ ...l, po_line_id: body.line_po_ids![i] ?? null }));
  }
  await c.env.DB.prepare("UPDATE invoices SET matched_po_id = ?, lines_json = ? WHERE id = ?")
    .bind((body.po_id || "").trim() || null, JSON.stringify(lines), c.req.param("id")).run();
  // A human just told us which PO line each invoice line bills — remember the
  // wording pairs so the next invoice from this supplier matches on its own.
  const mappedIds = lines.map((l) => l.po_line_id).filter((x): x is number => x != null);
  if (mappedIds.length) {
    const pls = (await c.env.DB.prepare(
      `SELECT id, item FROM po_lines WHERE id IN (${mappedIds.map(() => "?").join(",")})`,
    ).bind(...mappedIds).all<{ id: number; item: string }>()).results;
    const byId = new Map(pls.map((x) => [x.id, x.item]));
    await learnAliases(c.env.DB, "invoice_line", inv.supplier_name,
      lines.filter((l) => l.po_line_id != null).map((l) => ({ alias: l.description, target: byId.get(l.po_line_id!) })),
      c.get("userEmail"));
  }
  return c.json({ ok: true });
});

/** Approve the invoice for payment. The 3-way match is enforced HERE, server-
 *  side: a project invoice only approves cleanly when PO + lines + deliveries
 *  all agree; anything less needs a typed override reason (audited on the
 *  approval). Only approved invoices can be pushed to Xero. */
invoices.post("/:id/approve", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  let body: { note?: string; unapprove?: boolean } = {};
  try { body = await c.req.json(); } catch { /* none */ }
  if (body.unapprove) {
    await c.env.DB.prepare("UPDATE invoices SET approved_at = NULL, approved_by = NULL WHERE id = ?").bind(c.req.param("id")).run();
    return c.json({ ok: true });
  }
  const inv = await c.env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(c.req.param("id")).first<Record<string, unknown>>();
  if (!inv) return c.json({ error: "not found" }, 404);
  const note = (body.note || "").trim();
  if (inv.kind === "project" && !note) {
    const m = await computeInvoiceMatch(c.env, inv);
    if (m.match_status !== "ok") {
      const why = m.match_status === "no_po" ? "no PO is matched"
        : m.match_status === "partial" ? "some lines aren't linked to a PO line"
        : "there are open flags (price/total variance or goods not yet received)";
      return c.json({ error: `This invoice hasn't fully 3-way matched — ${why}. Fix the match (or receive the delivery) or add a reason to approve anyway.` }, 400);
    }
    // A clean auto-match locks in when the approval lands.
    if (!inv.matched_po_id && m.matched_po) {
      await c.env.DB.prepare("UPDATE invoices SET matched_po_id = ? WHERE id = ?").bind(m.matched_po.id, inv.id).run();
    }
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare("UPDATE invoices SET approved_at = ?, approved_by = ?, approval_note = ?, status = CASE WHEN status = 'inbox' THEN 'ready' ELSE status END WHERE id = ?")
    .bind(now, c.get("userEmail"), note || null, c.req.param("id")).run();

  // Approval IS the release: push straight to Xero as a draft bill, same as PO
  // approval auto-pushes. Best-effort — a failure never rolls back the
  // approval; it's stored on the row and the manual Push button retries.
  const alreadyPushed = inv.status === "pushed" || inv.xero_bill_id;
  const kindReady = inv.kind === "project"
    || (inv.kind === "overhead" && isAdmin(c) && !!(inv.nominal_code as string | null)?.trim());
  const canPush = !alreadyPushed && kindReady && !!c.env.XERO_CLIENT_ID && !!c.env.XERO_CLIENT_SECRET
    && !!(inv.supplier_name as string | null)?.trim() && inv.project_id !== "sandbox";
  if (canPush) {
    const r = await pushInvoiceBillToXero(c.env, { ...inv, approved_at: now }, c.req.param("id"));
    return c.json({ ok: true, approved_at: now, ...(r.ok
      ? { pushed: true, xero_bill_number: r.xero_bill_number, ...(r.attach_warning ? { attach_warning: r.attach_warning } : {}) }
      : { pushed: false, xero_error: r.error }) });
  }
  return c.json({ ok: true, approved_at: now });
});

/**
 * Raise a PO retrospectively to cover an invoice that arrived without one, so
 * the 3-way match can complete. Prefills supplier/project/lines from the
 * invoice, goes through the normal PO approval chain (pending approval), and
 * links itself as the invoice's matched PO with lines mapped 1:1.
 */
invoices.post("/:id/create-po", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const inv = await c.env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(c.req.param("id")).first<Record<string, unknown>>();
  if (!inv) return c.json({ error: "not found" }, 404);
  if (inv.matched_po_id) return c.json({ error: "This invoice is already matched to a PO." }, 400);
  const supplier = (inv.supplier_name as string | null)?.trim();
  if (!supplier) return c.json({ error: "Set the supplier before raising a PO for this invoice." }, 400);
  let body: { project_id?: string } = {};
  try { body = await c.req.json(); } catch { /* none */ }
  const projectId = (inv.project_id as string | null) || body.project_id || null;
  if (!projectId) return c.json({ error: "Code the invoice to a project first — the PO needs a project." }, 400);
  const project = await c.env.DB.prepare("SELECT id, code FROM projects WHERE id = ? AND deleted_at IS NULL").bind(projectId).first<{ id: string; code: string }>();
  if (!project) return c.json({ error: "project not found" }, 404);

  let invLines: InvLine[] = [];
  try { invLines = inv.lines_json ? JSON.parse(String(inv.lines_json)) : []; } catch { /* none */ }
  const lineRows = (invLines.length ? invLines : [{ description: `${supplier} — invoice ${inv.invoice_number ?? ""}`.trim(), qty: 1, unit_price: num(inv.net_amount), amount: num(inv.net_amount) } as InvLine])
    .map((l) => {
      // Extraction stores `quantity`; older manual rows use `qty`. Honour both,
      // else the retro PO's lines land as qty 1 and the delivery burn-down lies.
      const rawQty = typeof l.qty === "number" ? l.qty : typeof l.quantity === "number" ? l.quantity : null;
      const qty = rawQty != null && rawQty > 0 ? rawQty : 1;
      const amount = typeof l.amount === "number" ? l.amount : (typeof l.unit_price === "number" ? qty * l.unit_price : 0);
      const unitCost = typeof l.unit_price === "number" ? l.unit_price : (qty > 0 ? amount / qty : amount);
      return { item: l.description || "Invoice line", qty, unit_cost: unitCost, line_total: amount };
    });
  const total = lineRows.reduce((s, l) => s + (l.line_total || 0), 0) || num(inv.net_amount) || 0;

  const now = new Date().toISOString();
  const poId = crypto.randomUUID();
  const poNumber = await nextPONumber(c.env.DB, project.code);
  const tier = tierForApproval(total, false, await loadSettings(c.env.DB));
  await c.env.DB.prepare(
    `INSERT INTO purchase_orders
       (id, po_number, project_id, supplier, status, requires_approval, approval_tier, approval_reason,
        total_value, notes, created_at, created_by, order_type, category)
     VALUES (?, ?, ?, ?, 'pending_approval', 1, ?, ?, ?, ?, ?, ?, 'standard', 'materials')`,
  ).bind(
    poId, poNumber, project.id, supplier,
    tier,
    "retrospective",
    total,
    `Raised retrospectively to cover invoice ${inv.invoice_number ?? `#${inv.id}`} (${supplier}).`,
    now, c.get("userEmail"),
  ).run();
  await c.env.DB.batch(lineRows.map((l) =>
    c.env.DB.prepare(
      `INSERT INTO po_lines (po_id, material_id, item, type, manufacturer, qty, unit, unit_cost, line_total, is_unpriced, is_over_budget)
       VALUES (?, NULL, ?, 'additional', NULL, ?, '', ?, ?, 0, 0)`,
    ).bind(poId, l.item, l.qty, l.unit_cost, l.line_total),
  ));

  // First guess at the budget coding: match each line's wording against the
  // project's live materials list — learned aliases first, then exact wording,
  // then a leading code that hits exactly one budget line. Conservative: no
  // guess beats a wrong one, and every coding stays editable on the PO.
  try {
    const mats = (await c.env.DB.prepare(
      `SELECT m.id, m.item FROM materials m JOIN material_snapshots s ON s.id = m.snapshot_id
        WHERE s.project_id = ? AND s.is_active = 1`,
    ).bind(project.id).all<{ id: number; item: string }>()).results;
    if (mats.length) {
      const budgetAliases = await aliasMap(c.env.DB, "budget_item", supplier);
      const created = (await c.env.DB.prepare("SELECT id, item FROM po_lines WHERE po_id = ?").bind(poId).all<{ id: number; item: string }>()).results;
      const updates: D1PreparedStatement[] = [];
      for (const ln of created) {
        const norm = normText(ln.item);
        let hit = null as { id: number } | null;
        const learned = budgetAliases.get(norm);
        if (learned) hit = mats.find((m) => normText(m.item) === learned) ?? null;
        if (!hit) hit = mats.find((m) => normText(m.item) === norm) ?? null;
        if (!hit) {
          const code = invMaterialCode(ln.item);
          if (code.length >= 3) {
            const codeHits = mats.filter((m) => invMaterialCode(m.item) === code);
            if (codeHits.length === 1) hit = codeHits[0]!;
          }
        }
        if (hit) updates.push(c.env.DB.prepare("UPDATE po_lines SET material_id = ? WHERE id = ?").bind(hit.id, ln.id));
      }
      if (updates.length) await c.env.DB.batch(updates);
    }
  } catch { /* guessing must never block the PO */ }

  // Link the new PO and map invoice lines 1:1 onto its lines.
  const newLines = (await c.env.DB.prepare("SELECT id FROM po_lines WHERE po_id = ? ORDER BY id").bind(poId).all<{ id: number }>()).results;
  const withIds = invLines.map((l, i) => ({ ...l, po_line_id: newLines[i]?.id ?? null }));
  await c.env.DB.prepare("UPDATE invoices SET matched_po_id = ?, lines_json = ?, kind = COALESCE(kind, 'project'), project_id = COALESCE(project_id, ?) WHERE id = ?")
    .bind(poId, JSON.stringify(withIds.length ? withIds : invLines), project.id, inv.id).run();

  return c.json({ ok: true, po_id: poId, po_number: poNumber, status: "pending_approval" });
});

/** The actual DRAFT-bill push, shared by the manual button and the automatic
 *  push on approval. Assumes the caller checked permissions and gates. */
async function pushInvoiceBillToXero(
  env: Env, inv: Record<string, unknown>, id: string,
): Promise<{ ok: true; xero_bill_id: string; xero_bill_number: string | null; attach_warning?: string } | { ok: false; error: string }> {
  const supplierName = (inv.supplier_name as string | null)?.trim();
  if (!supplierName) return { ok: false, error: "Set the supplier before pushing to Xero." };
  try {
    const contactId = await ensureXeroContact(env, supplierName);
    if (!contactId) return { ok: false, error: "Xero isn't connected — connect it in Admin → Xero." };

    // Account code: overhead → the chosen nominal; project → the default purchase
    // account code from settings (optional; Xero falls back to its own default).
    let accountCode: string | undefined = undefined;
    if (inv.kind === "overhead") {
      accountCode = String(inv.nominal_code).trim().split(/\s+/)[0];
    } else {
      const s = await env.DB.prepare("SELECT value FROM settings WHERE key = 'xero_po_account_code'").first<{ value: string }>();
      const code = s?.value?.trim().split(/\s+/)[0];
      if (code) accountCode = code;
    }

    const vat = num(inv.vat_amount);
    const taxType = vat && vat > 0 ? "INPUT2" : "NONE";
    let parsedLines: ExtractedInvoice["lines"] = [];
    try { parsedLines = inv.lines_json ? JSON.parse(String(inv.lines_json)) : []; } catch { /* ignore */ }
    const net = num(inv.net_amount);
    const lineItems = (parsedLines.length && parsedLines.some((l) => num(l.amount) != null))
      ? parsedLines.filter((l) => num(l.amount) != null).map((l) => ({
          Description: l.description || "Invoice line",
          Quantity: 1,
          UnitAmount: Math.round((l.amount as number) * 100) / 100,
          ...(accountCode ? { AccountCode: accountCode } : {}),
          TaxType: taxType,
        }))
      : [{
          Description: `${supplierName}${inv.invoice_number ? ` — inv ${inv.invoice_number}` : ""}`,
          Quantity: 1,
          UnitAmount: Math.round((net ?? num(inv.gross_amount) ?? 0) * 100) / 100,
          ...(accountCode ? { AccountCode: accountCode } : {}),
          TaxType: taxType,
        }];

    // The document's own currency must go across: without CurrencyCode Xero
    // books the figures in the org's base currency, so a €2,600 bill posts as
    // £2,600. Only a clean ISO code is sent; anything odd falls back to the
    // Xero default rather than being rejected.
    const currency = normaliseCurrency(inv.currency as string | null);
    const bill = await createSalesInvoice(env, {
      Type: "ACCPAY",
      Contact: { ContactID: contactId },
      Date: (inv.invoice_date as string) || new Date().toISOString().slice(0, 10),
      DueDate: (inv.due_date as string) || undefined,
      Reference: (inv.invoice_number as string) || undefined,
      Status: "DRAFT",
      LineAmountTypes: "Exclusive",
      ...(currency ? { CurrencyCode: currency } : {}),
      LineItems: lineItems,
    });

    await env.DB.prepare(
      "UPDATE invoices SET status = 'pushed', xero_bill_id = ?, xero_bill_number = ?, xero_sync_status = 'pushed', xero_sync_error = NULL WHERE id = ?",
    ).bind(bill.InvoiceID, bill.InvoiceNumber ?? null, id).run();

    // Foreign currency: read Xero's own FX rate straight back off the bill it
    // just created and store the sterling equivalent. Xero owns the rate (it
    // applies one at creation), so reading it back beats sourcing our own and
    // keeps the app's roll-ups agreeing with the books. Best-effort — the bill
    // exists either way, and a missing rate just leaves the base figures null.
    if (currency && currency !== "GBP") {
      try {
        const full = await getInvoice(env, bill.InvoiceID);
        const rate = typeof full?.CurrencyRate === "number" && full.CurrencyRate > 0 ? full.CurrencyRate : null;
        if (rate) {
          const r2 = (n: number | null) => (n == null ? null : Math.round(n * rate * 100) / 100);
          await env.DB.prepare(
            `UPDATE invoices SET xero_currency_rate = ?, base_currency = 'GBP',
                    base_net_amount = ?, base_gross_amount = ?, fx_rate_at = ? WHERE id = ?`,
          ).bind(rate, r2(num(inv.net_amount)), r2(num(inv.gross_amount)), new Date().toISOString(), id).run();
        }
      } catch (e) {
        console.warn("couldn't read the Xero FX rate back", id, e instanceof Error ? e.message : e);
      }
    }

    // Ride the original invoice PDF along to the Xero bill so the accountant sees
    // the source document, not just the coded lines. Best-effort: this needs the
    // accounting.attachments scope, so a connection made before that scope was
    // added will 403 here — the bill is already created, so we never fail the
    // push; we just surface a warning to prompt a Xero reconnect.
    let attach_warning: string | undefined;
    if (inv.file_key) {
      try {
        const obj = await env.R2.get(String(inv.file_key));
        if (obj) {
          const fname = (inv.file_name as string) || `invoice-${id}.pdf`;
          await uploadAttachment(env, "Invoices", bill.InvoiceID, fname, (inv.file_type as string) || "application/pdf", await obj.arrayBuffer());
        }
      } catch (e) {
        attach_warning = e instanceof Error ? e.message : "couldn't attach the PDF";
        console.warn(`Xero attachment for invoice ${id} failed:`, attach_warning);
      }
    }
    return { ok: true, xero_bill_id: bill.InvoiceID, xero_bill_number: bill.InvoiceNumber ?? null, ...(attach_warning ? { attach_warning } : {}) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Xero push failed";
    await env.DB.prepare("UPDATE invoices SET xero_sync_status = 'failed', xero_sync_error = ? WHERE id = ?")
      .bind(msg, id).run();
    return { ok: false, error: msg };
  }
}

/** Goods collected from the supplier never produce a delivery ticket — log a
 *  receipt against the matched PO's outstanding lines so the 3-way match can
 *  complete honestly (collection IS receipt). One row per line at its
 *  remaining quantity, noted as collected. */
invoices.post("/:id/mark-collected", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const inv = await c.env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(c.req.param("id")).first<Record<string, unknown>>();
  if (!inv) return c.json({ error: "not found" }, 404);
  const poId = inv.matched_po_id as string | null;
  if (!poId) return c.json({ error: "Match the invoice to a PO first — the receipt is logged against the order." }, 400);
  const po = await c.env.DB.prepare("SELECT id, po_number, supplier, project_id FROM purchase_orders WHERE id = ?")
    .bind(poId).first<{ id: string; po_number: string; supplier: string | null; project_id: string }>();
  if (!po) return c.json({ error: "matched PO not found" }, 404);

  const lines = (await c.env.DB.prepare("SELECT id, item, qty, unit FROM po_lines WHERE po_id = ?").bind(poId)
    .all<{ id: number; item: string; qty: number | null; unit: string | null }>()).results;
  const prior = (await c.env.DB.prepare(
    "SELECT po_line_id, SUM(received_qty) AS rq FROM site_deliveries WHERE po_id = ? AND po_line_id IS NOT NULL GROUP BY po_line_id",
  ).bind(poId).all<{ po_line_id: number; rq: number | null }>()).results;
  const priorBy = new Map(prior.map((p) => [p.po_line_id, p.rq ?? 0]));
  const outstanding = lines
    .map((l) => ({ ...l, remaining: Math.max(0, (l.qty ?? 0) - (priorBy.get(l.id) ?? 0)) }))
    .filter((l) => l.remaining > 0.0001);
  if (!outstanding.length) return c.json({ error: "Every line on that PO is already fully received." }, 400);

  // Deliveries live on the site's base project, tagged to the contract.
  const scope = await siteScope(c.env, po.project_id);
  const contract = po.project_id !== scope.baseId ? po.project_id : null;
  const now = new Date().toISOString();
  const when = (inv.invoice_date as string | null) || now.slice(0, 10);
  const actor = c.get("userEmail");
  const note = `Collected from supplier — marked from invoice ${inv.invoice_number ?? `#${inv.id}`}`;
  await c.env.DB.batch(outstanding.map((l) =>
    c.env.DB.prepare(
      `INSERT INTO site_deliveries
         (project_id, supplier, description, po_number, po_id, po_line_id, po_line_desc, received_qty, received_unit,
          status, notes, delivered_at, contract_project_id, completes_po, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,'received',?,?,?,1,?,?)`,
    ).bind(scope.baseId, po.supplier, l.item, po.po_number, po.id, l.id, l.item,
      Math.round(l.remaining * 100) / 100, l.unit ?? null, note, when, contract, now, actor),
  ));
  return c.json({ ok: true, lines: outstanding.length });
});

/** Push the invoice to Xero as a DRAFT Bill (ACCPAY) for the accountant to
 *  review. Project invoices code to the default purchase account (+ optional
 *  project tracking); overheads code to the chosen nominal. */
invoices.post("/:id/push-xero", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const inv = await c.env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(c.req.param("id")).first<Record<string, unknown>>();
  if (!inv) return c.json({ error: "not found" }, 404);
  if (inv.kind === "overhead" && !isAdmin(c)) return c.json({ error: "Forbidden: overheads are admin-only" }, 403);
  // A push always CREATES a Xero bill — pushing twice would duplicate it in the
  // books. Edits made here after a push stay local: amend the draft bill in
  // Xero (or void it there and clear the link) rather than re-pushing.
  if (inv.xero_bill_id) {
    return c.json({ error: `Already in Xero as draft bill ${inv.xero_bill_number ?? inv.xero_bill_id}. Edits made here don't update Xero — amend or void the bill in Xero instead.` }, 409);
  }
  if (!inv.kind) return c.json({ error: "Route this invoice to a Project or Overheads first." }, 400);
  if (inv.kind === "overhead" && !(inv.nominal_code as string | null)?.trim()) {
    return c.json({ error: "Pick an overhead nominal (account code) first." }, 400);
  }
  // 3-way match gate: a job-costed (project) invoice must be approved for payment
  // — i.e. reconciled against its PO/deliveries — before it goes to Xero.
  if (inv.kind === "project" && !inv.approved_at) {
    return c.json({ error: "Approve this invoice for payment (match it to its PO) before pushing to Xero." }, 400);
  }
  const r = await pushInvoiceBillToXero(c.env, inv, c.req.param("id"));
  if (!r.ok) return c.json({ error: r.error }, 502);
  return c.json({ ok: true, xero_bill_id: r.xero_bill_id, xero_bill_number: r.xero_bill_number, ...(r.attach_warning ? { attach_warning: r.attach_warning } : {}) });
});

export default invoices;
