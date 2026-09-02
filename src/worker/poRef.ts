// Shared PO-reference matching. Suppliers hand-type our PO numbers onto
// invoices and delivery notes, so references arrive mangled — an extra digit in
// the project code ("PO-262002-0004"), block suffixes ("-C1", "BLOCK C"),
// arbitrary spacing/case. One tolerant matcher serves both the invoice inbox
// and the delivery-ticket scanner so the two never disagree about what a
// reference points at.

export type PoLike = { id: string; po_number: string; project_code: string };

/** Uppercase alphanumerics with any leading "PO" dropped — the comparable core. */
export function normPoRef(s: string | null | undefined): string {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^PO/, "");
}

/**
 * Find the PO a quoted reference points at within an already-loaded PO list.
 *   1. Exact normalized match ("PO 26001/0014" → PO-26001-0014).
 *   2. Exact-prefix match, longest wins — the ref carries a trailing suffix
 *      beyond our number ("…-0014-C1" quoted against parent PO-26001-0014, or
 *      junk like "/BLOCK C"), while a real call-off number still beats its
 *      parent because it's the longer prefix.
 *   3. Code repair: first digit run = project code (5 digits as-is; 6 digits
 *      trying every single-character deletion against live project codes),
 *      second run = PO sequence. Substituting the repaired code back into the
 *      ref keeps call-off suffixes intact; failing that, match the sequence.
 */
export function fuzzyFindPo<T extends PoLike>(ref: string | null | undefined, pos: T[]): T | null {
  const raw = String(ref ?? "").trim();
  if (!raw) return null;
  const target = normPoRef(raw);
  if (target.length < 4) return null;

  const exact = pos.find((p) => normPoRef(p.po_number) === target);
  if (exact) return exact;
  const prefixed = pos
    .filter((p) => normPoRef(p.po_number).length >= 8 && target.startsWith(normPoRef(p.po_number)))
    .sort((a, b) => normPoRef(b.po_number).length - normPoRef(a.po_number).length)[0];
  if (prefixed) return prefixed;

  const runs = raw.match(/\d+/g) ?? [];
  const codeRun = runs[0];
  const seq = runs[1];
  if (!codeRun || !seq || seq.length < 3) return null;
  const candidates: string[] = [];
  if (codeRun.length === 5) candidates.push(codeRun);
  if (codeRun.length === 6) for (let i = 0; i < codeRun.length; i++) {
    const cand = codeRun.slice(0, i) + codeRun.slice(i + 1);
    if (!candidates.includes(cand)) candidates.push(cand);
  }
  const liveCodes = new Set(pos.map((p) => p.project_code));
  for (const code of candidates.filter((cand) => liveCodes.has(cand))) {
    const repaired = target.replace(codeRun, code);
    const hit = pos.find((p) => normPoRef(p.po_number) === repaired)
      ?? pos.filter((p) => normPoRef(p.po_number).length >= 8 && repaired.startsWith(normPoRef(p.po_number)))
        .sort((a, b) => normPoRef(b.po_number).length - normPoRef(a.po_number).length)[0];
    if (hit) return hit;
    const bySeq = pos.find((p) => p.project_code === code && normPoRef(p.po_number).endsWith(seq));
    if (bySeq) return bySeq;
  }
  return null;
}

/** A PO with the lifecycle fields the supersede walk needs. */
export type PoLifecycle = {
  id: string;
  po_number: string;
  status: string;
  order_type: string | null;
  supplier: string | null;
  project_id: string;
  created_at: string | null;
  deleted_at: string | null;
};

/** How long after a deletion a replacement can still be read as the same order
 *  re-raised. See findSuccessor for why it is seven days. */
export const SUPERSEDE_WINDOW_DAYS = 7;

/**
 * The live order that replaced a deleted one, or null when nothing did.
 *
 * Deleting and immediately re-raising is how a framework gets re-priced here:
 * the Alumasc frameworks on 26001/26002/26003 were each cancelled and raised
 * again, twice, across 8 and 17 June. Suppliers keep quoting whichever number
 * was current when they set the job up on their system, so a dead reference is
 * routine and the live order it points at is knowable.
 *
 * Walks FORWARD along the chain — a re-raise that was itself re-raised is
 * followed through — because the first replacement is often dead too:
 * PO-26001-0008 → 0010 → 0011 → 0013, and only the last is live.
 *
 * A replacement is the same job, same supplier and same order type, raised
 * within SUPERSEDE_WINDOW_DAYS of the previous being deleted. The window is
 * what separates a re-raise from an unrelated later order, and it is measured,
 * not assumed: across the 29 deleted orders on live jobs, every genuine re-raise
 * lands within 3.4 days, while the nearest false pairing is 15.2 days (a call-off
 * to an unrelated order) and the worst is 44.9 days. Seven days sits in that gap.
 *
 * That gap matters. Without it, the seven abandoned Alumasc orders on 26001 all
 * resolve to PO-26001-0028 — a £559.78 order for a tin of primer raised 26 days
 * later — purely because it is the next Alumasc order on the job. Chains that
 * were abandoned rather than superseded must resolve to nothing, and do.
 */
export function findSuccessor<T extends PoLifecycle>(dead: T, all: T[], seen = new Set<string>()): T | null {
  if (seen.has(dead.id)) return null;   // a cycle can only come from bad data; refuse to spin on it
  seen.add(dead.id);
  const deletedAt = dead.deleted_at ? Date.parse(dead.deleted_at) : NaN;
  if (Number.isNaN(deletedAt)) return null;
  const sameOrder = (a: string | null, b: string | null) =>
    String(a ?? "standard").trim() === String(b ?? "standard").trim();
  const sameSupplier = (a: string | null, b: string | null) =>
    String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
  const next = all
    .filter((p) => p.id !== dead.id
      && p.project_id === dead.project_id
      && sameOrder(p.order_type, dead.order_type)
      && sameSupplier(p.supplier, dead.supplier))
    .map((p) => ({ p, at: p.created_at ? Date.parse(p.created_at) : NaN }))
    .filter(({ at }) => !Number.isNaN(at) && at > deletedAt
      && at - deletedAt <= SUPERSEDE_WINDOW_DAYS * 86_400_000)
    .sort((a, b) => a.at - b.at)[0]?.p;
  if (!next) return null;
  return next.status === "deleted" ? findSuccessor(next, all, seen) : next;
}
