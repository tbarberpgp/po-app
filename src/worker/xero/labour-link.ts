// Bring labour certificates in line with the bills Xero already holds for them
// (shared/labour-xero-link.ts says why). Runs hourly from the cron and on
// demand from Accounts; `dry` reports what it would do and writes nothing.
import type { Env } from "../env";
import { findContactByName, listInvoices, parseXeroDate, type XeroInvoiceFull } from "./client";
import { planLabourLink, appValue, type LinkApp, type LinkBill } from "../../shared/labour-xero-link";
import { isSandboxId } from "../sandbox";

type Row = LinkApp & {
  app_number: number; project_id: string; project_code: string;
  counterparty_supplier_id: number; supplier_name: string; xero_contact_id: string | null;
  extracted_meta_json: string | null;
};

export type LinkedRow = { id: number; app_number: number; project_code: string; supplier: string; bill: string; value: number };
export type LabourLinkResult = {
  dry: boolean;
  linked_paid: LinkedRow[];
  linked_owed: LinkedRow[];
  now_paid: LinkedRow[];
  amount_differs: Array<LinkedRow & { xero_value: number }>;
  no_contact: string[];
};

export async function linkLabourToXero(env: Env, opts: { dry?: boolean } = {}): Promise<LabourLinkResult> {
  const dry = !!opts.dry;
  const out: LabourLinkResult = { dry, linked_paid: [], linked_owed: [], now_paid: [], amount_differs: [], no_contact: [] };
  const rows = (await env.DB.prepare(
    `SELECT a.id, a.app_number, a.status, a.project_id, p.code AS project_code,
            a.certified_amount, a.this_period_net, a.amount_due, a.xero_po_id, a.xero_po_number,
            a.extracted_meta_json, a.source_file_name, a.counterparty_supplier_id,
            s.name AS supplier_name, s.xero_contact_id
       FROM applications_for_payment a
       JOIN projects p ON p.id = a.project_id
       JOIN suppliers s ON s.id = a.counterparty_supplier_id
      WHERE a.direction = 'incoming_labour' AND a.status IN ('submitted', 'certified')`,
  ).all<Omit<Row, "invoice_number">>()).results
    .filter((r) => !isSandboxId(r.project_id))
    .map((r): Row => {
      let invoice_number: string | null = null;
      try { invoice_number = (JSON.parse(r.extracted_meta_json ?? "null") as { invoice_number?: string } | null)?.invoice_number ?? null; } catch { /* none */ }
      return { ...r, invoice_number };
    });
  if (rows.length === 0) return out;

  const taken = new Set((await env.DB.prepare(
    "SELECT xero_po_id FROM applications_for_payment WHERE xero_po_id IS NOT NULL",
  ).all<{ xero_po_id: string }>()).results.map((r) => r.xero_po_id));

  const bySupplier = new Map<number, Row[]>();
  for (const r of rows) bySupplier.set(r.counterparty_supplier_id, [...(bySupplier.get(r.counterparty_supplier_id) ?? []), r]);

  const now = new Date().toISOString();
  for (const [, apps] of bySupplier) {
    const first = apps[0];
    let contactId = first.xero_contact_id;
    if (!contactId) contactId = (await findContactByName(env, first.supplier_name).catch(() => null))?.ContactID ?? null;
    if (!contactId) { out.no_contact.push(first.supplier_name); continue; }
    const bills = await listInvoices(env, `Type=="ACCPAY"&&Contact.ContactID==guid("${contactId}")`, { summaryOnly: true, maxPages: 10 });

    // Oldest first, so a duplicate in the app can't take the bill from the
    // certificate it was raised for.
    for (const a of [...apps].sort((x, y) => x.app_number - y.app_number)) {
      const plan = planLabourLink(a, bills as LinkBill[], taken);
      if (!plan) continue;
      const bill = plan.bill as XeroInvoiceFull & LinkBill;
      const billNo = bill.InvoiceNumber || bill.InvoiceID;
      const row: LinkedRow = { id: a.id, app_number: a.app_number, project_code: a.project_code, supplier: a.supplier_name, bill: billNo, value: appValue(a) };
      if (plan.kind === "amount_differs") { out.amount_differs.push({ ...row, xero_value: plan.xero }); continue; }
      const paidAt = parseXeroDate(bill.FullyPaidOnDate) ?? now;
      if (plan.kind === "now_paid") {
        out.now_paid.push(row);
        if (!dry) await env.DB.batch([
          env.DB.prepare(
            `UPDATE applications_for_payment SET status = 'paid', paid_at = ?, paid_by = 'xero', payment_reference = ?
              WHERE id = ? AND status = 'certified'`,
          ).bind(paidAt, billNo, a.id),
          audit(env, a.id, "paid_in_xero", { bill: billNo, xero_id: bill.InvoiceID }, now),
        ]);
        continue;
      }
      taken.add(bill.InvoiceID);
      (plan.paid ? out.linked_paid : out.linked_owed).push(row);
      if (dry) continue;
      // Certified at the app's value (it matched the bill to the pound) if
      // nobody certified it already; 'xero' as the certifier says how.
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE applications_for_payment
              SET status = ?, certified_at = COALESCE(certified_at, ?), certified_by = COALESCE(certified_by, 'xero'),
                  certified_amount = COALESCE(certified_amount, ?),
                  paid_at = CASE WHEN ? THEN ? ELSE paid_at END,
                  paid_by = CASE WHEN ? THEN 'xero' ELSE paid_by END,
                  payment_reference = CASE WHEN ? THEN ? ELSE payment_reference END,
                  xero_po_id = ?, xero_po_number = ?, xero_synced_at = ?, xero_sync_status = 'synced', xero_sync_error = NULL
            WHERE id = ? AND status IN ('submitted', 'certified') AND xero_po_id IS NULL`,
        ).bind(plan.paid ? "paid" : "certified", now, appValue(a),
          plan.paid ? 1 : 0, paidAt, plan.paid ? 1 : 0, plan.paid ? 1 : 0, billNo,
          bill.InvoiceID, billNo, now, a.id),
        audit(env, a.id, "linked_to_xero_bill", { bill: billNo, xero_id: bill.InvoiceID, xero_status: bill.Status, from_status: a.status, value: appValue(a) }, now),
      ]);
    }
  }
  return out;
}

function audit(env: Env, id: number, action: string, details: unknown, at: string) {
  return env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('afp', ?, ?, 'xero', ?, ?)`,
  ).bind(String(id), action, JSON.stringify(details), at);
}
