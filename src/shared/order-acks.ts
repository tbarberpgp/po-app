// Delivery arrival tracking — the pure rules, shared by the worker (which reads
// supplier order acknowledgements) and the client (which lists what's coming).
//
// "Before it arrives" runs on dates: the supplier's promised date from their
// order acknowledgement (SOR) where we have one, otherwise the required-by date
// we put on the PO. Once something is received the WhatsApp ticket inbox takes
// over, so every list here is of orders with nothing received yet.

/** Subjects/bodies worth spending a read on. Mirrors the Outlook rule that files
 *  accounts@ mail into the SOR folder, so projects@ catches the same emails:
 *  Alumasc "SOR465143/ Order Acknowledgment", "Fixfast Acknowledgement PO-… (713963)",
 *  "Your Eurocell order confirmation", "Your Fixfast order will be delivered today
 *  between 09:27 - 10:27", "Your delivery has now been arranged for …".
 *  Invoices are left alone — they have their own pipeline. */
export function looksLikeOrderAck(subject: string | null | undefined, body?: string | null): boolean {
  const s = subject ?? "";
  if (/\binvoice\b/i.test(s)) return false;
  const re = /\bSOR\s?\d{5,}|acknowledg|order confirmation|confirmation of (your )?order|will be delivered|delivery (has )?(now )?been (arranged|booked|scheduled)|confirmed (delivery )?date|out for delivery|has been dispatched/i;
  if (re.test(s)) return true;
  return !!body && re.test(body.slice(0, 3000)) && /\b(order|delivery|po)\b/i.test(s);
}

/** Alumasc's ERP prints 24/12 or 29/12 of the current year as a shipment date
 *  when it has none — the same placeholder that once put Dec-2026 receipt dates
 *  on delivery notes. Treat those as "no date given" rather than a promise. */
export function isPlaceholderPromise(supplier: string | null | undefined, date: string | null | undefined): boolean {
  if (!date || !/^\d{4}-12-(24|29)$/.test(date)) return false;
  return /alumasc/i.test(supplier ?? "");
}

export type ArrivalRow = {
  id: string;
  po_number: string;
  supplier: string;
  project_id: string;
  project_code: string;
  status: string;
  total_value: number;
  created_at: string;
  /** Our required-by date on the PO. */
  required_date: string | null;
  /** The supplier's latest promised date (SOR or a phoned-in date). */
  promised_date: string | null;
  promised_source: "sor_folder" | "projects_email" | "manual" | null;
  promised_ref: string | null;
  promised_note: string | null;
  collect_by_us: number;
  collector: string | null;
};

export type ArrivalBuckets = {
  overdue: ArrivalRow[];
  today: ArrivalRow[];
  week: ArrivalRow[];
  collect: ArrivalRow[];
  unconfirmed: ArrivalRow[];
};

/** How far back "No confirmation" looks. Older orders with nothing received are
 *  mostly goods that came and were never booked (see the missing-GRN pile), not
 *  orders anyone is still waiting to hear about. */
export const UNCONFIRMED_WINDOW_DAYS = 45;
/** Statuses that have gone (or are about to go) to the supplier. A PO still
 *  awaiting approval can't be chased for a confirmation. */
const SENT = new Set(["approved", "issued"]);

export function effectiveDate(r: Pick<ArrivalRow, "promised_date" | "required_date">): string | null {
  return r.promised_date || r.required_date || null;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 86_400_000);
}

/** Sort each open order into the tracker's lists. `today` is YYYY-MM-DD.
 *  An order can sit in a date list AND in "No confirmation" — due Friday on our
 *  own date, but the supplier hasn't said so — which is exactly the one to chase. */
export function bucketArrivals(rows: ArrivalRow[], today: string): ArrivalBuckets {
  const out: ArrivalBuckets = { overdue: [], today: [], week: [], collect: [], unconfirmed: [] };
  const byDate = (a: ArrivalRow, b: ArrivalRow) =>
    (effectiveDate(a) ?? "9999").localeCompare(effectiveDate(b) ?? "9999") || a.po_number.localeCompare(b.po_number);
  for (const r of rows) {
    if (r.collect_by_us) { out.collect.push(r); continue; }
    const d = effectiveDate(r);
    if (d) {
      const n = daysBetween(today, d);
      if (n < 0) out.overdue.push(r);
      else if (n === 0) out.today.push(r);
      else if (n <= 7) out.week.push(r);
    }
    if (!r.promised_date && SENT.has(r.status) && daysBetween(r.created_at, today) <= UNCONFIRMED_WINDOW_DAYS) {
      out.unconfirmed.push(r);
    }
  }
  out.overdue.sort(byDate); out.today.sort(byDate); out.week.sort(byDate); out.collect.sort(byDate);
  out.unconfirmed.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return out;
}

