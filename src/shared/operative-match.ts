/** Matching what an operative types on the site sign-in against the name the
 *  register holds for them.
 *
 *  The register is filled in by a manager reading a CSCS or ID card, and the
 *  sign-in has no freeform name box — so a search that can't find you is not a
 *  poor result, it's a lockout. You can't sign in, and you show up missing on
 *  the day's register with nothing anywhere to say why. (Sept 2026: one roofer
 *  sat outside that wall for six weeks, because the card said "WILLIAM" and he
 *  types "Willian".)
 *
 *  So this is deliberately forgiving in the three ways names on this register
 *  actually differ from how their owner types them: accents the keyboard
 *  doesn't offer, a surname the manager filed under a first name, and the
 *  one-letter drift of an anglicised or transliterated spelling. */

export type MatchableOperative = { name: string; company?: string | null; trade?: string | null };

/** Lowercase, drop accents, reduce anything else to a space: "José-María" → "jose maria". */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Whether `a` and `b` are within `max` single-character edits of each other.
 *  Levenshtein over two rows, abandoned as soon as the whole row is past the
 *  budget — the inputs are single words, but this runs per name per keystroke. */
export function withinEdits(a: string, b: string, max: number): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return false;
    prev = row;
  }
  return prev[b.length] <= max;
}

/** How much misspelling to forgive on a word this long. Short words stay exact:
 *  at three letters, one edit makes "ion" match half the register. */
function editBudget(token: string): number {
  if (token.length >= 7) return 2;
  if (token.length >= 4) return 1;
  return 0;
}

/** Rank `operatives` against what was typed, dropping those that don't match.
 *  Every word typed has to match something, so extra words still narrow the
 *  list. Word-start hits sort above mid-word hits, which sort above forgiven
 *  spellings — someone who types their name exactly stays at the top, and the
 *  near-misses come after rather than instead. Empty query → everyone, in the
 *  register's own order. */
export function matchOperatives<T extends MatchableOperative>(operatives: T[], query: string): T[] {
  const tokens = fold(query).split(" ").filter(Boolean);
  if (!tokens.length) return operatives;
  const scored: Array<{ op: T; score: number }> = [];
  for (const op of operatives) {
    const hay = fold([op.name, op.company ?? "", op.trade ?? ""].join(" "));
    const words = hay.split(" ").filter(Boolean);
    let score = 0;
    let matched = true;
    for (const token of tokens) {
      if (words.some((w) => w.startsWith(token))) continue;
      if (hay.includes(token)) { score += 1; continue; }
      const budget = editBudget(token);
      if (budget > 0 && words.some((w) => withinEdits(w, token, budget))) { score += 2; continue; }
      matched = false;
      break;
    }
    if (matched) scored.push({ op, score });
  }
  // Stable sort: equal scores keep the register's ordering.
  return scored.sort((a, b) => a.score - b.score).map((s) => s.op);
}
