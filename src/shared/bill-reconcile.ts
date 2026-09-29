// Reconcile the bills a supplier has in Xero against the invoices the app knows
// about. Read-only: nothing here writes to Xero or to the app — it exists so a
// bill somebody keyed straight into Xero (bypassing the Accounts inbox) stops
// being invisible to us.
//
// The app pushes a bill with Reference = the supplier's invoice number and lets
// Xero pick the InvoiceNumber, whereas a hand-keyed bill usually carries the
// supplier's number in InvoiceNumber and leaves Reference blank. So a match has
// to consider both fields on the Xero side, and the id we stored at push time
// takes precedence over any of it.

export type XeroBillSide = {
  id: string;
  /** Xero's InvoiceNumber — its own for a pushed bill, the supplier's when keyed by hand. */
  number: string | null;
  /** Xero's Reference — the supplier's invoice number on anything we pushed. */
  reference: string | null;
  status: string | null;
  total: number | null;
  amount_due: number | null;
  currency: string | null;
  /** ISO date (already parsed out of Xero's "/Date(…)/" form). */
  date: string | null;
  contact_name: string | null;
};

export type AppInvoiceSide = {
  id: number;
  invoice_number: string | null;
  supplier_name: string | null;
  gross_amount: number | null;
  currency: string | null;
  status: string | null;
  invoice_date: string | null;
  xero_bill_id: string | null;
  xero_bill_number: string | null;
  project_code: string | null;
};

/** Just enough of a PO to say "this Xero bill quotes one of our order numbers". */
export type AppPoSide = {
  po_number: string;
  supplier: string | null;
  total_value: number | null;
  xero_bill_id: string | null;
};

export type MatchBasis = "bill_id" | "invoice_number" | null;

export type ReconcileRow = {
  /** Stable key for React lists — the Xero id where there is one, else the app row. */
  key: string;
  state: "matched" | "xero_only" | "app_only";
  match_by: MatchBasis;
  xero: XeroBillSide | null;
  app: AppInvoiceSide | null;
  /** A Xero-only bill that quotes one of our PO numbers — the likeliest explanation. */
  po_number: string | null;
  /** Xero total minus the app's gross, when both sides have a figure. Positive = Xero is higher. */
  amount_delta: number | null;
  /** Plain-English observations shown under the row. Never blocking — this screen only reports. */
  notes: string[];
};

export type ReconcileSummary = {
  matched: number;
  xero_only: number;
  app_only: number;
  amount_mismatches: number;
  /** Gross value of bills that exist in Xero with nothing behind them here. */
  xero_only_total: number;
};

export type ReconcileResult = { rows: ReconcileRow[]; summary: ReconcileSummary };

/** Voided and deleted bills are still returned by Xero; they aren't money owed. */
export function isDeadBill(status: string | null): boolean {
  const s = (status ?? "").toUpperCase();
  return s === "VOIDED" || s === "DELETED";
}

/**
 * Compare two document references the way a person would: case, spaces and
 * punctuation don't count, so "INV-0012 345" and "inv0012345" are the same
 * reference. Returns "" when there's nothing comparable left.
 */
