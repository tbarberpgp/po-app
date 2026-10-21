// Tying a labour certificate to the bill that is already in Xero for it.
//
// Labour bills were keyed into Xero by hand long before the app could push
// them, so a certificate can sit in the app as "submitted" while Xero has the
// bill — even paid. Read as submitted, the app shows money as awaiting
// certification that has been agreed, or already left. The bill is the record:
// a certificate whose bill is in Xero is certified at that value, and paid once
// Xero says it's paid.
import { findKeyedBill } from "./labour-bill-duplicate";
import { refKey } from "./bill-reconcile";

export type LinkApp = {
  id: number;
  status: string;
  certified_amount: number | null;
  this_period_net: number | null;
  amount_due: number | null;
  xero_po_id: string | null;
  xero_po_number: string | null;
  invoice_number: string | null;   // read off the document, if it was
  source_file_name: string | null;
};

export type LinkBill = {
  InvoiceID: string;
  InvoiceNumber?: string | null;
  Status?: string | null;
  SubTotal?: number | null;
  Total?: number | null;
};

/** The subbie's own invoice number: as read off the document, else the
 *  number a hand-keyed record gave, else the one in the file name ("Invoice
 *  13.pdf", "Invoice INV - 017.docx"). Null when there is none to go on. */
export function invoiceNumberOf(a: Pick<LinkApp, "invoice_number" | "xero_po_number" | "source_file_name">): string | null {
  if (a.invoice_number?.trim()) return a.invoice_number.trim();
  if (a.xero_po_number?.trim()) return a.xero_po_number.trim();
  const stem = (a.source_file_name ?? "").replace(/\.[a-z0-9]+$/i, "");
  // Only a number at the END of the name: "… Claim - 26-06-26 BLYTH" is a
  // date, not an invoice number.
  const m = /(?:^|[^0-9])(\d{1,6})\s*$/.exec(stem);
  return m ? m[1] : null;
}

/** What the certificate is worth in the app, ex VAT. */
export function appValue(a: LinkApp): number {
  return a.certified_amount ?? a.this_period_net ?? a.amount_due ?? 0;
}

/** A bill's value ex VAT. */
export function billValue(b: LinkBill): number {
  return b.SubTotal ?? b.Total ?? 0;
}

export type LinkPlan =
  | { kind: "link"; bill: LinkBill; paid: boolean }       // not linked yet: link it
  | { kind: "now_paid"; bill: LinkBill }                  // linked already, Xero has since paid it
  | { kind: "amount_differs"; bill: LinkBill; app: number; xero: number }
  | null;

/**
 * What to do with one certificate, given its subcontractor's bills in Xero.
 * `taken` = bill ids already tied to another certificate: one bill pays for
 * one certificate, so a duplicate in the app can't claim it a second time.
 */
export function planLabourLink(a: LinkApp, bills: LinkBill[], taken: Set<string>): LinkPlan {
  if (a.status === "paid") return null;
  if (a.xero_po_id) {
    const bill = bills.find((b) => b.InvoiceID === a.xero_po_id);
    return bill && String(bill.Status).toUpperCase() === "PAID" ? { kind: "now_paid", bill } : null;
  }
  const num = invoiceNumberOf(a);
  if (!num || !refKey(num)) return null;
  const bill = findKeyedBill(bills.filter((b) => !taken.has(b.InvoiceID)), num) as LinkBill | null;
  if (!bill) return null;
  const app = appValue(a);
  const xero = billValue(bill);
  // A matching number on a different amount is a question for a person — a
  // part-payment, a credit, or the wrong bill — not something to settle here.
  if (Math.abs(app - xero) > 1) return { kind: "amount_differs", bill, app, xero };
  return { kind: "link", bill, paid: String(bill.Status).toUpperCase() === "PAID" };
}
