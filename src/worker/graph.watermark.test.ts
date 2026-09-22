// Tests that the mailbox pull reads forwards from a watermark, not from Outlook's
// unread flag.
//
//   npm test
//
// The case: eligibility was `hasAttachments eq true and isRead eq false`, so a
// message only reached the app if nobody had opened it when the hourly cron
// fired. Accounts works that mailbox live — mail is read, replied to and filed
// within minutes — so anything touched inside the hour was never pulled, never
// retried and never logged. On 21 Sep 2026 a supplier invoice thread (26003 BOC)
// was read at 13:16 and the 14:00 run listed 4 messages, none of them that one.
// There was no way to tell from the app: the run logged ok, 0 ingested.
//
// Eligibility is now a timestamp the app owns, so what anyone does in Outlook is
// irrelevant. The two things that keep it honest are covered below: the window
// must not skip forwards over an outage, and it must be walked to the end rather
// than stopping at the first page (Exchange won't sort a filtered folder, so one
// page is an arbitrary slice).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runMailboxPull } from "./graph";
import type { Env } from "./env";

const MAILBOX = "accounts@powergridprojects.net";
const CONFIG = JSON.stringify([{ mailbox: MAILBOX, as: "invoices@pgpprojects.com", folder: "Inbox" }]);

/** A message with no attachment: handleInboundEmail's invoice branch returns at
 *  once (and, pulled, never replies), which keeps these tests off the extractor. */
const MIME = ["From: accounts@fixfast.com", "To: " + MAILBOX, "Subject: Fixfast Invoice 1617738", "", "See attached."].join("\r\n");

type Stmt = { sql: string; args: unknown[] };

/** Minimal D1 stand-in covering the statements the pull issues, with the
 *  watermark and the processed set held as real state so a run can be observed
 *  the way the next run would see it. */
