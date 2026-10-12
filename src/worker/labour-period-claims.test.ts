// Period claims: an application that is worth its own lines (migration 0136).
//
//   npm test
//
// Paul Garbutt bills Blyth one week at a time — "Site Management Services,
// 6 × £550". Every application was read as a running total less everything
// before it, so each week cancelled the last: thirteen invoices for £39,050
// from July to October read £9,346 in the app, and #25 and #27 read £0.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { periodNet, priorAnchor } from "./routes/applications";
import { LABOUR_POSITION } from "./labour-expended";

/** Garbutt's Blyth invoices as they are on paper, in application order. */
const GARBUTT = [
  { app: 3, inv: "INV-002", total: 3300 }, { app: 9, inv: "INV-004", total: 3300 },
  { app: 10, inv: "INV-005", total: 1650 }, { app: 12, inv: "INV-007", total: 2750 },
  { app: 14, inv: "INV-006", total: 2750 }, { app: 16, inv: "INV-008", total: 2750 },
  { app: 18, inv: "INV-009", total: 3300 }, { app: 19, inv: "INV-010", total: 3300 },
  { app: 20, inv: "INV-011", total: 1650 }, { app: 22, inv: "INV-012", total: 3300 },
  { app: 23, inv: "INV-013", total: 3850 }, { app: 25, inv: "INV-014", total: 3300 },
  { app: 27, inv: "INV-015", total: 3850 },
];

describe("periodNet with a claim basis", () => {
  test("a period claim is worth its own lines, whatever came before", () => {
    assert.equal(periodNet({ cumulative: 3850, previousCertified: 28050, expensesAmount: 0, dayworksAmount: 0, basis: "period" }), 3850);
  });

  test("a cumulative claim is still the movement since the last one", () => {
    assert.equal(periodNet({ cumulative: 34096, previousCertified: 28050, expensesAmount: 0, dayworksAmount: 0, basis: "cumulative" }), 6046);
  });

  test("a claim made before 0136 (no basis) reads exactly as it always did", () => {
    assert.equal(periodNet({ cumulative: 34096, previousCertified: 28050, expensesAmount: 0, dayworksAmount: 0 }), 6046);
    assert.equal(periodNet({ cumulative: 34096, previousCertified: 28050, expensesAmount: 0, dayworksAmount: 0, basis: null }), 6046);
  });

  test("standalone claims ride on top in both readings", () => {
    assert.equal(periodNet({ cumulative: 2100, previousCertified: 9999, expensesAmount: 636.9, dayworksAmount: 0, basis: "period" }), 2736.9);
  });

  test("Garbutt's thirteen invoices, read as period claims, come to what he billed", () => {
    // Each application holds its own week; what came before is the sum of the
    // weeks before it — exactly what previous_certified works out — and is
    // shown, but not taken off.
    let before = 0;
    let paid = 0;
    for (const g of GARBUTT) {
      const net = periodNet({ cumulative: g.total, previousCertified: before, expensesAmount: 0, dayworksAmount: 0, basis: "period" });
      assert.equal(net, g.total, `${g.inv} on #${g.app}`);
      paid += net;
      before += priorAnchor({ certified_amount: null, cumulative_value: g.total, expenses_amount: 0, dayworks_amount: 0 });
    }
    assert.equal(paid, 39050);
  });

  test("the same series read as running totals cancels itself out — the bug", () => {
    let before = 0;
    const nets: number[] = [];
    for (const g of GARBUTT) {
      nets.push(periodNet({ cumulative: g.total, previousCertified: before, expensesAmount: 0, dayworksAmount: 0 }));
      before += g.total;
    }
    assert.equal(nets[0], 3300);
    assert.ok(nets.slice(1).every((n) => n === 0), "every week after the first reads £0");
  });
});

