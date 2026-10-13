import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { UNCODED_LINE } from "./uncoded-line";

/** A throwaway SQLite shaped like the tables the committed rules read. */
function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(`
    CREATE TABLE material_snapshots (id INTEGER PRIMARY KEY, project_id TEXT, is_active INTEGER);
    CREATE TABLE materials (id INTEGER PRIMARY KEY, snapshot_id INTEGER, item TEXT);
    CREATE TABLE material_substitutions (id INTEGER PRIMARY KEY, material_id INTEGER, replacement_item TEXT, active INTEGER);
    CREATE TABLE purchase_orders (id TEXT PRIMARY KEY, project_id TEXT, status TEXT, order_type TEXT);
    CREATE TABLE po_lines (id INTEGER PRIMARY KEY, po_id TEXT, item TEXT, line_total REAL, is_unpriced INTEGER, material_id INTEGER);
    INSERT INTO material_snapshots VALUES (1, 'p1', 1), (2, 'p1', 0);
    INSERT INTO materials VALUES
      (10, 1, 'External Corner Flashing'),
      (11, 1, '160mm Rockwool Duoslab'),
      (12, 2, 'F-02-TYPE-B METRE');            -- an old upload's wording, no longer live
    INSERT INTO material_substitutions VALUES (1, 11, 'Rockwool Duo Slab 150mm', 1);
    INSERT INTO purchase_orders VALUES ('po', 'p1', 'approved', 'standard');`);
  return d;
}

const line = (d: DatabaseSync, item: string, total: number, unpriced: 0 | 1, materialId: number | null = null) =>
  d.prepare("INSERT INTO po_lines (po_id, item, line_total, is_unpriced, material_id) VALUES ('po', ?, ?, ?, ?)")
    .run(item, total, unpriced, materialId);

/** The two ways the BOQ counts a line, as the materials route writes them
 *  (committed_value and assigned_committed_value), off-BOQ spend as projects.ts
 *  selects it, and the uncoded flag — per line. */
function buckets(d: DatabaseSync) {
  return d.prepare(`
    SELECT pl.item,
      EXISTS (SELECT 1 FROM materials m JOIN material_snapshots s ON s.id = m.snapshot_id AND s.is_active = 1
               LEFT JOIN material_substitutions sub ON sub.material_id = m.id AND sub.active = 1
              WHERE s.project_id = po.project_id AND pl.is_unpriced = 0
                AND (lower(pl.item) = lower(m.item) OR (sub.replacement_item IS NOT NULL AND lower(pl.item) = lower(sub.replacement_item)))) AS by_wording,
      EXISTS (SELECT 1 FROM materials m JOIN material_snapshots s ON s.id = m.snapshot_id AND s.is_active = 1
               LEFT JOIN material_substitutions sub ON sub.material_id = m.id AND sub.active = 1
              WHERE s.project_id = po.project_id AND pl.material_id IS NOT NULL
                AND lower(pl.item) != lower(m.item)
                AND (sub.replacement_item IS NULL OR lower(pl.item) != lower(sub.replacement_item))
                AND EXISTS (SELECT 1 FROM materials am WHERE am.id = pl.material_id AND lower(am.item) = lower(m.item))) AS by_coding,
      (pl.is_unpriced = 1 AND pl.material_id IS NULL) AS off_boq,
      ${UNCODED_LINE} AS uncoded
    FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id`).all() as Array<{ item: string; by_wording: number; by_coding: number; off_boq: number; uncoded: number }>;
}

test("every order line is counted in exactly one place, or flagged as uncoded", () => {
  const d = db();
  line(d, "SECTION - TOP HAT SECTION BY METRE", 4032, 0);   // retro PO off an invoice: unlinked, flagged priced
  line(d, "F-02-TYPE-B METRE", 2760, 0);                    // retro line under an OLD upload's wording
  line(d, "Customer Collection", 0, 1);                     // New PO free-text extra
  line(d, "External Corner Flashing", 2173, 0, 10);         // picked from the BOQ
  line(d, "external corner flashing", 500, 0);              // retro line that happens to use the BOQ wording
  line(d, "Rockwool Duo Slab 150mm", 714.78, 0);            // ordered under the substitution's wording
  line(d, "Barwell flashing 2.4m", 300, 1, 10);             // coded under other wording
  line(d, "External Corner Flashing", 120, 1);              // free text typed as the BOQ wording, never linked
  for (const r of buckets(d)) {
    const n = r.by_wording + r.by_coding + r.off_boq + r.uncoded;
    assert.equal(n, 1, `"${r.item}" counted/flagged ${n} times`);
  }
});

test("a retrospective invoice PO's unmatched lines are flagged, not booked as off-BOQ", () => {
  const d = db();
  line(d, "SECTION - TOP HAT SECTION BY METRE", 4032, 0);
  line(d, "F-02-TYPE-B METRE", 2760, 0);
  const rows = buckets(d);
  assert.deepEqual(rows.filter((r) => r.uncoded).map((r) => r.item), ["SECTION - TOP HAT SECTION BY METRE", "F-02-TYPE-B METRE"]);
  assert.ok(rows.every((r) => !r.off_boq));
});

test("a line the BOQ counts by wording is not flagged", () => {
  const d = db();
  line(d, "External Corner Flashing", 2173, 0, 10);
  line(d, "external corner flashing", 500, 0);
  line(d, "Rockwool Duo Slab 150mm", 714.78, 0);
  assert.ok(buckets(d).every((r) => r.by_wording === 1 && r.uncoded === 0));
});
