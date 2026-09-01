// Delivery-address → project matching. Used as a FALLBACK when an inbound
// invoice quotes no usable PO reference: the ship-to address printed on the
// document is scored against every live project's delivery address (plus its
// name and code), and a clear winner becomes the invoice's default coding.
// A guess here is only the inbox default — the coding stays editable until
// the invoice is approved.

export type AddrProject = {
  id: string;
  code: string;
  name: string;
  delivery_address: string | null;
  site_group_id: string | null;
};

/** Generic address words that match everything and identify nothing. */
const ADDR_NOISE = new Set([
  "road", "rd", "street", "st", "lane", "ln", "avenue", "ave", "drive", "close", "court", "way", "place",
  "unit", "units", "park", "estate", "industrial", "ind", "business", "centre", "center", "house", "floor",
  "the", "and", "for", "attn", "fao", "site", "england", "scotland", "wales", "uk", "united", "kingdom",
]);

function addrTokens(s: string): Set<string> {
  return new Set(
    (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
      .filter((t) => t.length >= 3 && !ADDR_NOISE.has(t)),
  );
}

/**
 * A block / unit designator — "Block B", "Blk D", "Block C1".
 *
 * On a grouped site every block shares one street address and one postcode, so
 * this letter is the only thing in a delivery address that tells three separate
 * contracts apart. addrTokens throws it away, because a one-character token is
 * noise everywhere else — which left "Dallas Rd Block B" and "Dallas Rd Block D"
 * scoring identically, the blocks tying, and the tie-break quietly picking
 * whichever contract was newest. An invoice that plainly said Block B was being
 * coded to Block D.
 */
function blockTag(s: string): string | null {
  const m = /\bbl(?:oc)?k\.?\s*([a-z0-9]{1,3})\b/i.exec(s || "");
  return m ? m[1]!.toLowerCase() : null;
}

function ukPostcode(s: string): { out: string; full: string } | null {
  const m = (s || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").match(/\b([A-Z]{1,2}\d[A-Z0-9]?) ?(\d[A-Z]{2})\b/);
  return m ? { out: m[1]!, full: `${m[1]} ${m[2]}` } : null;
}

/**
 * Pick the project a delivery address belongs to, or null when nothing is
 * clear enough to act on. Scoring per project: full postcode match 60,
 * outward code only 25, plus 12 per shared distinctive token (cap 3) from the
 * project's address + name + code. 36 or more is a candidate.
 *
 * Near-tied candidates first collapse through site groups (blocks of one
 * physical site tie constantly — they ARE the same address); if genuinely
 * separate identities still tie, the newest project code wins only when it is
 * strictly newest (an old contract and the live one at the same address → the
 * live one). Otherwise no assignment — an honest blank beats a coin flip.
 */
export function pickProjectByAddress(
  addr: string,
  rows: AddrProject[],
): { id: string; code: string; site_group_id: string | null } | null {
  const pc = ukPostcode(addr);
  const toks = addrTokens(addr);
  const addrBlock = blockTag(addr);
  if (!pc && toks.size === 0 && !addrBlock) return null;

  const scored = rows
    .map((p) => {
      const ppc = ukPostcode(p.delivery_address ?? "");
      let score = 0;
      if (pc && ppc) score += pc.full === ppc.full ? 60 : pc.out === ppc.out ? 25 : 0;
      const ptoks = addrTokens(`${p.delivery_address ?? ""} ${p.name} ${p.code}`);
      let shared = 0;
      for (const t of toks) if (ptoks.has(t)) shared++;
      score += Math.min(3, shared) * 12;
      // A named block decides it. Naming a DIFFERENT block rules the project out
      // rather than merely scoring it lower: on a grouped site the blocks share
      // an address, so a lower score still ties and the age tie-break takes over.
      // Only applied when both sides name one — a project without a block in its
      // name is not evidence either way.
      const pBlock = blockTag(`${p.delivery_address ?? ""} ${p.name}`);
      if (addrBlock && pBlock) {
        if (addrBlock === pBlock) score += 40;
        else return { p, score: 0 };
      }
      return { p, score };
    })
    .filter((x) => x.score >= 36)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;

  // One identity per site: a group is one identity carrying its best score and
  // newest member code; an ungrouped project is its own.
  const near = scored.filter((x) => scored[0]!.score - x.score < 12);
  type Ident = { id: string; code: string; site_group_id: string | null; n: number };
  const idents = new Map<string, Ident>();
  for (const { p } of near) {
    const key = p.site_group_id ?? p.id;
    const n = Number((p.code.match(/^\d+/) ?? ["0"])[0]);
    const cur = idents.get(key);
    if (!cur) idents.set(key, { id: p.id, code: p.code, site_group_id: p.site_group_id, n });
    else if (n > cur.n) idents.set(key, { id: p.id, code: p.code, site_group_id: p.site_group_id, n });
  }
  const list = [...idents.values()].sort((a, b) => b.n - a.n);
  const chosen = list.length === 1 ? list[0]! : list[0]!.n > list[1]!.n ? list[0]! : null;
  return chosen ? { id: chosen.id, code: chosen.code, site_group_id: chosen.site_group_id } : null;
}
