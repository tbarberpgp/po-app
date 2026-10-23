// What happened to a labour certificate, and who did it — the History panel on
// the certificate page and in Accounts.
//
// Built from two places: the stamps on the application itself (submitted_at/by,
// certified_at/by, pay_released_at/by, paid_at/by) and its audit_log rows. The
// stamps hold the current position; the audit rows hold what the stamps can't —
// a fast-track, an uncertify (which wipes the certify stamps), who pushed it.

export type AfpHistoryRow = {
  submitted_at: string | null; submitted_by: string | null;
  certified_at: string | null; certified_by: string | null; certified_amount: number | null;
  pay_released_at: string | null; pay_released_by: string | null;
  xero_po_id: string | null; xero_po_number: string | null;
  xero_sync_status: string | null; xero_synced_at: string | null;
  paid_at: string | null; paid_by: string | null;
};

export type AfpAuditRow = { action: string; actor: string | null; details: string | null; created_at: string };

export type AfpHistoryEvent = {
  at: string;
  what: string;
  by: string | null;
  detail?: string | null;
};

/** Fast-track certify: certified at what was claimed and approved in one go,
 *  then pushed (2026-10-23). `fast_track_pushed` is the first version, which
 *  pushed without certifying; its claims were certified afterwards. */
export const FAST_TRACK_ACTIONS = ["fast_track_certified", "fast_track_pushed"];

export function isFastTracked(audits: AfpAuditRow[]): boolean {
  return audits.some((a) => FAST_TRACK_ACTIONS.includes(a.action));
}

const money = (v: number | null | undefined) =>
  v == null ? null : `£${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function detailsOf(a: AfpAuditRow): Record<string, unknown> {
  try { return (JSON.parse(a.details ?? "null") as Record<string, unknown> | null) ?? {}; } catch { return {}; }
}

export function buildAfpHistory(afp: AfpHistoryRow, audits: AfpAuditRow[]): AfpHistoryEvent[] {
  const out: AfpHistoryEvent[] = [];
  const fastTracked = isFastTracked(audits);
  if (afp.submitted_at) out.push({ at: afp.submitted_at, what: "Submitted", by: afp.submitted_by });
  if (afp.certified_at) {
    out.push({
      at: afp.certified_at,
      what: afp.certified_by === "xero" ? "Certified — matched to its Xero bill" : fastTracked ? "Fast-track certified" : "Certified",
      by: afp.certified_by === "xero" ? null : afp.certified_by,
      detail: money(afp.certified_amount),
    });
  }
  if (afp.pay_released_at) out.push({ at: afp.pay_released_at, what: fastTracked ? "Approved (fast-track)" : "Approved", by: afp.pay_released_by });

  let pushLogged = false;
  for (const a of audits) {
    const d = detailsOf(a);
    if (a.action === "uncertified") {
      out.push({ at: a.created_at, what: "Uncertified", by: a.actor, detail: typeof d.reason === "string" ? d.reason : null });
    } else if (a.action === "pushed_to_xero") {
      pushLogged = true;
      out.push({ at: a.created_at, what: "Pushed to Xero", by: a.actor, detail: typeof d.bill_number === "string" && d.bill_number ? `bill ${d.bill_number}` : null });
    } else if (a.action === "keyed_in_xero_by_hand") {
      pushLogged = true;
      out.push({ at: a.created_at, what: "Recorded as keyed into Xero by hand", by: a.actor, detail: typeof d.bill_number === "string" ? `bill ${d.bill_number}` : null });
    }
  }
  // Pushes before 2026-10-23 left no audit row — the stamp still says when.
  if (!pushLogged && afp.xero_po_id && afp.xero_synced_at) {
    out.push({ at: afp.xero_synced_at, what: "Pushed to Xero", by: null, detail: afp.xero_po_number ? `bill ${afp.xero_po_number}` : null });
  }
  if (afp.paid_at) out.push({ at: afp.paid_at, what: afp.paid_by === "xero" ? "Paid in Xero" : "Paid", by: afp.paid_by === "xero" ? null : afp.paid_by });

  return out.sort((x, y) => x.at.localeCompare(y.at));
}
