/**
 * Restate a subcontractor's labour applications from their invoices, and record
 * the ones Xero has already paid.
 *
 * Why this exists. Paul Garbutt bills Blyth one week at a time ("Site
 * Management Services, 6 × £550"). Before 0136 every labour application was
 * read as a running total, so each week cancelled the last, and a seed in the
 * old creation path carried £2,196 of Cladders' work into his lines and doubled
 * it every application after. Meanwhile Accounts keyed his bills straight into
 * Xero and paid them, so the app was never told. Fifteen invoices for
 * £44,366.58, fourteen of them paid, read £9,346 in the app.
 *
 * A submitted application's figures are locked, and nothing else can turn an
 * old application into a period claim. This puts each application back to what
 * its invoice says:
 *
 *   - the invoice's time goes on ONE named BOQ line (`works_item_id`) and every
 *     other BOQ line is zeroed, which removes the carried-in Cladders work;
 *   - the application's expenses become exactly the ones listed;
 *   - the application becomes a period claim (worth its own lines);
 *   - an invoice Xero has paid is recorded as certified and paid at the
 *     invoice's value, with a payment reference naming the Xero bill.
 *
 * A subcontractor who bills TIME rather than measured work (Cladders: "2 x
 * Operatives x 10 Hours per Shift @ £33.00 P/H") has no BOQ line the time
 * belongs on. `works_as: "dayworks"` books each invoice's time as one Dayworks
 * line instead and zeroes every BOQ line, which also clears figures the
 * reader matched onto measured items from a time invoice.
 *
 * A certificate already agreed is never rewritten — except where Xero paid the
 * invoice at its own value and the app's certificate is the artefact of the
 * running-total reading (Cladders #2: certified £7,480.80, invoice and Xero
 * £9,676.80). That needs `recertify: true` on the invoice, only with
 * `paid_in_xero`, and the old certificate is kept in the audit row.
 *
 * It never sends anything to Xero. The bills are already there and paid; this
 * only tells the app.
 *
 * Every figure comes from the request, which is built from the invoices
 * themselves — nothing here reads a document or guesses. Planning is pure and
 * refuses rather than guesses: an application already certified at a different
 * value, one the app has billed to Xero itself, a prelims drawdown, or a series
 * with an application left out (mixing period claims with running totals in
 * one subcontractor's series miscounts labour expended).
 */
import { EXPENSES_SECTION, isExpenseSection } from "../shared/afp-expenses";
import { DAYWORKS_SECTION, isDayworkSection } from "../shared/afp-dayworks";

export type RestateExpense = { description: string; amount: number };

export type RestateInvoice = {
  afp_id: number;
  invoice_number: string;
  /** The invoice's time, e.g. 6 × £550 = 3300. */
  works: number;
  expenses?: RestateExpense[];
  /** Xero holds this bill as PAID. */
  paid_in_xero: boolean;
  /** Dayworks mode: what the Dayworks line says. Defaults to the invoice number. */
  works_description?: string;
  /** Replace a certificate agreed at a different value with the invoice's —
   *  only when Xero paid the invoice, which is the evidence the old figure was
   *  wrong. */
  recertify?: boolean;
};

/** Where an invoice's time is booked: one named BOQ line, or a Dayworks line. */
export type RestateWorksAs = "boq" | "dayworks";

export type RestateRequest = {
  project_id: string;
  supplier_id: number;
  /** The BOQ (contract) item the invoiced time is booked against. Required
   *  unless works_as is "dayworks". */
  works_item_id?: number | null;
  /** Default "boq". */
  works_as?: RestateWorksAs;
  invoices: RestateInvoice[];
  /** Clear the attention flag on applications this corrects. */
  clear_attention?: boolean;
};