export type AckCheck = { tone: "warn" | "ok"; text: string };

const money = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: string) => {
  const t = new Date(d.slice(0, 10) + "T00:00:00Z");
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
};

/** What an acknowledgement tells us about its order that someone should know
 *  now, rather than when the lorry or the invoice turns up. */
export function ackChecks(
  ack: { promised_date: string | null; promised_note?: string | null; goods_total: number | null; carriage: number | null; total_ex_vat: number | null; matched_by?: string | null },
  po: { status: string; delivery_date: string | null; total_value: number } | null,
): AckCheck[] {
  const out: AckCheck[] = [];
  if (!po) return out;
  if (ack.matched_by === "po_number") out.push({ tone: "ok", text: "Our PO number is printed on it — matched exactly." });
  if (!ack.promised_date) {
    out.push({ tone: "warn", text: ack.promised_note || "No delivery date given — chase the supplier for one." });
  } else if (po.delivery_date) {
    const late = daysBetween(po.delivery_date, ack.promised_date);
    if (late > 0) out.push({ tone: "warn", text: `Promised ${day(ack.promised_date)} — ${late} day${late === 1 ? "" : "s"} after our required-by of ${day(po.delivery_date)}.` });
    else out.push({ tone: "ok", text: `Promised ${day(ack.promised_date)} — on or before our required-by.` });
  } else {
    out.push({ tone: "ok", text: "The PO had no required-by date — this gives it one." });
  }
  if (po.status === "pending_approval" || po.status === "draft") {
    out.push({ tone: "warn", text: "The supplier has acknowledged it, but the PO is still awaiting approval." });
  }
  if (ack.carriage && ack.carriage > 0) {
    out.push({ tone: "warn", text: `Carriage ${money(ack.carriage)} is on the acknowledgement — check it's on the PO, or the invoice will come in over.` });
  }
  const goods = ack.goods_total ?? (ack.total_ex_vat != null ? ack.total_ex_vat - (ack.carriage ?? 0) : null);
  if (goods != null && po.total_value > 0) {
    const diff = Math.round((goods - po.total_value) * 100) / 100;
    if (Math.abs(diff) >= Math.max(1, po.total_value * 0.01)) {
      out.push({ tone: "warn", text: `Goods acknowledged at ${money(goods)} against ${money(po.total_value)} on the PO (${diff > 0 ? "+" : "−"}${money(Math.abs(diff))}).` });
    } else {
      out.push({ tone: "ok", text: `Goods total agrees with the PO (${money(goods)}).` });
    }
  }
  return out;
}

/** An order acknowledgement as the SOR inbox and the PO page show it. */
export type OrderAckView = {
  id: number;
  source: "sor_folder" | "projects_email" | "manual";
  kind: "acknowledgement" | "delivery_notice" | "other";
  sender: string | null;
  subject: string | null;
  received_at: string | null;
  file_name: string | null;
  file_url: string | null;
  supplier_name: string | null;
  supplier_order_ref: string | null;
  our_po_ref: string | null;
  ack_date: string | null;
  promised_date: string | null;
  promised_note: string | null;
  delivery_address: string | null;
  delivery_instructions: string | null;
  goods_total: number | null;
  carriage: number | null;
  total_ex_vat: number | null;
  lines: Array<{ code: string | null; description: string; quantity: number | null; unit: string | null; unit_price: string | null; amount: number | null; line_date: string | null }>;
  po_id: string | null;
  po_number: string | null;
  po_status: string | null;
  po_total: number | null;
  po_required: string | null;
  project_code: string | null;
  matched_by: "po_number" | "supplier_ref" | "manual" | null;
  suggested_po_id: string | null;
  suggested_po_number: string | null;
  suggest_reason: string | null;
  status: "matched" | "pending" | "dismissed";
  dismiss_reason: string | null;
  actioned_by: string | null;
  actioned_at: string | null;
  checks: AckCheck[];
};

export type PoArrival = {
  collect_by_us: boolean;
  collector: string | null;
  required_date: string | null;
  promised_date: string | null;
  promised: OrderAckView | null;
  acks: OrderAckView[];
  received_first: string | null;
  received_count: number;
};
