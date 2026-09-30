import { test } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../env";
import { runTool } from "./tools";

// A D1 stand-in that answers every query with the same canned rows.
function fakeEnv(rows: unknown[]): Env {
  const stmt = {
    bind: () => stmt,
    all: async () => ({ results: rows }),
    first: async () => rows[0] ?? null,
  };
  return { DB: { prepare: () => stmt } } as unknown as Env;
}

const po = {
  id: "x", po_number: "PO-26004-0012", supplier: "Acme", status: "pending_approval",
  order_type: "standard", category: "materials", requires_approval: 1, approval_tier: "commercial_manager",
  approval_reason: "over_budget", total_value: 12345, created_at: "2026-09-01T10:00:00Z", created_by: "a@b.c",
  approved_at: null, approved_by: null, rejected_at: null, rejected_by: null, rejection_reason: null,
  issued_at: null, paid_at: null, xero_sync_status: null, xero_sync_error: null,
  project_code: "26004", project_name: "Blyth",
};

test("a site user gets no order values from a search", async () => {
  const out = (await runTool(fakeEnv([po]), { role: "site" }, "find_purchase_orders", { query: "26004" })) as Array<Record<string, unknown>>;
  assert.equal(out[0].po_number, "PO-26004-0012");
  assert.ok(!("total_value_gbp" in out[0]));
});

test("a commercial user does", async () => {
  const out = (await runTool(fakeEnv([po]), { role: "commercial" }, "find_purchase_orders", {})) as Array<Record<string, unknown>>;
  assert.equal(out[0].total_value_gbp, 12345);
});

test("a per-user commercial.view grant is honoured", async () => {
  const out = (await runTool(fakeEnv([po]), { role: "viewer", grants: ["commercial.view"] }, "find_purchase_orders", {})) as Array<Record<string, unknown>>;
  assert.equal(out[0].total_value_gbp, 12345);
});

test("an unknown PO number says so rather than throwing", async () => {
  const out = (await runTool(fakeEnv([]), { role: "admin" }, "get_purchase_order", { po_number: "PO-NOPE" })) as { error: string };
  assert.match(out.error, /No purchase order/);
});

test("an unknown tool is an error result, not a crash", async () => {
  const out = (await runTool(fakeEnv([]), { role: "admin" }, "drop_tables", {})) as { error: string };
  assert.match(out.error, /Unknown tool/);
});
