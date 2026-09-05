// The two-stage release, in one place, for both kinds of payable that reach
// Xero: supplier invoices from the Accounts inbox, and subcontractor labour
// certificates from Applications. Imported by both the worker (to decide what
// it will let into Xero) and the client (to decide what it offers), for the
// same reason permissions.ts is shared: a gate defined twice ends up enforced
// on the server but hidden in the UI, or offered in the UI and refused by the
// server.
//
// Both payables used to reach Xero on ONE signature — approving the money and
// releasing it were the same act. Keeping the two apart is the whole point of
// this module, and it lives in one file because it is one rule: whoever agrees
// what is owed is not the person who lets it leave the company.
//
// The two shapes carry different column names (invoices: approved_at /
// released_at; certificates: pay_approved_at / pay_released_at), so the
// predicates come in pairs rather than one generic function over a union —
// naming the fields explicitly is what makes a misread field a type error.

/** The fields either side needs to judge where an invoice stands. A subset of
 *  `Invoice` so the worker can pass a raw DB row without shaping it first. */
export type ReleasableInvoice = {
  kind?: string | null;
  nominal_code?: string | null;
  approved_at?: string | null;
  released_at?: string | null;
  status?: string | null;
  xero_bill_id?: string | null;
};

/** Already a bill in Xero (or on its way as one), so past this gate entirely. */
export function isInXero(inv: ReleasableInvoice): boolean {
  return inv.status === "pushed" || !!inv.xero_bill_id;
}

/**
 * Does this invoice need an approve-for-payment before it can be signed off?
 *
 * Overheads don't: no PO, no delivery, nothing to 3-way match, and so no
 * approve-for-payment step in the UI at all. Coding one to a nominal is the
 * work that precedes sign-off. Requiring an approval that cannot be given
 * would make every overhead unpayable.
 */
export function needsApprovalBeforeRelease(inv: ReleasableInvoice): boolean {
  return inv.kind !== "overhead";
}

/** Has the work that precedes sign-off been done? */
export function readyForRelease(inv: ReleasableInvoice): boolean {
  return needsApprovalBeforeRelease(inv)
    ? !!inv.approved_at
    : !!inv.nominal_code?.trim();
}

/**
 * HELD: everything before the sign-off is done, and the sign-off is what's
 * missing. This is the state approval now ends in — the match is agreed and
 * the money is agreed, but nothing reaches Xero until a release approver
 * signs it off.
 */
export function isHeld(inv: ReleasableInvoice): boolean {
  return !isInXero(inv) && !inv.released_at && readyForRelease(inv);
}

/** Signed off, so a push (or a retry of a failed one) is permitted. */
export function isReleased(inv: ReleasableInvoice): boolean {
  return !!inv.released_at;
}


/* ── Subcontractor labour certificates ──────────────────────────────────
 *
 * The certificate equivalent, on the AfP's own columns. The stage that
 * precedes sign-off here is `pay_approved_at` — the financial go-ahead, which
 * itself requires the QS to have certified the value first. Certification is
 * not part of this gate: agreeing what the work was worth is a third,
 * earlier act, and the route enforces it separately.
 */

export type ReleasableLabourCert = {
  status?: string | null;
  pay_approved_at?: string | null;
  pay_released_at?: string | null;
  xero_po_id?: string | null;
  xero_sync_status?: string | null;
};

/** Already a bill in Xero, so past this gate entirely. */
export function isCertInXero(afp: ReleasableLabourCert): boolean {
  return !!afp.xero_po_id || afp.xero_sync_status === "synced";
}

/** Signed off, so a push (or a retry of a failed one) is permitted. */
export function isCertReleased(afp: ReleasableLabourCert): boolean {
  return !!afp.pay_released_at;
}

/**
 * HELD: approved for payment, and waiting on the release sign-off to become a
 * bill. A certificate that hasn't been approved for payment is not held — it
 * is still with the people who agree the money.
 */
export function isCertHeld(afp: ReleasableLabourCert): boolean {
  return !isCertInXero(afp) && !afp.pay_released_at && !!afp.pay_approved_at;
}
