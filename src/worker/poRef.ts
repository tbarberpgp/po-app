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
