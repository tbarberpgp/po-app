import { test } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../env";
import { runTool, toolsFor } from "./tools";

/** A D1 stand-in. `route` decides what each query answers with, so a lookup
 *  that reads several tables can be given a different answer per table; every
 *  statement it prepares is recorded, which is how the overhead filter — which
 *  lives in SQL, not in JavaScript — gets tested at all. */
function routedEnv(route: (sql: string) => unknown[]): { env: Env; sql: string[] } {
  const sql: string[] = [];
  const prepare = (q: string) => {
    sql.push(q);
    const stmt = {
      bind: () => stmt,
      all: async () => ({ results: route(q) }),
      first: async () => route(q)[0] ?? null,
      run: async () => ({}),
    };
    return stmt;
  };
  return { env: { DB: { prepare } } as unknown as Env, sql };
}

/** Every query answers with the same canned rows. */
function fakeEnv(rows: unknown[]): Env {
  return routedEnv(() => rows).env;
}

const po = {
  id: "x", po_number: "PO-26004-0012", supplier: "Acme", status: "pending_approval",
  order_type: "standard", category: "materials", requires_approval: 1, approval_tier: "commercial_manager",
  approval_reason: "over_budget", total_value: 12345, created_at: "2026-09-01T10:00:00Z", created_by: "a@b.c",
  approved_at: null, approved_by: null, rejected_at: null, rejected_by: null, rejection_reason: null,
  issued_at: null, paid_at: null, xero_sync_status: null, xero_sync_error: null,
  project_code: "26004", project_name: "Blyth",
};

const invoice = {
  id: 41, status: "inbox", kind: "project", nominal_code: null,
  supplier_name: "Alumasc", matched_supplier_name: "Alumasc Water Management",
  invoice_number: "INV2502383", invoice_date: "2026-09-02", due_date: "2026-10-31",
  currency: "GBP", net_amount: 1000, vat_amount: 200, gross_amount: 1200,
  approved_at: null, approved_by: null, released_at: null, released_by: null,
  xero_bill_id: null, xero_bill_number: null, xero_sync_status: null, xero_sync_error: null,
  matched_po_id: null, extracted_po_ref: "PO-26004-0012", labour_afp_id: null,
  project_code: "26004", project_id: "p1", received_at: "2026-09-03T08:00:00Z", created_at: "2026-09-03T08:00:00Z",
  sender_email: "ap@alumasc.example", subject: "Invoice INV2502383", source: "email", notes: null,
  approval_note: null, release_note: null, lines_json: "[]", extract_error: null, supplier_payment_terms: "60 days EOM",
};

/** Route a get_invoice call: the invoice itself, and nothing behind it. The
 *  3-way match then finds no candidate orders and reports `no_po`, which is the
 *  honest answer for an invoice with no order in the book. */
function invoiceEnv(inv: Record<string, unknown>) {
  return routedEnv((q) => (/FROM invoices i/.test(q) ? [inv] : []));
}

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

/* ── Invoices ─────────────────────────────────────────────────────────── */

test("the invoice lookups are only offered to people who can see Accounts", () => {
  const names = (role: "site" | "commercial") => toolsFor({ role }).map((t) => t.name);
  assert.ok(!names("site").includes("get_invoice"));
  assert.ok(!names("site").includes("find_invoices"));
  assert.ok(names("commercial").includes("get_invoice"));
  assert.ok(names("commercial").includes("find_invoices"));
  // The PO lookups stay for everyone.
  assert.ok(names("site").includes("get_purchase_order"));
});

test("a PM asking for an invoice anyway is refused, not answered", async () => {
  // PMs deliberately have no commercial.view, so the tool isn't in their list —
  // a call can only arrive here invented, and must not read the table.
  const { env, sql } = routedEnv(() => [invoice]);
  const out = (await runTool(env, { role: "pm" }, "find_invoices", {})) as { error: string };
  assert.match(out.error, /commercial workspace/);
  assert.equal(sql.length, 0);
});

