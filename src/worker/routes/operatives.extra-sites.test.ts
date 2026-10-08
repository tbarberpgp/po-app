// An operative working two sites in the same week — on both sign-in lists.
//
//   npm test
//
// Sign-in is picker-only: an operative appears on a site's list only if they
// work there, and a name that isn't on the list is a silent lockout (nothing is
// logged, no request is ever made). Until 0132 "work there" meant exactly one
// assigned site, so a Latbuild roofer assigned to Dallas Rd Townhouse (26008)
// could not sign in at Blocks B/C/D (26001 group) where his crew was — and
// moving him meant he couldn't sign in at the Townhouse instead.
//
// These run the real routes against the full migration set in SQLite, because
// the property that matters is that the picker, the gate and the roster all
// agree on who is on a site. A list that shows a name the gate then refuses is
// the same lockout with an extra step.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { operatives } from "./operatives";
import { publicOps } from "./publicOps";

const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

function schema(opts: { withExtraSites: boolean }): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    if (!opts.withExtraSites && f >= "0132") continue;
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
      ('tok-b', 'p1', 1, '${now}', 't'), ('tok-th', 'p8', 1, '${now}', 't');
    INSERT INTO operatives (id, token, name, company, assigned_project_id, induction_done, created_at, created_by) VALUES
      ('pedro', 'pt', 'PEDRO OSHIRO', 'LATBUILD', 'p8', 1, '${now}', 't'),
      ('crew',  'ct', 'CREW MATE',    'LATBUILD', 'p1', 1, '${now}', 't');
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

function app(db: DatabaseSync) {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use("*", async (c, next) => {
    c.set("userEmail", "alaw@powergridprojects.net");
    c.set("userRole", "superadmin" as Variables["userRole"]);
    c.set("userGrants", []);
    await next();
  });
  a.route("/api/operatives", operatives);
  a.route("/pub", publicOps);
  const env = { DB: d1(db) } as unknown as Env;
  return {
    get: (path: string) => a.request(path, {}, env),
    send: (method: string, path: string, body?: unknown) =>
      a.request(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env),
  };
}

async function pickerNames(api: ReturnType<typeof app>, token: string): Promise<string[]> {
  const r = await api.get(`/pub/site/${token}`);
  assert.equal(r.status, 200);
  return ((await r.json()) as { operatives: Array<{ name: string }> }).operatives.map((o) => o.name);
}

/** Whether the sign-in gate turns them away as not belonging to the site. */
async function refusedAsUnassigned(api: ReturnType<typeof app>, token: string, operativeId: string): Promise<boolean> {
  const r = await api.send("POST", `/pub/site/${token}/signin`, { operative_id: operativeId, name: "x" });
  const body = (await r.json()) as { unassigned?: boolean };
  return r.status === 403 && body.unassigned === true;
}

async function rosterIds(api: ReturnType<typeof app>, projectId: string) {
  const r = await api.get(`/api/operatives/by-project/${projectId}`);
  assert.equal(r.status, 200);
  return (await r.json()) as Array<{ id: string; extra_here: boolean; home_project_code: string | null; extra_project_codes: string | null }>;
}

// Runs first: the extra-sites table check memoises only once it succeeds.
describe("before migration 0132 is applied", () => {
  test("sign-in still works on home sites — a missing table never empties the list", async () => {
    const api = app(schema({ withExtraSites: false }));
    assert.deepEqual(await pickerNames(api, "tok-b"), ["CREW MATE"]);
    assert.deepEqual(await pickerNames(api, "tok-th"), ["PEDRO OSHIRO"]);
    assert.equal(await refusedAsUnassigned(api, "tok-th", "pedro"), false);
    assert.equal((await rosterIds(api, "p8")).length, 1);
  });
});

describe("an operative on two sites", () => {
  test("adding Block B as an extra site puts him on its list and lets him through, without leaving the Townhouse", async () => {
    const api = app(schema({ withExtraSites: true }));
    assert.deepEqual(await pickerNames(api, "tok-b"), ["CREW MATE"]);
    assert.equal(await refusedAsUnassigned(api, "tok-b", "pedro"), true);

    const r = await api.send("POST", "/api/operatives/pedro/extra-sites", { project_id: "p1" });
    assert.equal(r.status, 200);

    assert.deepEqual(await pickerNames(api, "tok-b"), ["CREW MATE", "PEDRO OSHIRO"]);
    assert.equal(await refusedAsUnassigned(api, "tok-b", "pedro"), false);
    // Still on the Townhouse list — this is "also", not "move".
    assert.deepEqual(await pickerNames(api, "tok-th"), ["PEDRO OSHIRO"]);
    assert.equal(await refusedAsUnassigned(api, "tok-th", "pedro"), false);
  });

  test("both rosters show him, each saying where else he works", async () => {
    const api = app(schema({ withExtraSites: true }));
    await api.send("POST", "/api/operatives/pedro/extra-sites", { project_id: "p1" });
    const block = (await rosterIds(api, "p1")).find((o) => o.id === "pedro");
    assert.ok(block, "Block B roster must include him — RAMS and toolbox talks go to this list");
    assert.equal(block.extra_here, true);
    assert.equal(block.home_project_code, "26008");
    // Block C shares the group's list, so he is on its roster too.
    assert.ok((await rosterIds(api, "p2")).some((o) => o.id === "pedro"));
    const home = (await rosterIds(api, "p8")).find((o) => o.id === "pedro");
    assert.equal(home?.extra_here, false);
    assert.equal(home?.extra_project_codes, "26001");
  });

  test("removing the extra site from a sibling block takes him off the group's list, not off his home site", async () => {
    const api = app(schema({ withExtraSites: true }));
    await api.send("POST", "/api/operatives/pedro/extra-sites", { project_id: "p1" });
    const r = await api.send("DELETE", "/api/operatives/pedro/extra-sites/p2");
    assert.equal(r.status, 200);
    assert.deepEqual(await pickerNames(api, "tok-b"), ["CREW MATE"]);
    assert.deepEqual(await pickerNames(api, "tok-th"), ["PEDRO OSHIRO"]);
  });

  test("an extra site inside his home site's group is refused, not stored twice", async () => {
    const api = app(schema({ withExtraSites: true }));
    const r = await api.send("POST", "/api/operatives/crew/extra-sites", { project_id: "p2" });
    assert.equal(r.status, 400);
  });

  test("moving his home onto the extra site drops the now-redundant extra row", async () => {
    const db = schema({ withExtraSites: true });
    const api = app(db);
    await api.send("POST", "/api/operatives/pedro/extra-sites", { project_id: "p1" });
    const r = await api.send("POST", "/api/operatives/pedro/assign", { project_id: "p2" });
    assert.equal(r.status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM operative_extra_sites").get()?.n, 0);
    assert.deepEqual(await pickerNames(api, "tok-th"), []);
    assert.ok((await pickerNames(api, "tok-b")).includes("PEDRO OSHIRO"));
  });
});
