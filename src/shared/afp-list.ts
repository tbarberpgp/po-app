/**
 * The project's Applications list: which invoice each application is, and the
 * filter/sort behind the list.
 *
 * Applications are numbered by one counter per project, in the order they were
 * uploaded, and every subcontractor shares it — so Paul Garbutt's fifteen
 * Blyth invoices sit at #3, #9, #10 … #29, #30 with Cladders' in the gaps, and
 * INV-001 (June) lands at the top because it was uploaded last. The invoice
 * number is what people look for, and it was nowhere on the list.
 *
 * There is no invoice-number column on an application. It is read, in order of
 * trust, from the payment reference ("Paid in Xero — INV-013", written when an
 * application is recorded as paid) and then from the uploaded file's name,
 * which is how subcontractors label their invoices in practice:
 *
 *   "Invoice INV - 004.docx"   → INV-004      (Garbutt)
 *   "Invoice 11.pdf", "INV 13.pdf" → INV-011, INV-013
 *   "INV 011.pdf", "Cladders Inv 12.pdf" → INV-011, INV-012   (Cladders)
 *   "Updated Asgard Projects Ltd PGP-019.pdf" → PGP-019     (Asgaard)
 *
 * A name that carries no reference ("CLADDERS LTD copy.pdf") gives null; the
 * screen shows the file name instead of guessing.
 */

export type AfpListRow = {
  id: number;
  app_number: number;
  status: string;
  period_end: string | null;
  counterparty_supplier_id: number | null;
  payment_reference?: string | null;
  source_file_name?: string | null;
};

const XERO_PREFIX = /^paid in xero\s*[—–-]\s*/i;

function pad3(digits: string): string {
  return digits.length < 3 ? digits.padStart(3, "0") : digits;
}

/** The invoice reference an application stands for, or null when nothing names one. */
export function invoiceRefOf(a: Pick<AfpListRow, "payment_reference" | "source_file_name">): string | null {
  const ref = a.payment_reference?.trim();
  if (ref && XERO_PREFIX.test(ref)) {
    const rest = ref.replace(XERO_PREFIX, "").trim();
    if (rest) return rest;
  }
  const name = a.source_file_name?.trim();
  if (!name) return null;
  // Drop every extension ("…009.docx.pdf"), so the digits read are the name's.
  const stem = name.replace(/(\.[a-z0-9]{2,4})+$/i, "");
  const inv = /\binv(?:oice)?(?![a-z])[\s_#-]*(?:inv(?![a-z])[\s_#-]*)?(\d{1,7})\b/i.exec(stem);
  if (inv) return `INV-${pad3(inv[1])}`;
  const coded = /\b([A-Z]{2,5})-(\d{2,7})\b/.exec(stem);
  if (coded) return `${coded[1]}-${coded[2]}`;
  return null;
}

export type AfpSort = "newest" | "oldest";

/** Natural order of two references, so INV-006 sorts before INV-007 and INV-010. */
function compareRefs(x: string | null, y: string | null): number {
  if (x === y) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Filter by status and subcontractor, then order by period end. Applications
 * uploaded the same day share a period end (INV-006 and INV-007 both read
 * 14 Aug), so within one subcontractor the invoice reference breaks the tie;
 * otherwise the app number does.
 */
export function filterAndSortAfps<T extends AfpListRow>(
  rows: readonly T[],
  opts: { status?: string | "all"; supplierId?: number | "all"; sort?: AfpSort },
): T[] {
  const status = opts.status ?? "all";
  const supplier = opts.supplierId ?? "all";
  const dir = (opts.sort ?? "newest") === "newest" ? -1 : 1;
  const kept = rows.filter((r) =>
    (status === "all" || r.status === status)
    && (supplier === "all" || r.counterparty_supplier_id === supplier));
  const refs = new Map(kept.map((r) => [r.id, invoiceRefOf(r)]));
  return [...kept].sort((a, b) => {
    const pa = a.period_end ?? "";
    const pb = b.period_end ?? "";
    if (pa !== pb) return pa < pb ? -dir : dir;
    // Invoice numbers only order one subcontractor's own invoices.
    if (a.counterparty_supplier_id === b.counterparty_supplier_id) {
      const byRef = compareRefs(refs.get(a.id) ?? null, refs.get(b.id) ?? null);
      if (byRef !== 0) return byRef * dir;
    }
    return (a.app_number - b.app_number) * dir;
  });
}

/** Distinct values present in the list, with how many rows carry each — for the filter menus. */
export function countBy<T, K>(rows: readonly T[], key: (r: T) => K): Map<K, number> {
  const m = new Map<K, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return m;
}

/** One labour application, as the Labour subtab's per-subcontractor breakdown needs it. */
export type LabourInvoiceRow = AfpListRow & {
  direction: string;
  this_period_net: number | null;
  prelim_heading?: string | null;
  claimed_amount?: number | null;
};

export type SubcontractorLabour<T extends LabourInvoiceRow = LabourInvoiceRow> = {
  supplierId: number | null;
  /** Certified and paid — labour expended. */
  spent: number;
  /** The part of `spent` recorded as paid. */
  paid: number;
  /** Submitted, not yet certified — the same rows as labourAwaitingCertification. */
  awaiting: number;
  /** Drafts and anything else not yet sent: counted nowhere in the money. */
  notCounted: number;
  /** Every application, oldest period first, then invoice order. */
  invoices: T[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Each subcontractor's labour invoices on a project and where their money sits.
 *
 * Every application is valued at `this_period_net` — its claim for its own
 * period, the figure the Applications list shows and labourAwaitingCertification
 * sums. Summing it across a series cannot double-count, because each
 * application carries only its advance on the one before; so a subcontractor's
 * certified and paid rows add up to what they put into labour expended.
 *
 * Prelims drawdowns (a PM's time against a Preliminaries heading) are left out:
 * they draw on the prelims allowance, not the labour BOQ, and the Prelims tab
 * counts them. Largest spend first.
 */
export function labourBySubcontractor<T extends LabourInvoiceRow>(afps: readonly T[]): SubcontractorLabour<T>[] {
  const by = new Map<number | null, SubcontractorLabour<T>>();
  for (const a of afps) {
    if (a.direction !== "incoming_labour") continue;
    if (a.prelim_heading != null && a.claimed_amount != null) continue;
    let s = by.get(a.counterparty_supplier_id);
    if (!s) {
      s = { supplierId: a.counterparty_supplier_id, spent: 0, paid: 0, awaiting: 0, notCounted: 0, invoices: [] };
      by.set(a.counterparty_supplier_id, s);
    }
    const v = a.this_period_net ?? 0;
    if (a.status === "certified" || a.status === "paid") {
      s.spent += v;
      if (a.status === "paid") s.paid += v;
    } else if (a.status === "submitted") {
      s.awaiting += v;
    } else {
      s.notCounted += v;
    }
    s.invoices.push(a);
  }
  return [...by.values()]
    .map((s) => ({
      ...s,
      spent: r2(s.spent), paid: r2(s.paid), awaiting: r2(s.awaiting), notCounted: r2(s.notCounted),
      invoices: filterAndSortAfps(s.invoices, { sort: "oldest" }),
    }))
    .sort((x, y) => y.spent - x.spent || y.awaiting - x.awaiting);
}