function fakeDb(seed: { watermark?: string; ingested?: string[] } = {}) {
  const issued: Stmt[] = [];
  const state = { watermark: seed.watermark ?? null as string | null };
  const ingested = new Set(seed.ingested ?? []);
  const db = {
    prepare(sql: string) {
      const q = sql.replace(/\s+/g, " ").trim();
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async first<T>(): Promise<T | null> {
          issued.push({ sql: q, args: bound });
          if (q.startsWith("SELECT watermark FROM graph_pull_state")) {
            return state.watermark ? ({ watermark: state.watermark } as T) : null;
          }
          if (q.startsWith("SELECT status, attempts FROM graph_pulled_messages")) {
            return ingested.has(String(bound[0])) ? ({ status: "ingested", attempts: 1 } as T) : null;
          }
          if (q.startsWith("SELECT MIN(received_at)")) return ({ oldest: null } as T);
          return null;
        },
        async run() {
          issued.push({ sql: q, args: bound });
          if (q.startsWith("INSERT INTO graph_pull_state")) state.watermark = String(bound[1]);
          if (q.startsWith("INSERT INTO graph_pulled_messages") && bound[6] === "ingested") ingested.add(String(bound[0]));
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return { db, issued, state, ingested };
}

function envWith(db: unknown): Env {
  return {
    DB: db, MS_GRAPH_TENANT_ID: "tenant", MS_GRAPH_CLIENT_ID: "client",
    MS_GRAPH_CLIENT_SECRET: "secret", MS_GRAPH_MAILBOXES: CONFIG,
  } as unknown as Env;
}

const msg = (id: string, received: string) => ({
  id, subject: `Invoice ${id}`, internetMessageId: `<${id}@fixfast.com>`,
  receivedDateTime: received, from: { emailAddress: { address: "accounts@fixfast.com" } },
});

/** Stands in for Graph: a token endpoint, the message list (one entry per page)
 *  and the raw-MIME fetch. Records every URL so the filter can be inspected. */
function fakeGraph(pages: Array<{ value: unknown[]; next?: string }>, opts: { listStatus?: number } = {}) {
  const urls: string[] = [];
  let page = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("login.microsoftonline.com")) {
      return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    }
    if (url.endsWith("/$value")) {
      return new Response(new TextEncoder().encode(MIME), { status: 200 });
    }
    if (opts.listStatus && opts.listStatus !== 200) {
      return new Response("InefficientFilter", { status: opts.listStatus });
    }
    const p = pages[page] ?? { value: [] };
    page++;
    return new Response(JSON.stringify({ value: p.value, ...(p.next ? { "@odata.nextLink": p.next } : {}) }), { status: 200 });
  }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

const listUrl = (urls: string[]) => decodeURIComponent(urls.find((u) => u.includes("/messages?")) ?? "");

describe("mailboxPullWatermark", () => {
  test("asks for what arrived, not for what nobody has opened", async () => {
    const { db } = fakeDb({ watermark: "2026-09-21T12:00:00Z" });
    const g = fakeGraph([{ value: [msg("m1", "2026-09-21T12:16:00Z")] }]);
    try {
      const r = await runMailboxPull(envWith(db));
      const q = listUrl(g.urls);
      assert.match(q, /receivedDateTime ge 2026-09-21T12:00:00Z/);
      assert.doesNotMatch(q, /isRead/, "the unread flag must not gate ingestion");
      assert.equal(r.ingested, 1, "a message read in Outlook is still pulled");
    } finally { g.restore(); }
  });

  test("a mailbox never read before starts one day back, not at the beginning of time", async () => {
    const { db } = fakeDb();
    const g = fakeGraph([{ value: [] }]);
    try {
      await runMailboxPull(envWith(db));
      const since = new Date(/ge (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/.exec(listUrl(g.urls))![1]);
      const hoursBack = (Date.now() - since.getTime()) / 3_600_000;
      assert.ok(hoursBack > 23.5 && hoursBack < 24.5, `bootstrapped ${hoursBack}h back`);
    } finally { g.restore(); }
  });

  test("a clean run moves the watermark on, overlapping the next window", async () => {
    const { db, state } = fakeDb({ watermark: "2026-09-21T12:00:00Z" });
    const g = fakeGraph([{ value: [msg("m1", "2026-09-21T12:16:00Z")] }]);
    try {
      await runMailboxPull(envWith(db));
      const minutesBack = (Date.now() - new Date(state.watermark!).getTime()) / 60_000;
      assert.ok(minutesBack > 14 && minutesBack < 16, `watermark set ${minutesBack}m back`);
    } finally { g.restore(); }
  });

  test("an unreachable mailbox leaves the watermark alone, so the outage is re-read", async () => {
    // The 21 Sep outage: every run from midnight died on an expired client
    // secret. Had the window moved on those runs, the night's invoices would
    // have been skipped the moment the secret was fixed.
    const { db, state } = fakeDb({ watermark: "2026-09-21T00:00:00Z" });
    const g = fakeGraph([], { listStatus: 401 });
    try {
      const r = await runMailboxPull(envWith(db));
      assert.equal(state.watermark, "2026-09-21T00:00:00Z");
      assert.equal(r.errors.length, 1);
    } finally { g.restore(); }
  });

  test("the whole window is walked, not just the first page", async () => {
    const { db } = fakeDb({ watermark: "2026-09-21T00:00:00Z" });
    const g = fakeGraph([
      { value: [msg("m1", "2026-09-21T09:00:00Z")], next: "https://graph.microsoft.com/v1.0/next-page" },
      { value: [msg("m2", "2026-09-21T10:00:00Z")] },
    ]);
    try {
      const r = await runMailboxPull(envWith(db));
      assert.equal(r.fetched, 2);
      assert.equal(r.ingested, 2);
    } finally { g.restore(); }
  });

  test("what the overlap re-lists is skipped, not ingested twice", async () => {
    const { db } = fakeDb({ watermark: "2026-09-21T12:00:00Z", ingested: ["<m1@fixfast.com>"] });
    const g = fakeGraph([{ value: [msg("m1", "2026-09-21T12:16:00Z"), msg("m2", "2026-09-21T12:40:00Z")] }]);
    try {
      const r = await runMailboxPull(envWith(db));
      assert.equal(r.ingested, 1);
      assert.equal(r.skipped, 1);
      assert.ok(!g.urls.some((u) => u.includes("/m1/$value")), "an ingested message isn't downloaded again");
    } finally { g.restore(); }
  });
});
