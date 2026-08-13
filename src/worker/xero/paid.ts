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

/** A Bill (ACCPAY) we owe — matched by Reference to a material PO's number,
 *  else to an incoming-labour certificate's reference. */
export async function markBillPaid(env: Env, inv: XeroInvoiceFull, paidAt: string): Promise<boolean> {
  const ref = inv.Reference?.trim();
  if (!ref) return false;

  const po = await env.DB.prepare(
    `UPDATE purchase_orders
       SET paid_at = ?, xero_bill_id = ?, paid_reference = ?
     WHERE po_number = ? AND paid_at IS NULL`,
  ).bind(paidAt, inv.InvoiceID, inv.InvoiceNumber ?? ref, ref).run();
  if ((po.meta?.changes ?? 0) > 0) return true;

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

/**
 * Manual backstop for missed webhooks: re-pull paid status from Xero.
 * - Money-in: re-fetch each client application we've invoiced but not yet
 *   marked paid (precise — we hold the invoice ids).
 * - Money-out: scan recently-paid bills and match by Reference (we don't hold
 *   bill ids until a webhook / this scan finds them).
 */
export async function recheckPaidStatus(env: Env): Promise<RecheckResult> {
  const out: RecheckResult = { client_checked: 0, client_marked_paid: 0, bills_scanned: 0, bills_marked_paid: 0 };

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
