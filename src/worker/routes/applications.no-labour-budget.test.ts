// A job with no labour budget: the subbie's bill is the claim.
//
//   npm test
//
// Latbuild's App-03 on 26006 LON3 Dog Boxes billed £7,700 over four day-rate
// lines. 26006's pricing workbook carries no labour, so there was nothing for
// those lines to match, every one sat unmatched, and the certificate read £0.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { carryWithoutLabourBudget } from "./applications";

/** Just enough of D1 over node:sqlite for these queries. */
function d1(db: DatabaseSync): D1Database {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async <T>() => (db.prepare(sql).get(...(args as never[])) ?? null) as T | null,
    all: async <T>() => ({ results: db.prepare(sql).all(...(args as never[])) as T[] }),
    run: async () => { db.prepare(sql).run(...(args as never[])); return { success: true }; },
  });
  return { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
}

function schema(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${f}`, "utf8"));
  }
  return db;
}

const LINES = [
  { raw_line_no: 1, description: "install riser- Dogbox on roof - WC: 05.10.2026", qty: 10, unit: "day", cumulative_value: 2500 },
  { raw_line_no: 2, description: "install riser- Dogbox on roof - WC: 12.10.2026", qty: 5, unit: "day", cumulative_value: 1350 },
  { raw_line_no: 3, description: "install riser- Dogbox on roof - WC: 05.10.2026", qty: 5, unit: "day", cumulative_value: 1350 },
  { raw_line_no: 4, description: "install riser- Dogbox on roof - WC: 12.10.2026", qty: 10, unit: "day", cumulative_value: 2500 },
];

function seed(labourTotal: number | null) {
  const db = schema();
  db.prepare("INSERT INTO projects (id, code, name, created_at, created_by) VALUES ('p', '26006', 'LON3 Dog Boxes', 't', 't')").run();
  const snap = db.prepare("INSERT INTO material_snapshots (project_id, is_active, uploaded_at, uploaded_by) VALUES ('p', 1, 't', 't') RETURNING id").get() as { id: number };
  db.prepare("INSERT INTO contract_items (snapshot_id, item_no, description, qty, sell_rate, sell_total, labour_total) VALUES (?, 1, 'Dog box', 1, 22420.16, 22420.16, ?)")
    .run(snap.id, labourTotal);
  const afp = db.prepare(
    `INSERT INTO applications_for_payment (project_id, direction, app_number, status, unmatched_lines_json, period_end, created_at, created_by, retention_pct, vat_pct)
     VALUES ('p', 'incoming_labour', 1, 'draft', ?, '2026-10-20', 't', 't', 0, 0) RETURNING id`,
  ).get(JSON.stringify(LINES)) as { id: number };
  return { db, id: afp.id };
}

describe("carryWithoutLabourBudget", () => {
  test("no labour budget: the certificate states what the bill states", async () => {
    const { db, id } = seed(null);
    assert.equal(await carryWithoutLabourBudget(d1(db), id), 4);
    const a = db.prepare("SELECT amount_due, dayworks_amount, unmatched_lines_json, resolved_lines_json FROM applications_for_payment WHERE id = ?").get(id) as
      { amount_due: number; dayworks_amount: number; unmatched_lines_json: string | null; resolved_lines_json: string };
    assert.equal(a.dayworks_amount, 7700);
    assert.equal(a.amount_due, 7700, "no retention on this one, so what's due is what was billed");
    assert.equal(a.unmatched_lines_json, null);
    // Recorded as resolutions, so the certificate's undo still works on each.
    const res = JSON.parse(a.resolved_lines_json) as Array<{ resolution: { action: string; afp_line_id: number } }>;
    assert.deepEqual(res.map((r) => r.resolution.action), ["add_as_daywork", "add_as_daywork", "add_as_daywork", "add_as_daywork"]);
  });

  test("a job with a labour budget is left for someone to match", async () => {
    const { db, id } = seed(5000);
    assert.equal(await carryWithoutLabourBudget(d1(db), id), 0);
    const a = db.prepare("SELECT unmatched_lines_json FROM applications_for_payment WHERE id = ?").get(id) as { unmatched_lines_json: string | null };
    assert.equal(JSON.parse(a.unmatched_lines_json!).length, 4);
  });
});
