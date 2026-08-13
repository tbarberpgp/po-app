// Combined site-group codes. A grouped site (one job split into per-contract
// blocks, e.g. Dallas Rd Blocks B/C/D = 26001 / 26002 / 26003) is shown and
// referenced with a single compact code "26001/2/3": the first member's full
// code, then each other member's tail beyond the shared prefix. People reuse
// this notation in WhatsApp group names and email subjects, so the inbound
// readers must be able to expand it back to the individual project codes.

/** ["26001","26002","26003"] → "26001/2/3". One code → that code. No shared
 *  prefix → just slash-joined. */
export function combineSiteCodes(codes: string[]): string {
  const sorted = [...new Set(codes.filter(Boolean))].sort();
  if (sorted.length <= 1) return sorted[0] ?? "";
  let pre = sorted[0];
  for (const c of sorted) { while (pre && !c.startsWith(pre)) pre = pre.slice(0, -1); if (!pre) break; }
  if (pre.length < 2) return sorted.join("/");          // nothing meaningful in common
  const [first, ...rest] = sorted;
  return first + "/" + rest.map((c) => c.slice(pre.length) || c).join("/");
}

/** Expand a combined token back to the individual codes that actually exist.
 *  "26001/2/3" / "26001/02/03" / "26001/2" → the matching known codes; a plain
 *  code → itself; anything unrecognised → []. `known` is the set of live codes. */
export function expandCombinedCode(token: string, known: Set<string>): string[] {
  const t = (token || "").trim();
  if (!t) return [];
  if (known.has(t)) return [t];
  const parts = t.split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || !known.has(parts[0])) return [];
  const first = parts[0];
  const out = [first];
  for (const p of parts.slice(1)) {
    if (known.has(p)) { out.push(p); continue; }                 // already a full code
    const cand = first.slice(0, Math.max(0, first.length - p.length)) + p;
    if (known.has(cand)) out.push(cand);
  }
  return [...new Set(out)];
}

/** Scan free text (a group name, an email subject) for a combined-code token and
 *  return the individual codes it maps to. Empty when none/unknown. Used by the
 *  WhatsApp + email readers so "26001/2/3" routes the same as "26001". */
export function findCombinedCodes(text: string, known: Set<string>): string[] {
  const m = (text || "").match(/[A-Za-z0-9]{3,8}(?:\/[A-Za-z0-9]{1,4})+/);
  return m ? expandCombinedCode(m[0], known) : [];
}
