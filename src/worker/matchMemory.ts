// Match memory — the system's learned aliases. Every human correction (this
// supplier's "VIEO 38-525-1050…" is our "MS-B36 bars" line) is recorded and
// consulted by the matchers before their code/token heuristics, so the same
// mapping never has to be made by hand twice. Deliveries, invoices and
// applications each learn in their own `kind` bucket, keyed per supplier.

export type AliasKind = "delivery_item" | "invoice_line" | "afp_line" | "budget_item";

/** Lowercased alphanumerics — the comparable core of a line description. */
export function normText(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Record human-made mappings (best-effort: learning must never break the save). */
export async function learnAliases(
  db: D1Database,
  kind: AliasKind,
  supplier: string | null | undefined,
  pairs: Array<{ alias: string | null | undefined; target: string | null | undefined }>,
  actor: string | null,
): Promise<void> {
  const sup = normText(supplier);
  const now = new Date().toISOString();
  try {
    const stmts = pairs
      .map((p) => ({ a: normText(p.alias), t: normText(p.target), at: (p.alias ?? "").trim(), tt: (p.target ?? "").trim() }))
      .filter((p) => p.a.length >= 4 && p.t.length >= 4 && p.a !== p.t)
      .map((p) => db.prepare(
        `INSERT INTO match_aliases (kind, supplier_norm, alias_norm, target_norm, alias_text, target_text, created_at, created_by, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, supplier_norm, alias_norm)
         DO UPDATE SET target_norm = excluded.target_norm, target_text = excluded.target_text,
                       hits = hits + 1, last_used_at = excluded.last_used_at`,
      ).bind(kind, sup, p.a, p.t, p.at.slice(0, 200), p.tt.slice(0, 200), now, actor, now));
    if (stmts.length) await db.batch(stmts);
  } catch { /* the table may predate the migration; never block the action */ }
}

/** alias_norm → target_norm for one supplier (plus the '' catch-all bucket). */
export async function aliasMap(
  db: D1Database,
  kind: AliasKind,
  supplier: string | null | undefined,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const sup = normText(supplier);
    const rows = await db.prepare(
      "SELECT supplier_norm, alias_norm, target_norm FROM match_aliases WHERE kind = ? AND supplier_norm IN (?, '')",
    ).bind(kind, sup).all<{ supplier_norm: string; alias_norm: string; target_norm: string }>();
    // Catch-all first so the supplier-specific mapping wins on collision.
    for (const r of rows.results.filter((x) => x.supplier_norm === "")) out.set(r.alias_norm, r.target_norm);
    for (const r of rows.results.filter((x) => x.supplier_norm !== "")) out.set(r.alias_norm, r.target_norm);
  } catch { /* absent table = empty memory */ }
  return out;
}

/** Every alias for a kind, bucketed by supplier — for endpoints that scan many
 *  suppliers' documents in one pass (the deliveries inbox). */
export async function aliasMapsBySupplier(
  db: D1Database,
  kind: AliasKind,
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  try {
    const rows = await db.prepare(
      "SELECT supplier_norm, alias_norm, target_norm FROM match_aliases WHERE kind = ?",
    ).bind(kind).all<{ supplier_norm: string; alias_norm: string; target_norm: string }>();
    for (const r of rows.results) {
      let m = out.get(r.supplier_norm);
      if (!m) { m = new Map(); out.set(r.supplier_norm, m); }
      m.set(r.alias_norm, r.target_norm);
    }
  } catch { /* absent table = empty memory */ }
  return out;
}
