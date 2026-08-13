// Best-effort matcher: tie a programme activity to the bill line it installs,
// so material/stock demand can be auto-tagged on import. Activities are named
// after work stages ("Torch-on underlay", "Insulation – 150mm"), while bill
// items are area-named ("Flat Roof"), so we score against BOTH the bill item's
// description and its component-material names (which carry the stage words).

const STOP = new Set([
  "the", "and", "for", "with", "to", "of", "a", "an", "on", "in", "at", "by", "or",
  "works", "work", "system", "systems", "layer", "detail", "details", "install",
  "installation", "new", "existing", "including", "incl", "etc", "off", "up", "down",
  "out", "from", "per", "all", "area", "areas", "line", "lines", "type", "size",
  "mm", "no", "nr", "set", "sets", "item", "items", "general", "misc", "various",
]);

export function tokenize(s: string): string[] {
  return s.toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

export type MatchableActivity = { id: number; name: string; is_milestone?: number | boolean; is_summary?: number | boolean };
export type MatchableBillItem = { id: number; description: string; components?: { name: string }[] };

/**
 * Returns activityId → billItemId for confident matches only. An activity needs
 * at least `minShared` (default 2) meaningful words in common with a bill line
 * (description + component names) to be tagged; ties resolve to the bill item
 * with the strongest description overlap, then the lowest id (stable).
 */
export function matchActivitiesToBill(
  activities: MatchableActivity[],
  billItems: MatchableBillItem[],
  minShared = 2,
): Map<number, number> {
  const bill = billItems.map((b) => {
    const desc = new Set(tokenize(b.description));
    const comp = new Set<string>();
    for (const c of b.components ?? []) for (const t of tokenize(c.name)) comp.add(t);
    return { id: b.id, desc, all: new Set([...desc, ...comp]) };
  });
  const out = new Map<number, number>();
  for (const a of activities) {
    if (a.is_summary || a.is_milestone) continue;
    const at = tokenize(a.name);
    if (at.length === 0) continue;
    let bestId: number | null = null, bestScore = 0, bestDesc = -1;
    for (const b of bill) {
      let score = 0, descHits = 0;
      for (const t of at) {
        if (b.all.has(t)) score++;
        if (b.desc.has(t)) descHits++;
      }
      if (score > bestScore || (score === bestScore && score > 0 && descHits > bestDesc)) {
        bestScore = score; bestDesc = descHits; bestId = b.id;
      }
    }
    if (bestId != null && bestScore >= minShared) out.set(a.id, bestId);
  }
  return out;
}
