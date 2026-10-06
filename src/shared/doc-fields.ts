// Deciding whether a piece of text on a document IS the value we extracted
// from it. Two callers need exactly the same judgement and must not drift:
//
//  • the PDF viewer, matching extracted values against a file's real text layer
//    to place highlight boxes;
//  • the worker, checking that a vision-supplied region really does sit over
//    the value it claims to (a photo has no text layer, so the reader is asked
//    what it sees inside each box and the claim is verified here).
//
// The same number is written a dozen ways on paper — "26/09/2026" for
// 2026-09-26, "1,250.00" for 1250 — so comparison runs over the written FORMS
// of a value, not its stored form.

/** Comparison form: lowercase alphanumerics only, so spacing, punctuation,
 *  currency marks and thousands separators stop mattering. */
export function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/** Every written form `value` might plausibly take on a document, normalised.
 *  Short forms are dropped — a two-character "fragment" matches half the page
 *  and would box the wrong text. */
export function writtenForms(value: string, minLen = 4): string[] {
  const v = (value ?? "").trim();
  const out = new Set<string>([norm(v)]);

  // ISO date → the UK renderings a supplier actually prints.
  const d = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (d) {
    const [, y, m, day] = d;
    const mon = MONTHS[Number(m) - 1] ?? "";
    const dayN = String(Number(day));
    const monN = String(Number(m));
    for (const f of [
      `${dayN} ${mon} ${y}`, `${dayN} ${mon.slice(0, 3)} ${y}`,
      `${day}/${m}/${y}`, `${dayN}/${monN}/${y}`,
      `${day}.${m}.${y}`, `${day}-${m}-${y}`,
      `${day}/${m}/${y.slice(2)}`, `${y}-${m}-${day}`,
    ]) out.add(norm(f));
  }

  // Amount → with and without thousands separators and decimals.
  //
  // Only for figures with three digits or more. Padding a small number to two
  // decimals invents digits: 12 becomes "12.00", which normalises to "1200"
  // and would then confirm a box sitting over £1,200.00. A short figure simply
  // gets no written forms, so nothing is highlighted for it.
  const n = Number(v);
  if (Number.isFinite(n) && /^[\d,.\s£$€-]+$/.test(v) && v.replace(/\D/g, "").length >= 3) {
    out.add(norm(n.toFixed(2)));
    out.add(norm(n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
    if (Number.isInteger(n)) out.add(norm(String(n)));
  }

  return [...out].filter((x) => x.length >= minLen);
}

/** Does `printed` — text somebody (or something) claims sits on the page —
 *  actually carry `value`? True only on a real overlap: either the printed text
 *  contains a written form of the value, or the printed text is itself a
 *  substantial fragment of one. Anything shorter is treated as no evidence,
 *  because a box placed on "no evidence" points somewhere arbitrary. */
export function textConfirms(printed: string, value: string): boolean {
  const p = norm(printed);
  if (p.length < 3) return false;
  const forms = writtenForms(value, 3);
  if (!forms.length) return false;
  return forms.some((f) => p.includes(f) || (p.length >= 6 && f.includes(p)));
}
