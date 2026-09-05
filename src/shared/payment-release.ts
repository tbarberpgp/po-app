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
//
// VOCABULARY — the column names predate the flow and read a stage early, so
// map them before changing anything here:
//
//   approved_at / pay_approved_at   Accounts (hgardner) matched the payable and
//                                   COMMITTED IT FOR APPROVAL. Not the approval.
//   released_at / pay_released_at   A release approver (tbarber, adouty)
//                                   APPROVED it. This is the decision.
//   status='pushed' / xero_po_id    Accounts then PUSHED it to Xero. Approval
//                                   only unlocks this; it never performs it.
//
// Three acts, and the middle one is the only one that decides anything. The UI
// says "Commit for approval", "Approve" and "Push to Xero"; a rename of the
// columns to match would be a swap on a live financial table, so the mapping
// lives here instead.

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
 * AWAITING APPROVAL: Accounts has committed it and an approver hasn't decided
 * yet. This is the queue tbarber and adouty work from.
 */
export function isAwaitingApproval(inv: ReleasableInvoice): boolean {
  return !isInXero(inv) && !inv.released_at && readyForRelease(inv);
}

/**
 * READY TO PUSH: approved, and not yet in Xero. This is the queue Accounts
 * works from — the only invoices the push button will accept.
 */
export function isReadyToPush(inv: ReleasableInvoice): boolean {
  return !isInXero(inv) && !!inv.released_at;
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

/** AWAITING APPROVAL: committed by Accounts, not yet decided by an approver. */
export function isCertAwaitingApproval(afp: ReleasableLabourCert): boolean {
  return !isCertInXero(afp) && !afp.pay_released_at && !!afp.pay_approved_at;
}

/** READY TO PUSH: approved, and not yet a bill in Xero. */
export function isCertReadyToPush(afp: ReleasableLabourCert): boolean {
  return !isCertInXero(afp) && !!afp.pay_released_at;
}
