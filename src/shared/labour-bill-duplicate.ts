// Finding a labour bill someone has already keyed into Xero by hand.
//
// Until labour ran through Accounts, subbies' invoices were typed straight into
// Xero. A certificate for the same invoice pushed from the app would be a second
// bill for the same work — and Xero would pay both. Before pushing, the app
// looks at the subbie's existing bills for their own invoice number.
import { isDeadBill, refKey } from "./bill-reconcile";

export type ExistingBill = {
  InvoiceID: string;
  InvoiceNumber?: string | null;
  Status?: string | null;
  Total?: number | null;
};

/** The trailing number with its leading zeros dropped: "INV - 016" → "16". */
function trailingNumber(v: string | null | undefined): string {
  const m = /(\d+)$/.exec(refKey(v));
  return m ? m[1].replace(/^0+/, "") || "0" : "";
}

/**
 * The live bill (not voided or deleted) that already carries this invoice
 * number, or null. `bills` must be ONE subcontractor's bills: within a single
 * contact, "INV-016", "INV 16" and "16" are the same invoice, so the number is
 * compared as well as the whole reference. Across contacts that would collide.
 */
export function findKeyedBill(bills: ExistingBill[], invoiceNumber: string | null | undefined): ExistingBill | null {
  const key = refKey(invoiceNumber);
  if (!key) return null;
  const num = trailingNumber(invoiceNumber);
  for (const b of bills) {
    if (isDeadBill(b.Status ?? null)) continue;
    if (refKey(b.InvoiceNumber) === key) return b;
    if (num && trailingNumber(b.InvoiceNumber) === num) return b;
  }
  return null;
}
