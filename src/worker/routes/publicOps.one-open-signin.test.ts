// One open sign-in per person, whichever phone they use.
//
//   npm test
//
// The phone that signed someone in remembers it; nothing else did. On
// 2026-10-08 a Latbuild roofer signed himself in at Dallas Rd Block B at 07:21,
// then a manager picked his name again on her own phone at 11:43 — two open
// rows, so the day's register counted him twice. And with operatives now on
// more than one site, someone still signed in at Block B who signs in at the
// Townhouse would be recorded at both at once.
//
// Runs the real routes against the full migration set in SQLite.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import type { Env } from "../env";
import { publicOps } from "./publicOps";

const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

function schema(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  }
  const now = "2026-10-01T08:00:00.000Z";
  db.exec(`
    INSERT INTO projects (id, code, name, created_at, created_by) VALUES
      ('p1', '26001', 'Dallas Rd Block B', '${now}', 't'),
      ('p2', '26002', 'Dallas Rd Block C', '${now}', 't'),
      ('p8', '26008', 'Dallas Rd Townhouse', '${now}', 't');
    INSERT INTO site_groups (id, name, base_project_id, created_at, created_by) VALUES ('g', 'Dallas Rd', 'p1', '${now}', 't');
    UPDATE projects SET site_group_id = 'g' WHERE id IN ('p1', 'p2');
    INSERT INTO site_tokens (token, project_id, active, created_at, created_by) VALUES
      ('tok-b', 'p1', 1, '${now}', 't'), ('tok-c', 'p2', 1, '${now}', 't'), ('tok-th', 'p8', 1, '${now}', 't');
    INSERT INTO operatives (id, token, name, company, phone, phone_norm, assigned_project_id, induction_done, created_at, created_by) VALUES
      ('pedro',  'pt', 'PEDRO OSHIRO',      'LATBUILD', '07000000001', '7000000001', 'p8', 1, '${now}', 't'),
      ('akzhol', 'at', 'AKZHOL ZHOMATAYRV', 'LATBUILD', '07000000002', '7000000002', 'p1', 1, '${now}', 't');
    INSERT INTO operative_extra_sites (operative_id, project_id, added_at, added_by) VALUES ('pedro', 'p1', '${now}', 't');
  `);
  return db;
}

/** Just enough of D1 over node:sqlite for these routes. */
function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const stmt = {
      bind(...a: unknown[]) { args = a; return stmt; },
      async first<T>() { return (db.prepare(sql).get(...(args as never[])) ?? null) as T; },
      async all<T>() { return { results: db.prepare(sql).all(...(args as never[])) as T[] }; },
      async run() { const r = db.prepare(sql).run(...(args as never[])); return { meta: { changes: r.changes } }; },
    };
    return stmt;
  };
  return { prepare, async batch(stmts: Array<{ run(): Promise<unknown> }>) { for (const s of stmts) await s.run(); return []; } };
}

type SignInBody = { id: number; already_signed_in?: boolean; signed_in_at?: string; moved_from?: string | null };

function site(db: DatabaseSync) {
  const a = new Hono();
  a.route("/pub", publicOps);
  const env = { DB: d1(db) } as unknown as Env;
  const post = (path: string, body: unknown) =>
    a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
  return {
    async signIn(token: string, operativeId: string): Promise<SignInBody> {
      const r = await post(`/pub/site/${token}/signin`, { operative_id: operativeId, name: "x", signature: "data:sig" });
      assert.equal(r.status, 200, await r.clone().text());
      return (await r.json()) as SignInBody;
    },
    async signOut(token: string, id: number) {
      const r = await post(`/pub/site/${token}/signout`, { signin_id: id });
      assert.equal(r.status, 200);
    },
  };
}

const openRows = (db: DatabaseSync, opId: string) =>
  (db.prepare("SELECT id, project_id FROM site_signins WHERE operative_id = ? AND signed_out_at IS NULL ORDER BY id").all(opId) as Array<{ id: number; project_id: string }>)
    .map((r) => ({ id: r.id, project_id: r.project_id })); // node:sqlite rows have a null prototype

describe("signing in when already signed in", () => {
  test("a second sign-in at the same site hands back the first — one row, not two", async () => {
    const db = schema();
    const s = site(db);
    const first = await s.signIn("tok-b", "akzhol");
    assert.equal(first.already_signed_in, undefined);
    const again = await s.signIn("tok-b", "akzhol");
    assert.equal(again.already_signed_in, true);
    assert.equal(again.id, first.id);
    assert.ok(again.signed_in_at, "the page shows when they actually signed in");
    assert.equal(openRows(db, "akzhol").length, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM site_signins").get() as { n: number }).n, 1);
  });

  test("a sibling block's link is the same site — and its Sign out button closes the handed-back row", async () => {
    const db = schema();
    const s = site(db);
    const first = await s.signIn("tok-b", "akzhol");
    const again = await s.signIn("tok-c", "akzhol");
    assert.equal(again.already_signed_in, true);
    assert.equal(again.id, first.id);
    await s.signOut("tok-c", again.id);
    assert.deepEqual(openRows(db, "akzhol"), []);
  });

  test("signing out and coming back later is a fresh sign-in, as before", async () => {
    const db = schema();
    const s = site(db);
    const first = await s.signIn("tok-b", "akzhol");
    await s.signOut("tok-b", first.id);
    const back = await s.signIn("tok-b", "akzhol");
    assert.equal(back.already_signed_in, undefined);
    assert.notEqual(back.id, first.id);
    assert.equal(openRows(db, "akzhol").length, 1);
  });

  test("signing in at another site signs them out of the first", async () => {
    const db = schema();
    const s = site(db);
    const blockB = await s.signIn("tok-b", "pedro");
    const townhouse = await s.signIn("tok-th", "pedro");
    assert.equal(townhouse.already_signed_in, undefined);
    assert.equal(townhouse.moved_from, "26001");
    assert.notEqual(townhouse.id, blockB.id);
    assert.deepEqual(openRows(db, "pedro"), [{ id: townhouse.id, project_id: "p8" }]);
    const closed = db.prepare("SELECT signed_out_at FROM site_signins WHERE id = ?").get(blockB.id) as { signed_out_at: string | null };
    assert.ok(closed.signed_out_at);
  });

  test("other people's sign-ins are untouched", async () => {
    const db = schema();
    const s = site(db);
    await s.signIn("tok-b", "akzhol");
    await s.signIn("tok-b", "pedro");
    await s.signIn("tok-th", "pedro");
    assert.equal(openRows(db, "akzhol").length, 1);
  });

  test("a sign-in left open from a previous day doesn't count as today's", async () => {
    const db = schema();
    db.exec(`INSERT INTO site_signins (project_id, operative_id, name, signed_in_at, created_at)
             VALUES ('p1', 'akzhol', 'AKZHOL ZHOMATAYRV', '2026-01-05T07:00:00.000Z', '2026-01-05T07:00:00.000Z')`);
    const r = await site(db).signIn("tok-b", "akzhol");
    assert.equal(r.already_signed_in, undefined);
  });
});
