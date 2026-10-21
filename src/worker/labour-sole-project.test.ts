// The project a labour email goes to when it names none: the subbie's only
// recent live project, or nothing (and it parks for someone to assign).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SUBBIE_RECENT_PROJECTS } from "./labour-sole-project";

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, code TEXT, name TEXT, deleted_at TEXT);
    CREATE TABLE applications_for_payment (id INTEGER PRIMARY KEY, project_id TEXT, direction TEXT,
      counterparty_supplier_id INTEGER, status TEXT, submitted_at TEXT, created_at TEXT);
    INSERT INTO projects VALUES ('blyth', '26004', 'Blyth', NULL), ('dallasb', '26002', 'Dallas Rd B', NULL),
      ('dallasc', '26003', 'Dallas Rd C', NULL), ('old', '25008', 'Old job', '2026-09-01');
  `);
  return d;
}
const add = (d: DatabaseSync, id: number, project: string, supplier: number, status: string, at: string, direction = "incoming_labour") =>
  d.prepare("INSERT INTO applications_for_payment VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, project, direction, supplier, status, at, at);
const pick = (d: DatabaseSync, supplier: number, since = "2026-06-01") => {
  const rows = d.prepare(SUBBIE_RECENT_PROJECTS).all(supplier, since) as Array<{ id: string }>;
  return rows.length === 1 ? rows[0].id : null;
};

test("a subbie on one site gets that site", () => {
  const d = db();
  add(d, 1, "blyth", 51, "paid", "2026-09-01");
  add(d, 2, "blyth", 51, "submitted", "2026-10-13");
  assert.equal(pick(d, 51), "blyth");
});

test("a subbie across two blocks gets nothing — it parks", () => {
  const d = db();
  add(d, 1, "dallasb", 66, "certified", "2026-10-01");
  add(d, 2, "dallasc", 66, "submitted", "2026-10-10");
  assert.equal(pick(d, 66), null);
});

test("drafts, old work, deleted projects and client applications don't count", () => {
  const d = db();
  add(d, 1, "blyth", 47, "certified", "2026-10-01");
  add(d, 2, "dallasb", 47, "draft", "2026-10-02");
  add(d, 3, "dallasc", 47, "paid", "2026-01-15");
  add(d, 4, "old", 47, "submitted", "2026-10-03");
  add(d, 5, "dallasb", 47, "submitted", "2026-10-04", "outgoing");
  assert.equal(pick(d, 47), "blyth");
});

test("a subbie with no history gets nothing", () => {
  assert.equal(pick(db(), 99), null);
});