export type RestateAppRow = {
  id: number;
  project_id: string;
  direction: string;
  app_number: number;
  status: "draft" | "submitted" | "certified" | "paid" | string;
  counterparty_supplier_id: number | null;
  prelim_heading: string | null;
  claimed_amount: number | null;
  claim_basis: string | null;
  xero_po_id: string | null;
  retention_pct: number | null;
  vat_pct: number | null;
  cumulative_value: number | null;
  this_period_net: number | null;
  certified_amount: number | null;
  attention_note: string | null;
  unmatched_lines_json: string | null;
  resolved_lines_json: string | null;
};

export type RestateLineRow = {
  id: number;
  afp_id: number;
  contract_item_id: number | null;
  section: string | null;
  description: string;
  contract_value: number;
  cumulative_value: number;
  is_adhoc: number;
  variation_id: number | null;
  display_order: number;
};

export type RestateStep = {
  afp_id: number;
  app_number: number;
  invoice_number: string;
  /** Already restated and paid at this value — nothing to write. */
  no_op: boolean;
  works_as: RestateWorksAs;
  before: {
    status: string;
    claim_basis: string | null;
    value: number;
    certified_amount: number | null;
    /** The named BOQ line's value, or the application's Dayworks total. */
    works_line: number;
    other_boq: Array<{ line_id: number; description: string; value: number }>;
    adhoc: Array<{ line_id: number; section: string | null; description: string; value: number }>;
    attention: boolean;
  };
  after: {
    status: string;
    claim_basis: "period";
    works: number;
    /** Dayworks mode: the Dayworks line's description. */
    works_description: string | null;
    expenses: RestateExpense[];
    value: number;
    certified_amount: number | null;
    payment_reference: string | null;
    attention: boolean;
  };
  /** The BOQ line the time goes on; null in Dayworks mode. */
  works_line_id: number | null;
  works_line_contract_value: number;
};

export type RestatePlan =
  | { ok: true; steps: RestateStep[]; totals: RestateTotals }
  | { ok: false; errors: string[] };

