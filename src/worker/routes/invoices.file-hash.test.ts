// Tests the guard that stops one document becoming two payables.
//
//   npm test
//
// The case: the mailbox pull now reads forwards from a watermark instead of
// relying on the unread flag, which means it deliberately re-lists an
// overlapping window, and its first window re-reads a day of mail whose
// invoices may already be in the book. On top of that the Accounts mailbox
// routinely holds the same invoice twice — the supplier's original and a
// colleague's forward of it (21 Sep: "Fixfast Invoice 1591492" arrived both as
// itself and as tbarber's FW).
//
// Identity by extracted supplier + invoice number can't cover that on its own:
// it compares two readings of a document rather than the document, so one name
// read as "Fixfast Ltd" and once as "FIXFAST LIMITED" is two suppliers to SQL,
// and a failed extraction has no name to compare at all. The file's SHA-256
// does, so it is checked first — before the document is read, which also means
// a re-forward costs a row read rather than an extraction.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ingestInvoice } from "./invoices";
import type { Env } from "../env";

type Stmt = { sql: string; args: unknown[] };

/** Minimal D1 + R2 stand-in. With no ANTHROPIC_API_KEY in the env the extractor
 *  throws and is recorded as an extract_error, which is the real behaviour for
 *  an unreadable document — and leaves these tests on the hash path alone. */
function fakeEnv(existingId: number | null) {
  const stmts: Stmt[] = [];
  const puts: string[] = [];
  const env = {
    DB: {
      prepare(q: string) {
        const sql = q.replace(/\s+/g, " ").trim();
        let bound: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) { bound = args; return stmt; },
          async first<T>(): Promise<T | null> {
            stmts.push({ sql, args: bound });
            if (sql.startsWith("SELECT id FROM invoices WHERE file_sha256")) {
              return existingId ? ({ id: existingId } as T) : null;
            }
            if (sql.includes("INSERT INTO invoices")) return ({ id: 501 } as T);
            return null;
          },
          async run() { stmts.push({ sql, args: bound }); return { success: true }; },
        };
        return stmt;
      },
    },
    R2: { put: async (key: string) => { puts.push(key); } },
  };
  return { env: env as unknown as Env, stmts, puts };
}

const fileOf = (bytes: string) => ({
  buffer: new TextEncoder().encode(bytes).buffer as ArrayBuffer,
  name: "Fixfast Invoice 1591492.pdf",
  type: "application/pdf",
});
const ARGS = { source: "email" as const, sender: "accounts@fixfast.com", subject: "FW: Fixfast Invoice 1591492", actor: "pull" };

describe("invoiceFileHash", () => {
  test("the same document arriving twice points at the invoice already there", async () => {
    const { env, puts } = fakeEnv(205);
    const r = await ingestInvoice(env, { file: fileOf("%PDF-1.4 fixfast 1591492"), ...ARGS });
    assert.equal(r.skipped, "duplicate");
    assert.equal(r.duplicate_of, 205);
    assert.equal(r.id, 205, "the caller is pointed at the original, not left with null");
    assert.deepEqual(puts, [], "a known document isn't stored a second time");
  });

  test("a duplicate is recognised without reading the document", async () => {
    // The check sits ahead of extraction on purpose: the overlap window re-lists
    // the same mail every hour, and that must not cost a document read each time.
    const { env, stmts } = fakeEnv(205);
    await ingestInvoice(env, { file: fileOf("%PDF-1.4 fixfast 1591492"), ...ARGS });
    assert.equal(stmts.length, 1, "one row read, nothing else");
    assert.match(stmts[0]!.sql, /SELECT id FROM invoices WHERE file_sha256/);
  });

  test("an unseen document is stored with its hash, so the next copy is caught", async () => {
    const { env, stmts, puts } = fakeEnv(null);
    const r = await ingestInvoice(env, { file: fileOf("%PDF-1.4 fixfast 1617738"), ...ARGS });
    assert.equal(r.skipped, undefined);
    assert.equal(r.id, 501);
    assert.equal(puts.length, 1);
    const insert = stmts.find((s) => s.sql.includes("INSERT INTO invoices"));
    assert.ok(insert, "expected an insert");
    const hash = insert!.args.find((a) => typeof a === "string" && /^[0-9a-f]{64}$/.test(a));
    assert.ok(hash, "the row must carry the document's hash");
  });

  test("two different invoices from one supplier both come through", async () => {
    // The point of the guard is the same document twice. Blocking a supplier's
    // next invoice would lose money, which is worse than the duplicate.
    const seen = new Set<string>();
    for (const bytes of ["%PDF-1.4 fixfast 1617599", "%PDF-1.4 fixfast 1617738"]) {
      const { env, stmts } = fakeEnv(null);
      await ingestInvoice(env, { file: fileOf(bytes), ...ARGS });
      const insert = stmts.find((s) => s.sql.includes("INSERT INTO invoices"))!;
      const hash = insert.args.find((a) => typeof a === "string" && /^[0-9a-f]{64}$/.test(a)) as string;
      assert.ok(!seen.has(hash), "two different documents must not share a fingerprint");
      seen.add(hash);
    }
    assert.equal(seen.size, 2);
  });
});