// LABOUR_POSITION is the one query behind labour expended, forecast cost and
// the dashboard. Run it for real so the rule is tested, not described.
function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(`
    CREATE TABLE material_snapshots (id INTEGER PRIMARY KEY, project_id TEXT, is_active INTEGER);
    CREATE TABLE contract_items (id INTEGER PRIMARY KEY, snapshot_id INTEGER, section TEXT, description TEXT,
      qty REAL, labour_rate REAL, labour_total REAL);
    CREATE TABLE labour_live_rates (contract_item_id INTEGER, description TEXT, project_id TEXT, status TEXT,
      live_rate REAL, applied_at TEXT);
    CREATE TABLE applications_for_payment (id INTEGER PRIMARY KEY, project_id TEXT, direction TEXT, app_number INTEGER,
      status TEXT, counterparty_supplier_id INTEGER, prelim_heading TEXT, claimed_amount REAL, claim_basis TEXT);
    CREATE TABLE afp_lines (afp_id INTEGER, section TEXT, cumulative_value REAL, is_adhoc INTEGER, variation_id INTEGER);
    INSERT INTO material_snapshots VALUES (1, 'P', 1);
    INSERT INTO contract_items VALUES (1, 1, 'Prelims', 'Project Manager Whole Scope', 1, 48000, 48000);
  `);
  return d;
}
const app = (d: DatabaseSync, id: number, n: number, sup: number, status: string, basis: string | null, boq: number) => {
  d.prepare("INSERT INTO applications_for_payment VALUES (?, 'P', 'incoming_labour', ?, ?, ?, NULL, NULL, ?)").run(id, n, status, sup, basis);
  d.prepare("INSERT INTO afp_lines VALUES (?, 'Prelims', ?, 0, NULL)").run(id, boq);
};
const boqExpended = (d: DatabaseSync) =>
  (d.prepare(`SELECT COALESCE(SUM(boq_expended), 0) AS v FROM (${LABOUR_POSITION}) WHERE pid = 'P'`).get() as { v: number }).v;

describe("LABOUR_POSITION: which applications' BOQ lines count", () => {
  test("applications from before 0136 count exactly as before — the newest certified per subcontractor", () => {
    const d = db();
    app(d, 1, 1, 7, "certified", null, 2196);
    app(d, 2, 2, 7, "certified", null, 9676.8);
    app(d, 3, 3, 8, "certified", null, 5496);
    app(d, 4, 4, 8, "submitted", null, 9999); // not certified: never counts
    assert.equal(boqExpended(d), 9676.8 + 5496);
  });

  test("every certified period claim counts — a weekly subcontractor's weeks add up", () => {
    const d = db();
    app(d, 1, 1, 8, "certified", "period", 3300);
    app(d, 2, 2, 8, "certified", "period", 3300);
    app(d, 3, 3, 8, "paid", "period", 1650);
    app(d, 4, 4, 8, "submitted", "period", 2750); // not certified: never counts
    assert.equal(boqExpended(d), 3300 + 3300 + 1650);
  });

  test("a running total, then period claims after it: the running total plus the weeks since", () => {
    const d = db();
    app(d, 1, 1, 8, "certified", null, 1000);        // superseded by #2
    app(d, 2, 2, 8, "certified", "cumulative", 5000); // position to date
    app(d, 3, 3, 8, "certified", "period", 700);
    app(d, 4, 4, 8, "certified", "period", 300);
    assert.equal(boqExpended(d), 5000 + 700 + 300);
  });

  test("a period claim from before the newest running total is already inside it", () => {
    const d = db();
    app(d, 1, 1, 8, "certified", "period", 700);
    app(d, 2, 2, 8, "certified", "cumulative", 5000); // restates everything to date, #1 included
    assert.equal(boqExpended(d), 5000);
  });

  test("subcontractors are counted separately", () => {
    const d = db();
    app(d, 1, 1, 7, "certified", null, 2196);
    app(d, 2, 2, 8, "certified", "period", 3300);
    app(d, 3, 3, 8, "certified", "period", 3300);
    assert.equal(boqExpended(d), 2196 + 6600);
  });

  test("a prelims drawdown is never part of labour expended", () => {
    const d = db();
    app(d, 1, 1, 8, "certified", "period", 3300);
    d.prepare("INSERT INTO applications_for_payment VALUES (2, 'P', 'incoming_labour', 2, 'certified', 8, 'Site management', 2100, 'period')").run();
    d.prepare("INSERT INTO afp_lines VALUES (2, 'Prelims', 2100, 0, NULL)").run();
    assert.equal(boqExpended(d), 3300);
  });
});
