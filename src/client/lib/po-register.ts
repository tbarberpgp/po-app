// One reading of a purchase-order register, shared by the screen and both
// exports. The KPI strip, the .xlsx and the PDF all roll up from here so a
// downloaded copy can't quietly disagree with the figures it was taken from.

import type { OrderType, POStatus, PurchaseOrder } from "../../shared/types";
import type { PoDeliveryState } from "../../shared/po-delivery-status";

/** A register row. Both PO lists join the project onto each order, and the
 *  cross-project register prints it as a column of its own. */
export type PoRegisterRow = PurchaseOrder & { project_code?: string; project_name?: string };

/** What a register export is of, and which optional columns it carries. */
export type PoListExport = {
  /** The register's subject — "26004 — Blyth", or "All projects". */
  subject: string;
  /** The slice on screen (status filter, search, count). Omitted when it's the lot. */
  scope?: string;
  /** Cross-project registers name the project on every row. */
  showProject?: boolean;
  /** The Deleted view carries when each order went, who deleted it and why. */
  showDeleted?: boolean;
};

export type PoRegisterTotals = {
  /** Every row, whatever its status. */
  all: number;
  /** Money we're on the hook for — approved + issued + awaiting approval. */
  committed: number;
  pending: number;
  inXero: number;
  xeroFailed: number;
};

export function summarisePoRegister(rows: readonly PurchaseOrder[]): PoRegisterTotals {
  return rows.reduce(
    (acc, r) => {
      acc.all += r.total_value;
      if (r.status === "approved" || r.status === "issued" || r.status === "pending_approval") {
        acc.committed += r.total_value;
      }
      if (r.status === "pending_approval") acc.pending += 1;
      if (r.xero_sync_status === "synced") acc.inXero += 1;
      if (r.xero_sync_status === "failed") acc.xeroFailed += 1;
      return acc;
    },
    { all: 0, committed: 0, pending: 0, inXero: 0, xeroFailed: 0 },
  );
}

/** "pending_approval" → "Pending approval" — the pill's wording, sentence-cased. */
export function poStatusLabel(s: POStatus): string {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Where the push to Xero got to, spelled out — no tick glyph, which a PDF
 *  standard font can't encode. */
export function poXeroStatusLabel(po: PurchaseOrder): string {
  if (po.xero_sync_status === "synced") return "Synced";
  if (po.xero_sync_status === "failed") return "Push failed";
  if (po.xero_sync_status === "pending") return "Queued";
  return "";
}

/** The same, with the Xero PO number appended — one column's worth for the PDF.
 *  The spreadsheet keeps the reference in a column of its own so it can be
 *  looked up against Xero without splitting the cell first. */
export function poXeroLabel(po: PurchaseOrder): string {
  const s = poXeroStatusLabel(po);
  return s && po.xero_po_number ? `${s} · ${po.xero_po_number}` : s;
}

export function poOrderTypeLabel(t: OrderType | undefined): string {
  return t === "framework" ? "Framework" : t === "call_off" ? "Call-off" : "Standard";
}

/** The delivery column in words. Distinct from `poDeliveryLabel` in
 *  shared/po-delivery-status, which needs the full per-line summary; a list
 *  row only carries the state. */
export function poDeliveryStateLabel(s: PoDeliveryState | undefined): string {
  return s === "full" ? "Delivered" : s === "part" ? "Part delivered" : s === "none" ? "Nothing delivered" : "";
}