export type RestateTotals = {
  invoices: number;
  value_before: number;
  value_after: number;
  paid_after: number;
  owed_after: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `£${r2(n).toFixed(2)}`;

export function paymentReference(invoiceNumber: string): string {
  return `Paid in Xero — ${invoiceNumber}`;
}

/** What an application is worth to the subcontractor right now, as the screen
 *  shows it: this period's net. */
function currentValue(a: RestateAppRow): number {
  return r2(a.this_period_net ?? 0);
}

export function planRestatement(
  req: RestateRequest,
  apps: RestateAppRow[],
  lines: RestateLineRow[],
): RestatePlan {
  const errors: string[] = [];
  if (!req.project_id) errors.push("project_id required");
  if (!Number.isInteger(req.supplier_id)) errors.push("supplier_id required");
  const worksAs: RestateWorksAs = req.works_as ?? "boq";
  if (worksAs !== "boq" && worksAs !== "dayworks") errors.push(`works_as must be "boq" or "dayworks"`);
  else if (worksAs === "boq" && !Number.isInteger(req.works_item_id)) errors.push("works_item_id required");
  if (!Array.isArray(req.invoices) || req.invoices.length === 0) errors.push("invoices required");
  if (errors.length) return { ok: false, errors };

  const series = apps.filter(
    (a) => a.project_id === req.project_id && a.direction === "incoming_labour"
      && a.counterparty_supplier_id === req.supplier_id,
  );
  const byId = new Map(series.map((a) => [a.id, a]));

  const seenAfp = new Set<number>();
  const seenInv = new Set<string>();
  for (const inv of req.invoices) {
    if (seenAfp.has(inv.afp_id)) errors.push(`application id ${inv.afp_id} is listed twice`);
    seenAfp.add(inv.afp_id);
    const key = (inv.invoice_number ?? "").trim().toUpperCase();
    if (!key) errors.push(`application id ${inv.afp_id}: invoice_number required`);
    else if (seenInv.has(key)) errors.push(`invoice ${inv.invoice_number} is listed twice`);
    seenInv.add(key);
  }

  // The whole series or nothing: one application left on the old running-total
  // reading among period claims makes LABOUR_POSITION count the wrong set.
  for (const a of series) {
    if (a.status !== "draft" && !seenAfp.has(a.id)) {
      errors.push(`#${a.app_number} (id ${a.id}, ${a.status}) belongs to this subcontractor but isn't listed — restate the whole series`);
    }
  }

  const steps: RestateStep[] = [];
  for (const inv of req.invoices) {
    const a = byId.get(inv.afp_id);
    const label = `${inv.invoice_number} (application id ${inv.afp_id})`;
    if (!a) {
      errors.push(`${label}: not an incoming labour application for this subcontractor on this project`);
      continue;
    }
    const tag = `${inv.invoice_number} on #${a.app_number}`;
    if (a.prelim_heading != null && a.claimed_amount != null) {
      errors.push(`${tag}: a prelims drawdown — its claimed amount is its value, so it isn't restated here`);
      continue;
    }
    if (a.xero_po_id) {
      errors.push(`${tag}: the app has already billed this to Xero itself — not touched`);
      continue;
    }
    if ((a.retention_pct ?? 0) !== 0 || (a.vat_pct ?? 0) !== 0) {
      errors.push(`${tag}: carries retention or VAT, so its payable figure isn't the invoice value — not handled here`);
      continue;
    }

    const works = Number(inv.works);
    const expenses = (inv.expenses ?? []).map((e) => ({ description: String(e.description ?? "").trim(), amount: r2(Number(e.amount)) }));
    if (!Number.isFinite(works) || works < 0) { errors.push(`${tag}: works must be £0 or more`); continue; }
    if (expenses.some((e) => !e.description || !Number.isFinite(e.amount) || e.amount <= 0)) {
      errors.push(`${tag}: each expense needs a description and an amount above £0`);
      continue;
    }
    const value = r2(works + expenses.reduce((s, e) => s + e.amount, 0));
    if (value <= 0) { errors.push(`${tag}: comes to £0`); continue; }

    const own = lines.filter((l) => l.afp_id === a.id);
    let wl: RestateLineRow | null = null;
    if (worksAs === "boq") {
      const worksLines = own.filter((l) => l.is_adhoc === 0 && l.contract_item_id === req.works_item_id);
      if (worksLines.length !== 1) {
        errors.push(`${tag}: expected one BOQ line for item ${req.works_item_id}, found ${worksLines.length}`);
        continue;
      }
      wl = worksLines[0];
    }
    if (inv.recertify && !inv.paid_in_xero) {
      errors.push(`${tag}: recertify is only for an invoice Xero has paid`);
      continue;
    }
    const variationLines = own.filter((l) => l.is_adhoc === 1 && (l.variation_id != null || !(isExpenseSection(l.section) || isDayworkSection(l.section))) && l.cumulative_value !== 0);
    if (variationLines.length) {
      errors.push(`${tag}: has variation or other ad-hoc lines with value — not handled here`);
      continue;
    }

    if (a.status === "certified" && a.certified_amount != null && Math.abs(a.certified_amount - value) > 0.005 && !inv.recertify) {
      errors.push(`${tag}: already certified at ${money(a.certified_amount)} but the invoice says ${money(value)} — an agreed certificate isn't rewritten here`);
      continue;
    }
    const alreadyDone = a.status === "paid" && a.claim_basis === "period";
    if (a.status === "paid" && !alreadyDone) {
      errors.push(`${tag}: already marked paid in the app — not touched`);
      continue;
    }
    if (alreadyDone && Math.abs((a.certified_amount ?? 0) - value) > 0.005) {
      errors.push(`${tag}: already paid in the app at ${money(a.certified_amount ?? 0)} but the invoice says ${money(value)}`);
      continue;
    }
    const worksDescription = worksAs === "dayworks"
      ? (String(inv.works_description ?? "").trim() || inv.invoice_number.trim())
      : null;
    const clearAttention = !!req.clear_attention && a.attention_note != null;
    const statusAfter = inv.paid_in_xero ? "paid" : a.status;
    steps.push({
      afp_id: a.id,
      app_number: a.app_number,
      invoice_number: inv.invoice_number.trim(),
      no_op: alreadyDone,
      works_as: worksAs,
      before: {
        status: a.status,
        claim_basis: a.claim_basis,
        value: currentValue(a),
        certified_amount: a.certified_amount,
        works_line: wl
          ? r2(wl.cumulative_value)
          : r2(own.filter((l) => l.is_adhoc === 1 && isDayworkSection(l.section)).reduce((t, l) => t + l.cumulative_value, 0)),
        other_boq: own
          .filter((l) => l.is_adhoc === 0 && l.id !== wl?.id && l.cumulative_value !== 0)
          .map((l) => ({ line_id: l.id, description: l.description, value: r2(l.cumulative_value) })),
        adhoc: own
          .filter((l) => l.is_adhoc === 1)
          .map((l) => ({ line_id: l.id, section: l.section, description: l.description, value: r2(l.cumulative_value) })),
        attention: a.attention_note != null,
      },
      after: {
        status: statusAfter,
        claim_basis: "period",
        works: r2(works),
        works_description: worksDescription,
        expenses,
        value,
        certified_amount: inv.paid_in_xero ? value : (a.status === "certified" ? a.certified_amount : null),
        payment_reference: inv.paid_in_xero ? paymentReference(inv.invoice_number.trim()) : null,
        attention: a.attention_note != null && !clearAttention,
      },
      works_line_id: wl?.id ?? null,
      works_line_contract_value: wl?.contract_value ?? 0,
    });
  }

  if (errors.length) return { ok: false, errors };
  steps.sort((x, y) => x.app_number - y.app_number);
  const totals: RestateTotals = {
    invoices: steps.length,
    value_before: r2(steps.reduce((s, x) => s + x.before.value, 0)),
    value_after: r2(steps.reduce((s, x) => s + x.after.value, 0)),
    paid_after: r2(steps.filter((x) => x.after.status === "paid").reduce((s, x) => s + x.after.value, 0)),
    owed_after: r2(steps.filter((x) => x.after.status !== "paid").reduce((s, x) => s + x.after.value, 0)),
  };
  return { ok: true, steps, totals };
}

export type Sql = { sql: string; params: unknown[] };

/** Phase 1 — the lines and the claim basis. Totals are recomputed after this
 *  (recalcTotals), then phase 2 settles the status from the recomputed figure. */
export function lineWrites(step: RestateStep, worksItemId: number | null | undefined, actor: string, now: string, current: { unmatched_lines_json: string | null; resolved_lines_json: string | null }): Sql[] {
  if (step.no_op) return [];
  const pct = step.works_line_contract_value > 0
    ? Math.min(100, (step.after.works / step.works_line_contract_value) * 100)
    : 0;
  const out: Sql[] = step.works_line_id == null
    // Dayworks mode: no BOQ line carries this invoice's time.
    ? [{
        sql: `UPDATE afp_lines SET percent_complete = 0, cumulative_value = 0
               WHERE afp_id = ? AND is_adhoc = 0`,
        params: [step.afp_id],
      }]
    : [
      {
        sql: `UPDATE afp_lines SET percent_complete = 0, cumulative_value = 0
               WHERE afp_id = ? AND is_adhoc = 0 AND id <> ?`,
        params: [step.afp_id, step.works_line_id],
      },
      {
        sql: `UPDATE afp_lines SET percent_complete = ?, cumulative_value = ?
               WHERE id = ? AND afp_id = ? AND contract_item_id = ?`,
        params: [pct, step.after.works, step.works_line_id, step.afp_id, worksItemId],
      },
    ];
  out.push(
    {
      sql: `DELETE FROM afp_lines
             WHERE afp_id = ? AND is_adhoc = 1 AND variation_id IS NULL
               AND lower(COALESCE(section, '')) IN ('expenses', 'dayworks')`,
      params: [step.afp_id],
    },
  );
  if (step.works_line_id == null && step.after.works > 0) {
    out.push({
      sql: `INSERT INTO afp_lines
              (afp_id, section, description, unit, qty, rate, contract_value,
               percent_complete, cumulative_value, is_adhoc, display_order)
            VALUES (?, ?, ?, NULL, 1, ?, ?, 100, ?, 1,
                    (SELECT COALESCE(MAX(display_order), 0) + 1 FROM afp_lines WHERE afp_id = ?))`,
      params: [step.afp_id, DAYWORKS_SECTION, step.after.works_description ?? step.invoice_number, step.after.works, step.after.works, step.after.works, step.afp_id],
    });
  }
  step.after.expenses.forEach((e) => {
    out.push({
      sql: `INSERT INTO afp_lines
              (afp_id, section, description, unit, qty, rate, contract_value,
               percent_complete, cumulative_value, is_adhoc, display_order)
            VALUES (?, ?, ?, NULL, 1, ?, ?, 100, ?, 1,
                    (SELECT COALESCE(MAX(display_order), 0) + 1 FROM afp_lines WHERE afp_id = ?))`,
      params: [step.afp_id, EXPENSES_SECTION, e.description, e.amount, e.amount, e.amount, step.afp_id],
    });
  });

  // Lines still waiting in the review tray are superseded by the invoice
  // figures above; keep them, marked, in the resolved list so nothing is lost.
  let unmatched: Array<Record<string, unknown>> = [];
  try { unmatched = current.unmatched_lines_json ? JSON.parse(current.unmatched_lines_json) : []; } catch { unmatched = []; }
  let resolved: Array<Record<string, unknown>> = [];
  try { resolved = current.resolved_lines_json ? JSON.parse(current.resolved_lines_json) : []; } catch { resolved = []; }
  const moved = unmatched.map((l) => ({ ...l, resolution: { action: "restated_from_invoice", invoice: step.invoice_number, by: actor, at: now } }));
  out.push({
    sql: `UPDATE applications_for_payment
             SET claim_basis = 'period', unmatched_lines_json = NULL, resolved_lines_json = ?
           WHERE id = ?`,
    params: [moved.length || resolved.length ? JSON.stringify([...resolved, ...moved]) : current.resolved_lines_json, step.afp_id],
  });
  return out;
}

/** Phase 2 — settle the status, after totals are recomputed. Refuses (returns
 *  an error, writes nothing) when the recomputed payable figure isn't the
 *  invoice's: an application is never recorded as paid at a value its invoice
 *  doesn't carry. */
export function settleWrites(step: RestateStep, amountDue: number, actor: string, now: string): { writes: Sql[]; error?: string } {
  if (step.no_op) return { writes: [] };
  if (Math.abs(r2(amountDue) - step.after.value) > 0.005) {
    return { writes: [], error: `${step.invoice_number} on #${step.app_number}: recomputed at ${money(amountDue)}, invoice says ${money(step.after.value)} — left unpaid` };
  }
  const writes: Sql[] = [];
  if (step.after.status === "paid") {
    writes.push({
      sql: `UPDATE applications_for_payment
               SET status = 'paid',
                   submitted_at = COALESCE(submitted_at, ?), submitted_by = COALESCE(submitted_by, ?),
                   certified_amount = ?,
                   certified_at = COALESCE(certified_at, ?), certified_by = COALESCE(certified_by, ?),
                   paid_at = ?, paid_by = ?, payment_reference = ?
             WHERE id = ?`,
      params: [now, actor, step.after.value, now, actor, now, actor, step.after.payment_reference, step.afp_id],
    });
  }
  if (step.before.attention && !step.after.attention) {
    writes.push({
      sql: `UPDATE applications_for_payment
               SET attention_note = NULL, attention_note_by = NULL, attention_note_at = NULL
             WHERE id = ?`,
      params: [step.afp_id],
    });
  }
  writes.push({
    sql: `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
          VALUES ('afp', ?, 'restated_from_invoice', ?, ?, ?)`,
    params: [String(step.afp_id), actor, JSON.stringify({ invoice: step.invoice_number, before: step.before, after: step.after }), now],
  });
  return { writes };
}
