// Has Xero paid for this order?
//
// POs themselves no longer go to Xero — the supplier's invoice does, as an
// ACCPAY bill, once it has been matched to its order and approved. So "is this
// PO paid" is a question about the bills behind it: every one of them paid,
// and between them covering the order. Bills that were voided or deleted in
// Xero are not owed and drop out; invoices never pushed are not in Xero at all.
//
// "paid" deliberately needs the order to be billed in full as well. One bill
// of three paid, with the other two still to arrive, is not a paid order — it
// is "part", and calling it paid would hide exactly the money still to go out.
//
// "Billed in full" is measured net OR gross. POs are meant to be net, but some
// were raised at shelf prices with VAT in (Toolstation, Screwfix, B&Q…): a
// £57.00 order billed £47.50 + VAT, paid in full, read as "part paid" against
// the net figure alone — 9 such orders on the first live sync (2026-11-03).

import { poBilledState } from "./po-delivery-status";

export type PoBill = {
  /** Net of VAT, in pounds — measured against the PO's own (net) value. */
  net: number | null;
  /** Gross of VAT, in the bill's currency — what Xero's AmountPaid is in. */
  gross: number | null;
  /** Gross of VAT in pounds, for an order raised with VAT in. Falls back to
   *  `gross` when absent. */
  gross_gbp?: number | null;
  paid_at: string | null;
  amount_paid: number | null;
  xero_bill_status: string | null;
};

export type PoPaymentState = "none" | "unpaid" | "part" | "paid";

export type PoPayment = {
  state: PoPaymentState;
  /** Bills in Xero against the order (voided/deleted ones left out). */
  bills: number;
  bills_paid: number;
  billed_net: number;
  /** Net value paid, a part-paid bill counting pro rata. */
  paid_net: number;
  /** When the last bill was settled — the order's paid date once state = paid. */
  last_paid_at: string | null;
};

const VOID = new Set(["VOIDED", "DELETED"]);

export function summarisePoPayment(bills: PoBill[], poValue: number | null | undefined): PoPayment {
  const live = bills.filter((b) => !VOID.has((b.xero_bill_status ?? "").toUpperCase()));
  let billed = 0, billedGross = 0, paid = 0, nPaid = 0, last: string | null = null, anyMoney = false;
  for (const b of live) {
    const net = b.net ?? 0;
    billed += net;
    billedGross += b.gross_gbp ?? b.gross ?? net;
    if (b.paid_at) {
      nPaid++;
      paid += net;
      anyMoney = true;
      if (!last || b.paid_at > last) last = b.paid_at;
    } else if ((b.amount_paid ?? 0) > 0.005 && (b.gross ?? 0) > 0) {
      paid += net * Math.min(1, (b.amount_paid ?? 0) / (b.gross ?? 1));
      anyMoney = true;
    }
  }
  const base = { bills: live.length, bills_paid: nPaid, billed_net: billed, paid_net: paid };
  if (live.length === 0) return { ...base, state: "none", last_paid_at: null };
  if (!anyMoney) return { ...base, state: "unpaid", last_paid_at: null };
  // Gross counts only on a match, never on "over": a £100 order billed £90 + VAT
  // is £108 gross and still has £10 to bill.
  const net = poBilledState(billed, poValue);
  const covered = net === "full" || net === "over" || net === "unknown" || poBilledState(billedGross, poValue) === "full";
  const allPaid = nPaid === live.length && covered;
  return { ...base, state: allPaid ? "paid" : "part", last_paid_at: allPaid ? last : null };
}

/** The pill's wording. */
export function poPaymentLabel(p: Pick<PoPayment, "state">): string {
  return p.state === "paid" ? "paid" : p.state === "part" ? "part paid" : p.state === "unpaid" ? "unpaid" : "";
}
