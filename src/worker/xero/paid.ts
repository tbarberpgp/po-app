// Paid-status matching, shared by the Xero webhook (real-time) and the manual
// "re-check paid status" backstop. Maps a paid Xero invoice/bill back to the
// app record it settles.
import type { Env } from "../env";
import { getInvoice, isInvoicePaid, listInvoices, parseXeroDate, type XeroInvoiceFull } from "./client";

/** Client application (ACCREC sales invoice) — matched by the stored invoice id. */
export async function markClientApplicationPaid(env: Env, inv: XeroInvoiceFull, paidAt: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE applications_for_payment
       SET status = 'paid', paid_at = ?, paid_by = 'xero', payment_reference = ?
     WHERE xero_invoice_id = ? AND status != 'paid'`,
  ).bind(paidAt, inv.InvoiceNumber ?? null, inv.InvoiceID).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** A supplier invoice we pushed as this bill — matched by the bill id we hold.
 *  The order it was matched to reads its paid state from these rows. */
export async function markSupplierInvoicePaid(env: Env, inv: XeroInvoiceFull, paidAt: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE invoices SET paid_at = ?, amount_paid = ?, xero_bill_status = ?
      WHERE xero_bill_id = ? AND paid_at IS NULL`,
  ).bind(paidAt, inv.AmountPaid ?? inv.Total ?? null, inv.Status, inv.InvoiceID).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** A Bill (ACCPAY) we owe — matched first to the supplier invoice we pushed as
 *  it, else by Reference to a material PO's number, else to an incoming-labour
 *  certificate's reference. */
export async function markBillPaid(env: Env, inv: XeroInvoiceFull, paidAt: string): Promise<boolean> {
  if (await markSupplierInvoicePaid(env, inv, paidAt)) return true;
  const ref = inv.Reference?.trim();

  const po = ref ? await env.DB.prepare(
    `UPDATE purchase_orders
       SET paid_at = ?, xero_bill_id = ?, paid_reference = ?
     WHERE po_number = ? AND paid_at IS NULL`,
  ).bind(paidAt, inv.InvoiceID, inv.InvoiceNumber ?? ref, ref).run() : null;
  if ((po?.meta?.changes ?? 0) > 0) return true;

  // A labour certificate tied to this bill by its id — pushed from the app, or
  // linked to a bill keyed in by hand. Holds whatever the bill's Reference says.
  const byId = await env.DB.prepare(
    `UPDATE applications_for_payment
       SET status = 'paid', paid_at = ?, paid_by = 'xero', payment_reference = ?
     WHERE direction = 'incoming_labour' AND status = 'certified' AND xero_po_id = ?`,
  ).bind(paidAt, inv.InvoiceNumber ?? ref ?? null, inv.InvoiceID).run();
  if ((byId.meta?.changes ?? 0) > 0) return true;
  if (!ref) return false;

  const cert = await env.DB.prepare(
    `UPDATE applications_for_payment
       SET status = 'paid', paid_at = ?, paid_by = 'xero', payment_reference = ?
     WHERE direction = 'incoming_labour' AND status != 'paid'
       AND id IN (
         SELECT a.id FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
         WHERE (p.code || ' Labour Cert #' || a.app_number) = ?
       )`,
  ).bind(paidAt, inv.InvoiceNumber ?? ref, ref).run();
  return (cert.meta?.changes ?? 0) > 0;
}

/** Apply one already-fetched invoice if it's paid. Returns true if a record changed. */
export async function applyPaidInvoice(env: Env, inv: XeroInvoiceFull): Promise<boolean> {
  if (!isInvoicePaid(inv)) return false;
  const paidAt = parseXeroDate(inv.FullyPaidOnDate) ?? new Date().toISOString();
  if (inv.Type === "ACCREC") return markClientApplicationPaid(env, inv, paidAt);
  if (inv.Type === "ACCPAY") return markBillPaid(env, inv, paidAt);
  return false;
}