test("overheads are filtered out of a non-admin's invoice search, and left in for an admin", async () => {
  const forRole = async (role: "commercial" | "admin") => {
    const { env, sql } = routedEnv(() => [invoice]);
    await runTool(env, { role }, "find_invoices", { query: "Alumasc" });
    return sql.join("\n");
  };
  assert.match(await forRole("commercial"), /kind != 'overhead'/);
  assert.doesNotMatch(await forRole("admin"), /kind != 'overhead'/);
});

test("an overhead invoice asked for by number is refused to a non-admin", async () => {
  const { env } = invoiceEnv({ ...invoice, kind: "overhead" });
  const out = (await runTool(env, { role: "commercial" }, "get_invoice", { invoice_number: "INV2502383" })) as { error: string };
  assert.match(out.error, /admin-only/);
});

test("a search reports the stage each invoice has reached", async () => {
  const stages = async (inv: Record<string, unknown>) => {
    const { env } = routedEnv(() => [inv]);
    const out = (await runTool(env, { role: "commercial" }, "find_invoices", {})) as Array<Record<string, unknown>>;
    return out[0].stage;
  };
  assert.equal(await stages(invoice), "in_progress");
  assert.equal(await stages({ ...invoice, approved_at: "2026-09-10T09:00:00Z" }), "awaiting_approval");
  assert.equal(await stages({ ...invoice, approved_at: "2026-09-10T09:00:00Z", released_at: "2026-09-11T09:00:00Z" }), "ready_to_push");
  assert.equal(await stages({ ...invoice, status: "pushed", xero_bill_id: "bill-1" }), "in_xero");
  assert.equal(await stages({ ...invoice, status: "dismissed" }), "dismissed");
});

test("an overhead sitting in the inbox is waiting on a nominal code, not on a match", async () => {
  const { env } = routedEnv(() => [{ ...invoice, kind: "overhead", project_code: null }]);
  const out = (await runTool(env, { role: "admin" }, "find_invoices", {})) as Array<Record<string, unknown>>;
  assert.match(String(out[0].waiting_on), /nominal/);
});

test("an invoice nobody has routed yet is waiting to be routed, not to be matched", async () => {
  const { env } = routedEnv(() => [{ ...invoice, kind: null, project_code: null }]);
  const out = (await runTool(env, { role: "commercial" }, "find_invoices", {})) as Array<Record<string, unknown>>;
  assert.match(String(out[0].waiting_on), /job or to overheads/);
});

test("an invoice already in Xero is never described as paid", async () => {
  const { env } = invoiceEnv({ ...invoice, status: "pushed", xero_bill_id: "b1", xero_bill_number: "BILL-9" });
  const out = (await runTool(env, { role: "commercial" }, "get_invoice", { invoice_id: 41 })) as Record<string, any>;
  assert.equal(out.stage, "in_xero");
  assert.doesNotMatch(JSON.stringify(out), /"paid"/i);
  // Past the gate, so the expensive reconciliation is not run again.
  assert.equal(out.match, null);
});

test("a held invoice names the people who sign it off", async () => {
  const { env } = routedEnv((q) =>
    /FROM invoices i/.test(q) ? [{ ...invoice, approved_at: "2026-09-10T09:00:00Z", approved_by: "hgardner@x.y" }]
    : /release_approvers/.test(q) ? [{ who: "Thomas Barber" }, { who: "Angela Douty" }]
    : []);
  const out = (await runTool(env, { role: "commercial" }, "get_invoice", { invoice_id: 41 })) as Record<string, any>;
  assert.equal(out.stage, "awaiting_approval");
  assert.deepEqual(out.stage_detail.who_signs_it_off, ["Thomas Barber", "Angela Douty"]);
  assert.equal(out.progress.committed_for_approval_by, "hgardner@x.y");
});

