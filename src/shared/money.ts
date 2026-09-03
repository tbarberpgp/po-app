// Parsing money the way people actually type it. Kept in `shared/` (no DOM, no
// D1) so the same rules can be unit-tested and reused by the worker if a typed
// figure ever arrives over the API.
//
// This exists because `Number()` is the wrong tool for a money field and had
// been used as one: `Number("1,250.00")` and `Number("£1250")` are both NaN, so
// the two most natural ways to write twelve hundred and fifty pounds were
// rejected as "Invalid amount" — on the AfP certified figure, of all fields.

/** Currency symbols and codes we strip before parsing. */
const CURRENCY = /[£$€]|\bGBP\b|\bEUR\b|\bUSD\b/gi;

/**
 * Group separators that carry no numeric meaning: ordinary spaces, the
 * non-breaking and thin spaces Excel and Word paste in, and the apostrophe
 * used as a thousands mark in Swiss formatting.
 */
const GROUPING = /[\s   ']/g;

/**
 * Parse a typed money figure to a number rounded to pence, or `null` when the
 * text isn't a number at all.
 *
 * Accepts: `1250`, `1250.5`, `1,250.00`, `£1,250`, `1 250,00`, `(1,250)` and
 * `-1250`. Rejects anything with leftover letters, more than one decimal
 * separator, or nothing but punctuation — those are typos, not figures, and
 * guessing at them is worse than asking again.
 *
 * Ambiguity is resolved the way a UK reader would: when both `.` and `,`
 * appear, the LAST one is the decimal separator (so `1,250.00` and `1.250,00`
 * both give 1250). A lone comma followed by exactly three digits is a
 * thousands mark (`1,250` → 1250); otherwise it's a decimal point
 * (`1,25` → 1.25).
 *
 * Negatives parse — the caller decides whether one is meaningful.
 */
export function parseMoney(raw: string | null | undefined): number | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;

  // (1,250) is accountants' notation for a negative.
  let negative = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) { negative = true; s = paren[1].trim(); }

  s = s.replace(CURRENCY, "").replace(GROUPING, "").trim();

  // A sign may sit either side of a stripped currency symbol ("-£5", "£-5").
  const sign = /^[-+]|[-+]$/.exec(s);
  if (sign) {
    if (sign[0] === "-") negative = !negative;
    s = s.replace(/^[-+]|[-+]$/g, "").trim();
  }
  if (!s) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");

  if (lastDot >= 0 && lastComma >= 0) {
    // Both present — the later mark is the decimal point, the earlier groups.
    const [dec, grp] = lastDot > lastComma ? [".", /,/g] : [",", /\./g];
    s = s.replace(grp, "");
    if (dec === ",") s = s.replace(",", ".");
  } else if (lastComma >= 0) {
    const groupsOfThree = /^\d{1,3}(,\d{3})+$/.test(s);
    s = groupsOfThree ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (lastDot >= 0 && /^\d{1,3}(\.\d{3}){2,}$/.test(s)) {
    // 1.250.000 — dots grouping, no decimal part. Needs TWO groups to qualify:
    // a single dot is a decimal point in a sterling field, always. "1.250" is
    // one pound twenty-five, and "0.005" must not become 5.
    s = s.replace(/\./g, "");
  }

  // Only a plain decimal survives. ".5" and "5." are accepted as written.
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const pence = Math.round(n * 100) / 100;
  return negative ? -pence : pence;
}

/** `parseMoney` restricted to a figure that can stand as an amount of money
 *  owed: a finite, non-negative number. Returns null for anything else. */
export function parsePositiveMoney(raw: string | null | undefined): number | null {
  const n = parseMoney(raw);
  return n == null || n < 0 ? null : n;
}
