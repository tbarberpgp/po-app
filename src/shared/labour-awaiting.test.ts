// Labour awaiting certification: the one rule behind every "labour applied"
// figure on the dashboard, the project Overview and the Labour subtab.
//
//   npm test
//
// Before this, four screens each had their own idea of it. The cash-flow chart
// and its month drill counted drafts, which are not agreed and were meant to be
// off every dashboard. The CSV export's "Labour applied" added up every labour
// application's cumulative position, so a subcontractor restating the same
// position over a series was counted once per application that repeated it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { isLabourAwaitingCertification, labourAwaitingCertification } from "./forecast";
import { LABOUR_AWAITING_CERT } from "../worker/labour-expended";
import type { AfpStatus } from "./types";

type Row = { id: number; direction: "outgoing" | "incoming_labour"; status: AfpStatus; this_period_net: number | null };
const app = (id: number, direction: Row["direction"], status: AfpStatus, this_period_net: number | null): Row =>
  ({ id, direction, status, this_period_net });

// Every combination the rule has to tell apart.
const ROWS: Row[] = [
  app(1, "incoming_labour", "draft", 2593.40),
  app(2, "incoming_labour", "submitted", 2783.90),
  app(3, "incoming_labour", "submitted", 9504.00),
  app(4, "incoming_labour", "certified", 7480.80),
  app(5, "incoming_labour", "paid", 2196.00),
  app(6, "outgoing", "submitted", 190827.83),
  app(7, "outgoing", "draft", 1000.00),
  app(8, "incoming_labour", "submitted", null),
];

describe("isLabourAwaitingCertification", () => {
  test("a submitted labour application is awaiting certification", () => {
    assert.equal(isLabourAwaitingCertification(app(0, "incoming_labour", "submitted", 1)), true);
  });
  test("a draft is not — it has not been agreed, and stays off every dashboard", () => {
    assert.equal(isLabourAwaitingCertification(app(0, "incoming_labour", "draft", 1)), false);
  });
  test("certified and paid have moved on to labour expended", () => {
    assert.equal(isLabourAwaitingCertification(app(0, "incoming_labour", "certified", 1)), false);
    assert.equal(isLabourAwaitingCertification(app(0, "incoming_labour", "paid", 1)), false);
  });
  test("a client application is never labour", () => {
    assert.equal(isLabourAwaitingCertification(app(0, "outgoing", "submitted", 1)), false);
  });
});

describe("labourAwaitingCertification", () => {
  test("adds the period claims of submitted labour applications only", () => {
    assert.deepEqual(labourAwaitingCertification(ROWS), { total: 12287.90, count: 3 });
  });
  test("a submitted application with no figure yet counts, at £0", () => {
    assert.deepEqual(labourAwaitingCertification([app(1, "incoming_labour", "submitted", null)]), { total: 0, count: 1 });
  });
  test("a restated series is not counted once per restatement", () => {
    // Three weekly applications from one subcontractor. Each restates the
    // running position (2,100 → 4,200 → 6,300) and carries only its advance as
    // this_period_net. The old CSV figure summed the positions: £12,600 for
    // £6,300 of work.
    const series = [
      { ...app(1, "incoming_labour", "submitted", 2100), cumulative_value: 2100 },
      { ...app(2, "incoming_labour", "submitted", 2100), cumulative_value: 4200 },
      { ...app(3, "incoming_labour", "submitted", 2100), cumulative_value: 6300 },
    ];
    assert.equal(series.reduce((s, a) => s + a.cumulative_value, 0), 12600, "what the old figure reported");
    assert.equal(labourAwaitingCertification(series).total, 6300);
  });
  test("rounds to pence", () => {
    assert.equal(labourAwaitingCertification([
      app(1, "incoming_labour", "submitted", 0.1),
      app(2, "incoming_labour", "submitted", 0.2),
    ]).total, 0.3);
  });
});

// The dashboard asks D1 with LABOUR_AWAITING_CERT; the project page asks the
// browser with isLabourAwaitingCertification. If they ever disagree, the
// dashboard's Committed and the project's Committed to date stop matching.
describe("the SQL rule and the TypeScript rule pick the same applications", () => {
  test("on every combination of direction and status", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE applications_for_payment (id INTEGER, direction TEXT, status TEXT, this_period_net REAL)");
    const ins = db.prepare("INSERT INTO applications_for_payment VALUES (?, ?, ?, ?)");
    for (const r of ROWS) ins.run(r.id, r.direction, r.status, r.this_period_net);
    const sqlIds = (db.prepare(`SELECT a.id FROM applications_for_payment a WHERE ${LABOUR_AWAITING_CERT} ORDER BY a.id`)
      .all() as Array<{ id: number }>).map((r) => r.id);
    const tsIds = ROWS.filter(isLabourAwaitingCertification).map((r) => r.id);
    assert.deepEqual(sqlIds, tsIds);
    assert.deepEqual(sqlIds, [2, 3, 8]);
  });
});
