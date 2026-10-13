// Days on site at certification — the sign-in register read against a
// day-rate labour application, and the note a disagreement needs.
//
//   npm test
//
// Paul Garbutt bills Blyth "N × £550". On 2026-10-12 Blyth had no sign-ins at
// all, so nothing in the app could say whether he was on site on the days
// billed. Runs the real routes against the full migration set in SQLite.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import type { Env, Variables } from "../env";
import type { AfpSigninDays } from "../../shared/types";
import { applications } from "./applications";

const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

function schema(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  }
  const now = "2026-10-01T08:00:00.000Z";
  db.exec(`
    INSERT INTO projects (id, code, name, created_at, created_by) VALUES
      ('blyth', '26004', 'Blyth', '${now}', 't'),
      ('other', '26001', 'Dallas Rd Block B', '${now}', 't');
    INSERT INTO suppliers (id, name, created_at, created_by) VALUES (51, 'Paul Garbutt', '${now}', 't'), (47, 'Cladders Ltd', '${now}', 't');
    INSERT INTO operatives (id, token, name, company, assigned_project_id, created_at, created_by) VALUES
      ('paul', 'pt', 'PAUL GARBUTT', NULL, 'blyth', '${now}', 't');
    -- #25 ended 1 Oct; #27 (submitted, being certified) ends 8 Oct.
    INSERT INTO applications_for_payment
      (id, project_id, direction, app_number, period_end, status, counterparty_supplier_id, amount_due,
       approved_at, rate_override_at, created_at, created_by)
    VALUES
      (94, 'blyth', 'incoming_labour', 25, '2026-10-01', 'paid', 51, 3300, '${now}', '${now}', '${now}', 't'),
      (96, 'blyth', 'incoming_labour', 27, '2026-10-08', 'submitted', 51, 3850, '${now}', '${now}', '${now}', 't'),
      (97, 'blyth', 'outgoing', 3, '2026-10-08', 'submitted', NULL, 10000, NULL, NULL, '${now}', 't');
  `);
  return db;
}

function signIn(db: DatabaseSync, project: string, at: string, name = "PAUL GARBUTT", opId: string | null = "paul") {
  db.prepare(
    `INSERT INTO site_signins (project_id, name, company, signed_in_at, created_at, operative_id)
     VALUES (?, ?, NULL, ?, ?, ?)`,
  ).run(project, name, at, at, opId);
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
    c.set("userEmail", "qs@powergridprojects.net");
    c.set("userRole", "commercial" as Variables["userRole"]);
    c.set("userGrants", []);
    await next();
  });
  a.route("/api/applications", applications);
  const env = { DB: d1(db) } as unknown as Env;
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  return {
    get: (path: string) => a.request(path, {}, env, ctx),
    post: (path: string, body: unknown) =>
      a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env, ctx),
  };
}

const days = async (api: ReturnType<typeof app>, q = "") => {
  const r = await api.get(`/api/applications/96/signin-days${q}`);
  assert.equal(r.status, 200, await r.clone().text());
  return (await r.json()) as AfpSigninDays;
};

const stored = (db: DatabaseSync) => ({ ...(db.prepare(
  "SELECT status, invoiced_days, signin_days, signin_from, signin_to, signin_note FROM applications_for_payment WHERE id = 96",
).get() as Record<string, unknown>) });

describe("reading the register for a labour application", () => {
  test("the period runs from the day after his previous application; days are counted once each", async () => {
    const db = schema();
    signIn(db, "blyth", "2026-10-01T07:00:00Z"); // #25's period — not this one
    signIn(db, "blyth", "2026-10-05T06:30:00Z");
    signIn(db, "blyth", "2026-10-05T12:30:00Z"); // back from lunch
    signIn(db, "blyth", "2026-10-06T06:30:00Z");
    signIn(db, "other", "2026-10-07T06:30:00Z"); // another site entirely
    const r = await days(app(db));
    assert.equal(r.from, "2026-10-02");
    assert.equal(r.to, "2026-10-08");
    assert.deepEqual(r.days.map((d) => d.date), ["2026-10-05", "2026-10-06"]);
    assert.equal(r.person_days, 2);
    assert.equal(r.site_label, "26004");
  });

  test("nobody signed in — and it says he is on the register, so the gap is the habit, not the set-up", async () => {
    const r = await days(app(schema()));
    assert.equal(r.person_days, 0);
    assert.deepEqual(r.registered, ["PAUL GARBUTT"]);
  });

  test("the QS can widen the period", async () => {
    const db = schema();
    signIn(db, "blyth", "2026-10-01T07:00:00Z");
    const r = await days(app(db), "?from=2026-09-30&to=2026-10-08");
    assert.equal(r.person_days, 1);
  });

  test("a client application has no days on site", async () => {
    const r = await app(schema()).get("/api/applications/97/signin-days");
    assert.equal(r.status, 404);
  });
});

describe("certifying with the days", () => {
  test("invoice and register agree — certifies and records both", async () => {
    const db = schema();
    signIn(db, "blyth", "2026-10-05T06:30:00Z");
    signIn(db, "blyth", "2026-10-06T06:30:00Z");
    const r = await app(db).post("/api/applications/96/certify", { certified_amount: 1100, invoiced_days: 2 });
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(stored(db), {
      status: "certified", invoiced_days: 2, signin_days: 2,
      signin_from: "2026-10-02", signin_to: "2026-10-08", signin_note: null,
    });
  });

  test("invoice for 7 days, register shows none — refused without a note", async () => {
    const db = schema();
    const r = await app(db).post("/api/applications/96/certify", { certified_amount: 3850, invoiced_days: 7 });
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /7 days .* register shows 0/);
    assert.equal(stored(db).status, "submitted");
  });

  test("…and certifies with one, keeping the note for the approver", async () => {
    const db = schema();
    const r = await app(db).post("/api/applications/96/certify", {
      certified_amount: 3850, invoiced_days: 7, signin_note: "Blyth not using the QR yet — days confirmed from the site diary",
    });
    assert.equal(r.status, 200, await r.clone().text());
    const s = stored(db);
    assert.equal(s.invoiced_days, 7);
    assert.equal(s.signin_days, 0);
    assert.equal(s.signin_note, "Blyth not using the QR yet — days confirmed from the site diary");
  });

  test("the server reads the register itself — a panel can't claim days that aren't there", async () => {
    const db = schema();
    signIn(db, "blyth", "2026-10-05T06:30:00Z");
    // A period that excludes the one sign-in: the register shows 0, not 1.
    const r = await app(db).post("/api/applications/96/certify", {
      certified_amount: 550, invoiced_days: 1, signin_from: "2026-10-06", signin_to: "2026-10-08",
    });
    assert.equal(r.status, 409);
  });

  test("measured work leaves the days blank — certifies as before, nothing recorded", async () => {
    const db = schema();
    const r = await app(db).post("/api/applications/96/certify", { certified_amount: 3850 });
    assert.equal(r.status, 200, await r.clone().text());
    const s = stored(db);
    assert.equal(s.status, "certified");
    assert.equal(s.invoiced_days, null);
    assert.equal(s.signin_days, null);
  });
});