test("the reason typed to push a flagged invoice through is reported", async () => {
  const { env } = invoiceEnv({ ...invoice, approved_at: "2026-09-10T09:00:00Z", approval_note: "Delivered" });
  const out = (await runTool(env, { role: "commercial" }, "get_invoice", { invoice_id: 41 })) as Record<string, any>;
  assert.equal(out.progress.reason_given_when_committing, "Delivered");
});

test("an invoice with no order behind it reports the match as no_po rather than failing", async () => {
  const { env } = invoiceEnv(invoice);
  const out = (await runTool(env, { role: "commercial" }, "get_invoice", { invoice_id: 41 })) as Record<string, any>;
  assert.equal(out.match.status, "no_po");
  assert.equal(out.match.cross_job_block, null);
});

test("two invoices sharing a number come back as a choice, not as one of them", async () => {
  const { env } = routedEnv((q) => (/FROM invoices i/.test(q) ? [invoice, { ...invoice, id: 42, supplier_name: "Fixfast" }] : []));
  const out = (await runTool(env, { role: "commercial" }, "get_invoice", { invoice_number: "INV2502383" })) as Record<string, any>;
  assert.match(out.ambiguous, /ask which supplier/);
  assert.equal(out.candidates.length, 2);
});

test("get_invoice asked for nothing in particular says so", async () => {
  const out = (await runTool(fakeEnv([]), { role: "commercial" }, "get_invoice", {})) as { error: string };
  assert.match(out.error, /invoice_id or an invoice_number/);
});

/* ── My queue ─────────────────────────────────────────────────────────── */

test("the work queue only offers a non-approver what they raised themselves", async () => {
  const { env } = routedEnv(() => [po]);
  const out = (await runTool(env, { role: "pm", email: "a@b.c" }, "my_work_queue", {})) as Record<string, any>;
  assert.match(String(out.purchase_orders_i_can_approve), /Not an approver/);
  assert.equal(out.purchase_orders_i_raised_not_yet_cleared[0].po_number, "PO-26004-0012");
  // No commercial access, so no invoice queue at all.
  assert.ok(!("invoices_awaiting_release_approval" in out));
});

test("the work queue keeps a tier's approvals to that tier", async () => {
  const { env } = routedEnv((q) => (/FROM purchase_orders/.test(q) ? [po] : []));
  const lineManager = (await runTool(env, { role: "commercial", email: "a@b.c", approver_tiers: ["line_manager"] }, "my_work_queue", {})) as Record<string, any>;
  assert.equal(lineManager.purchase_orders_i_can_approve.length, 0);
  const cm = (await runTool(env, { role: "commercial", email: "a@b.c", approver_tiers: ["commercial_manager"] }, "my_work_queue", {})) as Record<string, any>;
  assert.equal(cm.purchase_orders_i_can_approve[0].po_number, "PO-26004-0012");
});

test("a superadmin sees every tier's approvals", async () => {
  const { env } = routedEnv((q) => (/FROM purchase_orders/.test(q) ? [po] : []));
  const out = (await runTool(env, { role: "superadmin", email: "a@b.c", approver_tiers: [] }, "my_work_queue", {})) as Record<string, any>;
  assert.equal(out.purchase_orders_i_can_approve.length, 1);
});

test("the release queue says whether this user can actually sign it off", async () => {
  const held = { ...invoice, approved_at: "2026-09-10T09:00:00Z" };
  const { env } = routedEnv((q) => (/FROM invoices i/.test(q) ? [held] : []));
  const accounts = (await runTool(env, { role: "commercial", email: "h@x.y" }, "my_work_queue", {})) as Record<string, any>;
  assert.equal(accounts.invoices_awaiting_release_approval.can_i_sign_these_off, false);
  assert.equal(accounts.invoices_awaiting_release_approval.count, 1);
  const releaser = (await runTool(env, { role: "commercial", email: "t@x.y", can_release_payables: true }, "my_work_queue", {})) as Record<string, any>;
  assert.equal(releaser.invoices_awaiting_release_approval.can_i_sign_these_off, true);
});
