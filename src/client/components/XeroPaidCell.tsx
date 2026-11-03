import { fmtDate, fmtMoney } from "../lib/api";
import type { PurchaseOrder } from "../../shared/types";
import { poPaymentLabel } from "../../shared/po-payment";

/**
 * The PO register's Xero column: has Xero paid for this order? Read from the
 * supplier bills pushed against it (shared/po-payment.ts) — POs themselves
 * stopped going to Xero in Aug 2026, so the old "pending" push state could
 * never move. An order from before then still shows the Xero PO it became.
 */
export function XeroPaidCell({ po }: { po: PurchaseOrder }) {
  const p = po.xero_payment;
  if (p && p.state !== "none") {
    const bills = `${p.bills} bill${p.bills === 1 ? "" : "s"}`;
    const title =
      p.state === "paid"
        ? `Paid in Xero${p.last_paid_at ? ` on ${fmtDate(p.last_paid_at)}` : ""} · ${bills}, ${fmtMoney(p.billed_net)} net`
        : p.state === "part" && p.bills_paid === p.bills
          ? `Every bill paid (${bills}, ${fmtMoney(p.billed_net)} net) — but only that much billed against an order of ${fmtMoney(po.total_value)}`
          : p.state === "part"
            ? `${p.bills_paid} of ${bills} paid · ${fmtMoney(p.paid_net)} of ${fmtMoney(p.billed_net)} net paid · order ${fmtMoney(po.total_value)}`
          : `${bills} in Xero, ${fmtMoney(p.billed_net)} net — none paid yet`;
    const cls = p.state === "paid" ? "approved" : p.state === "part" ? "warn" : "draft";
    return <span className={`pill ${cls}`} style={{ fontSize: 10, whiteSpace: "nowrap" }} title={title}>{poPaymentLabel(p)}</span>;
  }
  if (po.xero_sync_status === "synced") {
    return (
      <span className="pill neutral" style={{ fontSize: 10 }} title={po.xero_po_number ? `Pushed as Xero PO ${po.xero_po_number} — no bill matched yet` : "Pushed to Xero"}>
        {po.xero_po_number ?? "in Xero"}
      </span>
    );
  }
  return <span className="muted" style={{ fontSize: 11 }} title="No bill in Xero for this order yet">—</span>;
}
