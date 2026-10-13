// Tests that a labour subcontractor's invoice reaches the app from the Accounts
// mailbox without anyone forwarding it.
//
//   npm test
//
// The case: Paul Garbutt emailed INV-016 to accounts@ on 12 Oct 2026. The pull
// only read the Invoices folder, and the mail rule that files supplier invoices
// there doesn't match subbies, so it sat in the Inbox and never reached the app.
// Every labour application before it had arrived because someone forwarded it to
// labourapps@ by hand. Now the Accounts mailbox is also swept, every folder, for
// mail from a registered labour subcontractor address, and what it finds is
// ingested as labour — never as an Accounts bill.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runMailboxPull } from "./graph";
import type { Env } from "./env";

const MAILBOX = "accounts@powergridprojects.net";
const CONFIG = JSON.stringify([{ mailbox: MAILBOX, as: "invoices@pgpprojects.com", folder: "Invoices" }]);
const PAUL = "paulgarbutt11@hotmail.co.uk";

/** No attachment: both pipelines return early, which keeps these tests off the
 *  extractor while the routing decision is still recorded. */
const MIME = ["From: " + PAUL, "To: " + MAILBOX, "Subject: Paul Garbutt - INV -016", "", "Please find attached."].join("\r\n");

function fakeDb(subbies: string[] | "broken") {
  const recorded: Array<{ id: string; kind: string; status: string }> = [];
  const db = {
    prepare(sql: string) {
      const q = sql.replace(/\s+/g, " ").trim();
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async first<T>(): Promise<T | null> {
          if (q.startsWith("SELECT watermark FROM graph_pull_state")) return ({ watermark: "2026-10-12T11:00:00Z" } as T);
          if (q.startsWith("SELECT MIN(received_at)")) return ({ oldest: null } as T);
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (subbies === "broken") throw new Error("no such table: suppliers");
          if (q.includes("FROM suppliers")) return { results: subbies.map((contact_email) => ({ contact_email })) as T[] };
          return { results: [] };
        },
        async run() {
          if (q.startsWith("INSERT INTO graph_pulled_messages")) {
            recorded.push({ id: String(bound[0]), kind: String(bound[2]), status: String(bound[6]) });
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return { db, recorded };
}

function envWith(db: unknown): Env {
  return {
    DB: db, MS_GRAPH_TENANT_ID: "tenant", MS_GRAPH_CLIENT_ID: "client",
    MS_GRAPH_CLIENT_SECRET: "secret", MS_GRAPH_MAILBOXES: CONFIG,
  } as unknown as Env;
}

const msg = (id: string, from: string, received: string) => ({
  id, subject: `Mail ${id}`, internetMessageId: `<${id}@mail>`,
  receivedDateTime: received, from: { emailAddress: { address: from } },
});

/** Graph with two lists: the Invoices folder, and the whole mailbox. */
function fakeGraph(folder: unknown[], wholeMailbox: unknown[]) {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    if (url.endsWith("/$value")) return new Response(new TextEncoder().encode(MIME), { status: 200 });
    const value = url.includes("/mailFolders/") ? folder : wholeMailbox;
    return new Response(JSON.stringify({ value }), { status: 200 });
  }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

describe("mailboxPullLabourSenders", () => {
  test("a subbie's invoice left in the Inbox is pulled, as labour", async () => {
    const { db, recorded } = fakeDb([PAUL]);
    const g = fakeGraph([], [msg("inv016", "PaulGarbutt11@Hotmail.co.uk", "2026-10-12T11:21:00Z")]);
    try {
      const r = await runMailboxPull(envWith(db));
      assert.equal(r.ingested, 1);
      assert.deepEqual(recorded, [{ id: "<inv016@mail>", kind: "labour", status: "ingested" }]);
    } finally { g.restore(); }
  });

  test("everyone else in the Inbox is still left alone", async () => {
    const { db, recorded } = fakeDb([PAUL]);
    const g = fakeGraph([], [msg("hmrc", "noreply@hmrc.gov.uk", "2026-10-12T11:30:00Z")]);
    try {
      const r = await runMailboxPull(envWith(db));
      assert.equal(r.fetched, 0);
      assert.equal(recorded.length, 0);
    } finally { g.restore(); }
  });

  test("a subbie's invoice in the Invoices folder goes to labour, once, not to Accounts", async () => {
    const { db, recorded } = fakeDb([PAUL]);
    const m = msg("inv016", PAUL, "2026-10-12T11:21:00Z");
    const g = fakeGraph([m, msg("fixfast", "accounts@fixfast.com", "2026-10-12T11:40:00Z")], [m]);
    try {
      const r = await runMailboxPull(envWith(db));
      assert.equal(r.fetched, 2, "listed by both sweeps, handled once");
      assert.deepEqual(recorded.map((x) => [x.id, x.kind]), [["<inv016@mail>", "labour"], ["<fixfast@mail>", "invoice"]]);
    } finally { g.restore(); }
  });

  test("an unreadable supplier register leaves the invoice pull exactly as it was", async () => {
    const { db, recorded } = fakeDb("broken");
    const g = fakeGraph([msg("fixfast", "accounts@fixfast.com", "2026-10-12T11:40:00Z")], []);
    try {
      const r = await runMailboxPull(envWith(db));
      assert.equal(r.ingested, 1);
      assert.equal(recorded[0].kind, "invoice");
      assert.ok(!g.urls.some((u) => /\/users\/[^/]+\/messages\?/.test(u)), "no whole-mailbox sweep without a register");
    } finally { g.restore(); }
  });
});
