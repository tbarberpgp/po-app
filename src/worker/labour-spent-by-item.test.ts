// Certified labour per BOQ line must add up to the section totals the Labour
// subtab already shows — the same applications, the same lines.
//
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LABOUR_POSITION, LABOUR_SPENT_BY_ITEM } from "./labour-expended";

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(`
    CREATE TABLE applications_for_payment (
      id INTEGER PRIMARY KEY, project_id TEXT, direction TEXT, app_number INTEGER,
      status TEXT, counterparty_supplier_id INTEGER,
      prelim_heading TEXT, claimed_amount REAL, cumulative_value REAL, claim_basis TEXT);
    CREATE TABLE afp_lines (
      id INTEGER PRIMARY KEY, afp_id INTEGER, contract_item_id INTEGER, section TEXT,
      cumulative_value REAL, is_adhoc INTEGER DEFAULT 0, variation_id INTEGER);
    CREATE TABLE material_snapshots (id INTEGER PRIMARY KEY, project_id TEXT, is_active INTEGER);
    CREATE TABLE contract_items (
      id INTEGER PRIMARY KEY, snapshot_id INTEGER, section TEXT, description TEXT,
      qty REAL, labour_rate REAL, labour_total REAL);
    CREATE TABLE labour_live_rates (
      id INTEGER PRIMARY KEY, project_id TEXT, contract_item_id INTEGER, description TEXT,
      live_rate REAL, status TEXT, applied_at TEXT);
    INSERT INTO material_snapshots VALUES (1, 'p1', 1);
    INSERT INTO contract_items VALUES
      (10, 1, 'Prelims', 'Project Manager Whole Scope', 19.2, 2500, 48000),
      (20, 1, 'Removal of Flashings', 'Roof Removal of Flashings', 642.5, 12, 7710),
      (21, 1, 'Removal of Flashings', 'Cladding Removal of Flashings', 495, 12, 5940);`);
  return d;
}
const app = (d: DatabaseSync, id: number, sup: number, no: number, status: string, basis: string | null) =>
  d.prepare(`INSERT INTO applications_for_payment (id, project_id, direction, app_number, status, counterparty_supplier_id, claim_basis)
    VALUES (?, 'p1', 'incoming_labour', ?, ?, ?, ?)`).run(id, no, status, sup, basis);
const line = (d: DatabaseSync, afp: number, item: number | null, section: string, v: number, adhoc = 0) =>
  d.prepare("INSERT INTO afp_lines (afp_id, contract_item_id, section, cumulative_value, is_adhoc) VALUES (?,?,?,?,?)")
    .run(afp, item, section, v, adhoc);
const spent = (d: DatabaseSync) => Object.fromEntries(
  (d.prepare(`SELECT contract_item_id, spent FROM (${LABOUR_SPENT_BY_ITEM}) WHERE pid = 'p1'`).all() as Array<{ contract_item_id: number; spent: number }>)
    .map((r) => [r.contract_item_id, Math.round(r.spent * 100) / 100]));

test("period claims sum, running totals take the latest, and lines add up to their section", () => {
  const d = db();
  // Garbutt: weekly period claims against the PM line — every certified one counts.
  app(d, 1, 7, 3, "paid", "period"); line(d, 1, 10, "Prelims", 3300);
  app(d, 2, 7, 9, "paid", "period"); line(d, 2, 10, "Prelims", 1650);
  app(d, 3, 7, 27, "submitted", "period"); line(d, 3, 10, "Prelims", 3850); // not certified
  app(d, 4, 7, 29, "paid", "period"); line(d, 4, 10, "Prelims", 2016.58); line(d, 4, null, "Expenses", 366.58, 1);
  // Cladders: running totals — only the newest certified one counts.
  app(d, 5, 3, 1, "certified", null); line(d, 5, 20, "Removal of Flashings", 2196);
  app(d, 6, 3, 2, "certified", null); line(d, 6, 20, "Removal of Flashings", 5000); line(d, 6, 21, "Removal of Flashings", 4676.8);
  app(d, 7, 3, 7, "draft", null); line(d, 7, 21, "Removal of Flashings", 9999);

  assert.deepEqual(spent(d), { 10: 6966.58, 20: 5000, 21: 4676.8 });

  const bySection = Object.fromEntries(
    (d.prepare(`SELECT section, boq_expended FROM (${LABOUR_POSITION}) WHERE pid = 'p1'`).all() as Array<{ section: string; boq_expended: number }>)
      .map((r) => [r.section, Math.round(r.boq_expended * 100) / 100]));
  assert.equal(bySection["Prelims"], spent(d)[10]);
  assert.equal(bySection["Removal of Flashings"], Math.round((spent(d)[20] + spent(d)[21]) * 100) / 100);
});
