import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LABOUR_EXPENDED_BY_PROJECT, LABOUR_EXPENDED_BY_SECTION } from "./labour-expended";

/** A throwaway SQLite shaped like the two tables the definition reads. */
function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(`
    CREATE TABLE applications_for_payment (
      id INTEGER PRIMARY KEY, project_id TEXT, direction TEXT, app_number INTEGER,
      status TEXT, counterparty_supplier_id INTEGER);
    CREATE TABLE afp_lines (
      id INTEGER PRIMARY KEY, afp_id INTEGER, section TEXT,
      cumulative_value REAL, is_adhoc INTEGER DEFAULT 0);`);
  return d;
}
const app = (d: DatabaseSync, id: number, sup: number, no: number, status = "certified") =>
  d.prepare(`INSERT INTO applications_for_payment
    (id, project_id, direction, app_number, status, counterparty_supplier_id)
    VALUES (?, 'p1', 'incoming_labour', ?, ?, ?)`).run(id, no, status, sup);
const line = (d: DatabaseSync, afp: number, section: string, v: number, adhoc = 0) =>
  d.prepare("INSERT INTO afp_lines (afp_id, section, cumulative_value, is_adhoc) VALUES (?,?,?,?)")
    .run(afp, section, v, adhoc);
const total = (d: DatabaseSync) =>
  Number((d.prepare(LABOUR_EXPENDED_BY_PROJECT).all()[0] as { v: number } | undefined)?.v ?? 0);
const sections = (d: DatabaseSync) =>
  Object.fromEntries((d.prepare(LABOUR_EXPENDED_BY_SECTION).all("p1", "p1") as Array<{ section: string; expended: number }>)
    .map((r) => [r.section, Math.round(Number(r.expended) * 100) / 100]));

describe("labour expended", () => {
  // Blyth: Cladders applied £2,196, then restated the position as £9,676.80.
  // Summing the series read £11,872.80 — the first application counted twice.
  test("a cumulative series counts once, not once per application", () => {
    const d = db();
    app(d, 1, 10, 1); line(d, 1, "Removal of Flashings", 2196);
    app(d, 2, 10, 2); line(d, 2, "Removal of Flashings", 9676.8);
    assert.equal(total(d), 9676.8);
    assert.deepEqual(sections(d), { "Removal of Flashings": 9676.8 });
  });

  test("each subcontractor's own latest position counts", () => {
    const d = db();
    app(d, 1, 10, 1); line(d, 1, "Removal of Flashings", 2196);
    app(d, 2, 10, 2); line(d, 2, "Removal of Flashings", 9676.8);
    app(d, 3, 11, 3); line(d, 3, "Prelims", 3300);
    assert.equal(total(d), 9676.8 + 3300);
  });

  // Expenses are claimed per application and never carried forward, so taking
  // only the latest application would drop every earlier hotel bill.
  test("expenses sum across the series instead of being superseded", () => {
    const d = db();
    app(d, 1, 10, 1); line(d, 1, "Removal of Flashings", 2196); line(d, 1, "Expenses", 636.9, 1);
    app(d, 2, 10, 2); line(d, 2, "Removal of Flashings", 9676.8); line(d, 2, "Expenses", 752.28, 1);
    assert.equal(total(d), 9676.8 + 636.9 + 752.28);
    assert.deepEqual(sections(d), { "Removal of Flashings": 9676.8, Expenses: 1389.18 });
  });

  test("the per-project total and the per-section split are the same number", () => {
    const d = db();
    app(d, 1, 10, 1); line(d, 1, "Roof", 5000); line(d, 1, "Expenses", 120, 1);
    app(d, 2, 10, 2); line(d, 2, "Roof", 8000); line(d, 2, "Variations", 400, 1);
    app(d, 3, 11, 3); line(d, 3, "Prelims", 3300);
    const split = Object.values(sections(d)).reduce((s, v) => s + v, 0);
    assert.equal(Math.round(split * 100), Math.round(total(d) * 100));
  });

  test("an uncertified claim is not yet expenditure", () => {
    const d = db();
    app(d, 1, 10, 1); line(d, 1, "Roof", 5000);
    app(d, 2, 10, 2, "submitted"); line(d, 2, "Roof", 9000);
    app(d, 3, 10, 3, "draft"); line(d, 3, "Roof", 12000);
    assert.equal(total(d), 5000);
  });

  test("a paid application counts as expended", () => {
    const d = db();
    app(d, 1, 10, 1, "paid"); line(d, 1, "Roof", 5000);
    assert.equal(total(d), 5000);
  });

  test("an unlabelled section reads as Other rather than vanishing", () => {
    const d = db();
    app(d, 1, 10, 1); line(d, 1, "", 700);
    assert.deepEqual(sections(d), { Other: 700 });
  });
});
