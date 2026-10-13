// Tests that a subbie's mailbox folder is pulled as that subbie's labour.
//
//   npm test
//
// Accounts' mail rules file each subcontractor into its own folder under Labour
// in accounts@ (Labour/Cladders, Labour/Paul Garbutt, …). Nothing in those
// folders reached the app: the pull read the Invoices folder only, so Hannah
// forwarded every application to labourapps@ by hand. Cladders' invoices also
// arrive via Tom or Angela, so the sender can't say whose they are — the folder
// can. Covered below: a display-name path is walked to a folder id, each folder
// keeps its own watermark, the folder's subbie overrides sender matching, and
// timesheets / materials filed alongside are left out.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runMailboxPull, isLabourFolderNoise } from "./graph";
import { handleInboundEmail } from "./email";
import type { Env } from "./env";

const MAILBOX = "accounts@powergridprojects.net";
const MIME = ["From: tbarber@powergridprojects.net", "To: " + MAILBOX, "Subject: Cladders Ltd Invoice", "", "See attached."].join("\r\n");

/** D1 stand-in holding one watermark per graph_pull_state key. */
function fakeDb(seed: Record<string, string> = {}) {
  const watermarks = new Map(Object.entries(seed));
  const outcomes: Array<{ key: string; status: string }> = [];
  const db = {
    prepare(sql: string) {
      const q = sql.replace(/\s+/g, " ").trim();
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async first<T>(): Promise<T | null> {
          if (q.startsWith("SELECT watermark FROM graph_pull_state")) {
            const w = watermarks.get(String(bound[0]));
            return w ? ({ watermark: w } as T) : null;
          }
          if (q.startsWith("SELECT MIN(received_at)")) return ({ oldest: null } as T);
          return null;
        },
        async run() {
          if (q.startsWith("INSERT INTO graph_pull_state")) watermarks.set(String(bound[0]), String(bound[1]));
          if (q.startsWith("INSERT INTO graph_pulled_messages")) outcomes.push({ key: String(bound[0]), status: String(bound[6]) });
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return { db, watermarks, outcomes };
}

function envWith(db: unknown, config: unknown[]): Env {
  return {
    DB: db, MS_GRAPH_TENANT_ID: "tenant", MS_GRAPH_CLIENT_ID: "client",
    MS_GRAPH_CLIENT_SECRET: "secret", MS_GRAPH_MAILBOXES: JSON.stringify(config),
  } as unknown as Env;
}

const msg = (id: string, subject: string) => ({
  id, subject, internetMessageId: `<${id}@x>`, receivedDateTime: "2026-10-12T12:00:00Z",
  from: { emailAddress: { address: "tbarber@powergridprojects.net" } },
});

/** Graph stand-in: folders by display name under a parent, messages per folder
 *  id. Every URL is recorded. */
function fakeGraph(folders: Record<string, Record<string, string>>, messages: Record<string, unknown[]>) {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input));
    urls.push(url);
    if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "tok" }));
    if (url.endsWith("/$value")) return new Response(new TextEncoder().encode(MIME));
    const named = /mailFolders(?:\/([^/?]+)\/childFolders)?\?\$filter=displayName eq '([^']+)'/.exec(url);
    if (named) {
      const id = folders[named[1] ?? "root"]?.[named[2]];
      return new Response(JSON.stringify({ value: id ? [{ id }] : [] }));
    }
    const listed = /mailFolders\/([^/?]+)\/messages\?/.exec(url);
    if (listed) return new Response(JSON.stringify({ value: messages[listed[1]] ?? [] }));
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

const LABOUR_TREE = { root: { Labour: "LAB" }, LAB: { Cladders: "CLA", "Paul Garbutt": "PAU" } };
const cladders = { mailbox: MAILBOX, as: "labourapps@pgpprojects.com", folder: "Labour/Cladders", supplier: 47 };