export type RecheckResult = {
  client_checked: number;
  client_marked_paid: number;
  bills_scanned: number;
  bills_marked_paid: number;
};

export type SupplierBillSync = { checked: number; marked_paid: number; part_paid: number; voided: number };

/**
 * Read back every supplier bill we pushed and haven't yet seen paid, by the ids
 * we hold — precise, unlike the Reference scan, and independent of the webhook
 * ever firing. Runs hourly from the cron. Xero takes a list of ids per request,
 * so this is a handful of calls however many bills are open.
 */
export async function syncSupplierBillPayments(env: Env): Promise<SupplierBillSync> {
  const out: SupplierBillSync = { checked: 0, marked_paid: 0, part_paid: 0, voided: 0 };
  const open = (await env.DB.prepare(
    `SELECT xero_bill_id FROM invoices
      WHERE xero_bill_id IS NOT NULL AND paid_at IS NULL
        AND COALESCE(xero_bill_status, '') NOT IN ('VOIDED', 'DELETED')`,
  ).all<{ xero_bill_id: string }>()).results.map((r) => r.xero_bill_id);
  for (let i = 0; i < open.length; i += 50) {
    const bills = await listInvoices(env, "", { ids: open.slice(i, i + 50), maxPages: 1 });
    for (const inv of bills) {
      out.checked++;
      if (isInvoicePaid(inv)) {
        const paidAt = parseXeroDate(inv.FullyPaidOnDate) ?? new Date().toISOString();
        if (await markSupplierInvoicePaid(env, inv, paidAt)) out.marked_paid++;
        continue;
      }
      if ((inv.AmountPaid ?? 0) > 0) out.part_paid++;
      if (inv.Status === "VOIDED" || inv.Status === "DELETED") out.voided++;
      await env.DB.prepare(
        "UPDATE invoices SET amount_paid = ?, xero_bill_status = ? WHERE xero_bill_id = ? AND paid_at IS NULL",
      ).bind(inv.AmountPaid ?? 0, inv.Status, inv.InvoiceID).run();
    }
  }
  return out;
}

/**
 * Manual backstop for missed webhooks: re-pull paid status from Xero.
 * - Money-in: re-fetch each client application we've invoiced but not yet
 *   marked paid (precise — we hold the invoice ids).
 * - Money-out: read back every bill we pushed by its id, then scan recently-paid
 *   bills and match by Reference for the ones keyed into Xero by hand.
 */
export async function recheckPaidStatus(env: Env): Promise<RecheckResult> {
  const out: RecheckResult = { client_checked: 0, client_marked_paid: 0, bills_scanned: 0, bills_marked_paid: 0 };

  // Supplier bills we pushed: read back by id first.
  const pushed = await syncSupplierBillPayments(env);
  out.bills_scanned += pushed.checked;
  out.bills_marked_paid += pushed.marked_paid;

  const unpaid = await env.DB.prepare(
    `SELECT xero_invoice_id FROM applications_for_payment
      WHERE direction = 'outgoing' AND status != 'paid' AND xero_invoice_id IS NOT NULL`,
  ).all<{ xero_invoice_id: string }>();
  for (const r of unpaid.results) {
    out.client_checked++;
    const inv = await getInvoice(env, r.xero_invoice_id);
    if (inv && (await applyPaidInvoice(env, inv))) out.client_marked_paid++;
  }

  // Recently-paid bills only, to keep the scan bounded for established orgs.
  const since = new Date(Date.now() - 120 * 86_400_000);
  const bills = await listInvoices(env, 'Type=="ACCPAY"&&Status=="PAID"', { modifiedSince: since, maxPages: 20 });
  for (const inv of bills) {
    out.bills_scanned++;
    const paidAt = parseXeroDate(inv.FullyPaidOnDate) ?? new Date().toISOString();
    if (await markBillPaid(env, inv, paidAt)) out.bills_marked_paid++;
  }
  return out;
}
