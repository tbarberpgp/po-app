/**
 * A supplier bill as Xero holds it — its lines, the project each line is
 * tracked to, and the files attached to it — in the shape the bill-detail
 * route returns.
 *
 * Why it exists. The bill check (bill-reconcile.ts) compares totals only. When a
 * total disagrees with the invoice (Asgard 018: invoice £3,482.28, Xero
 * £2,975.97), or a bill was keyed straight into Xero and its invoice never
 * reached the app (Asgard 001–009), the answer is on the bill itself: what
 * Accounts keyed, which project they tracked it to, and the PDF they attached.
 * Read-only — nothing here writes to Xero.
 */
import type { XeroBillRaw, XeroAttachmentMeta } from "./client";

export type BillDetailLine = {
  description: string;
  quantity: number | null;
  unit_amount: number | null;
  line_amount: number | null;
  account_code: string | null;
  /** "Project: 26001" style, one per tracking category the line carries. */
  tracking: string[];
};

export type BillDetail = {
  id: string;
  number: string | null;
  reference: string | null;
  type: string;
  status: string;
  contact: string | null;
  date: string | null;
  total: number | null;
  amount_due: number | null;
  lines: BillDetailLine[];
  attachments: Array<{ id: string; file_name: string; mime_type: string | null; size: number | null }>;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function summariseBill(
  raw: XeroBillRaw,
  attachments: XeroAttachmentMeta[],
  parseDate: (v: string | undefined | null) => string | null,
): BillDetail {
  return {
    id: raw.InvoiceID,
    number: raw.InvoiceNumber ?? null,
    reference: raw.Reference || null,
    type: raw.Type,
    status: raw.Status,
    contact: raw.Contact?.Name ?? null,
    date: parseDate(raw.Date)?.slice(0, 10) ?? null,
    total: num(raw.Total),
    amount_due: num(raw.AmountDue),
    lines: (raw.LineItems ?? []).map((l) => ({
      description: (l.Description ?? "").trim(),
      quantity: num(l.Quantity),
      unit_amount: num(l.UnitAmount),
      line_amount: num(l.LineAmount),
      account_code: l.AccountCode ?? null,
      tracking: (l.Tracking ?? [])
        .filter((t) => t.Name || t.Option)
        .map((t) => `${t.Name ?? "Tracking"}: ${t.Option ?? "—"}`),
    })),
    attachments: attachments.map((a) => ({
      id: a.AttachmentID,
      file_name: a.FileName,
      mime_type: a.MimeType ?? null,
      size: num(a.ContentLength),
    })),
  };
}