describe("labourFolderPull", () => {
  test("a display-name path is walked down to the subfolder's id", async () => {
    const { db } = fakeDb({ [MAILBOX]: "2026-10-12T11:00:00Z" });
    const g = fakeGraph(LABOUR_TREE, { CLA: [] });
    try {
      const r = await runMailboxPull(envWith(db, [cladders]));
      assert.deepEqual(r.errors, []);
      assert.ok(g.urls.some((u) => u.includes("/mailFolders/CLA/messages?")), "lists the Cladders folder by id");
    } finally { g.restore(); }
  });

  test("a folder that doesn't exist is an error, and its watermark stays put", async () => {
    const { db, watermarks } = fakeDb({ [MAILBOX]: "2026-10-12T11:00:00Z" });
    const g = fakeGraph(LABOUR_TREE, {});
    try {
      const r = await runMailboxPull(envWith(db, [{ ...cladders, folder: "Labour/Latbuild" }]));
      assert.match(r.errors[0] ?? "", /no folder named "Latbuild"/);
      assert.ok(![...watermarks.keys()].some((k) => k.includes("#")), "no watermark written for a folder never read");
    } finally { g.restore(); }
  });

  test("each folder keeps its own watermark; a new one starts from the mailbox's old row", async () => {
    // The 12 Oct gap the old shared watermark would make: Invoices runs first and
    // moves the mailbox on to now, then Cladders lists from now and never sees
    // the invoice that arrived yesterday.
    const { db, watermarks } = fakeDb({ [MAILBOX]: "2026-10-12T11:00:00Z" });
    const g = fakeGraph(LABOUR_TREE, { inbox: [], CLA: [] });
    try {
      await runMailboxPull(envWith(db, [
        { mailbox: MAILBOX, as: "invoices@pgpprojects.com", folder: "inbox" },
        cladders,
      ]));
      const claList = g.urls.find((u) => u.includes("/mailFolders/CLA/messages?")) ?? "";
      assert.match(claList, /receivedDateTime ge 2026-10-12T11:00:00Z/, "Cladders reads from the old mark, not from Invoices' new one");
      assert.ok(watermarks.has(`${MAILBOX}#inbox`) && watermarks.has(`${MAILBOX}#Labour/Cladders`));
      assert.equal(watermarks.get(MAILBOX), "2026-10-12T11:00:00Z", "the legacy row is only read, never moved");
    } finally { g.restore(); }
  });

  test("timesheets and materials filed in a subbie's folder are skipped, not drafted", async () => {
    const { db, outcomes } = fakeDb({ [MAILBOX]: "2026-10-12T11:00:00Z" });
    const g = fakeGraph(LABOUR_TREE, { CLA: [
      msg("t1", "Cladders Ltd Timesheet W/E 11/07/26"),
      msg("m1", "26004 Fw: Materials Invoice"),
    ] });
    try {
      const r = await runMailboxPull(envWith(db, [cladders]));
      assert.equal(r.skipped, 2);
      assert.equal(r.ingested, 0);
      assert.ok(!g.urls.some((u) => u.endsWith("/$value")), "a skipped message isn't downloaded");
      assert.deepEqual(outcomes.map((o) => o.status), ["skipped", "skipped"]);
    } finally { g.restore(); }
  });

  test("the noise filter keeps every real subject seen to date", () => {
    for (const s of [
      "Fw: Cladders Ltd Invoice & Timesheets W/Ending 26/07/26", "Fw: Cladders Ltd", "Asgard Projects 20 + 21",
      "Paul Garbutt Inv 14", "Cladders Inv 011 + Expenses", "Fw: Paul Garbutt - INV -002", "",
    ]) assert.equal(isLabourFolderNoise(s), false, s);
    for (const s of ["Cladders Ltd Timesheet 2026-07-13", "26004 Fw: Blyth Materials", "26004 Fw: Materials Inv"]) {
      assert.equal(isLabourFolderNoise(s), true, s);
    }
  });
});

describe("labourFolderSupplier", () => {
  /** Records each query; answers the folder's supplier lookup from `labour`. */
  function emailDb(labour: Record<number, string>) {
    const queries: string[] = [];
    return {
      queries,
      db: {
        prepare(sql: string) {
          const q = sql.replace(/\s+/g, " ").trim();
          let bound: unknown[] = [];
          const stmt = {
            bind(...args: unknown[]) { bound = args; return stmt; },
            async first<T>(): Promise<T | null> {
              queries.push(q);
              if (q.includes("FROM suppliers WHERE id = ?")) {
                const name = labour[Number(bound[0])];
                return name ? ({ id: Number(bound[0]), name, contact_email: null } as T) : null;
              }
              return null;
            },
            async run() { queries.push(q); return { success: true }; },
          };
          return stmt;
        },
      },
    };
  }
  const message = (from: string) => ({
    from, to: "labourapps@pgpprojects.com", headers: new Headers(), rawSize: MIME.length,
    raw: new Response(new TextEncoder().encode(MIME)).body, setReject() {},
  }) as unknown as Parameters<typeof handleInboundEmail>[0];

  test("the folder's subbie wins, so a forward from an unknown sender isn't rejected", async () => {
    // Shaun's icloud address is no labour supplier and no PG user: unmapped,
    // this email is turned away before the attachment is even looked at.
    const { db, queries } = emailDb({ 47: "Cladders Ltd" });
    await handleInboundEmail(message("smoggieshaun@icloud.com"), { DB: db } as unknown as Env, { noReply: true, labourSupplierId: 47 });
    assert.ok(queries.some((q) => q.includes("FROM suppliers WHERE id = ?")));
    assert.ok(!queries.some((q) => q.includes("lower(contact_email) LIKE")), "sender-domain matching is not consulted");
  });

  test("a folder mapped to a supplier that isn't labour fails loudly", async () => {
    const { db } = emailDb({});
    await assert.rejects(
      handleInboundEmail(message("tbarber@powergridprojects.net"), { DB: db } as unknown as Env, { noReply: true, labourSupplierId: 999 }),
      /isn't a labour supplier/,
    );
  });
});