export function refKey(v: string | null | undefined): string {
  return (v ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/**
 * A looser key for the same reference: the trailing run of digits with leading
 * zeros dropped, so "INV-0012345" and "12345" meet. Only used as a second pass,
 * and only for runs of four digits or more — three digits collide far too
 * readily to be safe as an identity.
 */
export function looseRefKey(v: string | null | undefined): string {
  const m = /(\d{4,})$/.exec(refKey(v));
  if (!m) return "";
  const digits = m[1].replace(/^0+/, "");
  return digits.length >= 4 ? digits : "";
}

/** Money comparison at the penny — floats from two systems rarely land equal. */
function samePence(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

function pushIndex(index: Map<string, number[]>, key: string, i: number) {
  if (!key) return;
  const at = index.get(key);
  if (at) at.push(i);
  else index.set(key, [i]);
}

/**
 * Match Xero's bills for a supplier against the app's invoices for that same
 * supplier, in three passes of decreasing confidence:
 *   1. the Xero bill id we stored when the app pushed the bill (definitive);
 *   2. the reference written on both sides, compared loosely;
 *   3. for whatever is left in Xero, a PO number quoted on the bill — not a
 *      match, but the reason a bill can be legitimately absent from the inbox.
 * Anything still unpaired is reported as one-sided, which is the whole point.
 */
export function reconcileBills(
  bills: XeroBillSide[],
  invoices: AppInvoiceSide[],
  pos: AppPoSide[] = [],
): ReconcileResult {
  const takenApp = new Set<number>();          // indexes into `invoices`
  const rows: ReconcileRow[] = [];
  const pairedBill = new Set<number>();        // indexes into `bills`

  const pair = (bi: number, ai: number, basis: MatchBasis) => {
    pairedBill.add(bi);
    takenApp.add(ai);
    rows.push(buildMatchedRow(bills[bi], invoices[ai], basis));
  };

  // Pass 1 — the id the app recorded at push time.
  const byBillId = new Map<string, number>();
  bills.forEach((b, i) => { if (b.id) byBillId.set(b.id, i); });
  invoices.forEach((inv, ai) => {
    const bi = inv.xero_bill_id ? byBillId.get(inv.xero_bill_id) : undefined;
    if (bi != null && !pairedBill.has(bi)) pair(bi, ai, "bill_id");
  });

  // Pass 2 — references. A Xero bill offers two fields that might hold the
  // supplier's number, and either can be the one that lines up.
  for (const loose of [false, true]) {
    const key = loose ? looseRefKey : refKey;
    const appIndex = new Map<string, number[]>();
    invoices.forEach((inv, ai) => {
      if (takenApp.has(ai)) return;
      pushIndex(appIndex, key(inv.invoice_number), ai);
    });
    bills.forEach((b, bi) => {
      if (pairedBill.has(bi)) return;
      for (const candidate of [b.reference, b.number]) {
        const k = key(candidate);
        if (!k) continue;
        const at = (appIndex.get(k) ?? []).find((ai) => !takenApp.has(ai));
        if (at != null) { pair(bi, at, "invoice_number"); return; }
      }
    });
  }

  // Pass 3 — everything Xero has that we couldn't tie to an invoice record.
  const poByKey = new Map<string, AppPoSide>();
  for (const po of pos) {
    const k = refKey(po.po_number);
    if (k && !poByKey.has(k)) poByKey.set(k, po);
  }
  bills.forEach((b, bi) => {
    if (pairedBill.has(bi)) return;
    let po: AppPoSide | null = null;
    for (const candidate of [b.reference, b.number]) {
      const hit = poByKey.get(refKey(candidate));
      if (hit) { po = hit; break; }
    }
    const notes: string[] = [];
    if (isDeadBill(b.status)) {
      notes.push(`${(b.status ?? "").toLowerCase()} in Xero — no money owed, shown so it isn't chased twice.`);
    } else if (po) {
      notes.push(`Quotes our order ${po.po_number}, but no invoice was logged here against it.`);
    } else {
      notes.push("Only in Xero — it never came through the Accounts inbox.");
    }
    rows.push({
      key: `x:${b.id}`,
      state: "xero_only",
      match_by: null,
      xero: b,
      app: null,
      po_number: po?.po_number ?? null,
      amount_delta: null,
      notes,
    });
  });

  // Whatever is left on our side: logged here, absent from Xero.
  invoices.forEach((inv, ai) => {
    if (takenApp.has(ai)) return;
    const notes: string[] = [];
    if (inv.status === "pushed" || inv.xero_bill_id) {
      // The app believes it posted this, so either the bill was deleted in Xero
      // or it fell outside the window/supplier this check was run for.
      notes.push("The app recorded this as pushed, but no matching bill came back from Xero.");
    } else if (inv.status === "dismissed") {
      notes.push("Dismissed here, so its absence from Xero is expected.");
    } else {
      notes.push("Sitting in the app, not yet in Xero.");
    }
    rows.push({
      key: `a:${inv.id}`,
      state: "app_only",
      match_by: null,
      xero: null,
      app: inv,
      po_number: null,
      amount_delta: null,
      notes,
    });
  });

  rows.sort(rowOrder);
  return { rows, summary: summarise(rows) };
}

function buildMatchedRow(b: XeroBillSide, inv: AppInvoiceSide, basis: MatchBasis): ReconcileRow {
  const notes: string[] = [];
  let delta: number | null = null;

  if (typeof b.total === "number" && typeof inv.gross_amount === "number") {
    const bCur = (b.currency ?? "GBP").toUpperCase();
    const aCur = (inv.currency ?? "GBP").toUpperCase();
    if (bCur !== aCur) {
      // Comparing the numbers across two currencies would invent a discrepancy
      // (or hide one), so say what's different and leave the figures alone.
      notes.push(`Xero holds this in ${bCur}, the app in ${aCur} — the totals aren't comparable.`);
    } else if (!samePence(b.total, inv.gross_amount)) {
      delta = Math.round((b.total - inv.gross_amount) * 100) / 100;
      notes.push(`Totals disagree by ${delta > 0 ? "+" : ""}${delta.toFixed(2)} ${bCur} (Xero ${b.total.toFixed(2)}, app ${inv.gross_amount.toFixed(2)}).`);
    }
  }

  if (isDeadBill(b.status)) {
    notes.push(`The Xero bill is ${(b.status ?? "").toLowerCase()}, but the app still holds it as ${inv.status ?? "open"}.`);
  }
  if (basis === "invoice_number" && !inv.xero_bill_id) {
    // Worth flagging: it means the bill was keyed into Xero for an invoice we
    // also hold, rather than pushed from here — so it can be double-entered.
    notes.push("Matched on the invoice number — the app never pushed this bill, so it was entered in Xero separately.");
  }

  return {
    key: `x:${b.id}`,
    state: "matched",
    match_by: basis,
    xero: b,
    app: inv,
    po_number: null,
    amount_delta: delta,
    notes,
  };
}

/** Problems first — a reconciliation is read top-down and the exceptions are the
 *  point. Within a group, newest document first. */
function rowOrder(a: ReconcileRow, b: ReconcileRow): number {
  const rank = (r: ReconcileRow) =>
    r.state === "xero_only" ? 0
    : r.state === "app_only" ? 1
    : r.amount_delta != null || r.notes.length > 0 ? 2
    : 3;
  const d = rank(a) - rank(b);
  if (d !== 0) return d;
  const date = (r: ReconcileRow) => r.xero?.date ?? r.app?.invoice_date ?? "";
  return date(b).localeCompare(date(a));
}

function summarise(rows: ReconcileRow[]): ReconcileSummary {
  const s: ReconcileSummary = { matched: 0, xero_only: 0, app_only: 0, amount_mismatches: 0, xero_only_total: 0 };
  for (const r of rows) {
    if (r.state === "matched") s.matched++;
    if (r.state === "app_only") s.app_only++;
    if (r.state === "xero_only") {
      s.xero_only++;
      // A voided bill is in the list for completeness, not as an exposure.
      if (!isDeadBill(r.xero?.status ?? null)) s.xero_only_total += r.xero?.total ?? 0;
    }
    if (r.amount_delta != null) s.amount_mismatches++;
  }
  s.xero_only_total = Math.round(s.xero_only_total * 100) / 100;
  return s;
}
