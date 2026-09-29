import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LABOUR_POSITION, PRELIM_LABOUR_BY_PROJECT } from "./labour-expended";

/** A throwaway SQLite shaped like the tables the definition reads. */
function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(`
    CREATE TABLE applications_for_payment (
      id INTEGER PRIMARY KEY, project_id TEXT, direction TEXT, app_number INTEGER,
      status TEXT, counterparty_supplier_id INTEGER,
      prelim_heading TEXT, claimed_amount REAL, cumulative_value REAL);
    CREATE TABLE afp_lines (
      id INTEGER PRIMARY KEY, afp_id INTEGER, section TEXT,
      cumulative_value REAL, is_adhoc INTEGER DEFAULT 0, variation_id INTEGER);
    CREATE TABLE material_snapshots (id INTEGER PRIMARY KEY, project_id TEXT, is_active INTEGER);
    CREATE TABLE contract_items (
      id INTEGER PRIMARY KEY, snapshot_id INTEGER, section TEXT, description TEXT,
      qty REAL, labour_rate REAL, labour_total REAL);
    CREATE TABLE labour_live_rates (
      id INTEGER PRIMARY KEY, project_id TEXT, contract_item_id INTEGER, description TEXT,
      live_rate REAL, status TEXT, applied_at TEXT);
    INSERT INTO material_snapshots (id, project_id, is_active) VALUES (1, 'p1', 1), (2, 'p1', 0);`);
  return d;
}
const app = (d: DatabaseSync, id: number, sup: number, no: number, status = "certified") =>
  d.prepare(`INSERT INTO applications_for_payment
    (id, project_id, direction, app_number, status, counterparty_supplier_id)
    VALUES (?, 'p1', 'incoming_labour', ?, ?, ?)`).run(id, no, status, sup);
const prelimClaim = (d: DatabaseSync, id: number, sup: number, no: number, amount: number, status = "certified") =>
  d.prepare(`INSERT INTO applications_for_payment
    (id, project_id, direction, app_number, status, counterparty_supplier_id, prelim_heading, claimed_amount, cumulative_value)
    VALUES (?, 'p1', 'incoming_labour', ?, ?, ?, 'Site management', ?, ?)`).run(id, no, status, sup, amount, amount);
const line = (d: DatabaseSync, afp: number, section: string, v: number, adhoc = 0, variationId: number | null = null) =>
  d.prepare("INSERT INTO afp_lines (afp_id, section, cumulative_value, is_adhoc, variation_id) VALUES (?,?,?,?,?)")
    .run(afp, section, v, adhoc, variationId);
const boqItem = (d: DatabaseSync, id: number, section: string, qty: number, rate: number, snapshot = 1) =>
  d.prepare(`INSERT INTO contract_items (id, snapshot_id, section, description, qty, labour_rate, labour_total)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, snapshot, section, `item ${id}`, qty, rate, qty * rate);
const liveRate = (d: DatabaseSync, itemId: number, rate: number) =>
  d.prepare(`INSERT INTO labour_live_rates (project_id, contract_item_id, live_rate, status, applied_at)
    VALUES ('p1', ?, ?, 'applied', '2026-09-01')`).run(itemId, rate);

type Row = { section: string; line_count: number; budget: number; saving: number;
  boq_expended: number; variation_expended: number; other_expended: number };
const position = (d: DatabaseSync) =>
  d.prepare(`SELECT * FROM (${LABOUR_POSITION}) WHERE pid = ?`).all("p1") as Row[];
const pence = (v: number) => Math.round(v * 100) / 100;
/** Labour expended: the three certified columns added up. */
const total = (d: DatabaseSync) =>
  pence(position(d).reduce((s, r) => s + r.boq_expended + r.variation_expended + r.other_expended, 0));
const sections = (d: DatabaseSync) =>
  Object.fromEntries(position(d)
    .map((r) => [r.section, pence(r.boq_expended + r.variation_expended + r.other_expended)] as const)
    .filter(([, v]) => v !== 0));

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
    assert.equal(total(d), pence(9676.8 + 636.9 + 752.28));
    assert.deepEqual(sections(d), { "Removal of Flashings": 9676.8, Expenses: 1389.18 });
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

  // A PM's time tagged to a prelim heading is its own standalone claim. Letting
  // it be the subcontractor's "latest" application wiped their measured
  // position: the claim has no BOQ lines, so the latest position read £0.
  test("a prelim claim doesn't stand in for the subcontractor's measured position", () => {
    const d = db();
    app(d, 1, 10, 1); line(d, 1, "Roof", 8000);
    prelimClaim(d, 2, 10, 2, 1200);
    assert.equal(total(d), 8000);
  });

  test("certified prelim claims are counted on their own, and they sum", () => {
    const d = db();
    prelimClaim(d, 1, 10, 1, 1200);
    prelimClaim(d, 2, 10, 2, 900);
    prelimClaim(d, 3, 10, 3, 5000, "submitted");
    const rows = d.prepare(PRELIM_LABOUR_BY_PROJECT).all() as Array<{ pid: string; v: number }>;
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ pid: "p1", v: 2100 }]);
    assert.equal(total(d), 0, "they are prelims spend, not labour expended");
  });
});

describe("labour position", () => {
  test("carries the active BOQ's budget per section, with live-rate savings", () => {
    const d = db();
    boqItem(d, 1, "Roof", 100, 50);   // £5,000
    boqItem(d, 2, "Roof", 10, 100);   // £1,000
    boqItem(d, 3, "Walls", 20, 25);   // £500
    boqItem(d, 9, "Roof", 999, 999, 2); // a superseded snapshot — not the budget
    liveRate(d, 1, 40);               // £10/unit cheaper on 100 units
    const byS = Object.fromEntries(position(d).map((r) => [r.section, r]));
    assert.equal(byS.Roof.budget, 6000);
    assert.equal(byS.Roof.line_count, 2);
    assert.equal(byS.Roof.saving, 1000);
    assert.equal(byS.Walls.budget, 500);
    assert.equal(byS.Walls.saving, 0);
  });

  test("splits certified ad-hoc claims into variation labour and the rest", () => {
    const d = db();
    app(d, 1, 10, 1);
    line(d, 1, "Roof", 4000);
    line(d, 1, "Expenses", 300, 1);
    line(d, 1, "Variations", 250, 1, 7);  // tagged to the register
    line(d, 1, "Variations", 150, 1);     // an uploaded workbook's untagged Variations tab
    line(d, 1, "Daywork", 80, 1);
    const byS = Object.fromEntries(position(d).map((r) => [r.section, r]));
    assert.equal(byS.Roof.boq_expended, 4000);
    assert.equal(byS.Expenses.other_expended, 300);
    assert.equal(byS.Variations.variation_expended, 400);
    assert.equal(byS.Variations.other_expended, 0);
    assert.equal(byS.Daywork.other_expended, 80);
  });

  test("the per-project total and the per-section split are the same number", () => {
    const d = db();
    boqItem(d, 1, "Roof", 100, 50);
    app(d, 1, 10, 1); line(d, 1, "Roof", 5000); line(d, 1, "Expenses", 120, 1);
    app(d, 2, 10, 2); line(d, 2, "Roof", 8000); line(d, 2, "Variations", 400, 1);
    app(d, 3, 11, 3); line(d, 3, "Prelims", 3300);
    const split = Object.values(sections(d)).reduce((s, v) => s + v, 0);
    assert.equal(pence(split), total(d));
    assert.equal(total(d), 8000 + 120 + 400 + 3300);
  });
});
