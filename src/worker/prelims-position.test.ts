import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PLANT_ON_ORDER, PRELIMS_POSITION, PRELIM_LINE } from "./prelims-position";

/** A throwaway SQLite shaped like the tables the prelims pot reads. */
function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE material_snapshots (id INTEGER PRIMARY KEY, project_id TEXT, is_active INTEGER);
    CREATE TABLE elements (code TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE materials (
      id INTEGER PRIMARY KEY, snapshot_id INTEGER, item TEXT, type TEXT, element_code TEXT,
      cost REAL, total_units REAL, material_total_cost REAL);
    CREATE TABLE material_omissions (project_id TEXT, item_key TEXT, omit_qty REAL, PRIMARY KEY (project_id, item_key));
    CREATE TABLE project_commercials (id INTEGER PRIMARY KEY, snapshot_id INTEGER, category TEXT, cost REAL, is_total INTEGER);
    CREATE TABLE purchase_orders (id TEXT PRIMARY KEY, project_id TEXT, category TEXT, status TEXT, order_type TEXT, total_value REAL);
    CREATE TABLE po_lines (id INTEGER PRIMARY KEY, po_id TEXT, item TEXT, type TEXT, line_total REAL, is_unpriced INTEGER, material_id INTEGER);
    CREATE TABLE applications_for_payment (
      id INTEGER PRIMARY KEY, project_id TEXT, direction TEXT, status TEXT,
      prelim_heading TEXT, claimed_amount REAL, cumulative_value REAL);
    CREATE TABLE plant_logs (
      id INTEGER PRIMARY KEY, project_id TEXT, po_id TEXT, day_rate REAL, rate_unit TEXT,
      on_hire_from TEXT, off_hire_to TEXT);
    INSERT INTO projects (id) VALUES ('p1'), ('p2');
    INSERT INTO material_snapshots (id, project_id, is_active) VALUES (1, 'p1', 1), (2, 'p1', 0), (3, 'p2', 1);
    INSERT INTO elements (code, name) VALUES ('PRE', 'Preliminaries'), ('ROOF', 'Roofing');`);
  return d;
}
let nextId = 100;
const prelimRow = (d: DatabaseSync, item: string, cost: number, units: number, snapshot = 1) => {
  const id = nextId++;
  d.prepare(`INSERT INTO materials (id, snapshot_id, item, type, element_code, cost, total_units, material_total_cost)
    VALUES (?, ?, ?, 'Preliminaries', 'PRE', ?, ?, ?)`).run(id, snapshot, item, cost, units, cost * units);
  return id;
};
const boqRow = (d: DatabaseSync, item: string, cost: number, units: number) => {
  const id = nextId++;
  d.prepare(`INSERT INTO materials (id, snapshot_id, item, type, element_code, cost, total_units, material_total_cost)
    VALUES (?, 1, ?, 'Sheet', 'ROOF', ?, ?, ?)`).run(id, item, cost, units, cost * units);
  return id;
};
const order = (d: DatabaseSync, id: string, category: string, o: { status?: string; type?: string; project?: string } = {}) =>
  d.prepare(`INSERT INTO purchase_orders (id, project_id, category, status, order_type, total_value) VALUES (?, ?, ?, ?, ?, 0)`)
    .run(id, o.project ?? "p1", category, o.status ?? "approved", o.type ?? "standard");
const line = (d: DatabaseSync, po: string, total: number, o: { material_id?: number | null; unpriced?: 0 | 1; item?: string } = {}) =>
  d.prepare(`INSERT INTO po_lines (po_id, item, type, line_total, is_unpriced, material_id) VALUES (?, ?, 'Welfare', ?, ?, ?)`)
    .run(po, o.item ?? "line", total, o.unpriced ?? (o.material_id != null ? 0 : 1), o.material_id ?? null);
const pos = (d: DatabaseSync, pid = "p1") =>
  d.prepare(`SELECT * FROM (${PRELIMS_POSITION}) WHERE pid = ?`).get(pid) as
    { budget: number; row_count: number; orders: number; po_count: number; labour: number };
/** The project page's unpriced list, as projects.ts selects it. */
const unpriced = (d: DatabaseSync) => Number((d.prepare(`
  SELECT COALESCE(SUM(pl.line_total), 0) AS v FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
   WHERE po.project_id = 'p1' AND po.status IN ('approved','issued','pending_approval')
     AND pl.is_unpriced = 1 AND pl.material_id IS NULL
     AND COALESCE(po.order_type, 'standard') != 'call_off'
     AND NOT ${PRELIM_LINE}`).get() as { v: number }).v);

describe("prelims budget", () => {
  test("is the prelim rows' total on the active bill", () => {
    const d = db();
    prelimRow(d, "Site Manager", 1700, 3);      // £5,100
    prelimRow(d, "Project Manager", 2750, 1);   // £2,750
    prelimRow(d, "Site Manager", 9999, 9, 2);   // superseded snapshot — not the budget
    boqRow(d, "Roof sheet", 50, 100);           // a BOQ material — not prelims
    assert.equal(pos(d).budget, 7850);
    assert.equal(pos(d).row_count, 2);
  });

  test("falls back to the cost sheet's Preliminaries line when the bill has no prelim rows", () => {
    const d = db();
    d.exec(`INSERT INTO project_commercials (snapshot_id, category, cost, is_total) VALUES
      (1, 'Preliminaries', 18700, 0), (1, 'Business Prelims', 0, 0), (1, 'Total', 300000, 1)`);
    assert.equal(pos(d).budget, 18700);
  });

  test("the rows win when both exist, so the budget isn't counted twice", () => {
    const d = db();
    prelimRow(d, "Site Manager", 1700, 3);
    d.exec(`INSERT INTO project_commercials (snapshot_id, category, cost, is_total) VALUES (1, 'Preliminaries', 5100, 0)`);
    assert.equal(pos(d).budget, 5100);
  });

  // Forecast cost already takes omitted budget out; the pot mustn't still offer it.
  test("an omitted row's budget is gone, a part-omitted row keeps the rest", () => {
    const d = db();
    prelimRow(d, "Site Manager", 1700, 3);      // £5,100, 1 of 3 omitted → £3,400
    prelimRow(d, "Welfare", 400, 10);           // £4,000, wholly omitted → £0
    d.exec(`INSERT INTO material_omissions (project_id, item_key, omit_qty) VALUES ('p1', 'site manager', 1), ('p1', 'welfare', NULL)`);
    assert.equal(pos(d).budget, 3400);
  });
});

describe("prelims orders", () => {
  test("count every committed prelim order line, frameworks included", () => {
    const d = db();
    order(d, "a", "prelims"); line(d, "a", 329.33);
    order(d, "b", "prelims", { type: "framework" }); line(d, "b", 100);
    order(d, "c", "prelims", { status: "pending_approval" }); line(d, "c", 50);
    assert.equal(pos(d).orders, 479.33);
    assert.equal(pos(d).po_count, 3);
  });

  test("leave out call-offs, drafts, rejected and deleted orders", () => {
    const d = db();
    order(d, "a", "prelims", { type: "call_off" }); line(d, "a", 100);
    order(d, "b", "prelims", { status: "draft" }); line(d, "b", 100);
    order(d, "c", "prelims", { status: "rejected" }); line(d, "c", 100);
    order(d, "e", "prelims", { status: "deleted" }); line(d, "e", 100);
    assert.equal(pos(d).orders, 0);
  });

  test("follow the budget row a line is coded to, whatever the order's category", () => {
    const d = db();
    const pre = prelimRow(d, "Site Manager", 1700, 3);
    const mat = boqRow(d, "Roof sheet", 50, 100);
    order(d, "m", "materials"); line(d, "m", 200, { material_id: pre });   // coded to a prelim row → prelims
    order(d, "p", "prelims"); line(d, "p", 70, { material_id: mat });      // coded to a BOQ material → that material's
    assert.equal(pos(d).orders, 200);
  });

  // The whole point: before, prelim orders sat in the unpriced list at full
  // value AND drew on a budget already inside contract cost.
  test("every unpriced line is counted exactly once — prelims or unpriced, never both", () => {
    const d = db();
    order(d, "p", "prelims"); line(d, "p", 329.33); line(d, "p", 232.11);
    order(d, "m", "materials"); line(d, "m", 90);
    assert.equal(pos(d).orders, 561.44);
    assert.equal(unpriced(d), 90);
    const all = Number((d.prepare("SELECT SUM(line_total) AS v FROM po_lines").get() as { v: number }).v);
    assert.equal(Math.round((pos(d).orders + unpriced(d)) * 100), Math.round(all * 100));
  });

  test("belong to their own project", () => {
    const d = db();
    order(d, "a", "prelims", { project: "p2" }); line(d, "a", 500);
    assert.equal(pos(d).orders, 0);
    assert.equal(pos(d, "p2").orders, 500);
  });
});

describe("prelims labour", () => {
  test("counts certified prelim-tagged claims only", () => {
    const d = db();
    d.exec(`INSERT INTO applications_for_payment (project_id, direction, status, prelim_heading, claimed_amount, cumulative_value) VALUES
      ('p1', 'incoming_labour', 'certified', 'Site management', 1200, 1200),
      ('p1', 'incoming_labour', 'paid', 'Site management', 300, 300),
      ('p1', 'incoming_labour', 'submitted', 'Site management', 900, 900),
      ('p1', 'incoming_labour', 'certified', NULL, NULL, 5000)`);
    assert.equal(pos(d).labour, 1500);
  });
});

describe("plant on order", () => {
  test("lists tracker rows with a live order behind them, and only those", () => {
    const d = db();
    order(d, "live", "prelims");
    order(d, "gone", "prelims", { status: "deleted" });
    d.exec(`INSERT INTO plant_logs (project_id, po_id, day_rate, rate_unit, on_hire_from) VALUES
      ('p1', 'live', 126, 'day', '2026-09-01'),
      ('p1', 'gone', 126, 'day', '2026-09-01'),
      ('p1', NULL, 126, 'day', '2026-09-01'),
      ('p1', 'live', NULL, 'day', '2026-09-01')`);
    const rows = d.prepare(PLANT_ON_ORDER).all() as Array<{ po_id: string }>;
    assert.deepEqual(rows.map((r) => r.po_id), ["live"]);
  });
});
