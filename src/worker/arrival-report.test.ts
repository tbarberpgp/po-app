// WhatsApp arrival reports — a message saying goods came, with no delivery note.
// The AI read is stood in for (fetch to api.anthropic.com is faked) so these
// pin what the scanner DOES with each answer: file it, turn it away, or see
// that a ticket already covers it.
//
//   npm test
//
// Cases are Andrew's real messages from the 26008 Block B group, 3 Nov 2026.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { recordArrivalReport, supersedeArrivalReports } from "./routes/operations";
import type { Env } from "./env";

type Row = Record<string, unknown>;
function fakeDb(opts: { tickets?: Row[]; reports?: Row[] } = {}) {
  const inserts: unknown[][] = [];
  const updates: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      const q = sql.replace(/\s+/g, " ").trim();
      let bound: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { bound = a; return stmt; },
        async first() { return null; },
        async all() {
          if (q.includes("s.is_ticket = 1 AND COALESCE(json_extract")) return { results: opts.tickets ?? [] };
          if (q.includes("s.status = 'pending' AND json_extract")) return { results: opts.reports ?? [] };
          return { results: [] };
        },
        async run() {
          if (q.startsWith("INSERT INTO delivery_ticket_scans")) inserts.push([q, ...bound]);
          if (q.startsWith("UPDATE delivery_ticket_scans")) updates.push(bound);
          return { success: true, meta: {} };
        },
      };
      return stmt;
    },
  };
  return { db, inserts, updates };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function claudeSays(input: Record<string, unknown>) {
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes("api.anthropic.com")) {
      return new Response(JSON.stringify({
        id: "msg_1", type: "message", role: "assistant", model: "claude-opus-4-7",
        content: [{ type: "tool_use", id: "tu_1", name: "record_arrival", input }],
        stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

const env = (db: unknown) => ({ DB: db, ANTHROPIC_API_KEY: "test", R2: { put: async () => ({}) } }) as unknown as Env;
const BOC_TEXT = { id: 901, media_url: null, sender: "Andrew Law", body: "BOC Delivery of 5 bottles of gas. 4 empties returned", occurred_at: "2026-11-03T12:12:00Z", created_at: "2026-11-03T12:12:00Z" };
const pos = [
  { id: "boc10", po_number: "PO-26008-0010", supplier: "BOC Ltd", order_type: "standard", project_id: "p8", project_code: "26008" },
  { id: "tp12", po_number: "PO-26008-0012", supplier: "Travis Perkins", order_type: "standard", project_id: "p8", project_code: "26008" },
];

describe("recordArrivalReport", () => {
  test("BOC's text becomes a pending report, guessed onto the open BOC order", async () => {
    claudeSays({ is_arrival_report: true, photo_matches_message: false, supplier_name: "BOC", summary: "5 size D propane cylinders delivered, 4 empties returned", delivery_date: "2026-11-03", items: [{ description: "Propane cylinder size D", qty: 5, unit: "bottles" }] });
    const { db, inserts } = fakeDb();
    const filed = await recordArrivalReport(env(db), { base: "p8", msg: BOC_TEXT, photoUrl: null, pos, actor: "cron", now: "2026-11-09T10:00:00Z" });
    assert.equal(filed, true);
    assert.equal(inserts.length, 1);
    const row = inserts[0];
    assert.match(String(row[0]), /'pending'/);
    assert.ok(row.includes("msg:901"), "no photo → keyed on the message");
    assert.ok(row.includes("boc10"), "guessed onto PO-26008-0010");
    assert.ok(row.includes("supplier"), "a supplier guess, never a PO-number match");
    const ex = JSON.parse(String(row.find((v) => typeof v === "string" && v.startsWith("{\"is_delivery_ticket\""))));
    assert.equal(ex.report, true);
    assert.equal(ex.message, BOC_TEXT.body);
  });

  test("“not received yet” is read and turned away — a dismissed marker, so it isn't read again", async () => {
    claudeSays({ is_arrival_report: false, photo_matches_message: false, supplier_name: "", summary: "" });
    const { db, inserts } = fakeDb();
    const filed = await recordArrivalReport(env(db), { base: "p1", msg: { ...BOC_TEXT, id: 902, body: "Not received any spray paint yet. Has anyone signed for it?" }, photoUrl: null, pos, actor: "cron", now: "2026-11-09T10:00:00Z" });
    assert.equal(filed, false);
    assert.equal(inserts.length, 1);
    assert.match(String(inserts[0][0]), /'dismissed'/);
    assert.ok(inserts[0].includes("msg:902"));
  });

  test("a delivery note from the same supplier within 4 hours already covers it", async () => {
    claudeSays({ is_arrival_report: true, photo_matches_message: false, supplier_name: "BOC", summary: "5 cylinders" });
    const { db, inserts } = fakeDb({ tickets: [{ id: 77, supplier_name: "BOC Limited", sender: "Victor" }] });
    const filed = await recordArrivalReport(env(db), { base: "p8", msg: BOC_TEXT, photoUrl: null, pos, actor: "cron", now: "2026-11-09T10:00:00Z" });
    assert.equal(filed, false);
    assert.match(String(inserts[0][0]), /'dismissed'/);
    assert.ok(inserts[0].some((v) => typeof v === "string" && v.includes("Covered by delivery note scan #77")));
  });

  test("no AI available → nothing written, so the message is tried again next run", async () => {
    const { db, inserts } = fakeDb();
    const filed = await recordArrivalReport({ DB: db } as unknown as Env, { base: "p8", msg: BOC_TEXT, photoUrl: null, pos, actor: "cron", now: "x" });
    assert.equal(filed, false);
    assert.equal(inserts.length, 0);
  });
});

describe("supersedeArrivalReports", () => {
  test("a ticket from the same supplier sets the pending report aside; another supplier's is left", async () => {
    const { db, updates } = fakeDb({ reports: [
      { id: 5, supplier_name: "BOC", sender: "Andrew Law" },
      { id: 6, supplier_name: "Travis Perkins", sender: "Victor" },
    ] });
    await supersedeArrivalReports(env(db), "p8", { ...BOC_TEXT, id: 950, media_url: "https://x/y.jpg" }, "BOC Ltd", 950);
    assert.deepEqual(updates.map((u) => u[1]), [5]);
  });
});
