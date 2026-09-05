// Applications for Payment (AfP) — both outgoing (PowerGrid → client) and
// incoming labour (subcontractor → PowerGrid). The same shape backs both via
// the `direction` field; for the first ship we only expose the outgoing AfP
// to clients in the UI.

import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import * as XLSX from "xlsx";
import { unzipSync, strFromU8 } from "fflate";
import type { Env, Variables } from "../env";
import { isReleaseApprover, requirePermission } from "../auth";
import { learnAliases, aliasMap, normText } from "../matchMemory";
import { findSupplier } from "./invoices";
import { cisLabourBase, pushAfpToXero } from "./xero";
import { emailAfpCertified } from "../notify";
import type { AfpCisPreview } from "../../shared/types";
import { isSandboxId } from "../sandbox";

export const applications = new Hono<{ Bindings: Env; Variables: Variables }>();

type Direction = "outgoing" | "incoming_labour";
type Status = "draft" | "pending_approval" | "submitted" | "certified" | "paid";

type AfpRow = {
  id: number;
  project_id: string;
  direction: Direction;
  app_number: number;
  period_end: string;
  notes: string | null;
  retention_pct: number;
  vat_pct: number;
  contract_sum: number | null;
  cumulative_value: number | null;
  previous_certified: number | null;
  this_period_net: number | null;
  retention_amount: number | null;
  amount_due: number | null;
  vat_amount: number | null;
  total_invoice: number | null;
  status: Status;
  counterparty_supplier_id: number | null;
  created_at: string;
  created_by: string;
  submitted_at: string | null;
  submitted_by: string | null;
  certified_at: string | null;
  certified_by: string | null;
  certified_amount: number | null;
  paid_at: string | null;
  paid_by: string | null;
  payment_reference: string | null;
};

type AfpLineRow = {
  id: number;
  afp_id: number;
  contract_item_id: number | null;
  section: string | null;
  description: string;
  unit: string | null;
  qty: number | null;
  rate: number;
  contract_value: number;
  percent_complete: number;
  cumulative_value: number;
  is_adhoc: 0 | 1;
  display_order: number;
};

/**
 * Recompute the AfP totals from its current lines and persist back onto the
 * row. Called after any line edit while the AfP is still in draft. Once
 * submitted the totals stay frozen — the snapshot is the audit point.
 *
 * The `force` option lets the client-certificate path recompute totals when an
 * AfP is being moved submitted → certified (the certified figures returned by
 * the client overwrite the snapshot, then freeze again).
 */
async function recalcTotals(
  db: D1Database,
  afpId: number,
  opts: { force?: boolean } = {},
): Promise<void> {
  const afp = await db
    .prepare(
      `SELECT id, project_id, direction, app_number, retention_pct, vat_pct, status,
              prelim_heading, claimed_amount
       FROM applications_for_payment WHERE id = ?`,
    )
    .bind(afpId)
    .first<{
      id: number; project_id: string; direction: Direction; app_number: number;
      retention_pct: number; vat_pct: number; status: Status;
      prelim_heading: string | null; claimed_amount: number | null;
    }>();
  if (!afp || (afp.status !== "draft" && !opts.force)) return;

  const lines = await db
    .prepare(
      "SELECT contract_value, percent_complete, cumulative_value FROM afp_lines WHERE afp_id = ?",
    )
    .bind(afpId)
    .all<{ contract_value: number; percent_complete: number; cumulative_value: number }>();
  const contractSum = lines.results.reduce((s, l) => s + (l.contract_value ?? 0), 0);

  // A prelim-tagged application is a standalone drawdown against the prelim
  // heading's allowance: its single claimed amount IS its value (management/PM
  // time never matches BOQ lines), and it neither anchors on prior apps nor
  // counts as "previously certified" for later BOQ apps — each claim stands
  // alone and the allowance tracks the running total.
  const isPrelimClaim = afp.prelim_heading != null && afp.claimed_amount != null;
  const cumulative = isPrelimClaim
    ? (afp.claimed_amount ?? 0)
    : lines.results.reduce((s, l) => s + (l.cumulative_value ?? 0), 0);

  // Previously certified = sum of certified_amount on prior AfPs for the same
  // (project, direction). If an earlier app is still 'submitted' (not yet
  // certified) we treat its cumulative_value as the previous certified
  // anchor so we never double-claim work between overlapping apps.
  // Prelim-tagged apps are excluded on both sides: their claims are
  // standalone, not part of the cumulative measured-works position.
  let previousCertified = 0;
  if (!isPrelimClaim) {
    const priors = await db
      .prepare(
        `SELECT COALESCE(certified_amount, cumulative_value, 0) AS prev_value
         FROM applications_for_payment
         WHERE project_id = ? AND direction = ? AND app_number < ?
           AND status IN ('submitted', 'certified', 'paid')
           AND prelim_heading IS NULL`,
      )
      .bind(afp.project_id, afp.direction, afp.app_number)
      .all<{ prev_value: number }>();
    previousCertified = priors.results.reduce((s, p) => s + (p.prev_value ?? 0), 0);
  }

  // Round every monetary result to pence. These figures become the ex-VAT
  // UnitAmount on live Xero invoices/bills and the frozen certified_amount, so
  // raw binary-float artifacts (e.g. 1234.5600000000002) would drift the app
  // vs. Xero by a penny on reconciliation.
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const thisPeriodNet = r2(Math.max(0, cumulative - previousCertified));
  const retentionAmount = r2(thisPeriodNet * (afp.retention_pct / 100));
  const amountDue = r2(thisPeriodNet - retentionAmount);
  const vatAmount = r2(amountDue * (afp.vat_pct / 100));
  const totalInvoice = r2(amountDue + vatAmount);

  await db
    .prepare(
      `UPDATE applications_for_payment
       SET contract_sum = ?, cumulative_value = ?, previous_certified = ?,
           this_period_net = ?, retention_amount = ?, amount_due = ?,
           vat_amount = ?, total_invoice = ?
       WHERE id = ?`,
    )
    .bind(
      contractSum, cumulative, previousCertified,
      thisPeriodNet, retentionAmount, amountDue,
      vatAmount, totalInvoice, afpId,
    )
    .run();
}

/**
 * Mark an application as "sent" (status 'submitted') once it's complete.
 * Applications no longer require director approval — a received or built
 * application becomes live as soon as it has nothing left to reconcile
 * (no unmatched lines) and, for labour, a subcontractor assigned. No-op unless
 * the AfP is currently a draft. Returns true if it transitioned.
 */
async function autoSubmitIfReady(db: D1Database, afpId: number, actor: string): Promise<boolean> {
  const afp = await db
    .prepare(
      `SELECT status, direction, counterparty_supplier_id, unmatched_lines_json,
              prelim_heading, claimed_amount
       FROM applications_for_payment WHERE id = ?`,
    )
    .bind(afpId)
    .first<{
      status: Status; direction: Direction;
      counterparty_supplier_id: number | null; unmatched_lines_json: string | null;
      prelim_heading: string | null; claimed_amount: number | null;
    }>();
  if (!afp || afp.status !== "draft") return false;
  // A prelim claim's value is its single claimed amount — line matching (and
  // therefore reconciling the unmatched list) doesn't apply.
  const isPrelimClaim = afp.prelim_heading != null && afp.claimed_amount != null;
  if (afp.unmatched_lines_json && !isPrelimClaim) return false;                                 // still needs reconciling
  // Only incoming labour auto-submits (the subbie already sent it — reconciling
  // completes the record). An OUTGOING application is ours to send: it stays a
  // draft until someone presses Submit, so reconciling the last review line
  // can't lock the draft (and its undo list) prematurely.
  if (afp.direction !== "incoming_labour") return false;
  if (afp.counterparty_supplier_id == null) return false;                                       // needs a subbie
  await recalcTotals(db, afpId);
  await db
    .prepare(
      `UPDATE applications_for_payment
         SET status = 'submitted',
             submitted_at = COALESCE(submitted_at, ?),
             submitted_by = COALESCE(submitted_by, ?)
       WHERE id = ? AND status = 'draft'`,
    )
    .bind(new Date().toISOString(), actor, afpId)
    .run();
  return true;
}

/**
 * Budget vs claimed for an application's lines. Budget is the sum of the
 * non-variation (BOQ) line values; claimed is the cumulative value to date
 * (which includes any variation lines). For labour, `over` means the claim has
 * gone beyond the budgeted labour — typically because variations were added —
 * and a director must sign it off before it can be certified.
 */
async function lineBudgetStatus(db: D1Database, afpId: number): Promise<{ budget: number; claimed: number; over: boolean; overBy: number }> {
  const rows = await db
    .prepare("SELECT is_adhoc, contract_value, cumulative_value FROM afp_lines WHERE afp_id = ?")
    .bind(afpId)
    .all<{ is_adhoc: 0 | 1; contract_value: number; cumulative_value: number }>();
  let budget = 0, claimed = 0;
  for (const l of rows.results) {
    if (!l.is_adhoc) budget += l.contract_value ?? 0;
    claimed += l.cumulative_value ?? 0;
  }
  const overBy = claimed - budget;
  return { budget, claimed, over: overBy > 0.01, overBy };
}

/** Per-line rate-variance info for a labour AfP. A BOQ-derived line is
 *  "off-rate" when its frozen rate differs (to the penny) from the rate we'd
 *  expect to pay: the agreed live rate for that BOQ line if one exists, else the
 *  original BOQ labour rate. Ad-hoc/variation lines have no reference rate and
 *  are never flagged. Only meaningful for incoming-labour applications. */
type RateInfo = { expected: number | null; source: "live" | "boq" | null; flagged: boolean };

/** Map line id → rate-variance info for every line on the AfP. The live-rate
 *  lookup mirrors the Labour BOQ (match by contract-item id OR description,
 *  status applied/approved, latest, with a 5× sanity bound). */
async function rateMismatchMap(
  db: D1Database,
  afpId: number,
  projectId: string,
): Promise<Map<number, RateInfo>> {
  const rows = await db
    .prepare(
      `SELECT l.id, l.contract_item_id, l.rate, l.is_adhoc,
              ci.labour_rate AS boq_rate,
              (SELECT llr.live_rate FROM labour_live_rates llr
                WHERE (llr.contract_item_id = ci.id
                       OR (llr.description IS NOT NULL AND lower(llr.description) = lower(ci.description)))
                  AND llr.project_id = ?
                  AND llr.status IN ('applied', 'approved')
                  AND llr.live_rate <= COALESCE(ci.labour_rate, llr.live_rate) * 5
                ORDER BY llr.applied_at DESC LIMIT 1) AS live_rate
       FROM afp_lines l
       LEFT JOIN contract_items ci ON ci.id = l.contract_item_id
       WHERE l.afp_id = ?`,
    )
    .bind(projectId, afpId)
    .all<{
      id: number; contract_item_id: number | null; rate: number; is_adhoc: 0 | 1;
      boq_rate: number | null; live_rate: number | null;
    }>();
  const pennies = (n: number) => Math.round(n * 100);
  const map = new Map<number, RateInfo>();
  for (const r of rows.results) {
    if (r.is_adhoc || r.contract_item_id == null) {
      map.set(r.id, { expected: null, source: null, flagged: false });
      continue;
    }
    const source: "live" | "boq" | null =
      r.live_rate != null ? "live" : r.boq_rate != null ? "boq" : null;
    const expected = r.live_rate != null ? r.live_rate : r.boq_rate;
    const flagged = expected != null && pennies(r.rate) !== pennies(expected);
    map.set(r.id, { expected: expected ?? null, source, flagged });
  }
  return map;
}

/** Project row shape carrying the per-direction commercial terms. */
type ProjectTerms = {
  retention_pct?: number;
  client_vat_pct?: number;
  client_retention_pct?: number;
  labour_vat_pct?: number;
  labour_retention_pct?: number;
};

/** Pick the VAT + retention to snapshot onto a new AfP, by direction. Falls
 *  back to the legacy single retention_pct, then to sensible defaults. */
function termsFor(direction: Direction, p: ProjectTerms): { vat_pct: number; retention_pct: number } {
  if (direction === "incoming_labour") {
    return {
      vat_pct: p.labour_vat_pct ?? 20,
      retention_pct: p.labour_retention_pct ?? p.retention_pct ?? 5,
    };
  }
  return {
    vat_pct: p.client_vat_pct ?? 20,
    retention_pct: p.client_retention_pct ?? p.retention_pct ?? 5,
  };
}

const PROJECT_TERMS_COLS =
  "retention_pct, client_vat_pct, client_retention_pct, labour_vat_pct, labour_retention_pct";

// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * Portfolio-wide list of every AfP across all projects, joined with project
 * and supplier names. Powers the Applications workspace. Optional filters:
 *   ?direction=outgoing|incoming_labour   ?status=draft|…   ?unassigned=1
 */
applications.get("/", async (c) => {
  const direction = c.req.query("direction");
  const status = c.req.query("status");
  const unassigned = c.req.query("unassigned") === "1";

  const where: string[] = [];
  const binds: unknown[] = [];
  if (direction === "outgoing" || direction === "incoming_labour") {
    where.push("a.direction = ?"); binds.push(direction);
  }
  if (status) { where.push("a.status = ?"); binds.push(status); }
  if (unassigned) where.push("a.direction = 'incoming_labour' AND a.counterparty_supplier_id IS NULL");
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.project_id, a.direction, a.app_number, a.period_end, a.status,
            a.counterparty_supplier_id, a.total_invoice, a.certified_amount,
            a.amount_due, a.cumulative_value, a.created_at, a.created_by,
            CASE WHEN a.unmatched_lines_json IS NOT NULL AND a.unmatched_lines_json != ''
                 THEN 1 ELSE 0 END AS has_unmatched,
            p.code AS project_code, p.name AS project_name,
            s.name AS supplier_name
     FROM applications_for_payment a
     JOIN projects p ON p.id = a.project_id
     LEFT JOIN suppliers s ON s.id = a.counterparty_supplier_id
     ${whereSql}
     ORDER BY a.created_at DESC`,
  ).bind(...binds).all();
  return c.json(rows.results);
});

// ── Inbound tray (emails parked without a resolvable project) ────────────────

/** List pending inbound applications awaiting a project assignment. */
applications.get("/inbound", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.received_at, i.sender_email, i.subject, i.filename, i.direction,
            i.counterparty_supplier_id, i.extracted_lines_json, i.note,
            s.name AS supplier_name
     FROM inbound_applications i
     LEFT JOIN suppliers s ON s.id = i.counterparty_supplier_id
     WHERE i.status = 'pending'
     ORDER BY i.received_at DESC`,
  ).all<Record<string, unknown>>();
  // Surface a line count rather than the full JSON blob.
  const out = rows.results.map((r) => {
    let lineCount = 0;
    try { lineCount = (JSON.parse(String(r.extracted_lines_json)) as unknown[]).length; } catch { /* ignore */ }
    const { extracted_lines_json: _omit, ...rest } = r;
    return { ...rest, line_count: lineCount };
  });
  return c.json(out);
});

/**
 * Resolve a parked inbound application: assign a project (and optionally the
 * subcontractor), run the BOQ match against the stored extracted lines, and
 * create the draft AfP. Marks the inbound row resolved.
 */
applications.post("/inbound/:id/resolve", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ project_id: string; counterparty_supplier_id?: number | null; period_mode?: boolean }>();
  if (!body.project_id) return c.json({ error: "project_id required" }, 400);

  const row = await c.env.DB.prepare(
    "SELECT id, status, sender_email, subject, direction, counterparty_supplier_id, extracted_lines_json, source_file_key, source_file_name, source_file_type, source_file_hash, extracted_meta_json FROM inbound_applications WHERE id = ?",
  ).bind(id).first<{
    id: number; status: string; sender_email: string; subject: string | null;
    direction: Direction; counterparty_supplier_id: number | null; extracted_lines_json: string;
    source_file_key: string | null; source_file_name: string | null; source_file_type: string | null;
    source_file_hash: string | null; extracted_meta_json: string | null;
  }>();
  if (!row) return c.json({ error: "inbound application not found" }, 404);
  if (row.status !== "pending") return c.json({ error: "already resolved or dismissed" }, 409);

  let extracted: ExtractedLabourLine[];
  try { extracted = JSON.parse(row.extracted_lines_json) as ExtractedLabourLine[]; }
  catch { return c.json({ error: "stored lines are corrupt" }, 500); }

  try {
    const result = await createAfpFromLines(c.env, {
      projectId: body.project_id,
      direction: row.direction,
      counterpartySupplierId: body.counterparty_supplier_id ?? row.counterparty_supplier_id ?? null,
      periodEnd: new Date().toISOString().slice(0, 10),
      amountsArePeriod: !!body.period_mode,
      notes: `From inbound email ${row.sender_email}${row.subject ? ` — "${row.subject}"` : ""}.`,
      extracted,
      actor: c.get("userEmail"),
    });
    // Carry the parked source file (stored in R2 on receipt) onto the new AfP.
    if (row.source_file_key) {
      await setAfpSourceFile(c.env, result.id, { key: row.source_file_key, name: row.source_file_name, type: row.source_file_type, hash: row.source_file_hash }).catch(() => {});
    }
    if (row.extracted_meta_json) {
      await c.env.DB.prepare("UPDATE applications_for_payment SET extracted_meta_json = ? WHERE id = ?")
        .bind(row.extracted_meta_json, result.id).run().catch(() => {});
    }
    await c.env.DB.prepare(
      "UPDATE inbound_applications SET status = 'resolved', resolved_afp_id = ? WHERE id = ?",
    ).bind(result.id, id).run();
    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = /not found|upload a pricing/.test(msg) ? 400 : 500;
    return c.json({ error: msg }, code);
  }
});

/** Dismiss a parked inbound application without creating an AfP. */
applications.post("/inbound/:id/dismiss", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare(
    "UPDATE inbound_applications SET status = 'dismissed' WHERE id = ? AND status = 'pending'",
  ).bind(id).run();
  return c.json({ ok: true });
});

/** List AfPs for a project (newest first). Filter by direction with ?direction= */
applications.get("/project/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const direction = (c.req.query("direction") as Direction | undefined) ?? "outgoing";
  const rows = await c.env.DB.prepare(
    `SELECT a.*,
            (SELECT COUNT(*) FROM afp_lines l WHERE l.afp_id = a.id) AS line_count
     FROM applications_for_payment a
     WHERE a.project_id = ? AND a.direction = ?
     ORDER BY a.app_number DESC`,
  )
    .bind(projectId, direction)
    .all();
  return c.json(rows.results);
});

/** List AfPs awaiting approval (used by the inbox). Registered before "/:id"
 *  so the literal path is never captured as an id. */
applications.get("/_pending-approval", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.app_number, a.period_end, a.direction, a.total_invoice,
            a.contract_sum, a.cumulative_value, a.submitted_at, a.submitted_by,
            p.code AS project_code, p.name AS project_name,
            s.name AS supplier_name
     FROM applications_for_payment a
     JOIN projects p ON p.id = a.project_id
     LEFT JOIN suppliers s ON s.id = a.counterparty_supplier_id
     WHERE a.status = 'pending_approval'
     ORDER BY a.submitted_at DESC`,
  ).all();
  return c.json(rows.results);
});

/** Get one AfP with lines + the prior-AfPs context for "previously certified". */
/** Create (or link) a LABOUR supplier from the application's extracted sender
 *  details — name, address, VAT, UTR, contact, terms, bank — and assign them
 *  as this application's counterparty. Same permission as the register. */
applications.post("/:id/create-supplier", async (c) => {
  const denied = requirePermission(c, "suppliers.manage");
  if (denied) return denied;
  const id = c.req.param("id");
  const afp = await c.env.DB.prepare(
    "SELECT id, counterparty_supplier_id, extracted_meta_json FROM applications_for_payment WHERE id = ?",
  ).bind(id).first<{ id: number; counterparty_supplier_id: number | null; extracted_meta_json: string | null }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.counterparty_supplier_id) return c.json({ error: "A subcontractor is already assigned." }, 409);
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
  let meta: Partial<LabourAppMeta> = {};
  try { meta = afp.extracted_meta_json ? (JSON.parse(afp.extracted_meta_json) as LabourAppMeta) : {}; } catch { /* name-only */ }
  const name = (body.name ?? meta.supplier_name ?? "").trim();
  if (!name) return c.json({ error: "No subcontractor name — type the name from the document." }, 400);

  const existing = await findSupplier(c.env, name, meta.supplier_vat_number ?? null);
  if (existing) {
    await c.env.DB.prepare("UPDATE suppliers SET is_labour_supplier = 1 WHERE id = ?").bind(existing).run();
    await c.env.DB.prepare("UPDATE applications_for_payment SET counterparty_supplier_id = ? WHERE id = ?").bind(existing, id).run();
    return c.json({ id: existing, linked_existing: true, captured: [] as string[] });
  }
  const fields: Record<string, string | null> = {
    payment_terms: meta.payment_terms ?? null,
    contact_email: meta.supplier_email ?? null,
    contact_phone: meta.supplier_phone ?? null,
    address: meta.supplier_address ?? null,
    vat_number: meta.supplier_vat_number ?? null,
    utr: meta.supplier_utr ?? null,
    bank_name: meta.bank_name ?? null,
    bank_sort_code: meta.bank_sort_code ?? null,
    bank_account_number: meta.bank_account_number ?? null,
    bank_account_name: meta.bank_account_name ?? null,
  };
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO suppliers (name, status, is_labour_supplier, payment_terms, contact_email, contact_phone, address,
          vat_number, utr, bank_name, bank_sort_code, bank_account_number, bank_account_name, created_at, created_by)
       VALUES (?, 'approved', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(name, fields.payment_terms, fields.contact_email, fields.contact_phone, fields.address, fields.vat_number,
      fields.utr, fields.bank_name, fields.bank_sort_code, fields.bank_account_number, fields.bank_account_name,
      new Date().toISOString(), c.get("userEmail")).first<{ id: number }>();
    await c.env.DB.prepare("UPDATE applications_for_payment SET counterparty_supplier_id = ? WHERE id = ?").bind(res!.id, id).run();
    return c.json({ id: res!.id, linked_existing: false, captured: Object.keys(fields).filter((k) => fields[k]) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "couldn't create the subcontractor" }, 400);
  }
});

/** Stream the application's stored source document (the emailed/uploaded
 *  file) so the AfP page can show what actually arrived. */
applications.get("/:id/source-file", async (c) => {
  const denied = requirePermission(c, "commercial.view");
  if (denied) return denied;
  const afp = await c.env.DB.prepare(
    "SELECT source_file_key, source_file_name, source_file_type FROM applications_for_payment WHERE id = ?",
  ).bind(c.req.param("id")).first<{ source_file_key: string | null; source_file_name: string | null; source_file_type: string | null }>();
  if (!afp?.source_file_key) return c.json({ error: "no stored source document" }, 404);
  const obj = await c.env.R2.get(afp.source_file_key);
  if (!obj) return c.json({ error: "stored file missing" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": afp.source_file_type || "application/octet-stream",
      "Content-Disposition": `inline; filename="${(afp.source_file_name || "application").replace(/["\\]/g, "")}"`,
    },
  });
});

/** Stream the counterparty's returned payment certificate — the document that
 *  set this AfP's certified figures. */
applications.get("/:id/cert-file", async (c) => {
  const denied = requirePermission(c, "commercial.view");
  if (denied) return denied;
  const afp = await c.env.DB.prepare(
    "SELECT cert_file_key, cert_file_name, cert_file_type FROM applications_for_payment WHERE id = ?",
  ).bind(c.req.param("id")).first<{ cert_file_key: string | null; cert_file_name: string | null; cert_file_type: string | null }>();
  if (!afp?.cert_file_key) return c.json({ error: "no stored certificate" }, 404);
  const obj = await c.env.R2.get(afp.cert_file_key);
  if (!obj) return c.json({ error: "stored file missing" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": afp.cert_file_type || "application/octet-stream",
      "Content-Disposition": `inline; filename="${(afp.cert_file_name || "certificate").replace(/["\\]/g, "")}"`,
    },
  });
});

applications.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const afp = await c.env.DB.prepare(
    `SELECT a.*, p.code AS project_code, p.name AS project_name,
            p.client AS project_client, p.retention_pct AS project_retention_pct
     FROM applications_for_payment a
     JOIN projects p ON p.id = a.project_id
     WHERE a.id = ?`,
  )
    .bind(id)
    .first();
  if (!afp) return c.json({ error: "not found" }, 404);

  const lines = await c.env.DB.prepare(
    `SELECT * FROM afp_lines WHERE afp_id = ? ORDER BY display_order`,
  )
    .bind(id)
    .all<Record<string, unknown>>();

  // Flag labour lines valued at a rate that differs from the agreed live rate
  // (or BOQ rate), so the UI can surface them and hold certification.
  if ((afp as AfpRow).direction === "incoming_labour") {
    const rm = await rateMismatchMap(c.env.DB, id, (afp as AfpRow).project_id);
    for (const l of lines.results) {
      const info = rm.get(Number(l.id));
      if (info) {
        l.expected_rate = info.expected;
        l.rate_source = info.source;
        l.rate_flagged = info.flagged ? 1 : 0;
      }
    }
  }

  const priors = await c.env.DB.prepare(
    `SELECT app_number, period_end, status, certified_amount, cumulative_value, total_invoice
     FROM applications_for_payment
     WHERE project_id = ? AND direction = ? AND app_number < ?
     ORDER BY app_number`,
  )
    .bind((afp as AfpRow).project_id, (afp as AfpRow).direction, (afp as AfpRow).app_number)
    .all();

  // Previously certified PER bill line — sum, over prior (submitted/certified/paid)
  // apps in this direction, of each line's certified (or applied) value for the
  // same contract_item. So the UI can show this period = cumulative − previously.
  const prevByItem = new Map<number, number>();
  try {
    const prevLines = await c.env.DB.prepare(
      `SELECT al.contract_item_id AS cid,
              COALESCE(SUM(COALESCE(al.certified_percent / 100.0 * al.contract_value, al.cumulative_value)), 0) AS prev
         FROM afp_lines al
         JOIN applications_for_payment a2 ON a2.id = al.afp_id
        WHERE a2.project_id = ? AND a2.direction = ? AND a2.app_number < ?
          AND a2.status IN ('submitted','certified','paid') AND al.contract_item_id IS NOT NULL
        GROUP BY al.contract_item_id`,
    ).bind((afp as AfpRow).project_id, (afp as AfpRow).direction, (afp as AfpRow).app_number)
      .all<{ cid: number; prev: number }>();
    for (const r of prevLines.results) prevByItem.set(Number(r.cid), r.prev ?? 0);
  } catch { /* pre-existing schemas — skip */ }
  for (const l of lines.results) {
    l.previously_certified = l.contract_item_id != null ? (prevByItem.get(Number(l.contract_item_id)) ?? 0) : 0;
  }

  // CIS preview for a labour certificate — the exact deduction the Xero bill
  // will carry (same helper the push uses, so the two can't drift). Only for a
  // subbie on a >0% rate; best-effort, never fails the certificate view.
  let cis: AfpCisPreview | null = null;
  const row = afp as AfpRow & { certified_amount: number | null; amount_due: number | null };
  if (row.direction === "incoming_labour" && row.counterparty_supplier_id != null) {
    try {
      const sup = await c.env.DB.prepare("SELECT name, cis_rate FROM suppliers WHERE id = ?")
        .bind(row.counterparty_supplier_id)
        .first<{ name: string; cis_rate: number | null }>();
      const net = row.certified_amount ?? row.amount_due ?? 0;
      if (sup?.cis_rate != null && sup.cis_rate > 0 && net > 0) {
        const base = await cisLabourBase(c.env, row, net);
        const deduction = Math.round(base * sup.cis_rate) / 100;
        cis = {
          supplier_name: sup.name,
          rate: sup.cis_rate,
          certified_net: net,
          labour_base: base,
          deduction,
          net_payable: net - deduction,
        };
      }
    } catch (e) { console.warn("CIS preview skipped:", e instanceof Error ? e.message : e); }
  }

  return c.json({ afp, lines: lines.results, prior_apps: priors.results, cis });
});

/**
 * Create a draft AfP. Seeds afp_lines from the active snapshot's contract_items
 * (sell rate by default; labour rate when direction='incoming_labour'). Each
 * seeded line starts at 0% complete.
 */
applications.post("/project/:projectId", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const projectId = c.req.param("projectId");
  const body = await c.req.json<{
    period_end: string;
    notes?: string;
    direction?: Direction;
    counterparty_supplier_id?: number | null;
  }>();
  if (!body.period_end) return c.json({ error: "period_end required" }, 400);

  const project = await c.env.DB.prepare(
    `SELECT id, ${PROJECT_TERMS_COLS} FROM projects WHERE id = ?`,
  )
    .bind(projectId)
    .first<{ id: string } & ProjectTerms>();
  if (!project) return c.json({ error: "project not found" }, 404);

  const direction: Direction = body.direction ?? "outgoing";
  if (direction === "incoming_labour" && !body.counterparty_supplier_id) {
    return c.json({ error: "counterparty_supplier_id required for incoming_labour" }, 400);
  }
  const terms = termsFor(direction, project);

  const snap = await c.env.DB.prepare(
    "SELECT id FROM material_snapshots WHERE project_id = ? AND is_active = 1",
  )
    .bind(projectId)
    .first<{ id: number }>();
  if (!snap) return c.json({ error: "upload a pricing workbook first" }, 400);

  const next = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(app_number), 0) + 1 AS n
     FROM applications_for_payment WHERE project_id = ? AND direction = ?`,
  )
    .bind(projectId, direction)
    .first<{ n: number }>();
  const appNumber = next!.n;

  const actor = c.get("userEmail");
  const now = new Date().toISOString();

  const inserted = await c.env.DB.prepare(
    `INSERT INTO applications_for_payment
       (project_id, direction, app_number, period_end, notes, retention_pct, vat_pct,
        counterparty_supplier_id, status, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?) RETURNING id`,
  )
    .bind(
      projectId, direction, appNumber, body.period_end, body.notes ?? null,
      terms.retention_pct, terms.vat_pct, body.counterparty_supplier_id ?? null, now, actor,
    )
    .first<{ id: number }>();
  const afpId = inserted!.id;

  // Seed lines from contract_items. Pick rate based on direction.
  const items = await c.env.DB.prepare(
    `SELECT id, item_no, category, section, description, qty, unit, sell_rate, sell_total, labour_rate, labour_total
     FROM contract_items WHERE snapshot_id = ? ORDER BY item_no`,
  )
    .bind(snap.id)
    .all<{
      id: number; item_no: number; category: string | null; section: string | null;
      description: string; qty: number; unit: string | null;
      sell_rate: number; sell_total: number;
      labour_rate: number | null; labour_total: number | null;
    }>();

  // Supplier-scoped labour: if this subbie has been allocated specific bill items
  // on the project, seed ONLY those, and cap each line's value at their £ slice.
  let allocByItem: Map<number, number | null> | null = null;
  if (direction === "incoming_labour" && body.counterparty_supplier_id) {
    try {
      const al = await c.env.DB.prepare(
        "SELECT contract_item_id, allocated_value FROM contract_item_suppliers WHERE project_id = ? AND supplier_id = ?",
      ).bind(projectId, body.counterparty_supplier_id).all<{ contract_item_id: number; allocated_value: number | null }>();
      if (al.results.length > 0) allocByItem = new Map(al.results.map((r) => [Number(r.contract_item_id), r.allocated_value]));
    } catch { /* pre-0074 */ }
  }

  // Labour AfPs only seed labour-bearing lines (Prelims/Ancil carry no labour);
  // client AfPs seed every line across Prelims + Measured + Ancil.
  const seedRows = (direction === "incoming_labour"
    ? items.results.filter((it) => (it.labour_total ?? 0) > 0)
    : items.results
  ).filter((it) => !allocByItem || allocByItem.has(it.id));
  const stmts = seedRows.map((it, idx) => {
    const rate = direction === "incoming_labour"
      ? (it.labour_rate ?? 0)
      : it.sell_rate;
    const allocCap = allocByItem?.get(it.id);
    const total = allocCap != null ? allocCap
      : direction === "incoming_labour" ? (it.labour_total ?? 0) : it.sell_total;
    return c.env.DB.prepare(
      `INSERT INTO afp_lines
         (afp_id, contract_item_id, category, section, description, unit, qty, rate,
          contract_value, percent_complete, cumulative_value, is_adhoc, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`,
    ).bind(
      afpId, it.id, it.category ?? "measured", it.section, it.description, it.unit, it.qty, rate, total, idx + 1,
    );
  });
  if (stmts.length > 0) await c.env.DB.batch(stmts);

  await recalcTotals(c.env.DB, afpId);
  return c.json({ id: afpId, app_number: appNumber });
});

/* ── Labour supplier ↔ bill-item allocations ─────────────────────────────
 * Assign labour subcontractors to specific bill items so their application only
 * shows their items; one item can be split across suppliers by £. */
applications.get("/project/:projectId/labour-allocations", async (c) => {
  const denied = requirePermission(c, "commercial.view"); if (denied) return denied;
  const rows = await c.env.DB.prepare(
    `SELECT cis.id, cis.contract_item_id, cis.supplier_id, cis.allocated_value,
            ci.item_no, ci.description, ci.labour_total, s.name AS supplier_name
       FROM contract_item_suppliers cis
       JOIN contract_items ci ON ci.id = cis.contract_item_id
       JOIN suppliers s ON s.id = cis.supplier_id
      WHERE cis.project_id = ?
      ORDER BY ci.item_no, s.name`,
  ).bind(c.req.param("projectId")).all();
  return c.json(rows.results);
});

applications.post("/project/:projectId/labour-allocations", async (c) => {
  const denied = requirePermission(c, "commercial.edit"); if (denied) return denied;
  const projectId = c.req.param("projectId");
  const b = await c.req.json<{ contract_item_id: number; supplier_id: number; allocated_value?: number | null }>();
  if (!b.contract_item_id || !b.supplier_id) return c.json({ error: "contract_item_id and supplier_id required" }, 400);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO contract_item_suppliers (project_id, contract_item_id, supplier_id, allocated_value, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(contract_item_id, supplier_id) DO UPDATE SET allocated_value = excluded.allocated_value`,
  ).bind(projectId, b.contract_item_id, b.supplier_id, b.allocated_value ?? null, now, c.get("userEmail")).run();
  return c.json({ ok: true });
});

applications.delete("/labour-allocations/:id", async (c) => {
  const denied = requirePermission(c, "commercial.edit"); if (denied) return denied;
  await c.env.DB.prepare("DELETE FROM contract_item_suppliers WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ── Labour-app upload + auto-populate ───────────────────────────────────────
//
// Accept a subcontractor's labour application as a PDF or XLSX. Extract the
// claimed lines (description + this-period value AND/OR cumulative %), match
// each to a contract_item on the active snapshot, then create a draft
// incoming_labour AfP with the matched lines pre-populated. Unmatched lines
// are stored as JSON on the AfP for review on the detail page.

export type ExtractedLabourLine = {
  line_no: number;
  description: string;
  qty: number | null;
  unit: string | null;
  /** Cumulative pound value claimed to date for this line (preferred). */
  cumulative_value: number | null;
  /** Cumulative % complete (alternative to cumulative_value). */
  cumulative_pct: number | null;
  /** This-period (delta) value if the subbie reports per-period rather than cumulative. */
  this_period_value: number | null;
  /** The line's full contract/total value if the source carries it (the cost
   *  workbook's "Total Value" column). Used to match a certificate line back to
   *  the application line by value when descriptions have drifted. */
  contract_value?: number | null;
  /** True when the row came from a non-BOQ tab ("Variations" or "Materials on
   *  Site") — added as an ad-hoc line rather than matched to a contract item. */
  is_variation?: boolean;
  /** Section label for an ad-hoc line, e.g. "Variations" or "Materials on Site". */
  section?: string | null;
};

/** ArrayBuffer → base64 (Workers-safe, chunked to avoid stack overflow). */
function bufToBase64Workers(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Extract readable text from a .docx (Word) file so Claude can read an
 * application/invoice that arrived as Word rather than PDF. Paragraphs land on
 * their own lines and table cells are tab-separated, which is plenty for the
 * line-item extraction that follows.
 */
function docxToText(buf: ArrayBuffer): string {
  const files = unzipSync(new Uint8Array(buf));
  const entry = files["word/document.xml"];
  if (!entry) throw new Error("not a readable Word document (no word/document.xml)");
  // Guard against a decompression bomb: a small .docx can inflate document.xml to
  // hundreds of MB and OOM the Worker isolate. Reachable unauthenticated via the
  // inbound-email path, so cap the inflated size.
  if (entry.length > 30_000_000) throw new Error("Word document is too large to process");
  let xml = strFromU8(entry);
  // Turn OOXML structural boundaries into whitespace we can read.
  xml = xml
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<\/w:p>/g, "\n")   // paragraph → newline
    .replace(/<\/w:tc>/g, "\t")  // table cell → tab
    .replace(/<\/w:tr>/g, "\n"); // table row → newline
  // Drop every remaining tag, keep the text nodes, then decode entities.
  let text = xml.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&"); // ampersand last so we don't double-decode
  // A paragraph break sitting right before a cell/row separator is noise — drop it.
  text = text.replace(/\n+(?=[\t\n])/g, "");
  return text
    .split("\n")
    .map((l) => l.replace(/\t{2,}/g, "\t").replace(/[ \t]+$/g, "").trimStart())
    .filter((l) => l.length > 0)
    .join("\n")
    .trim();
}

/** Call Claude with a flexible schema that accepts whichever value-shape the subbie used. */
/** The SENDER'S company details read off an application document — everything
 *  needed to put a new subcontractor on the register without retyping. */
export type LabourAppMeta = {
  supplier_name: string | null;
  supplier_address: string | null;
  supplier_vat_number: string | null;
  supplier_utr: string | null;
  supplier_email: string | null;
  supplier_phone: string | null;
  payment_terms: string | null;
  bank_name: string | null;
  bank_sort_code: string | null;
  bank_account_number: string | null;
  bank_account_name: string | null;
};
function labourMetaJson(m: LabourAppMeta | null): string | null {
  return m && Object.values(m).some((v) => v != null) ? JSON.stringify(m) : null;
}

async function extractLabourAppViaClaude(
  env: Env,
  source: { pdf: ArrayBuffer } | { text: string },
  opts: { certificate?: boolean; collectMeta?: (m: LabourAppMeta) => void } = {},
): Promise<ExtractedLabourLine[]> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? "" });
  const system = opts.certificate
    ? `You are processing a UK construction CLIENT'S PAYMENT CERTIFICATE. This is OUR
application for payment returned by the client (or their QS/employer's agent) with
the amounts they have CERTIFIED. Each line typically shows what we APPLIED for and,
in a column to the RIGHT, what the client has CERTIFIED (often headed "Certified",
"Certified £", "% certified", "Approved", or similar).

Extract, for each line, the CERTIFIED figure the client has approved — NOT the
applied/claimed figure. Return:
- description: what the line is for, as written.
- qty / unit: if present, otherwise omit.
- cumulative_value: the cumulative £ the client has CERTIFIED to date for this line (preferred).
- cumulative_pct: the cumulative % the client has CERTIFIED to date for this line.
- this_period_value: the £ certified in this period only, if that's all that's shown.

If a line shows only the applied figure with no certified amount, omit that line.
You only need to populate the value fields you can find — leave the others null.
Skip headers, sub-totals, retention rows, VAT rows, payment-summary rows.
Numbers must be plain — no £ symbol, no commas.`
    : `You are processing a UK construction subcontractor's Application for Payment (AfP)
for labour-only works. Subbies format these wildly differently — sometimes per BOQ
line with a % complete, sometimes with a £ value claimed this period, sometimes
with a cumulative £ to-date. Extract every line that represents a discrete piece
of priced work.

For each line, return:
- description: what the line is for, as written.
- qty / unit: if present, otherwise omit.
- cumulative_value: the cumulative £ claimed to date for this line (preferred).
- cumulative_pct: the cumulative % complete to date for this line.
- this_period_value: just the £ value claimed in this application (delta only).

You only need to populate the value fields you can find — leave the others null.
Skip headers, sub-totals, retention rows, VAT rows, payment-summary rows.
Numbers must be plain — no £ symbol, no commas.`;

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 4096,
    system,
    tools: [{
      name: "extract_labour_application",
      description: "Extract the priced line items from a subcontractor's labour application.",
      input_schema: {
        type: "object" as const,
        properties: {
          sender: {
            type: "object",
            description: "The SUBCONTRACTOR who sent this application (who we pay): their company details exactly as printed. Null anything not shown. NOT the client's or PowerGrid's details.",
            properties: {
              name: { type: "string", description: "The subcontractor's company name." },
              address: { type: "string", description: "Their address as printed." },
              vat_number: { type: "string", description: "Their VAT registration number, e.g. 'GB 123 4567 89'." },
              utr: { type: "string", description: "Their UTR (unique taxpayer reference) if printed — common on CIS labour applications." },
              email: { type: "string", description: "Their contact / remittance email if printed." },
              phone: { type: "string", description: "Their phone number if printed." },
              payment_terms: { type: "string", description: "Payment terms as written, if any." },
              bank_name: { type: "string" },
              bank_sort_code: { type: "string", description: "e.g. '12-34-56'." },
              bank_account_number: { type: "string" },
              bank_account_name: { type: "string" },
            },
          },
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                description: { type: "string", description: "Line description as written on the application." },
                qty: { type: "number", description: "Quantity if present." },
                unit: { type: "string", description: "Unit if present (m², lm, each, etc.)." },
                cumulative_value: { type: "number", description: "Cumulative £ claimed to date." },
                cumulative_pct: { type: "number", description: "Cumulative % complete." },
                this_period_value: { type: "number", description: "£ claimed in this application period only." },
              },
              required: ["description"],
            },
          },
        },
        required: ["lines"],
      },
    }],
    tool_choice: { type: "tool", name: "extract_labour_application" },
    messages: [{
      role: "user",
      content: "pdf" in source
        ? [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: bufToBase64Workers(source.pdf) } },
            { type: "text", text: "Extract the priced labour lines via extract_labour_application." },
          ]
        : [
            { type: "text", text: `The following is the text of a subcontractor's labour application / invoice, converted from a Word document (table cells are tab-separated, one row per line). Extract the priced labour lines via extract_labour_application.\n\n---\n${source.text}` },
          ],
    }],
  });

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) return [];
  if (!opts.certificate && opts.collectMeta) {
    const sd = ((toolUse.input as Record<string, unknown>).sender ?? {}) as Record<string, unknown>;
    const st = (v: unknown) => { const t = (v == null ? "" : String(v)).trim(); return t || null; };
    opts.collectMeta({
      supplier_name: st(sd.name), supplier_address: st(sd.address), supplier_vat_number: st(sd.vat_number),
      supplier_utr: st(sd.utr), supplier_email: st(sd.email), supplier_phone: st(sd.phone),
      payment_terms: st(sd.payment_terms), bank_name: st(sd.bank_name), bank_sort_code: st(sd.bank_sort_code),
      bank_account_number: st(sd.bank_account_number), bank_account_name: st(sd.bank_account_name),
    });
  }
  const raw = (toolUse.input as { lines?: Array<Record<string, unknown>> }).lines ?? [];
  return raw.map((r, i) => ({
    line_no: i + 1,
    description: String(r.description ?? "").trim(),
    qty: typeof r.qty === "number" ? r.qty : null,
    unit: r.unit ? String(r.unit).trim() : null,
    cumulative_value: typeof r.cumulative_value === "number" ? r.cumulative_value : null,
    cumulative_pct: typeof r.cumulative_pct === "number" ? r.cumulative_pct : null,
    this_period_value: typeof r.this_period_value === "number" ? r.this_period_value : null,
  })).filter((l) => l.description.length > 0);
}

// Cover A–Z and AA–AZ. The cost workbook puts applied figures around N/O and
// the client's CERTIFIED figures out at Y/Z, so scanning only A–T silently
// missed the certified columns. AA–AZ gives headroom for wider sheets.
const ALL_COLS = [
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),          // A–Z
  ...Array.from({ length: 26 }, (_, i) => "A" + String.fromCharCode(65 + i)),    // AA–AZ
];

/**
 * sheet_to_json, but clamped to the columns/rows the parsers actually read
 * (A–AZ, ≤2000 rows). Some client workbooks carry thousands of phantom columns
 * (a stray "WVF…" range) which, expanded to full row objects, exhaust the
 * worker's memory. We only ever look at A–AZ, so bound the range first.
 */
function boundedSheetRows(ws: XLSX.WorkSheet): Record<string, unknown>[] {
  const opts = { header: "A" as const, defval: null, raw: true };
  const ref = ws["!ref"];
  if (ref) {
    const r = XLSX.utils.decode_range(ref);
    if (r.e.c > 51 || r.e.r > 2000) {
      const range = XLSX.utils.encode_range({ s: { r: r.s.r, c: 0 }, e: { r: Math.min(r.e.r, 2000), c: Math.min(r.e.c, 51) } });
      return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { ...opts, range });
    }
  }
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, opts);
}

/**
 * Structured extraction of one sheet that carries a "% Complete" column —
 * works for any of the cost-workbook tabs (Prelims, Pricing, Ancil Items),
 * since the application is the workbook with % Complete + Value filled in.
 * Finds the header row by the "% Complete" label, then identifies the
 * description / % / value columns. Returns [] if the sheet has no such header.
 */
function extractSheetStructured(ws: XLSX.WorkSheet): Array<Omit<ExtractedLabourLine, "line_no">> {
  const rows = boundedSheetRows(ws);
  let headerIdx = -1;
  let pctCol: string | null = null;
  let valueCol: string | null = null;
  let appliedCol: string | null = null;
  let descCol: string | null = null;
  let refCol: string | null = null;
  let qtyCol: string | null = null;
  let unitCol: string | null = null;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const r = rows[i] ?? {};
    const hasPct = ALL_COLS.some((c) => typeof r[c] === "string" && /%\s*complete/i.test(String(r[c])));
    if (!hasPct) continue;
    headerIdx = i;
    for (const c of ALL_COLS) {
      const v = r[c];
      if (typeof v !== "string") continue;
      const t = v.trim().toLowerCase();
      // "Applied" / "Applied Value" / "Application Value" (and the common
      // "Aplication" typo) — the claimed amount. Matching only the bare word
      // "applied" used to leave this null, which let the CONTRACT "Value"
      // column below stand in as the claim and marked never-applied-for lines
      // (e.g. a Fall Arrest tab with blank % / Applied) as fully claimed.
      if (!pctCol && /%\s*complete/.test(t)) pctCol = c;
      else if (!appliedCol && /^(ap?plied|ap?plicat)/.test(t)) appliedCol = c;
      else if (!valueCol && t === "value") valueCol = c;             // the claimed value (not "Total/Material/Labour Value")
      if (!descCol && (t === "item" || t === "description")) descCol = c;
      if (!refCol && t === "ref") refCol = c;                        // Prelims: whole-number Ref = section subtotal
      if (!qtyCol && (t === "qty" || t === "quantity")) qtyCol = c;
      if (!unitCol && (t === "unit" || t === "units")) unitCol = c;
    }
    break;
  }
  // Prefer an explicit "Applied" column (the claim) over "Value" — on the
  // Prelims tab "Value" is the budget and "Applied" is the claimed amount.
  const claimValueCol = appliedCol ?? valueCol;
  if (headerIdx < 0 || !descCol || (!pctCol && !claimValueCol)) return [];

  const out: Array<Omit<ExtractedLabourLine, "line_no">> = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] ?? {};
    const d = r[descCol];
    if (typeof d !== "string" || d.trim().length === 0) continue;
    // "Costing" starts the internal cost block — never read past it. A "Total"
    // row is just a section subtotal (sheets like Blyth's Pricing tab total
    // each section mid-sheet), so skip it and keep reading.
    if (/^costing$/i.test(d.trim())) break;
    if (/^total$/i.test(d.trim())) continue;
    // Skip section / subtotal rows — a whole-number Ref (e.g. Prelims "1 Management").
    if (refCol) {
      const ref = r[refCol];
      if (typeof ref === "number" && Number.isInteger(ref)) continue;
    }
    const pctRaw = pctCol && typeof r[pctCol] === "number" ? (r[pctCol] as number) : null;
    const valueRaw = claimValueCol && typeof r[claimValueCol] === "number" ? (r[claimValueCol] as number) : null;
    if ((pctRaw == null || pctRaw === 0) && (valueRaw == null || valueRaw === 0)) continue;  // unclaimed
    const qCol = qtyCol ?? "D";
    const uCol = unitCol ?? "E";
    out.push({
      description: d.trim(),
      qty: typeof r[qCol] === "number" ? (r[qCol] as number) : null,
      unit: typeof r[uCol] === "string" ? (r[uCol] as string) : null,
      cumulative_value: valueRaw != null && valueRaw !== 0 ? valueRaw : null,
      // Template stores % as 0–1 decimal (1.00 = 100%); also accept 0–100.
      cumulative_pct: pctRaw != null && pctRaw !== 0 ? (pctRaw <= 1 ? pctRaw * 100 : pctRaw) : null,
      this_period_value: null,
    });
  }
  return out;
}

/** Heuristic fallback for a single free-form sheet with no "% Complete" header. */
/**
 * Invoice-style labour documents (a subbie's own invoice/day-work sheet rather
 * than our % Complete template): a header row naming a description column and a
 * money column — e.g. "Date | Works Description | Quantity | Rate (£) | Sub
 * Total (£)" — with one row per day/item. The generic heuristic can't read
 * these because it only looks for the description in column A, where these
 * sheets put the date; every works row was skipped and the application landed
 * at £0. Returns [] when the sheet isn't this shape, so callers can fall
 * through to the other parsers.
 */
function extractInvoiceStyleSheet(ws: XLSX.WorkSheet): Array<Omit<ExtractedLabourLine, "line_no">> {
  const rows = boundedSheetRows(ws);
  let headerIdx = -1, descCol: string | null = null, valueCol: string | null = null;
  let qtyCol: string | null = null, unitCol: string | null = null;
  for (let i = 0; i < Math.min(30, rows.length); i++) {
    const r = rows[i] ?? {};
    let d: string | null = null, v: string | null = null, q: string | null = null, u: string | null = null;
    for (const c of ALL_COLS) {
      const raw = r[c];
      if (typeof raw !== "string") continue;
      const t = raw.trim().toLowerCase();
      if (!d && /description|works|details|narrative/.test(t) && !/no\.?$/.test(t)) d = c;
      // The money column is the LINE total, not the unit rate.
      if (!v && /^(sub ?total|total|amount|value|line total)/.test(t) && !/due|vat|cis|net|gross/.test(t)) v = c;
      if (!q && /^(qty|quantity|days?|hours?|units?)\b/.test(t)) q = c;
      if (!u && /^(unit|uom)\b/.test(t)) u = c;
    }
    if (d && v) { headerIdx = i; descCol = d; valueCol = v; qtyCol = q; unitCol = u; break; }
  }
  if (headerIdx < 0 || !descCol || !valueCol) return [];

  const out: Array<Omit<ExtractedLabourLine, "line_no">> = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] ?? {};
    const d = r[descCol];
    if (typeof d !== "string" || !d.trim()) continue;
    const desc = d.trim();
    // Stop at the summary block — those are totals/deductions, not works.
    if (/^(sub ?total|total|cis|vat|net|gross|amount due|payment|bank|account)/i.test(desc)) continue;
    const raw = r[valueCol];
    const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/[£$€,\s]/g, ""));
    if (!Number.isFinite(n) || n === 0) continue;
    const qRaw = qtyCol ? r[qtyCol] : null;
    const qty = typeof qRaw === "number" ? qRaw : null;
    out.push({
      description: desc,
      qty,
      unit: unitCol && typeof r[unitCol] === "string" ? String(r[unitCol]).trim() : null,
      cumulative_value: n,
      cumulative_pct: null,
      this_period_value: null,
    });
  }
  // Day-work sheets repeat the same wording every day ("Management on site").
  // Roll those into one claimed line so the application reads as a total, not
  // a diary — the dates live on the source document.
  const merged = new Map<string, Omit<ExtractedLabourLine, "line_no">>();
  for (const l of out) {
    const k = l.description.toLowerCase();
    const cur = merged.get(k);
    if (cur) {
      cur.cumulative_value = (cur.cumulative_value ?? 0) + (l.cumulative_value ?? 0);
      cur.qty = (cur.qty ?? 0) + (l.qty ?? 0);
    } else merged.set(k, { ...l });
  }
  return [...merged.values()];
}

function extractSheetHeuristic(ws: XLSX.WorkSheet): Array<Omit<ExtractedLabourLine, "line_no">> {
  const rows = boundedSheetRows(ws);
  const valueCols = ["B","C","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T"];
  const out: Array<Omit<ExtractedLabourLine, "line_no">> = [];
  for (const r of rows) {
    const a = r["A"];
    if (typeof a !== "string" || a.trim().length === 0) continue;
    const nums: number[] = [];
    for (const col of valueCols) {
      const v = r[col];
      const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[£,\s]/g, ""));
      if (Number.isFinite(n) && n !== 0) nums.push(n);
    }
    if (nums.length === 0) continue;
    const largest = Math.max(...nums);
    let cumulative_value: number | null = null;
    let cumulative_pct: number | null = null;
    if (largest > 100) cumulative_value = largest;
    else if (largest > 0 && largest <= 1) cumulative_pct = largest * 100;
    else if (largest > 0 && largest <= 100) cumulative_pct = largest;
    out.push({ description: a.trim(), qty: null, unit: null, cumulative_value, cumulative_pct, this_period_value: null });
  }
  return out;
}

/**
 * Parse an XLSX application. The application is the cost workbook with
 * "% Complete" / "Value" filled in on each value tab (Prelims, Pricing,
 * Ancil Items), so we scan EVERY sheet that has a "% Complete" header and
 * concatenate the claimed lines — they're matched to contract items by
 * description regardless of which tab they came from. Falls back to a
 * single-sheet heuristic for free-form spreadsheets.
 */
function extractLabourAppFromXlsx(buf: ArrayBuffer): ExtractedLabourLine[] {
  const wb = XLSX.read(buf, { type: "array" });
  const out: ExtractedLabourLine[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    // The "Variations" and "Materials on Site" tabs use Applied/Certified
    // headers (not "% Complete"), so read them with the variation parser.
    const lines = /variation/i.test(name)
      ? extractVariationSheet(ws, "applied", "Variations")
      : (/material/i.test(name) && /site/i.test(name))
        ? extractVariationSheet(ws, "applied", "Materials on Site")
        : extractSheetStructured(ws);
    for (const line of lines) {
      out.push({ ...line, line_no: out.length + 1 });
    }
  }
  if (out.length > 0) return out;
  // No structured "% Complete" tab: try every sheet as a subbie's own
  // invoice / day-work sheet before the last-resort column-A heuristic.
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const inv = extractInvoiceStyleSheet(ws);
    if (inv.length > 0) return inv.map((line, i) => ({ ...line, line_no: i + 1 }));
  }
  const first = wb.Sheets[wb.SheetNames[0]];
  if (!first) return [];
  return extractSheetHeuristic(first).map((line, i) => ({ ...line, line_no: i + 1 }));
}

/**
 * Split a COMBINED labour workbook into per-project line sets. Grouped jobs are
 * often applied for in one workbook with a tab per block (named by project code,
 * e.g. "26001 Block B") plus shared tabs (Fall Arrest, Variations) whose rows are
 * prefixed with the block's code ("26001 Block B Fall Arrest"). We create one tab
 * → one project, then route each shared-tab line to the project its code names.
 * Returns one entry per project code found (empty lines are kept, so a nil block
 * still seeds an AfP from its BOQ). Codes are resolved to real projects by caller.
 */
export function extractCombinedLabourByProject(buf: ArrayBuffer): Array<{ code: string; lines: ExtractedLabourLine[] }> {
  const wb = XLSX.read(buf, { type: "array" });
  const codeOf = (s: string): string | null => { const m = /^\s*(\d{5})\b/.exec(s || ""); return m ? m[1] : null; };
  const byCode = new Map<string, Array<Omit<ExtractedLabourLine, "line_no">>>();

  // 1. Project tabs — a sheet whose NAME starts with a 5-digit code is that block.
  for (const name of wb.SheetNames) {
    const code = codeOf(name);
    if (!code) continue;
    const ws = wb.Sheets[name];
    if (!ws) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code)!.push(...extractSheetStructured(ws));
  }

  // 2. Shared tabs (Fall Arrest / Variations / Materials on Site) — route each
  //    line to the project whose code prefixes the item text.
  for (const name of wb.SheetNames) {
    if (codeOf(name)) continue;                                   // already handled as a project tab
    if (!/fall\s*arrest|variation|material/i.test(name)) continue;
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const lines = /variation|material/i.test(name)
      ? extractVariationSheet(ws, "applied", /material/i.test(name) ? "Materials on Site" : "Variations")
      : extractSheetStructured(ws);
    for (const l of lines) {
      const code = codeOf(l.description);
      if (code && byCode.has(code)) byCode.get(code)!.push(l);
    }
  }

  return [...byCode.entries()].map(([code, lines]) => ({
    code,
    lines: lines.map((l, i) => ({ ...l, line_no: i + 1 })),
  }));
}

/**
 * Extract a CLIENT-CERTIFICATE sheet. The client returns our application
 * workbook with their CERTIFIED figures added in a column to the RIGHT of the
 * applied figures. We read those certified columns — never the applied ones:
 *   1. An explicitly-headed column ("Certified £", "% certified", "Approved").
 *   2. Failing that, the first numeric column to the right of the applied
 *      "Cumulative £" / "% complete" column (the client added it there).
 * Returns [] if the sheet has no recognisable header row.
 */
function extractCertSheet(ws: XLSX.WorkSheet, sheetName?: string): Array<Omit<ExtractedLabourLine, "line_no">> {
  const rows = boundedSheetRows(ws);
  const colIdx = (c: string | null) => (c ? ALL_COLS.indexOf(c) : -1);

  let headerIdx = -1, descCol: string | null = null, refCol: string | null = null;
  let appliedPctCol: string | null = null, appliedValCol: string | null = null;
  let certPctCol: string | null = null, certValCol: string | null = null;

  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const r = rows[i] ?? {};
    const label = (c: string) => (typeof r[c] === "string" ? String(r[c]).trim().toLowerCase() : "");
    const hasDesc = ALL_COLS.some((c) => label(c) === "item" || label(c) === "description");
    const hasMetric = ALL_COLS.some((c) => /%\s*complete|cumulative|certif|approv|\bvalue\b/.test(label(c)));
    if (!(hasDesc && hasMetric)) continue;
    headerIdx = i;
    for (const c of ALL_COLS) {
      const t = label(c);
      if (!t || t === "item" || t === "description") continue;
      if (t === "ref") { if (!refCol) refCol = c; continue; }  // Prelims: whole-number Ref = section row
      const isCert = /certif|approv/.test(t);
      const isPct = t.includes("%") || t.includes("percent");
      if (isCert) {
        if (isPct) { if (!certPctCol) certPctCol = c; }   // "% certified"
        else if (!certValCol) certValCol = c;             // "Certified £", "Approved value"
      } else {
        // Anchor only on the APPLIED cumulative/percent — not "Rate £" or
        // "Contract £" (which also contain "£").
        if (/complete/.test(t) && !appliedPctCol) appliedPctCol = c;        // "% complete"
        if ((/cumulative/.test(t) || t === "value") && !appliedValCol) appliedValCol = c; // "Cumulative £"
      }
    }
    for (const c of ALL_COLS) { if (label(c) === "item" || label(c) === "description") { descCol = c; break; } }
    break;
  }
  if (headerIdx < 0 || !descCol) return [];

  // No explicitly-headed certified column. These workbooks lay the sheet out as
  // repeating "% Complete | <value>" PAIRS — contract, then applied, then
  // certified — and a client often labels every one of them "Total Value"
  // (Block C of the Dallas certificate does exactly that). The certified figure
  // is therefore the LAST pair, not the first column right of the applied
  // anchor: taking the first landed on the APPLIED value and silently certified
  // whatever had been claimed.
  let valCol = certValCol;
  let pctCol = certPctCol;
  if (!certValCol && !certPctCol) {
    const headerRow = rows[headerIdx] ?? {};
    const lbl = (c: string) => (typeof headerRow[c] === "string" ? String(headerRow[c]).trim().toLowerCase() : "");
    const pctCols = ALL_COLS.filter((c) => /%|percent/.test(lbl(c)));
    // Value columns, excluding the unit rate (a rate is per-unit, not a total).
    const valCols = ALL_COLS.filter((c) => /value|amount|total/.test(lbl(c)) && !/rate/.test(lbl(c)));
    if (pctCols.length >= 2 && valCols.length >= 2) {
      pctCol = pctCols[pctCols.length - 1];
      valCol = valCols[valCols.length - 1];
    } else {
      const anchor = Math.max(colIdx(appliedValCol), colIdx(appliedPctCol));
      if (anchor >= 0) {
        valCol = ALL_COLS.slice(anchor + 1).find((c) => {
          for (let i = headerIdx + 1; i < rows.length; i++) {
            const v = (rows[i] ?? {})[c];
            if (typeof v === "number" && v !== 0) return true;
          }
          return false;
        }) ?? null;
      }
    }
  }
  if (!valCol && !pctCol) return [];

  // The line's contract/total value sits immediately LEFT of the applied
  // "% complete" column (… Total Value | % complete | Value …). Capturing it
  // lets us match a certificate line back to the application line by value even
  // when the description has drifted (e.g. "Flat Roof" vs "Alumasc Felt Roof").
  const contractCol = colIdx(appliedPctCol) > 0 ? ALL_COLS[colIdx(appliedPctCol) - 1] : null;

  const out: Array<Omit<ExtractedLabourLine, "line_no">> = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] ?? {};
    const d = r[descCol];
    if (typeof d !== "string" || d.trim().length === 0) continue;
    const dl = d.trim().toLowerCase();
    if (/^costing$/.test(dl)) break;                    // internal cost block — never read past
    if (/^total$/.test(dl)) continue;                   // section/grand total rows (Blyth totals each section mid-sheet)
    if (/subtotal$/.test(dl)) continue;                 // section subtotal rows
    // Section rows carry rolled-up values (Prelims "1 Management" = the sum of
    // its items) — reading them as lines would certify the same money twice.
    if (refCol) {
      const ref = r[refCol];
      if (typeof ref === "number" && Number.isInteger(ref)) continue;
    }
    const valueRaw = valCol && typeof r[valCol] === "number" ? (r[valCol] as number) : null;
    const pctRaw = pctCol && typeof r[pctCol] === "number" ? (r[pctCol] as number) : null;
    if ((valueRaw == null || valueRaw === 0) && (pctRaw == null || pctRaw === 0)) continue;
    const contractRaw = contractCol && typeof r[contractCol] === "number" ? (r[contractCol] as number) : null;
    out.push({
      description: d.trim(),
      qty: typeof r["C"] === "number" ? (r["C"] as number) : null,
      unit: typeof r["D"] === "string" ? (r["D"] as string) : null,
      cumulative_value: valueRaw != null && valueRaw !== 0 ? valueRaw : null,
      // % stored as 0–1 decimal (1.00 = 100%) or 0–100; normalise to 0–100.
      cumulative_pct: pctRaw != null && pctRaw !== 0 ? (pctRaw <= 1 ? pctRaw * 100 : pctRaw) : null,
      this_period_value: null,
      contract_value: contractRaw,
      // Which tab of the client's workbook the row came from ("26003 Block D").
      // On a combined application the same item exists once per block at the
      // same value, so the matcher needs the block to certify the right line.
      section: sheetName ?? null,
    });
  }
  return out;
}

/** Parse a client-certificate XLSX — scan every sheet for certified columns.
 *  The dedicated "Variations" tab uses Applied/Certified column headers, so
 *  read it with the variation parser (certified mode) rather than the generic one. */
function extractCertificateFromXlsx(buf: ArrayBuffer): ExtractedLabourLine[] {
  const wb = XLSX.read(buf, { type: "array" });
  const out: ExtractedLabourLine[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const lines = /variation/i.test(name)
      ? extractVariationSheet(ws, "certified", "Variations")
      : (/material/i.test(name) && /site/i.test(name))
        ? extractVariationSheet(ws, "certified", "Materials on Site")
        : extractCertSheet(ws, name);
    for (const line of lines) out.push({ ...line, line_no: out.length + 1 });
  }
  return out;
}

/**
 * Parse the workbook's "Variations" tab — extra work beyond the BOQ. Its
 * header is: Item · Qty · Rate · Value · Applied % · Applied Value ·
 * Certified % · Certified Value. We read "Value" as the variation's contract
 * value, and the Applied or Certified columns depending on mode. Each row is
 * flagged is_variation so it's added as an ad-hoc line, not matched to the BOQ.
 */
function extractVariationSheet(ws: XLSX.WorkSheet, mode: "applied" | "certified", sectionLabel = "Variations"): Array<Omit<ExtractedLabourLine, "line_no">> {
  const rows = boundedSheetRows(ws);
  const wantPct = mode === "applied" ? /applied\s*%/ : /certif\w*\s*%/;
  const wantVal = mode === "applied" ? /applied\s*value/ : /certif\w*\s*value/;
  let headerIdx = -1, descCol: string | null = null, valueCol: string | null = null, pctCol: string | null = null, valCol: string | null = null;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const r = rows[i] ?? {};
    const label = (c: string) => (typeof r[c] === "string" ? String(r[c]).trim().toLowerCase() : "");
    const hasItem = ALL_COLS.some((c) => label(c) === "item" || label(c) === "description");
    const hasMetric = ALL_COLS.some((c) => wantPct.test(label(c)) || wantVal.test(label(c)));
    if (!(hasItem && hasMetric)) continue;
    headerIdx = i;
    for (const c of ALL_COLS) {
      const t = label(c);
      if (!t) continue;
      if (!descCol && (t === "item" || t === "description")) descCol = c;
      else if (!valueCol && t === "value") valueCol = c;
      else if (!pctCol && wantPct.test(t)) pctCol = c;
      else if (!valCol && wantVal.test(t)) valCol = c;
    }
    break;
  }
  if (headerIdx < 0 || !descCol) return [];

  const out: Array<Omit<ExtractedLabourLine, "line_no">> = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] ?? {};
    const d = r[descCol];
    if (typeof d !== "string" || d.trim().length === 0) continue;
    const dl = d.trim().toLowerCase();
    if (/^costing$/.test(dl)) break;
    if (/^total$/.test(dl)) continue;                   // section totals mid-sheet — keep reading
    if (/subtotal$/.test(dl)) continue;
    const contractRaw = valueCol && typeof r[valueCol] === "number" ? (r[valueCol] as number) : null;
    const pctRaw = pctCol && typeof r[pctCol] === "number" ? (r[pctCol] as number) : null;
    const valRaw = valCol && typeof r[valCol] === "number" ? (r[valCol] as number) : null;
    if ((pctRaw == null || pctRaw === 0) && (valRaw == null || valRaw === 0)) continue;  // not applied/certified
    out.push({
      description: d.trim(),
      qty: null,
      unit: null,
      cumulative_value: valRaw != null && valRaw !== 0 ? valRaw : null,
      cumulative_pct: pctRaw != null && pctRaw !== 0 ? (pctRaw <= 1 ? pctRaw * 100 : pctRaw) : null,
      this_period_value: null,
      contract_value: contractRaw,
      is_variation: true,
      section: sectionLabel,
    });
  }
  return out;
}

/** Token-Jaccard match against the project's contract_items (labour-bearing only). */
type MatchCandidate = { contract_item_id: number; total: number; score: number };

/**
 * Fuzzy-match extracted lines to contract items by description (token Jaccard).
 * `total` is the direction-appropriate BOQ value for the item (labour_total for
 * incoming labour, sell_total for outgoing). Items with total ≤ 0 are skipped.
 */
function matchLines(
  extracted: ExtractedLabourLine[],
  contractItems: Array<{ id: number; description: string; total: number | null }>,
  aliases?: Map<string, string>,
): Map<number, MatchCandidate | null> {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length >= 2);
  const out = new Map<number, MatchCandidate | null>();
  for (const line of extracted) {
    // A human mapped this exact wording before — that beats any heuristic.
    const learned = aliases?.get(normText(line.description));
    if (learned) {
      const hit = contractItems.find((ci) => normText(ci.description) === learned && (ci.total ?? 0) !== 0);
      if (hit) { out.set(line.line_no, { contract_item_id: hit.id, total: hit.total!, score: 1 }); continue; }
    }
    const lt = new Set(norm(line.description));
    if (lt.size === 0) { out.set(line.line_no, null); continue; }
    let best: MatchCandidate | null = null;
    for (const ci of contractItems) {
      // Zero-total rows are headings/blank seeds — never match those. NEGATIVE
      // totals are real deduction items (e.g. "Site Manager: Overlap Reduction"
      // at −£6,018): they must stay matchable or their credit silently
      // shadow-matches the nearest positive line and the deduction vanishes.
      if ((ci.total ?? 0) === 0) continue;
      const ct = new Set(norm(ci.description));
      if (ct.size === 0) continue;
      let overlap = 0;
      for (const t of lt) if (ct.has(t)) overlap++;
      const score = overlap === 0 ? 0 : overlap / (lt.size + ct.size - overlap);
      if (score > (best?.score ?? 0)) {
        best = { contract_item_id: ci.id, total: ci.total!, score };
      }
    }
    out.set(line.line_no, best && best.score >= 0.25 ? best : null);
  }
  return out;
}

/**
 * Reusable: parse, match, and persist a labour application from a file
 * buffer. Used by both the HTTP upload endpoint and the inbound-email
 * handler. Returns the new AfP id + summary counts. Throws with a clear
 * Error message on validation failure so callers can surface it.
 */
/**
 * Extract labour lines from an uploaded file (PDF via Claude, XLSX locally).
 * Project-independent — the result can be parked in inbound_applications and
 * matched against a project's BOQ later.
 */
export async function extractLabourLines(
  env: Env,
  file: { buffer: ArrayBuffer; name: string; type: string },
  collectMeta?: (m: LabourAppMeta) => void,
): Promise<ExtractedLabourLine[]> {
  const lower = file.name.toLowerCase();
  const isPdf = file.type === "application/pdf" || lower.endsWith(".pdf");
  const isXlsx = lower.endsWith(".xlsx") || lower.endsWith(".xls");
  const isWord = lower.endsWith(".docx") || /wordprocessingml/.test(file.type);
  if (isPdf) {
    if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured (needed to read PDFs)");
    return extractLabourAppViaClaude(env, { pdf: file.buffer }, { collectMeta });
  }
  if (isWord) {
    if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured (needed to read Word documents)");
    const text = docxToText(file.buffer);
    if (!text) throw new Error("couldn't read any text from that Word document");
    return extractLabourAppViaClaude(env, { text }, { collectMeta });
  }
  // Spreadsheets carry no reliable letterhead — no sender meta from this path.
  if (isXlsx) return extractLabourAppFromXlsx(file.buffer);
  throw new Error("unsupported file type — upload a PDF, Word (.docx) or XLSX");
}

/**
 * Extract the CERTIFIED figures from a client's returned payment certificate
 * (PDF via Claude in certificate mode, XLSX by reading the certified columns
 * to the right of the applied ones). Used by the clientcerts@ inbound flow.
 */
export async function extractCertificateLines(
  env: Env,
  file: { buffer: ArrayBuffer; name: string; type: string },
): Promise<ExtractedLabourLine[]> {
  const lower = file.name.toLowerCase();
  const isPdf = file.type === "application/pdf" || lower.endsWith(".pdf");
  const isXlsx = lower.endsWith(".xlsx") || lower.endsWith(".xls");
  const isWord = lower.endsWith(".docx") || /wordprocessingml/.test(file.type);
  if (isPdf) {
    if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured (needed to read PDFs)");
    const lines = await extractLabourAppViaClaude(env, { pdf: file.buffer }, { certificate: true });
    console.log(`[cert] "${file.name}" → ${lines.length} certified lines extracted (pdf)`);
    return lines;
  }
  if (isWord) {
    if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured (needed to read Word documents)");
    const text = docxToText(file.buffer);
    if (!text) throw new Error("couldn't read any text from that Word document");
    const lines = await extractLabourAppViaClaude(env, { text }, { certificate: true });
    console.log(`[cert] "${file.name}" → ${lines.length} certified lines extracted (docx)`);
    return lines;
  }
  if (isXlsx) {
    const lines = extractCertificateFromXlsx(file.buffer);
    console.log(`[cert] "${file.name}" → ${lines.length} certified lines extracted (xlsx)`);
    return lines;
  }
  throw new Error("unsupported file type — upload a PDF, Word (.docx) or XLSX");
}

/**
 * Given already-extracted lines, match them to a project's BOQ and create a
 * draft AfP with the matched % pre-populated. Works for both directions:
 *   incoming_labour → lines seeded from labour rates, counterparty = subbie
 *   outgoing        → lines seeded from sell rates, counterparty = client (null supplier)
 * Unmatched lines are persisted for review. Shared by the file-upload path and
 * the inbound-tray resolve path.
 */
export async function createAfpFromLines(env: Env, args: {
  projectId: string;
  direction: Direction;
  /** Only used for incoming_labour; null/ignored for outgoing (client is implicit). */
  counterpartySupplierId: number | null;
  periodEnd: string;
  notes: string | null;
  extracted: ExtractedLabourLine[];
  /** When true, the applied figures are THIS PERIOD (add to previously certified)
   *  rather than the cumulative-to-date total. */
  amountsArePeriod?: boolean;
  actor: string;
}): Promise<{
  id: number;
  app_number: number;
  extracted_count: number;
  matched_count: number;
  unmatched_count: number;
}> {
  const project = await env.DB.prepare(`SELECT id, ${PROJECT_TERMS_COLS} FROM projects WHERE id = ?`)
    .bind(args.projectId).first<{ id: string } & ProjectTerms>();
  if (!project) throw new Error("project not found");

  const snap = await env.DB.prepare(
    "SELECT id FROM material_snapshots WHERE project_id = ? AND is_active = 1",
  ).bind(args.projectId).first<{ id: number }>();
  if (!snap) throw new Error("upload a pricing workbook first");

  const extracted = args.extracted;
  // Variation rows (from the workbook's Variations tab) are extra work beyond
  // the BOQ — they're added as ad-hoc lines, not matched to contract items.
  const variationLines = extracted.filter((l) => l.is_variation);
  const normalLines = extracted.filter((l) => !l.is_variation);
  const isLabour = args.direction === "incoming_labour";
  const terms = termsFor(args.direction, project);

  // Load contract items. Pick the direction-appropriate rate/total.
  const rawItems = await env.DB.prepare(
    `SELECT id, item_no, category, section, description, qty, unit, sell_rate, sell_total, labour_rate, labour_total
     FROM contract_items WHERE snapshot_id = ? ORDER BY item_no`,
  ).bind(snap.id).all<{
    id: number; item_no: number; category: string | null; section: string | null;
    description: string; qty: number; unit: string | null;
    sell_rate: number; sell_total: number;
    labour_rate: number | null; labour_total: number | null;
  }>();
  const items = rawItems.results.map((it) => ({
    ...it,
    rate: isLabour ? (it.labour_rate ?? 0) : it.sell_rate,
    total: isLabour ? (it.labour_total ?? 0) : it.sell_total,
  }));
  const afpAliases = await aliasMap(env.DB, "afp_line", isLabour ? (await env.DB.prepare("SELECT name FROM suppliers WHERE id = ?").bind(args.counterpartySupplierId ?? 0).first<{ name: string }>())?.name : null);
  const matches = matchLines(normalLines, items.map((it) => ({ id: it.id, description: it.description, total: it.total })), afpAliases);

  // Create the draft AfP
  const nextN = await env.DB.prepare(
    `SELECT COALESCE(MAX(app_number), 0) + 1 AS n
     FROM applications_for_payment WHERE project_id = ? AND direction = ?`,
  ).bind(args.projectId, args.direction).first<{ n: number }>();
  const appNumber = nextN!.n;
  const now = new Date().toISOString();

  const inserted = await env.DB.prepare(
    `INSERT INTO applications_for_payment
       (project_id, direction, app_number, period_end, notes, retention_pct, vat_pct,
        counterparty_supplier_id, status, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?) RETURNING id`,
  ).bind(
    args.projectId, args.direction, appNumber, args.periodEnd, args.notes,
    terms.retention_pct, terms.vat_pct, isLabour ? (args.counterpartySupplierId ?? null) : null, now, args.actor,
  ).first<{ id: number }>();
  const afpId = inserted!.id;

  // Period mode: the applied figures are THIS PERIOD, so everything sits on top
  // of what's already been certified. Load previously-certified £ per contract
  // item BEFORE seeding — every line starts at its previous position (a line the
  // subbie didn't claim this period carries forward, not zero), claimed lines
  // then add their period value on top.
  const prevByItem = new Map<number, number>();
  if (args.amountsArePeriod) {
    const prev = await env.DB.prepare(
      `SELECT al.contract_item_id AS cid,
              COALESCE(SUM(COALESCE(al.certified_percent / 100.0 * al.contract_value, al.cumulative_value)), 0) AS prev
         FROM afp_lines al JOIN applications_for_payment a2 ON a2.id = al.afp_id
        WHERE a2.project_id = ? AND a2.direction = ?
          AND a2.status IN ('submitted','certified','paid') AND al.contract_item_id IS NOT NULL
        GROUP BY al.contract_item_id`,
    ).bind(args.projectId, args.direction).all<{ cid: number; prev: number | null }>();
    for (const r of prev.results) prevByItem.set(Number(r.cid), r.prev ?? 0);
  }

  // Seed afp_lines (one per contract item). For labour AfPs only seed
  // labour-bearing lines (Prelims/Ancil carry no labour), so a labour
  // application isn't cluttered with £0 prelims/ancil rows. Client AfPs get
  // every line across Prelims + Measured + Ancil.
  const seedItems = isLabour ? items.filter((it) => it.total > 0) : items;
  const itemById = new Map(items.map((it) => [it.id, it]));
  const seedStmts = seedItems.map((it, idx) => {
    const startCum = args.amountsArePeriod ? Math.round((prevByItem.get(it.id) ?? 0) * 100) / 100 : 0;
    const startPct = args.amountsArePeriod && it.total > 0 ? Math.max(0, Math.min(100, (startCum / it.total) * 100)) : 0;
    return env.DB.prepare(
      `INSERT INTO afp_lines
         (afp_id, contract_item_id, category, section, description, unit, qty, rate,
          contract_value, percent_complete, cumulative_value, is_adhoc, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).bind(
      afpId, it.id, it.category ?? "measured", it.section, it.description, it.unit, it.qty,
      it.rate, it.total, startPct, startCum, idx + 1,
    );
  });
  if (seedStmts.length > 0) await env.DB.batch(seedStmts);

  // Patch matched lines with the extracted % / value
  const unmatched: Array<Record<string, unknown>> = [];
  for (const line of normalLines) {
    const m = matches.get(line.line_no);
    if (!m) {
      unmatched.push({
        raw_line_no: line.line_no,
        description: line.description,
        qty: line.qty,
        unit: line.unit,
        cumulative_value: line.cumulative_value,
        cumulative_pct: line.cumulative_pct,
        this_period_value: line.this_period_value,
      });
      continue;
    }
    const ci = itemById.get(m.contract_item_id);
    if (!ci) continue;
    const itemTotal = ci.total;

    // The £ the line carries, from whichever column the parser filled.
    const lineVal = line.cumulative_value != null ? line.cumulative_value
      : line.this_period_value != null ? line.this_period_value
      : (line.cumulative_pct != null && itemTotal !== 0 ? line.cumulative_pct / 100 * itemTotal : null);
    if (lineVal == null) continue;

    // Cumulative mode: the line value IS the to-date total. Period mode: add it
    // on top of what's already been certified (capped at the line's contract).
    const cumVal = args.amountsArePeriod
      ? Math.min((prevByItem.get(m.contract_item_id) ?? 0) + lineVal, itemTotal || (prevByItem.get(m.contract_item_id) ?? 0) + lineVal)
      : lineVal;
    // itemTotal !== 0, not > 0: deduction lines (negative qty/rate, e.g. a
    // "week not needed" prelim credit) apply like any other — a negative value
    // over a negative total is a positive % and the credit flows through.
    const pct = itemTotal !== 0 ? Math.max(0, Math.min(100, (cumVal / itemTotal) * 100)) : 0;

    await env.DB.prepare(
      `UPDATE afp_lines SET percent_complete = ?, cumulative_value = ? WHERE afp_id = ? AND contract_item_id = ?`,
    ).bind(pct, cumVal, afpId, m.contract_item_id).run();
  }

  // Add variation / materials-on-site rows as ad-hoc lines (beyond the BOQ).
  // Each carries its own value as the contract value, with the applied % from
  // its tab, and keeps its section label ("Variations" / "Materials on Site").
  //
  // A client (outgoing) "Variations" line is also matched into the project's
  // Variations register (find-or-create by description) and the afp_line is
  // tagged with variation_id — so it shows on the Variations tab where material
  // and labour can be added. Materials-on-site and labour-app variation lines
  // stay as plain ad-hoc lines.
  let varOrder = seedItems.length;
  const linedVariationIds = new Set<number>();
  if (variationLines.length > 0) {
    for (const v of variationLines) {
      varOrder += 1;
      const contract = v.contract_value ?? v.cumulative_value ?? 0;
      let pct = v.cumulative_pct ?? (contract > 0 && v.cumulative_value != null ? (v.cumulative_value / contract) * 100 : 0);
      pct = Math.max(0, Math.min(100, pct ?? 0));
      const cum = contract * pct / 100;
      const section = v.section ?? "Variations";
      const isMos = /material/i.test(section) && /site/i.test(section);

      let variationId: number | null = null;
      if (!isMos && !isLabour) {
        const existing = await env.DB.prepare(
          "SELECT id FROM variations WHERE project_id = ? AND lower(trim(description)) = lower(trim(?)) LIMIT 1",
        ).bind(args.projectId, v.description).first<{ id: number }>();
        if (existing) {
          variationId = existing.id;
        } else {
          const nextNo = await env.DB.prepare(
            "SELECT COALESCE(MAX(variation_no), 0) + 1 AS n FROM variations WHERE project_id = ?",
          ).bind(args.projectId).first<{ n: number }>();
          const created = await env.DB.prepare(
            `INSERT INTO variations (project_id, variation_no, description, status, sell_value, notes, created_at, created_by)
             VALUES (?, ?, ?, 'open', ?, ?, ?, ?) RETURNING id`,
          ).bind(args.projectId, nextNo!.n, v.description, contract, `From application #${appNumber}`, now, args.actor)
            .first<{ id: number }>();
          variationId = created!.id;
        }
      }
      if (variationId != null) linedVariationIds.add(variationId);

      await env.DB.prepare(
        `INSERT INTO afp_lines
           (afp_id, section, description, unit, qty, rate, contract_value, percent_complete, cumulative_value, is_adhoc, display_order, variation_id)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(afpId, section, v.description, v.unit ?? null, contract, contract, pct, cum, varOrder, variationId).run();
    }
  }

  // Auto-seed the project's OPEN variations so they're expendable on this
  // application (claimable, tagged to the variation, starting at 0%):
  //   • client (outgoing) apps → one sell line per variation
  //   • labour apps           → one line per variation labour line
  // Skip a variation that already got a line above (from the workbook tab).
  {
    const openVars = await env.DB.prepare(
      "SELECT id, variation_no, description, sell_value, approved_at FROM variations WHERE project_id = ? AND status = 'open' ORDER BY variation_no",
    ).bind(args.projectId).all<{ id: number; variation_no: number; description: string; sell_value: number; approved_at: string | null }>();
    for (const ov of openVars.results) {
      if (isLabour) {
        // Labour claimed against a variation expends its budget — only seed
        // approved variations so unapproved budget can't be drawn down.
        if (!ov.approved_at) continue;
        const labs = await env.DB.prepare(
          "SELECT description, value FROM variation_labour WHERE variation_id = ?",
        ).bind(ov.id).all<{ description: string; value: number }>();
        for (const l of labs.results) {
          if ((l.value ?? 0) <= 0) continue;
          varOrder += 1;
          await env.DB.prepare(
            `INSERT INTO afp_lines
               (afp_id, section, description, unit, qty, rate, contract_value, percent_complete, cumulative_value, is_adhoc, display_order, variation_id)
             VALUES (?, 'Variations', ?, NULL, 1, ?, ?, 0, 0, 1, ?, ?)`,
          ).bind(afpId, `VO${ov.variation_no} — ${l.description}`, l.value, l.value, varOrder, ov.id).run();
        }
      } else if (!linedVariationIds.has(ov.id) && (ov.sell_value ?? 0) !== 0) {
        varOrder += 1;
        await env.DB.prepare(
          `INSERT INTO afp_lines
             (afp_id, section, description, unit, qty, rate, contract_value, percent_complete, cumulative_value, is_adhoc, display_order, variation_id)
           VALUES (?, 'Variations', ?, NULL, 1, ?, ?, 0, 0, 1, ?, ?)`,
        ).bind(afpId, `VO${ov.variation_no} — ${ov.description}`, ov.sell_value, ov.sell_value, varOrder, ov.id).run();
      }
    }
  }

  // Persist unmatched + recompute totals
  if (unmatched.length > 0) {
    await env.DB.prepare(
      "UPDATE applications_for_payment SET unmatched_lines_json = ? WHERE id = ?",
    ).bind(JSON.stringify(unmatched), afpId).run();
  }
  await recalcTotals(env.DB, afpId);

  // Received applications don't need director approval — if there's nothing to
  // reconcile (and, for labour, a subbie is known) it's "sent" immediately.
  // Otherwise it stays a draft until the unmatched lines / subbie are resolved.
  await autoSubmitIfReady(env.DB, afpId, args.actor);

  return {
    id: afpId,
    app_number: appNumber,
    extracted_count: extracted.length,
    matched_count: extracted.length - unmatched.length,
    unmatched_count: unmatched.length,
  };
}

/**
 * Apply a client's payment certificate to the newest outgoing application that
 * is still awaiting certification. The client returns our application (PDF or
 * XLSX) annotated with the figures they have certified; we match those figures
 * back onto the AfP's own lines, lock them in as `certified_percent`, recompute
 * the header totals (with `force`, since the AfP is leaving draft), and move it
 * submitted → certified. The certified figures are not editable afterwards.
 *
 * Matching strategy (per the agreed design): find the newest outgoing AfP for
 * the project whose status is 'submitted', then fuzzy-match the certificate's
 * lines to that AfP's lines by description. Lines the client did not annotate
 * are certified at the amount we applied for (certified_percent = applied %),
 * so nothing is silently dropped.
 *
 * Returns null if there is no submitted outgoing AfP to certify against.
 */
export async function applyClientCertificate(env: Env, args: {
  projectId: string;
  extracted: ExtractedLabourLine[];
  actor: string;
  // 'outgoing' = a client payment certificate (clientcerts@); 'incoming_labour'
  // = a subcontractor labour certificate (labourcerts@). Defaults to outgoing.
  direction?: Direction;
  // For labour certs, narrow to a specific subbie's application when known.
  counterpartySupplierId?: number | null;
}): Promise<{
  id: number;
  app_number: number;
  certified_amount: number;
  matched_count: number;
  unmatched_count: number;
  line_count: number;
} | null> {
  const direction = args.direction ?? "outgoing";
  const useCounterparty = direction === "incoming_labour" && args.counterpartySupplierId != null;
  // Newest application of this direction still awaiting certification (narrowed
  // to the subcontractor when we know which one a labour cert is for).
  const afp = await env.DB.prepare(
    `SELECT id, app_number, retention_pct, vat_pct
     FROM applications_for_payment
     WHERE project_id = ? AND direction = ? AND status = 'submitted'
       ${useCounterparty ? "AND counterparty_supplier_id = ?" : ""}
     ORDER BY app_number DESC LIMIT 1`,
  ).bind(...(useCounterparty
    ? [args.projectId, direction, args.counterpartySupplierId]
    : [args.projectId, direction])).first<{
    id: number; app_number: number; retention_pct: number; vat_pct: number;
  }>();
  if (!afp) return null;

  // The AfP's own lines are the certification target. Match the certificate
  // rows against these (not the raw contract items) so we honour exactly what
  // was applied for.
  const lineRows = await env.DB.prepare(
    `SELECT id, contract_item_id, description, section, contract_value, percent_complete
     FROM afp_lines WHERE afp_id = ? ORDER BY display_order`,
  ).bind(afp.id).all<{
    id: number; contract_item_id: number | null; description: string; section: string | null; contract_value: number; percent_complete: number;
  }>();
  const lines = lineRows.results;

  // Match each certificate line to an application line. Prefer matching by the
  // line's contract value (the cost workbook's "Total Value" equals our line's
  // contract_value and is far more stable than the description, which a client
  // may reword — e.g. "Flat Roof" vs "Alumasc Felt Roof…"). Fall back to a
  // description token match. Each application line can be claimed only once.
  type CertTarget = { id: number; description: string; contract_value: number; percent_complete: number };
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length >= 2);
  const jaccard = (a: string, b: string) => {
    const A = new Set(norm(a)), B = new Set(norm(b));
    if (A.size === 0 || B.size === 0) return 0;
    let o = 0; for (const t of A) if (B.has(t)) o++;
    return o / (A.size + B.size - o);
  };
  const valueClose = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.002);
  // A combined application repeats the same items block by block, often at the
  // same value AND wording (e.g. "Site Manager" £12,036 in two blocks). The
  // block is the only reliable discriminator, so when the certificate row and
  // the application lines both carry a project code ("26003 Block D" tab →
  // "26003 · Management" section), match only within that block.
  const blockOf = (s: string | null | undefined): string | null => {
    const m = /^\s*(\d{5})\b/.exec(s || ""); return m ? m[1] : null;
  };

  const claimed = new Set<number>();
  const certifiedLineIds = new Set<number>();
  let unmatchedCount = 0;
  for (const line of args.extracted) {
    const availAll = lines.filter((l) => !claimed.has(l.id));
    const certBlock = blockOf(line.section) ?? blockOf(line.description);
    const scoped = certBlock ? availAll.filter((l) => blockOf(l.section) === certBlock) : availAll;
    const avail = scoped.length > 0 ? scoped : availAll;
    let target: CertTarget | null = null;

    // 1) Match by contract value (unique, or disambiguated by description).
    if (line.contract_value != null && line.contract_value !== 0) {
      const byVal = avail.filter((l) => valueClose(line.contract_value!, l.contract_value));
      if (byVal.length === 1) target = byVal[0];
      else if (byVal.length > 1) {
        target = byVal.reduce((best, l) =>
          jaccard(line.description, l.description) > jaccard(line.description, best.description) ? l : best);
      }
    }
    // 2) Fall back to a description token match.
    if (!target) {
      let best: { l: CertTarget; s: number } | null = null;
      for (const l of avail) {
        const s = jaccard(line.description, l.description);
        if (s > (best?.s ?? 0)) best = { l, s };
      }
      if (best && best.s >= 0.25) target = best.l;
    }
    if (!target) { unmatchedCount++; continue; }

    const itemTotal = target.contract_value;
    let pct: number | null = null;
    if (line.cumulative_pct != null) {
      pct = line.cumulative_pct;
    } else if (line.cumulative_value != null && itemTotal > 0) {
      pct = (line.cumulative_value / itemTotal) * 100;
    } else if (line.this_period_value != null && itemTotal > 0) {
      pct = (line.this_period_value / itemTotal) * 100;
    }
    if (pct == null) { unmatchedCount++; continue; }
    pct = Math.max(0, Math.min(100, pct));
    await env.DB.prepare(
      `UPDATE afp_lines
       SET certified_percent = ?, cumulative_value = contract_value * ? / 100
       WHERE id = ?`,
    ).bind(pct, pct, target.id).run();
    claimed.add(target.id);
    certifiedLineIds.add(target.id);
  }

  // A line the certificate doesn't list is treated as NOT certified: its
  // certified value is zeroed, so it drops out of the cumulative. The client's
  // certificate is therefore the complete cumulative certified position — any
  // line they don't include is reduced to £0 and deducted from the total.
  const untouched = lines.filter((l) => !certifiedLineIds.has(l.id));
  if (untouched.length > 0) {
    await env.DB.batch(
      untouched.map((l) =>
        env.DB.prepare(
          "UPDATE afp_lines SET certified_percent = 0, cumulative_value = 0 WHERE id = ?",
        ).bind(l.id),
      ),
    );
  }

  // Recompute header totals from the now-certified line cumulatives, then lock.
  await recalcTotals(env.DB, afp.id, { force: true });
  const refreshed = await env.DB.prepare(
    "SELECT amount_due FROM applications_for_payment WHERE id = ?",
  ).bind(afp.id).first<{ amount_due: number | null }>();
  const certifiedAmount = refreshed?.amount_due ?? 0;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE applications_for_payment
     SET status = 'certified', certified_at = ?, certified_by = ?, certified_amount = ?
     WHERE id = ?`,
  ).bind(now, args.actor, certifiedAmount, afp.id).run();

  return {
    id: afp.id,
    app_number: afp.app_number,
    certified_amount: certifiedAmount,
    matched_count: certifiedLineIds.size,
    unmatched_count: unmatchedCount,
    line_count: lines.length,
  };
}

/** Extract then create — the file-upload entry point (project-page labour upload). */
/** Store a labour/subcontract application's source file in R2 so it can later be
 *  attached to the Xero bill. Returns the R2 key + metadata; no DB write. Used by
 *  the direct upload and both inbound-email paths so every route keeps the file. */
/** SHA-256 of a document, hex — the duplicate-detection fingerprint for
 *  inbound application files (a re-forwarded PDF hashes identically no matter
 *  the email around it). */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function putLabourSourceFile(
  env: Env, file: { buffer: ArrayBuffer; name: string; type: string },
): Promise<{ key: string; name: string | null; type: string | null; hash: string | null }> {
  const safe = (file.name || "application").replace(/[^\w.\-]+/g, "_");
  const key = `labour-apps/${crypto.randomUUID()}-${safe}`;
  await env.R2.put(key, file.buffer, { httpMetadata: { contentType: file.type || "application/octet-stream" } });
  const hash = await sha256Hex(file.buffer).catch(() => null);
  return { key, name: file.name || null, type: file.type || null, hash };
}

/** Point an AfP at a stored source file so it attaches on the Xero push. */
export async function setAfpSourceFile(
  env: Env, afpId: number, sf: { key: string; name: string | null; type: string | null; hash?: string | null },
): Promise<void> {
  await env.DB.prepare(
    "UPDATE applications_for_payment SET source_file_key = ?, source_file_name = ?, source_file_type = ?, source_file_hash = COALESCE(?, source_file_hash) WHERE id = ?",
  ).bind(sf.key, sf.name, sf.type, sf.hash ?? null, afpId).run();
}

/** Does this exact document already exist — as an application or parked in the
 *  inbound tray? Lets the email ingest skip re-forwards instead of minting a
 *  shadow draft next to the application that was already processed. */
export async function findDuplicateSourceDoc(env: Env, hash: string): Promise<
  | { where: "afp"; id: number; app_number: number; status: string; project_code: string | null; value: number }
  | { where: "inbound"; id: number }
  | null
> {
  const afp = await env.DB.prepare(
    `SELECT a.id, a.app_number, a.status, p.code AS project_code,
            COALESCE(a.certified_amount, a.amount_due, 0) AS value
       FROM applications_for_payment a LEFT JOIN projects p ON p.id = a.project_id
      WHERE a.source_file_hash = ? ORDER BY a.id LIMIT 1`,
  ).bind(hash).first<{ id: number; app_number: number; status: string; project_code: string | null; value: number }>();
  if (afp) return { where: "afp", ...afp };
  const inb = await env.DB.prepare(
    "SELECT id FROM inbound_applications WHERE source_file_hash = ? AND status = 'pending' ORDER BY id LIMIT 1",
  ).bind(hash).first<{ id: number }>();
  return inb ? { where: "inbound", id: inb.id } : null;
}

/** One-off/rerunnable: hash the source files already sitting in R2 onto their
 *  AfP / inbound rows, so duplicate detection also catches re-forwards of
 *  documents that predate the hash column. Safe to run repeatedly. */
applications.post("/backfill-source-hashes", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  let hashed = 0, missing = 0;
  for (const table of ["applications_for_payment", "inbound_applications"] as const) {
    const rows = (await c.env.DB.prepare(
      `SELECT id, source_file_key FROM ${table} WHERE source_file_key IS NOT NULL AND source_file_hash IS NULL`,
    ).all<{ id: number; source_file_key: string }>()).results;
    for (const r of rows) {
      const obj = await c.env.R2.get(r.source_file_key).catch(() => null);
      if (!obj) { missing++; continue; }
      const hash = await sha256Hex(await obj.arrayBuffer());
      await c.env.DB.prepare(`UPDATE ${table} SET source_file_hash = ? WHERE id = ?`).bind(hash, r.id).run();
      hashed++;
    }
  }
  return c.json({ ok: true, hashed, files_missing: missing });
});

/** Store a returned payment certificate in R2 and point the AfP at it, so the
 *  document that locked the certified figures stays openable from the AfP. */
export async function setAfpCertFile(
  env: Env, afpId: number, file: { buffer: ArrayBuffer; name: string; type: string },
): Promise<void> {
  const safe = (file.name || "certificate").replace(/[^\w.\-]+/g, "_");
  const key = `certs/${crypto.randomUUID()}-${safe}`;
  await env.R2.put(key, file.buffer, { httpMetadata: { contentType: file.type || "application/octet-stream" } });
  await env.DB.prepare(
    "UPDATE applications_for_payment SET cert_file_key = ?, cert_file_name = ?, cert_file_type = ? WHERE id = ?",
  ).bind(key, file.name || null, file.type || null, afpId).run();
}

export async function processLabourAppUpload(env: Env, args: {
  projectId: string;
  counterpartySupplierId: number | null;
  periodEnd: string;
  notes: string | null;
  file: { buffer: ArrayBuffer; name: string; type: string };
  amountsArePeriod?: boolean;
  actor: string;
}) {
  let meta: LabourAppMeta | null = null;
  const extracted = await extractLabourLines(env, args.file, (m) => { meta = m; });
  const created = await createAfpFromLines(env, {
    projectId: args.projectId,
    direction: "incoming_labour",
    counterpartySupplierId: args.counterpartySupplierId,
    periodEnd: args.periodEnd,
    notes: args.notes,
    extracted,
    amountsArePeriod: args.amountsArePeriod,
    actor: args.actor,
  });
  // Keep the uploaded application file in R2 so it can ride along to the Xero
  // bill when the certificate is later approved for payment. Best-effort — a
  // storage hiccup must not lose the parsed application.
  try {
    await setAfpSourceFile(env, created.id, await putLabourSourceFile(env, args.file));
  } catch (e) {
    console.warn(`Couldn't store labour app file for AfP ${created.id}:`, e instanceof Error ? e.message : e);
  }
  const metaJson = labourMetaJson(meta);
  if (metaJson) await env.DB.prepare("UPDATE applications_for_payment SET extracted_meta_json = ? WHERE id = ?").bind(metaJson, created.id).run().catch(() => {});
  return created;
}

/**
 * POST /api/applications/project/:projectId/upload-labour
 * Upload a subcontractor's labour AfP (PDF or XLSX), extract lines, match
 * to contract items, and create a draft incoming_labour AfP with the
 * matched lines pre-populated. Unmatched lines are persisted for review.
 */
/**
 * POST /api/applications/upload-combined-labour
 * Upload ONE combined labour workbook (a tab per block, named by project code)
 * and fan it out into one draft incoming_labour AfP per block. Not project-
 * scoped — the tabs decide which projects get an application. The workbook is
 * attached to each AfP so it rides to the Xero bill.
 */
applications.post("/upload-combined-labour", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const form = await c.req.formData();
  const file = form.get("file");
  const supplierId = form.get("counterparty_supplier_id");
  const periodEnd = form.get("period_end");
  const notes = form.get("notes");

  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  if (!periodEnd) return c.json({ error: "period_end required" }, 400);
  const lower = file.name.toLowerCase();
  if (!(lower.endsWith(".xlsx") || lower.endsWith(".xls"))) {
    return c.json({ error: "A combined application must be an .xlsx workbook with one tab per block (named by project code)." }, 400);
  }

  const buf = await file.arrayBuffer();
  let byProject: Array<{ code: string; lines: ExtractedLabourLine[] }>;
  try { byProject = extractCombinedLabourByProject(buf); }
  catch (e) { return c.json({ error: e instanceof Error ? e.message : "couldn't read the workbook" }, 400); }
  if (byProject.length === 0) {
    return c.json({ error: "No project tabs found — name each block's tab with its project code, e.g. \"26001 Block B\"." }, 400);
  }

  // Resolve the tab codes to live projects.
  const codes = byProject.map((b) => b.code);
  const projs = (await c.env.DB.prepare(
    `SELECT id, code FROM projects WHERE deleted_at IS NULL AND code IN (${codes.map(() => "?").join(",")})`,
  ).bind(...codes).all<{ id: string; code: string }>()).results;
  const idByCode = new Map(projs.map((p) => [p.code, p.id]));

  // Preview the split (which blocks, how many claimed lines each) without
  // creating anything — used to sanity-check a workbook before committing.
  if (form.get("dry_run")) {
    return c.json({
      dry_run: true,
      blocks: byProject.map((b) => ({
        code: b.code, project_id: idByCode.get(b.code) ?? null, line_count: b.lines.length,
        sample: b.lines.slice(0, 4).map((l) => ({ description: l.description, pct: l.cumulative_pct, value: l.cumulative_value })),
      })),
    });
  }

  // Keep the workbook once so it can attach to each block's Xero bill.
  const sf = await putLabourSourceFile(c.env, { buffer: buf, name: file.name, type: file.type }).catch(() => null);

  const created: Array<{ code: string; project_id: string; afp_id: number; app_number: number; extracted: number; matched: number; unmatched: number }> = [];
  const skipped: Array<{ code: string; reason: string }> = [];
  for (const b of byProject) {
    const projectId = idByCode.get(b.code);
    if (!projectId) { skipped.push({ code: b.code, reason: "no live project with that code" }); continue; }
    try {
      const r = await createAfpFromLines(c.env, {
        projectId, direction: "incoming_labour",
        counterpartySupplierId: supplierId ? Number(supplierId) : null,
        periodEnd: periodEnd.toString(),
        notes: notes?.toString() || `Combined application — ${file.name}`,
        extracted: b.lines, amountsArePeriod: !!form.get("period_mode"), actor: c.get("userEmail"),
      });
      if (sf) await setAfpSourceFile(c.env, r.id, sf).catch(() => {});
      created.push({ code: b.code, project_id: projectId, afp_id: r.id, app_number: r.app_number, extracted: r.extracted_count, matched: r.matched_count, unmatched: r.unmatched_count });
    } catch (e) {
      skipped.push({ code: b.code, reason: e instanceof Error ? e.message : "failed" });
    }
  }
  return c.json({ created, skipped });
});

/**
 * One combined CLIENT application across a site group (we apply to OUR client
 * for every block in one document). The whole group's contract basis — every
 * member project's active snapshot — seeds a single outgoing AfP on the
 * group's base project, sections prefixed by block code ("26003 · Roof"), and
 * each block tab's extracted lines are matched against that block's own items
 * so a combined workbook lands block-exact values.
 */
export async function createCombinedClientAfpFromLines(env: Env, args: {
  baseProjectId: string;
  periodEnd: string;
  notes: string | null;
  /** Extracted lines per block code (extractCombinedLabourByProject output). */
  perBlock: Array<{ code: string; extracted: ExtractedLabourLine[] }>;
  actor: string;
}): Promise<{ id: number; app_number: number; extracted_count: number; matched_count: number; unmatched_count: number }> {
  const base = await env.DB.prepare(
    `SELECT id, site_group_id, ${PROJECT_TERMS_COLS} FROM projects WHERE id = ?`,
  ).bind(args.baseProjectId).first<{ id: string; site_group_id: string | null } & ProjectTerms>();
  if (!base) throw new Error("base project not found");
  if (!base.site_group_id) throw new Error("project is not in a site group — use a normal application");
  const terms = termsFor("outgoing", base);

  // The contract basis is the WHOLE group: every member with an active snapshot,
  // in code order, whether or not its tab carried values this period.
  const members = (await env.DB.prepare(
    `SELECT p.id, p.code, s.id AS snapshot_id
       FROM projects p JOIN material_snapshots s ON s.project_id = p.id AND s.is_active = 1
      WHERE p.site_group_id = ? AND p.deleted_at IS NULL
      ORDER BY p.code`,
  ).bind(base.site_group_id).all<{ id: string; code: string; snapshot_id: number }>()).results;
  if (members.length === 0) throw new Error("no group projects with a pricing workbook");
  const extractedByCode = new Map(args.perBlock.map((b) => [b.code, b.extracted]));

  const nextN = await env.DB.prepare(
    `SELECT COALESCE(MAX(app_number), 0) + 1 AS n
     FROM applications_for_payment WHERE project_id = ? AND direction = 'outgoing'`,
  ).bind(base.id).first<{ n: number }>();
  const appNumber = nextN!.n;
  const now = new Date().toISOString();
  const inserted = await env.DB.prepare(
    `INSERT INTO applications_for_payment
       (project_id, direction, app_number, period_end, notes, retention_pct, vat_pct,
        counterparty_supplier_id, status, created_at, created_by)
     VALUES (?, 'outgoing', ?, ?, ?, ?, ?, NULL, 'draft', ?, ?) RETURNING id`,
  ).bind(base.id, appNumber, args.periodEnd, args.notes, terms.retention_pct, terms.vat_pct, now, args.actor)
    .first<{ id: number }>();
  const afpId = inserted!.id;

  const combinedAliases = await aliasMap(env.DB, "afp_line", null);
  let order = 0;
  let extractedCount = 0;
  let matchedCount = 0;
  let rawNo = 0; // unmatched raw_line_no must be unique across blocks
  const unmatched: Array<Record<string, unknown>> = [];

  for (const m of members) {
    const items = (await env.DB.prepare(
      `SELECT id, item_no, category, section, description, qty, unit, sell_rate, sell_total
         FROM contract_items WHERE snapshot_id = ? ORDER BY item_no`,
    ).bind(m.snapshot_id).all<{
      id: number; item_no: number; category: string | null; section: string | null;
      description: string; qty: number; unit: string | null; sell_rate: number; sell_total: number;
    }>()).results;

    // Seed this block's lines, section-prefixed so the picker/PDF read per block.
    const seedStmts = items.map((it) => {
      order += 1;
      const section = `${m.code} · ${it.section ?? it.category ?? ""}`.replace(/ · $/, "");
      return env.DB.prepare(
        `INSERT INTO afp_lines
           (afp_id, contract_item_id, category, section, description, unit, qty, rate,
            contract_value, percent_complete, cumulative_value, is_adhoc, display_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`,
      ).bind(afpId, it.id, it.category ?? "measured", section, it.description, it.unit, it.qty, it.sell_rate, it.sell_total, order);
    });
    if (seedStmts.length > 0) await env.DB.batch(seedStmts);

    const extracted = extractedByCode.get(m.code) ?? [];
    const normalLines = extracted.filter((l) => !l.is_variation);
    const variationLines = extracted.filter((l) => l.is_variation);
    extractedCount += extracted.length;
    const itemById = new Map(items.map((it) => [it.id, it]));
    const matches = matchLines(normalLines, items.map((it) => ({ id: it.id, description: it.description, total: it.sell_total })), combinedAliases);

    for (const line of normalLines) {
      const match = matches.get(line.line_no);
      if (!match) {
        rawNo += 1;
        unmatched.push({
          raw_line_no: rawNo,
          description: `${m.code} · ${line.description}`,
          qty: line.qty, unit: line.unit,
          cumulative_value: line.cumulative_value,
          cumulative_pct: line.cumulative_pct,
          this_period_value: line.this_period_value,
        });
        continue;
      }
      const ci = itemById.get(match.contract_item_id);
      if (!ci) continue;
      const itemTotal = ci.sell_total;
      const lineVal = line.cumulative_value != null ? line.cumulative_value
        : line.this_period_value != null ? line.this_period_value
        : (line.cumulative_pct != null && itemTotal !== 0 ? line.cumulative_pct / 100 * itemTotal : null);
      if (lineVal == null) continue;
      // Deduction lines (negative totals) apply like any other — see the
      // matching comment on the single-project path above.
      const pct = itemTotal !== 0 ? Math.max(0, Math.min(100, (lineVal / itemTotal) * 100)) : 0;
      matchedCount += 1;
      await env.DB.prepare(
        `UPDATE afp_lines SET percent_complete = ?, cumulative_value = ? WHERE afp_id = ? AND contract_item_id = ?`,
      ).bind(pct, lineVal, afpId, match.contract_item_id).run();
    }

    // Workbook variation rows for this block → ad-hoc lines + the block
    // project's variations register (same behaviour as a single-project app).
    for (const v of variationLines) {
      order += 1;
      const contract = v.contract_value ?? v.cumulative_value ?? 0;
      let pct = v.cumulative_pct ?? (contract > 0 && v.cumulative_value != null ? (v.cumulative_value / contract) * 100 : 0);
      pct = Math.max(0, Math.min(100, pct ?? 0));
      const cum = contract * pct / 100;
      const rawSection = v.section ?? "Variations";
      const isMos = /material/i.test(rawSection) && /site/i.test(rawSection);
      let variationId: number | null = null;
      if (!isMos) {
        const existing = await env.DB.prepare(
          "SELECT id FROM variations WHERE project_id = ? AND lower(trim(description)) = lower(trim(?)) LIMIT 1",
        ).bind(m.id, v.description).first<{ id: number }>();
        if (existing) variationId = existing.id;
        else {
          const nextNo = await env.DB.prepare(
            "SELECT COALESCE(MAX(variation_no), 0) + 1 AS n FROM variations WHERE project_id = ?",
          ).bind(m.id).first<{ n: number }>();
          const createdVar = await env.DB.prepare(
            `INSERT INTO variations (project_id, variation_no, description, status, sell_value, notes, created_at, created_by)
             VALUES (?, ?, ?, 'open', ?, ?, ?, ?) RETURNING id`,
          ).bind(m.id, nextNo!.n, v.description, contract, `From combined application #${appNumber}`, now, args.actor)
            .first<{ id: number }>();
          variationId = createdVar!.id;
        }
      }
      await env.DB.prepare(
        `INSERT INTO afp_lines
           (afp_id, section, description, unit, qty, rate, contract_value, percent_complete, cumulative_value, is_adhoc, display_order, variation_id)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(afpId, `${m.code} · ${rawSection}`, v.description, v.unit ?? null, contract, contract, pct, cum, order, variationId).run();
    }

    // Open variations on this block become claimable lines (0% to start),
    // unless the workbook tab already landed a line for them above.
    const openVars = await env.DB.prepare(
      "SELECT id, variation_no, description, sell_value FROM variations WHERE project_id = ? AND status = 'open' ORDER BY variation_no",
    ).bind(m.id).all<{ id: number; variation_no: number; description: string; sell_value: number }>();
    for (const ov of openVars.results) {
      if ((ov.sell_value ?? 0) === 0) continue;
      const already = await env.DB.prepare(
        "SELECT 1 AS x FROM afp_lines WHERE afp_id = ? AND variation_id = ? LIMIT 1",
      ).bind(afpId, ov.id).first<{ x: number }>();
      if (already) continue;
      order += 1;
      await env.DB.prepare(
        `INSERT INTO afp_lines
           (afp_id, section, description, unit, qty, rate, contract_value, percent_complete, cumulative_value, is_adhoc, display_order, variation_id)
         VALUES (?, ?, ?, NULL, 1, ?, ?, 0, 0, 1, ?, ?)`,
      ).bind(afpId, `${m.code} · Variations`, `VO${ov.variation_no} — ${ov.description}`, ov.sell_value, ov.sell_value, order, ov.id).run();
    }
  }

  if (unmatched.length > 0) {
    await env.DB.prepare(
      "UPDATE applications_for_payment SET unmatched_lines_json = ? WHERE id = ?",
    ).bind(JSON.stringify(unmatched), afpId).run();
  }
  await recalcTotals(env.DB, afpId);
  return { id: afpId, app_number: appNumber, extracted_count: extractedCount, matched_count: matchedCount, unmatched_count: unmatched.length };
}

/** Resolve a combined workbook's tab codes to ONE site group's base project. */
export async function resolveCombinedGroupBase(env: Env, codes: string[]): Promise<string> {
  const projs = (await env.DB.prepare(
    `SELECT p.id, p.code, p.site_group_id, g.base_project_id
       FROM projects p LEFT JOIN site_groups g ON g.id = p.site_group_id
      WHERE p.deleted_at IS NULL AND p.code IN (${codes.map(() => "?").join(",")})`,
  ).bind(...codes).all<{ id: string; code: string; site_group_id: string | null; base_project_id: string | null }>()).results;
  const groups = new Set(projs.map((p) => p.site_group_id).filter(Boolean));
  if (projs.length === 0 || groups.size !== 1) {
    throw new Error("The workbook's tabs must all be blocks of one grouped site (set the group up under Admin → Sites).");
  }
  return projs[0].base_project_id ?? projs[0].id;
}

/**
 * POST /api/applications/:id/rebuild-combined
 * Rebuild an outgoing application that arrived as ONE combined workbook (e.g.
 * forwarded via clientapps@ and landed on a single block) as a proper combined
 * AfP: re-extract its stored source file from R2 and build a fresh draft on
 * the group's base project carrying every block's BOQ. The original AfP is
 * left untouched so the two can be compared before one is deleted.
 */
/**
 * POST /api/applications/:id/reread-source
 * Re-read this application's stored source file with the CURRENT parser and
 * re-apply the claimed figures in place. Exists because a parser fix only
 * changes new uploads: an application parsed by an older reader keeps its
 * stored (possibly £0) figures for ever otherwise. Line values are recomputed
 * from scratch — every line resets, then whatever the file claims is applied —
 * so re-reading twice gives the same answer. Uncertified applications only:
 * certified figures are agreed money and never move under anyone.
 */
applications.post("/:id/reread-source", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const afp = await c.env.DB.prepare(
    `SELECT id, project_id, direction, status, counterparty_supplier_id,
            source_file_key, source_file_name, source_file_type
       FROM applications_for_payment WHERE id = ?`,
  ).bind(id).first<{
    id: number; project_id: string; direction: Direction; status: Status;
    counterparty_supplier_id: number | null;
    source_file_key: string | null; source_file_name: string | null; source_file_type: string | null;
  }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.status === "certified" || afp.status === "paid") {
    return c.json({ error: "This application is certified — its figures can't be re-read." }, 409);
  }
  if (!afp.source_file_key) return c.json({ error: "No stored source file on this application." }, 400);
  const obj = await c.env.R2.get(afp.source_file_key);
  if (!obj) return c.json({ error: "The stored source file is missing from storage." }, 404);

  const extracted = await extractLabourLines(c.env, {
    buffer: await obj.arrayBuffer(),
    name: afp.source_file_name ?? "application.xlsx",
    type: afp.source_file_type ?? "",
  });
  const normalLines = extracted.filter((l) => !l.is_variation);
  if (normalLines.length === 0) {
    return c.json({ error: "The current reader still finds no claimed lines in that file." }, 422);
  }

  const isLabour = afp.direction === "incoming_labour";
  const snap = await c.env.DB.prepare(
    "SELECT id FROM material_snapshots WHERE project_id = ? AND is_active = 1",
  ).bind(afp.project_id).first<{ id: number }>();
  if (!snap) return c.json({ error: "That project has no active pricing workbook." }, 400);
  const rawItems = await c.env.DB.prepare(
    `SELECT id, description, sell_total, labour_total FROM contract_items WHERE snapshot_id = ?`,
  ).bind(snap.id).all<{ id: number; description: string; sell_total: number; labour_total: number | null }>();
  const items = rawItems.results.map((it) => ({
    id: it.id, description: it.description,
    total: isLabour ? (it.labour_total ?? 0) : it.sell_total,
  }));
  const supplierName = isLabour && afp.counterparty_supplier_id
    ? (await c.env.DB.prepare("SELECT name FROM suppliers WHERE id = ?").bind(afp.counterparty_supplier_id).first<{ name: string }>())?.name ?? null
    : null;
  const matches = matchLines(normalLines, items, await aliasMap(c.env.DB, "afp_line", supplierName));

  // Reset every line before re-applying, so a re-read is idempotent rather
  // than stacking on top of the previous read.
  await c.env.DB.prepare("UPDATE afp_lines SET percent_complete = 0, cumulative_value = 0 WHERE afp_id = ?").bind(id).run();
  const itemById = new Map(items.map((it) => [it.id, it]));
  let matched = 0;
  const unmatched: Array<Record<string, unknown>> = [];
  for (const line of normalLines) {
    const m = matches.get(line.line_no);
    const it = m ? itemById.get(m.contract_item_id) : null;
    const lineVal = line.cumulative_value != null ? line.cumulative_value
      : line.this_period_value != null ? line.this_period_value
      : (line.cumulative_pct != null && it && it.total !== 0 ? line.cumulative_pct / 100 * it.total : null);
    if (!m || !it || lineVal == null) {
      unmatched.push({
        raw_line_no: unmatched.length + 1, description: line.description,
        qty: line.qty, unit: line.unit,
        cumulative_value: line.cumulative_value, cumulative_pct: line.cumulative_pct,
        this_period_value: line.this_period_value,
      });
      continue;
    }
    const pct = it.total !== 0 ? Math.max(0, Math.min(100, (lineVal / it.total) * 100)) : 0;
    await c.env.DB.prepare(
      "UPDATE afp_lines SET percent_complete = ?, cumulative_value = ? WHERE afp_id = ? AND contract_item_id = ?",
    ).bind(pct, lineVal, id, m.contract_item_id).run();
    matched++;
  }
  await c.env.DB.prepare("UPDATE applications_for_payment SET unmatched_lines_json = ? WHERE id = ?")
    .bind(unmatched.length ? JSON.stringify(unmatched) : null, id).run();
  await recalcTotals(c.env.DB, id, { force: true });
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('afp', ?, 'source_reread', ?, ?, ?)`,
  ).bind(String(id), c.get("userEmail"), JSON.stringify({ extracted: normalLines.length, matched, unmatched: unmatched.length }), new Date().toISOString()).run();

  const after = await c.env.DB.prepare(
    "SELECT cumulative_value, amount_due FROM applications_for_payment WHERE id = ?",
  ).bind(id).first<{ cumulative_value: number; amount_due: number }>();
  return c.json({ ok: true, extracted: normalLines.length, matched, unmatched: unmatched.length, cumulative_value: after?.cumulative_value ?? 0, amount_due: after?.amount_due ?? 0 });
});

applications.post("/:id/rebuild-combined", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const afp = await c.env.DB.prepare(
    `SELECT id, project_id, direction, app_number, period_end, notes,
            source_file_key, source_file_name, source_file_type
       FROM applications_for_payment WHERE id = ?`,
  ).bind(id).first<{
    id: number; project_id: string; direction: Direction; app_number: number;
    period_end: string; notes: string | null;
    source_file_key: string | null; source_file_name: string | null; source_file_type: string | null;
  }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.direction !== "outgoing") return c.json({ error: "only client (outgoing) applications can be rebuilt combined" }, 400);
  if (!afp.source_file_key) return c.json({ error: "no stored source file on this application" }, 400);
  const obj = await c.env.R2.get(afp.source_file_key);
  if (!obj) return c.json({ error: "stored source file is missing from storage" }, 404);
  const buf = await obj.arrayBuffer();

  let byProject: Array<{ code: string; lines: ExtractedLabourLine[] }>;
  try { byProject = extractCombinedLabourByProject(buf); }
  catch (e) { return c.json({ error: e instanceof Error ? e.message : "couldn't read the workbook" }, 400); }
  if (byProject.length === 0) {
    return c.json({ error: "No project tabs found — the stored file isn't a combined workbook (one tab per block, named by project code)." }, 400);
  }

  try {
    const baseProjectId = await resolveCombinedGroupBase(c.env, byProject.map((b) => b.code));
    const r = await createCombinedClientAfpFromLines(c.env, {
      baseProjectId,
      periodEnd: afp.period_end,
      notes: `Combined rebuild of application #${afp.app_number} — ${afp.source_file_name ?? "source workbook"}.`,
      perBlock: byProject.map((b) => ({ code: b.code, extracted: b.lines })),
      actor: c.get("userEmail"),
    });
    // Same stored workbook backs both applications until one of them is deleted.
    await setAfpSourceFile(c.env, r.id, { key: afp.source_file_key, name: afp.source_file_name, type: afp.source_file_type }).catch(() => {});
    return c.json(r);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    return c.json({ error: msg }, /not found|site group|pricing workbook|grouped site/.test(msg) ? 400 : 500);
  }
});

/**
 * POST /api/applications/upload-combined-client
 * Upload OUR combined application to the client (one workbook, a tab per
 * block named by project code, shared Fall Arrest/Variations tabs with
 * code-prefixed rows). Creates ONE outgoing AfP on the group's base project
 * carrying every block's BOQ. The workbook is attached for the Xero invoice.
 */
applications.post("/upload-combined-client", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const form = await c.req.formData();
  const file = form.get("file");
  const periodEnd = form.get("period_end");
  const notes = form.get("notes");
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  if (!periodEnd) return c.json({ error: "period_end required" }, 400);
  const lower = file.name.toLowerCase();
  if (!(lower.endsWith(".xlsx") || lower.endsWith(".xls"))) {
    return c.json({ error: "A combined application must be an .xlsx workbook with one tab per block (named by project code)." }, 400);
  }

  const buf = await file.arrayBuffer();
  let byProject: Array<{ code: string; lines: ExtractedLabourLine[] }>;
  try { byProject = extractCombinedLabourByProject(buf); }
  catch (e) { return c.json({ error: e instanceof Error ? e.message : "couldn't read the workbook" }, 400); }
  if (byProject.length === 0) {
    return c.json({ error: "No project tabs found — name each block's tab with its project code, e.g. \"26001 Block B\"." }, 400);
  }

  try {
    // The tab codes must all belong to ONE site group; the AfP lives on its base.
    const baseProjectId = await resolveCombinedGroupBase(c.env, byProject.map((b) => b.code));
    const r = await createCombinedClientAfpFromLines(c.env, {
      baseProjectId,
      periodEnd: periodEnd.toString(),
      notes: notes?.toString() || `Combined client application — ${file.name}`,
      perBlock: byProject.map((b) => ({ code: b.code, extracted: b.lines })),
      actor: c.get("userEmail"),
    });
    await setAfpSourceFile(c.env, r.id, await putLabourSourceFile(c.env, { buffer: buf, name: file.name, type: file.type })).catch(() => {});
    return c.json(r);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    return c.json({ error: msg }, /not found|site group|pricing workbook/.test(msg) ? 400 : 500);
  }
});

applications.post("/project/:projectId/upload-labour", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const form = await c.req.formData();
  const file = form.get("file");
  const supplierId = form.get("counterparty_supplier_id");
  const periodEnd = form.get("period_end");
  const notes = form.get("notes");

  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  if (!supplierId) return c.json({ error: "counterparty_supplier_id required" }, 400);
  if (!periodEnd) return c.json({ error: "period_end required" }, 400);

  try {
    const result = await processLabourAppUpload(c.env, {
      projectId: c.req.param("projectId"),
      counterpartySupplierId: Number(supplierId),
      periodEnd: periodEnd.toString(),
      notes: notes?.toString() || null,
      file: { buffer: await file.arrayBuffer(), name: file.name, type: file.type },
      amountsArePeriod: !!form.get("period_mode"),
      actor: c.get("userEmail"),
    });
    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = /not found|not configured|upload a pricing/.test(msg) ? 400 : 500;
    return c.json({ error: msg }, code);
  }
});

/**
 * Resolve one of the unmatched lines on a draft AfP — assign it to an existing
 * BOQ line (applies the % / value to that contract_item's afp_line), add it as
 * an ad-hoc Variation or Expense line, or dismiss it. The line is MOVED from
 * unmatched_lines_json to resolved_lines_json (with a `resolution` record) so
 * the action can be undone (see .../resolved/:rawLineNo/undo).
 */
applications.post("/:id/unmatched/:rawLineNo/resolve", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const rawLineNo = Number(c.req.param("rawLineNo"));
  const body = await c.req.json<{
    action: "assign" | "assign_split" | "dismiss" | "add_as_variation" | "add_as_expense" | "add_as_adjustment";
    /** Required for action="assign" — the contract_item_id to apply the value to. */
    contract_item_id?: number;
    /** action="assign_split": the line's cost portioned over several BOQ lines. */
    parts?: Array<{ contract_item_id: number; value: number }>;
    /** "add" (default): the figure is this-period / a separate piece — stack it
     *  on the line's claim. "set": the figure IS the item's cumulative-to-date —
     *  it replaces the line's claim instead of double-counting. */
    mode?: "add" | "set";
  }>();

  const afp = await c.env.DB.prepare(
    "SELECT id, status, unmatched_lines_json, resolved_lines_json FROM applications_for_payment WHERE id = ?",
  ).bind(id).first<{ id: number; status: Status; unmatched_lines_json: string | null; resolved_lines_json: string | null }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.status !== "draft") return c.json({ error: "AfP not editable" }, 409);

  const list: Array<Record<string, unknown>> = afp.unmatched_lines_json
    ? JSON.parse(afp.unmatched_lines_json) : [];
  const idx = list.findIndex((l) => Number(l.raw_line_no) === rawLineNo);
  if (idx < 0) return c.json({ error: "unmatched line not found" }, 404);
  const line = list[idx];

  // What we record so the action can be reversed by the undo endpoint.
  let resolution: Record<string, unknown>;

  if (body.action === "assign") {
    if (!body.contract_item_id) return c.json({ error: "contract_item_id required" }, 400);
    // Find the afp_line for this contract item, including whatever it's already
    // claiming (cumulative_value) so several unmatched sub-items can be assigned
    // to the same BOQ line and ADD UP rather than overwrite one another.
    const afpLine = await c.env.DB.prepare(
      "SELECT id, contract_value, cumulative_value, percent_complete FROM afp_lines WHERE afp_id = ? AND contract_item_id = ?",
    ).bind(id, body.contract_item_id).first<{ id: number; contract_value: number; cumulative_value: number; percent_complete: number }>();
    if (!afpLine) return c.json({ error: "no seeded line for that contract item" }, 404);

    const cumPct = typeof line.cumulative_pct === "number" ? line.cumulative_pct : null;
    const cumVal = typeof line.cumulative_value === "number" ? line.cumulative_value : null;
    const periodVal = typeof line.this_period_value === "number" ? line.this_period_value : null;
    // The £ this unmatched line contributes (cumulative preferred, period
    // fallback; a bare % is converted against the BOQ line's contract value).
    let addVal: number | null = cumVal ?? periodVal ?? null;
    if (addVal == null && cumPct != null && afpLine.contract_value > 0) {
      addVal = afpLine.contract_value * Math.max(0, Math.min(100, cumPct)) / 100;
    }
    if (addVal == null) {
      return c.json({ error: "no value/% on this unmatched line — dismiss it or add as a variation" }, 400);
    }

    // "add" stacks onto the line's existing claim (separate pieces / period
    // figures); "set" replaces it (the stated cumulative for the whole item).
    const mode = body.mode === "set" ? "set" : "add";
    const wasUnpriced = !(afpLine.contract_value > 0);
    const newCum = mode === "set"
      ? Math.round(addVal * 100) / 100
      : Math.round(((afpLine.cumulative_value ?? 0) + addVal) * 100) / 100;
    if (!wasUnpriced) {
      // Real BOQ value: derive % from the running total (may exceed 100% if the
      // assigned sub-items over-claim the line — that's a genuine over-claim).
      const pct = Math.round((newCum / afpLine.contract_value) * 10000) / 100;
      await c.env.DB.prepare(
        "UPDATE afp_lines SET percent_complete = ?, cumulative_value = ? WHERE id = ?",
      ).bind(pct, newCum, afpLine.id).run();
    } else {
      // Unpriced BOQ line (labour rate wasn't parsed): build its value up from
      // the assigned amounts, holding it at 100% complete.
      await c.env.DB.prepare(
        "UPDATE afp_lines SET contract_value = ?, percent_complete = 100, cumulative_value = ? WHERE id = ?",
      ).bind(newCum, newCum, afpLine.id).run();
    }
    resolution = {
      action: "assign", contract_item_id: body.contract_item_id, afp_line_id: afpLine.id,
      added_value: addVal, was_unpriced: wasUnpriced, mode,
      // Exact restore point for undo — subtracting added_value can't reverse a "set".
      prev_cum: afpLine.cumulative_value ?? 0, prev_pct: afpLine.percent_complete ?? 0, prev_contract: afpLine.contract_value ?? 0,
    };
    // Remember the wording pair so the next upload matches this line unaided.
    {
      const ci = await c.env.DB.prepare("SELECT description FROM contract_items WHERE id = ?").bind(body.contract_item_id).first<{ description: string }>();
      if (ci) await learnAliases(c.env.DB, "afp_line", null, [{ alias: String(line.description ?? ""), target: ci.description }], c.get("userEmail"));
    }
  } else if (body.action === "assign_split") {
    // The line's cost portioned over several BOQ lines — each part applies like
    // an assign at its own £, and the whole line resolves in one move.
    const parts = (body.parts ?? []).filter((p) => p.contract_item_id > 0 && Number.isFinite(p.value) && p.value > 0);
    if (!parts.length) return c.json({ error: "Give at least one split part with a contract item and a positive value." }, 400);
    const mode = body.mode === "set" ? "set" : "add";
    const applied: Array<Record<string, unknown>> = [];
    for (const part of parts) {
      const afpLine = await c.env.DB.prepare(
        "SELECT id, contract_value, cumulative_value, percent_complete FROM afp_lines WHERE afp_id = ? AND contract_item_id = ?",
      ).bind(id, part.contract_item_id).first<{ id: number; contract_value: number; cumulative_value: number; percent_complete: number }>();
      if (!afpLine) return c.json({ error: `No seeded line for contract item ${part.contract_item_id} — nothing was applied.` }, 404);
      const wasUnpriced = !(afpLine.contract_value > 0);
      const newCum = mode === "set"
        ? Math.round(part.value * 100) / 100
        : Math.round(((afpLine.cumulative_value ?? 0) + part.value) * 100) / 100;
      if (!wasUnpriced) {
        const pct = Math.round((newCum / afpLine.contract_value) * 10000) / 100;
        await c.env.DB.prepare(
          "UPDATE afp_lines SET percent_complete = ?, cumulative_value = ? WHERE id = ?",
        ).bind(pct, newCum, afpLine.id).run();
      } else {
        await c.env.DB.prepare(
          "UPDATE afp_lines SET contract_value = ?, percent_complete = 100, cumulative_value = ? WHERE id = ?",
        ).bind(newCum, newCum, afpLine.id).run();
      }
      applied.push({
        contract_item_id: part.contract_item_id, afp_line_id: afpLine.id,
        added_value: part.value, was_unpriced: wasUnpriced, mode,
        prev_cum: afpLine.cumulative_value ?? 0, prev_pct: afpLine.percent_complete ?? 0, prev_contract: afpLine.contract_value ?? 0,
      });
    }
    resolution = { action: "assign_split", parts: applied };
  } else if (body.action === "add_as_adjustment") {
    // A CONTRACT adjustment (e.g. "Directors Adjustment" bringing the total to
    // the agreed contract sum): its own line carrying its FULL contract value —
    // derived from the claimed % when the workbook gives one (−£1,000 at 10%
    // ⇒ −£10,000 contract) — so the application's contract sum foots to the
    // agreed figure. Unlike a variation it's part of the base contract.
    const v = typeof line.cumulative_value === "number" ? line.cumulative_value
      : typeof line.this_period_value === "number" ? line.this_period_value : 0;
    const pct = typeof line.cumulative_pct === "number" && line.cumulative_pct !== 0 ? line.cumulative_pct : null;
    const contractVal = pct != null ? Math.round((v / (pct / 100)) * 100) / 100 : v;
    const codePrefix = /^(\d{5})\b/.exec(String(line.description ?? ""))?.[1];
    const maxOrder = await c.env.DB.prepare(
      "SELECT COALESCE(MAX(display_order), 0) AS n FROM afp_lines WHERE afp_id = ?",
    ).bind(id).first<{ n: number }>();
    const ins = await c.env.DB.prepare(
      `INSERT INTO afp_lines
         (afp_id, section, description, unit, qty, rate, contract_value,
          percent_complete, cumulative_value, is_adhoc, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?) RETURNING id`,
    ).bind(
      id, codePrefix ? `${codePrefix} · Adjustments` : "Adjustments", String(line.description ?? ""),
      line.unit ? String(line.unit) : null,
      typeof line.qty === "number" ? line.qty : 1,
      contractVal, contractVal, pct ?? 100, v, (maxOrder?.n ?? 0) + 1,
    ).first<{ id: number }>();
    resolution = { action: body.action, afp_line_id: ins!.id };
  } else if (body.action === "add_as_variation" || body.action === "add_as_expense") {
    // Add as an ad-hoc line (100% complete, value = the claimed £). "Expenses"
    // sit in their own bucket; both are excluded from the measured labour budget.
    const section = body.action === "add_as_expense" ? "Expenses" : "Variations";
    const v = typeof line.cumulative_value === "number" ? line.cumulative_value
      : typeof line.this_period_value === "number" ? line.this_period_value : 0;
    const maxOrder = await c.env.DB.prepare(
      "SELECT COALESCE(MAX(display_order), 0) AS n FROM afp_lines WHERE afp_id = ?",
    ).bind(id).first<{ n: number }>();
    const ins = await c.env.DB.prepare(
      `INSERT INTO afp_lines
         (afp_id, section, description, unit, qty, rate, contract_value,
          percent_complete, cumulative_value, is_adhoc, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, 100, ?, 1, ?) RETURNING id`,
    ).bind(
      id, section, String(line.description ?? ""),
      line.unit ? String(line.unit) : null,
      typeof line.qty === "number" ? line.qty : 1,
      v, v, v, (maxOrder?.n ?? 0) + 1,
    ).first<{ id: number }>();
    resolution = { action: body.action, afp_line_id: ins!.id };
  } else {
    resolution = { action: "dismiss" };
  }

  // Move the entry from unmatched → resolved (keeping the resolution so it can
  // be undone) and persist both lists.
  list.splice(idx, 1);
  const resolved: Array<Record<string, unknown>> = afp.resolved_lines_json ? JSON.parse(afp.resolved_lines_json) : [];
  resolved.push({ ...line, resolution });
  await c.env.DB.prepare(
    "UPDATE applications_for_payment SET unmatched_lines_json = ?, resolved_lines_json = ? WHERE id = ?",
  ).bind(list.length > 0 ? JSON.stringify(list) : null, JSON.stringify(resolved), id).run();

  await recalcTotals(c.env.DB, id);

  // Reconciling the last unmatched line counts the application as sent (no
  // director approval needed) — provided a subbie is assigned for labour.
  let sent = false;
  if (list.length === 0) sent = await autoSubmitIfReady(c.env.DB, id, c.get("userEmail"));
  return c.json({ ok: true, remaining: list.length, status: sent ? "submitted" : undefined });
});

/**
 * Undo a previously-resolved unmatched line (draft only): reverse its effect —
 * back out an assign's added value, delete an added variation/expense line —
 * and send the item back to the unmatched list so it can be re-assigned.
 */
applications.post("/:id/resolved/:rawLineNo/undo", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const rawLineNo = Number(c.req.param("rawLineNo"));
  const afp = await c.env.DB.prepare(
    "SELECT status, unmatched_lines_json, resolved_lines_json FROM applications_for_payment WHERE id = ?",
  ).bind(id).first<{ status: Status; unmatched_lines_json: string | null; resolved_lines_json: string | null }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.status !== "draft") return c.json({ error: "AfP not editable" }, 409);

  const resolved: Array<Record<string, unknown>> = afp.resolved_lines_json ? JSON.parse(afp.resolved_lines_json) : [];
  const idx = resolved.findIndex((l) => Number(l.raw_line_no) === rawLineNo);
  if (idx < 0) return c.json({ error: "resolved line not found" }, 404);
  const entry = resolved[idx];
  const res = (entry.resolution ?? {}) as Record<string, unknown>;

  if (res.action === "assign") {
    const lineId = Number(res.afp_line_id);
    const added = typeof res.added_value === "number" ? res.added_value : 0;
    // Newer resolutions carry the exact previous position — restore it
    // verbatim (required to reverse a "set", exact either way).
    if (typeof res.prev_cum === "number") {
      await c.env.DB.prepare(
        "UPDATE afp_lines SET contract_value = ?, percent_complete = ?, cumulative_value = ? WHERE id = ? AND afp_id = ?",
      ).bind(
        typeof res.prev_contract === "number" ? res.prev_contract : 0,
        typeof res.prev_pct === "number" ? res.prev_pct : 0,
        res.prev_cum, lineId, id,
      ).run();
    } else {
    const al = await c.env.DB.prepare(
      "SELECT contract_value, cumulative_value FROM afp_lines WHERE id = ? AND afp_id = ?",
    ).bind(lineId, id).first<{ contract_value: number; cumulative_value: number }>();
    if (al) {
      const newCum = Math.max(0, Math.round(((al.cumulative_value ?? 0) - added) * 100) / 100);
      if (res.was_unpriced) {
        // The line was unpriced before assign built its value; strip it back.
        await c.env.DB.prepare("UPDATE afp_lines SET contract_value = ?, percent_complete = ?, cumulative_value = ? WHERE id = ?")
          .bind(newCum, newCum > 0 ? 100 : 0, newCum, lineId).run();
      } else {
        const pct = al.contract_value > 0 ? Math.round((newCum / al.contract_value) * 10000) / 100 : 0;
        await c.env.DB.prepare("UPDATE afp_lines SET percent_complete = ?, cumulative_value = ? WHERE id = ?").bind(pct, newCum, lineId).run();
      }
    }
    }
  } else if (res.action === "assign_split") {
    // Restore each part's exact previous position, LAST part first — if two
    // parts touched the same line, the first part's snapshot is the true
    // original and lands last.
    const parts = Array.isArray(res.parts) ? [...(res.parts as Array<Record<string, unknown>>)].reverse() : [];
    for (const p of parts) {
      if (typeof p.prev_cum !== "number") continue;
      await c.env.DB.prepare(
        "UPDATE afp_lines SET contract_value = ?, percent_complete = ?, cumulative_value = ? WHERE id = ? AND afp_id = ?",
      ).bind(
        typeof p.prev_contract === "number" ? p.prev_contract : 0,
        typeof p.prev_pct === "number" ? p.prev_pct : 0,
        p.prev_cum, Number(p.afp_line_id), id,
      ).run();
    }
  } else if (res.action === "add_as_variation" || res.action === "add_as_expense" || res.action === "add_as_adjustment") {
    await c.env.DB.prepare("DELETE FROM afp_lines WHERE id = ? AND afp_id = ? AND is_adhoc = 1").bind(Number(res.afp_line_id), id).run();
  }
  // dismiss: nothing to reverse.

  // Move the item back to the unmatched list (stripping the resolution record).
  resolved.splice(idx, 1);
  const bare: Record<string, unknown> = { ...entry };
  delete bare.resolution;
  const unmatched: Array<Record<string, unknown>> = afp.unmatched_lines_json ? JSON.parse(afp.unmatched_lines_json) : [];
  unmatched.push(bare);
  await c.env.DB.prepare(
    "UPDATE applications_for_payment SET unmatched_lines_json = ?, resolved_lines_json = ? WHERE id = ?",
  ).bind(JSON.stringify(unmatched), resolved.length > 0 ? JSON.stringify(resolved) : null, id).run();

  await recalcTotals(c.env.DB, id);
  return c.json({ ok: true });
});

/** Update header fields (period_end, notes, retention_pct, vat_pct) while draft. */
applications.patch("/:id", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    period_end?: string;
    notes?: string;
    retention_pct?: number;
    vat_pct?: number;
    counterparty_supplier_id?: number | null;
    prelim_heading?: string | null;
    claimed_amount?: number | null;
  }>();
  const cur = await c.env.DB.prepare(
    "SELECT status FROM applications_for_payment WHERE id = ?",
  )
    .bind(id)
    .first<{ status: Status }>();
  if (!cur) return c.json({ error: "not found" }, 404);
  // Tagging spend as prelims is a reporting recategorisation, not an edit of
  // the claim — allowed at any status. Everything else — including the prelim
  // claimed amount, which sets the payable value — stays draft-only.
  const prelimOnly = body.prelim_heading !== undefined
    && body.period_end == null && body.notes == null && body.retention_pct == null
    && body.vat_pct == null && body.counterparty_supplier_id === undefined
    && body.claimed_amount === undefined;
  if (cur.status !== "draft" && !prelimOnly) return c.json({ error: "AfP is not editable in this status" }, 409);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.period_end != null) { sets.push("period_end = ?"); vals.push(body.period_end); }
  if (body.notes != null) { sets.push("notes = ?"); vals.push(body.notes); }
  if (body.retention_pct != null) { sets.push("retention_pct = ?"); vals.push(body.retention_pct); }
  if (body.vat_pct != null) { sets.push("vat_pct = ?"); vals.push(body.vat_pct); }
  // Assign/clear the subcontractor — used to resolve an email-forwarded app
  // that arrived without an auto-detected supplier.
  if (body.prelim_heading !== undefined) {
    sets.push("prelim_heading = ?");
    vals.push(body.prelim_heading == null || !body.prelim_heading.trim() ? null : body.prelim_heading.trim());
  }
  // The single claimed £ for a prelim-tagged app (replaces line matching —
  // recalcTotals makes it the application's value).
  if (body.claimed_amount !== undefined) {
    sets.push("claimed_amount = ?");
    vals.push(typeof body.claimed_amount === "number" && Number.isFinite(body.claimed_amount)
      ? Math.round(body.claimed_amount * 100) / 100 : null);
  }
  if (body.counterparty_supplier_id !== undefined) {
    sets.push("counterparty_supplier_id = ?");
    vals.push(body.counterparty_supplier_id ?? null);
  }
  if (sets.length === 0) return c.json({ ok: true });
  vals.push(id);
  await c.env.DB.prepare(
    `UPDATE applications_for_payment SET ${sets.join(", ")} WHERE id = ?`,
  )
    .bind(...vals)
    .run();
  await recalcTotals(c.env.DB, id);
  // Assigning the subbie was the last thing a received labour app was waiting
  // on — counts as sent (no approval needed).
  let sent = false;
  if (body.counterparty_supplier_id) sent = await autoSubmitIfReady(c.env.DB, id, c.get("userEmail"));
  return c.json({ ok: true, status: sent ? "submitted" : undefined });
});

/** Set percent_complete on a line (and recompute the AfP totals). */
applications.patch("/lines/:lineId", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const lineId = Number(c.req.param("lineId"));
  const body = await c.req.json<{
    percent_complete?: number;   // applied (claimed) %
    certified_percent?: number;  // certified % (what we'll pay)
    description?: string;     // ad-hoc only
    qty?: number;             // ad-hoc only
    unit?: string;            // ad-hoc only
    rate?: number;            // ad-hoc only
  }>();

  const line = await c.env.DB.prepare(
    `SELECT l.id, l.afp_id, l.contract_value, l.is_adhoc,
            a.status AS afp_status
     FROM afp_lines l
     JOIN applications_for_payment a ON a.id = l.afp_id
     WHERE l.id = ?`,
  )
    .bind(lineId)
    .first<{ id: number; afp_id: number; contract_value: number; is_adhoc: 0 | 1; afp_status: Status }>();
  if (!line) return c.json({ error: "not found" }, 404);
  // Drafts are fully editable. A SUBMITTED application locks the claim but
  // keeps the certified figures open — that's when certification happens,
  // whether typed on-system or applied from a certificate in the inbox.
  const certifiedOnly = body.certified_percent != null
    && body.percent_complete == null && body.description == null
    && body.qty == null && body.unit == null && body.rate == null;
  if (line.afp_status !== "draft" && !(line.afp_status === "submitted" && certifiedOnly)) {
    return c.json({ error: "AfP not editable" }, 409);
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.percent_complete != null) {
    sets.push("percent_complete = ?");
    vals.push(Math.max(0, Math.min(100, body.percent_complete)));
  }
  if (body.certified_percent != null) {
    sets.push("certified_percent = ?");
    vals.push(Math.max(0, Math.min(100, body.certified_percent)));
  }
  if (line.is_adhoc) {
    if (body.description != null) { sets.push("description = ?"); vals.push(body.description); }
    if (body.qty != null) { sets.push("qty = ?"); vals.push(body.qty); }
    if (body.unit != null) { sets.push("unit = ?"); vals.push(body.unit); }
    if (body.rate != null) {
      sets.push("rate = ?");
      vals.push(body.rate);
      // Recompute contract_value = qty × rate; if qty isn't being set we read
      // the current qty from the row.
      if (body.qty == null) {
        const cur = await c.env.DB.prepare("SELECT qty FROM afp_lines WHERE id = ?")
          .bind(lineId)
          .first<{ qty: number | null }>();
        sets.push("contract_value = ? * ?");
        vals.push(cur?.qty ?? 0, body.rate);
      } else {
        sets.push("contract_value = ? * ?");
        vals.push(body.qty, body.rate);
      }
    }
  }
  if (sets.length === 0) return c.json({ ok: true });
  vals.push(lineId);
  await c.env.DB.prepare(`UPDATE afp_lines SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals)
    .run();

  // Cumulative (the value that flows to the invoice) is driven by the
  // certified %; until a line is certified it falls back to the applied %.
  await c.env.DB.prepare(
    "UPDATE afp_lines SET cumulative_value = contract_value * COALESCE(certified_percent, percent_complete) / 100 WHERE id = ?",
  )
    .bind(lineId)
    .run();

  await recalcTotals(c.env.DB, line.afp_id);
  return c.json({ ok: true });
});

/** Add an ad-hoc / variation line to a draft AfP. */
applications.post("/:id/lines", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    description: string;
    qty: number;
    unit?: string;
    rate: number;
    section?: string;
  }>();
  if (!body.description?.trim()) return c.json({ error: "description required" }, 400);

  const afp = await c.env.DB.prepare(
    "SELECT id, status FROM applications_for_payment WHERE id = ?",
  )
    .bind(id)
    .first<{ id: number; status: Status }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.status !== "draft") return c.json({ error: "AfP not editable" }, 409);

  const maxOrder = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(display_order), 0) AS n FROM afp_lines WHERE afp_id = ?",
  )
    .bind(id)
    .first<{ n: number }>();
  const contractValue = body.qty * body.rate;

  await c.env.DB.prepare(
    `INSERT INTO afp_lines
       (afp_id, section, description, unit, qty, rate, contract_value,
        percent_complete, cumulative_value, is_adhoc, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?)`,
  )
    .bind(
      id, body.section ?? "Variations", body.description, body.unit ?? null,
      body.qty, body.rate, contractValue, (maxOrder?.n ?? 0) + 1,
    )
    .run();
  await recalcTotals(c.env.DB, id);
  return c.json({ ok: true });
});

/** Remove a line (ad-hoc lines only — BOQ-derived lines must be zeroed instead). */
applications.delete("/lines/:lineId", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const lineId = Number(c.req.param("lineId"));
  const line = await c.env.DB.prepare(
    `SELECT l.id, l.afp_id, l.is_adhoc, a.status AS afp_status
     FROM afp_lines l
     JOIN applications_for_payment a ON a.id = l.afp_id
     WHERE l.id = ?`,
  )
    .bind(lineId)
    .first<{ id: number; afp_id: number; is_adhoc: 0 | 1; afp_status: Status }>();
  if (!line) return c.json({ error: "not found" }, 404);
  if (line.afp_status !== "draft") return c.json({ error: "AfP not editable" }, 409);
  if (!line.is_adhoc) return c.json({ error: "BOQ lines can't be deleted — set their % to 0" }, 400);
  await c.env.DB.prepare("DELETE FROM afp_lines WHERE id = ?").bind(lineId).run();
  await recalcTotals(c.env.DB, line.afp_id);
  return c.json({ ok: true });
});

/**
 * Mark a draft as sent. Applications no longer require director approval —
 * this freezes the totals and moves straight to 'submitted' (live / awaiting
 * certification). Blocked while there are unmatched lines to reconcile or, for
 * labour, no subcontractor assigned.
 */
applications.post("/:id/submit", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const afp = await c.env.DB.prepare(
    "SELECT id, status, direction, counterparty_supplier_id, unmatched_lines_json, prelim_heading, claimed_amount FROM applications_for_payment WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: number; status: Status; direction: Direction;
      counterparty_supplier_id: number | null; unmatched_lines_json: string | null;
      prelim_heading: string | null; claimed_amount: number | null;
    }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.status !== "draft") return c.json({ error: "only drafts can be sent" }, 409);
  // Prelim claims don't line-match — the claimed amount replaces reconciliation.
  if (afp.unmatched_lines_json && !(afp.prelim_heading != null && afp.claimed_amount != null)) {
    return c.json({ error: "reconcile the unmatched lines before sending" }, 409);
  }
  if (afp.direction === "incoming_labour" && afp.counterparty_supplier_id == null) {
    return c.json({ error: "assign the subcontractor before sending" }, 409);
  }
  await autoSubmitIfReady(c.env.DB, id, c.get("userEmail"));
  return c.json({ ok: true, status: "submitted" });
});

/**
 * Director sign-off for an OVER-BUDGET labour application. Applications no
 * longer need routine approval, but a labour application whose claim exceeds
 * the budgeted labour (e.g. variations were added) is held until a director
 * signs it off here. Records approved_at / approved_by, which the certify route
 * checks. Director-tier approvers only.
 */
applications.post("/:id/approve", async (c) => {
  const userEmail = c.get("userEmail");
  const id = Number(c.req.param("id"));
  const afp = await c.env.DB.prepare(
    "SELECT a.id, a.status, a.direction, a.project_id FROM applications_for_payment a WHERE a.id = ?",
  )
    .bind(id)
    .first<{ id: number; status: Status; direction: Direction; project_id: string }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  // Director-tier approver, project-wide or global.
  const approver = await c.env.DB.prepare(
    `SELECT id FROM approvers
     WHERE email = ? AND tier = 'director'
       AND (project_id IS NULL OR project_id = ?)`,
  )
    .bind(userEmail, afp.project_id)
    .first();
  if (!approver) {
    return c.json({ error: "Only a director-tier approver can sign off an over-budget application" }, 403);
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE applications_for_payment SET approved_at = ?, approved_by = ? WHERE id = ?",
  )
    .bind(now, userEmail, id)
    .run();
  return c.json({ ok: true, approved_at: now, approved_by: userEmail });
});

/** Director rejects a pending AfP → back to draft with a reason. */
applications.post("/:id/reject", async (c) => {
  const userEmail = c.get("userEmail");
  const id = Number(c.req.param("id"));
  const body = await c.req
    .json<{ reason?: string }>()
    .catch(() => ({} as { reason?: string }));
  const afp = await c.env.DB.prepare(
    `SELECT a.id, a.status, a.project_id
     FROM applications_for_payment a WHERE a.id = ?`,
  )
    .bind(id)
    .first<{ id: number; status: Status; project_id: string }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.status !== "pending_approval") {
    return c.json({ error: "AfP is not awaiting approval" }, 409);
  }
  const approver = await c.env.DB.prepare(
    `SELECT id FROM approvers
     WHERE email = ? AND tier = 'director'
       AND (project_id IS NULL OR project_id = ?)`,
  )
    .bind(userEmail, afp.project_id)
    .first();
  if (!approver) {
    return c.json({ error: "Only a director-tier approver can reject this AfP" }, 403);
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE applications_for_payment
     SET status = 'draft', approval_rejected_at = ?, approval_rejected_by = ?,
         approval_rejection_reason = ?, submitted_at = NULL, submitted_by = NULL
     WHERE id = ?`,
  )
    .bind(now, userEmail, body.reason ?? null, id)
    .run();
  return c.json({ ok: true });
});


/**
 * Re-rate off-rate line(s) to the agreed rate. For a labour AfP, sets each
 * flagged line's rate to its expected rate (agreed live rate, else BOQ rate),
 * recomputing contract_value and the cumulative (certified-or-applied) value.
 * With a line_id, re-rates just that line; otherwise every flagged line. Works
 * on a draft or submitted AfP — the review happens before certification.
 */
applications.post("/:id/rerate", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ line_id?: number }>().catch(() => ({} as { line_id?: number }));
  const afp = await c.env.DB.prepare(
    "SELECT id, status, direction, project_id FROM applications_for_payment WHERE id = ?",
  )
    .bind(id)
    .first<{ id: number; status: Status; direction: Direction; project_id: string }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.direction !== "incoming_labour") {
    return c.json({ error: "rate variance only applies to labour applications" }, 400);
  }
  if (afp.status !== "draft" && afp.status !== "submitted") {
    return c.json({ error: "AfP can't be re-rated in this status" }, 409);
  }
  const rm = await rateMismatchMap(c.env.DB, id, afp.project_id);
  let updated = 0;
  for (const [lineId, info] of rm) {
    if (!info.flagged || info.expected == null) continue;
    if (body.line_id != null && lineId !== body.line_id) continue;
    await c.env.DB.prepare(
      `UPDATE afp_lines
         SET rate = ?,
             contract_value = COALESCE(qty, 0) * ?,
             cumulative_value = (COALESCE(qty, 0) * ?) * COALESCE(certified_percent, percent_complete) / 100
       WHERE id = ?`,
    )
      .bind(info.expected, info.expected, info.expected, lineId)
      .run();
    updated++;
  }
  if (updated > 0) await recalcTotals(c.env.DB, id, { force: true });
  return c.json({ ok: true, updated });
});

/**
 * Director sign-off of a rate variance on a labour AfP. Records
 * rate_override_at/by/reason, which the certify route checks — lets an
 * application with off-rate lines be certified without re-rating them.
 * Director-tier approvers only; a reason is required.
 */
applications.post("/:id/rate-override", async (c) => {
  const userEmail = c.get("userEmail");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
  const reason = body.reason?.trim();
  if (!reason) return c.json({ error: "a reason is required to sign off a rate variance" }, 400);
  const afp = await c.env.DB.prepare(
    "SELECT id, direction, project_id FROM applications_for_payment WHERE id = ?",
  )
    .bind(id)
    .first<{ id: number; direction: Direction; project_id: string }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.direction !== "incoming_labour") {
    return c.json({ error: "rate variance only applies to labour applications" }, 400);
  }
  const approver = await c.env.DB.prepare(
    `SELECT id FROM approvers
     WHERE email = ? AND tier = 'director'
       AND (project_id IS NULL OR project_id = ?)`,
  )
    .bind(userEmail, afp.project_id)
    .first();
  if (!approver) {
    return c.json({ error: "Only a director-tier approver can sign off a rate variance" }, 403);
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE applications_for_payment SET rate_override_at = ?, rate_override_by = ?, rate_override_reason = ? WHERE id = ?",
  )
    .bind(now, userEmail, reason, id)
    .run();
  return c.json({ ok: true, rate_override_at: now, rate_override_by: userEmail });
});

/** Move from submitted → certified, with optional certified_amount override. */
applications.post("/:id/certify", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const body = await c.req
    .json<{ certified_amount?: number; notes?: string }>()
    .catch(() => ({} as { certified_amount?: number; notes?: string }));
  const afp = await c.env.DB.prepare(
    "SELECT id, status, amount_due, direction, approved_at, project_id, rate_override_at FROM applications_for_payment WHERE id = ?",
  )
    .bind(id)
    .first<{ id: number; status: Status; amount_due: number | null; direction: Direction; approved_at: string | null; project_id: string; rate_override_at: string | null }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.status !== "submitted") return c.json({ error: "only submitted AfPs can be certified" }, 409);
  // A labour application that's gone over the budgeted labour needs a director
  // sign-off (recorded as approved_at) before it can be certified/paid.
  if (afp.direction === "incoming_labour" && !afp.approved_at) {
    const bs = await lineBudgetStatus(c.env.DB, id);
    if (bs.over) {
      return c.json({
        error: `This labour application is £${bs.overBy.toFixed(2)} over the budgeted labour (claimed £${bs.claimed.toFixed(2)} vs budget £${bs.budget.toFixed(2)}). A director must sign it off before it can be certified.`,
      }, 409);
    }
  }
  // A labour application with line(s) valued at a rate that differs from the
  // agreed live rate is held until either the lines are re-rated or a director
  // signs off the variance (recorded as rate_override_at).
  if (afp.direction === "incoming_labour" && !afp.rate_override_at) {
    const rm = await rateMismatchMap(c.env.DB, id, afp.project_id);
    const flagged = [...rm.values()].filter((i) => i.flagged).length;
    if (flagged > 0) {
      return c.json({
        error: `${flagged} line${flagged === 1 ? "" : "s"} ${flagged === 1 ? "is" : "are"} valued at a rate that differs from the agreed live rate. Re-rate the flagged line${flagged === 1 ? "" : "s"} to the live rate, or have a director sign off the rate variance, before certifying.`,
      }, 409);
    }
  }
  const certified = body.certified_amount ?? afp.amount_due ?? 0;
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  await c.env.DB.prepare(
    `UPDATE applications_for_payment
     SET status = 'certified', certified_at = ?, certified_by = ?, certified_amount = ?
     WHERE id = ?`,
  )
    .bind(now, actor, certified, id)
    .run();

  // Email the raiser that the AfP was certified
  c.executionCtx.waitUntil((async () => {
    const d = await c.env.DB.prepare(
      `SELECT a.id, a.project_id, a.app_number, a.submitted_by, a.created_by,
              p.code AS project_code, p.name AS project_name
       FROM applications_for_payment a JOIN projects p ON p.id = a.project_id
       WHERE a.id = ?`,
    ).bind(id).first<{
      id: number; project_id: string; app_number: number; submitted_by: string | null; created_by: string;
      project_code: string; project_name: string;
    }>();
    if (!d) return;
    const to = d.submitted_by ?? d.created_by;
    if (!to || isSandboxId(d.project_id)) return; // sandbox never emails real people
    await emailAfpCertified(c.env, {
      afp: { id: d.id, app_number: d.app_number, certified_amount: certified },
      project: { code: d.project_code, name: d.project_name },
      to, actor,
    });
  })());

  // Certification agrees the value but no longer pushes to Xero automatically.
  // A labour certificate now reaches Xero only after a separate "approve for
  // payment" step (POST /:id/approve-payment) — mirroring the supplier-invoice
  // gate — and then pushes as a DRAFT bill, not straight into the pay run.

  return c.json({ ok: true, certified_amount: certified });
});

/**
 * Approve a certified labour certificate FOR PAYMENT (flag-don't-block). This is
 * the financial go-ahead, separate from certification (the QS agreeing the
 * value): only once approved can the certificate push to Xero as a DRAFT bill.
 * Mirrors the supplier-invoice approval gate in the Accounts workpiece.
 */
applications.post("/:id/approve-payment", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const body = await c.req
    .json<{ note?: string; unapprove?: boolean }>()
    .catch(() => ({} as { note?: string; unapprove?: boolean }));
  const afp = await c.env.DB.prepare(
    "SELECT id, status, direction FROM applications_for_payment WHERE id = ?",
  ).bind(id).first<{ id: number; status: string; direction: string }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.direction !== "incoming_labour") return c.json({ error: "Only labour certificates are approved for payment here." }, 400);
  if (body.unapprove) {
    // Withdrawing the pay approval withdraws the final sign-off with it, or a
    // re-approval would arrive already released and push on the old one. A
    // certificate already in Xero is past this point and keeps its release.
    const inXero = "(xero_po_id IS NOT NULL OR xero_sync_status = 'synced')";
    await c.env.DB.prepare(
      `UPDATE applications_for_payment
          SET pay_approved_at = NULL, pay_approved_by = NULL,
              pay_released_at  = CASE WHEN ${inXero} THEN pay_released_at  ELSE NULL END,
              pay_released_by  = CASE WHEN ${inXero} THEN pay_released_by  ELSE NULL END,
              pay_release_note = CASE WHEN ${inXero} THEN pay_release_note ELSE NULL END
        WHERE id = ?`,
    ).bind(id).run();
    return c.json({ ok: true });
  }
  if (afp.status !== "certified" && afp.status !== "paid") {
    return c.json({ error: "Certify the labour certificate before approving it for payment." }, 409);
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE applications_for_payment SET pay_approved_at = ?, pay_approved_by = ?, pay_approval_note = ? WHERE id = ?",
  ).bind(now, c.get("userEmail"), (body.note || "").trim() || null, id).run();
  return c.json({ ok: true, pay_approved_at: now });
});

/**
 * Final sign-off on a held labour certificate — the second signature, and the
 * only route that pushes the bill to Xero.
 *
 * Restricted by name, not by role, and by the SAME allowlist as supplier
 * invoices: the last approval before money leaves the company is one job, and
 * splitting it per workpiece would mean a person trusted with one route and
 * not the other, which is not a distinction anyone asked for.
 */
applications.post("/:id/release-payment", async (c) => {
  // Still needs the base right to be in this workpiece; the allowlist narrows
  // it from there.
  const denied = requirePermission(c, "commercial.view");
  if (denied) return denied;
  const actor = c.get("userEmail");
  if (!(await isReleaseApprover(c.env, actor))) {
    return c.json({
      error: "Only a nominated release approver can send a labour certificate to Xero. "
        + "The certificate stays held until then.",
    }, 403);
  }
  const id = Number(c.req.param("id"));
  const afp = await c.env.DB.prepare(
    "SELECT id, status, direction, pay_approved_at, pay_released_at, xero_po_id, xero_po_number FROM applications_for_payment WHERE id = ?",
  ).bind(id).first<{
    id: number; status: string; direction: string; pay_approved_at: string | null;
    pay_released_at: string | null; xero_po_id: string | null; xero_po_number: string | null;
  }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.direction !== "incoming_labour") {
    return c.json({ error: "Only labour certificates are released for payment here." }, 400);
  }
  if (afp.xero_po_id) {
    return c.json({ error: `This certificate is already in Xero as bill ${afp.xero_po_number ?? afp.xero_po_id}.` }, 409);
  }
  // Release signs off an approval — it doesn't stand in for one. Both earlier
  // stages have to be on record separately: the QS certifying the value, and
  // whoever approved it for payment.
  if (afp.status !== "certified" && afp.status !== "paid") {
    return c.json({ error: "Certify the labour certificate before releasing it." }, 409);
  }
  if (!afp.pay_approved_at) {
    return c.json({ error: "This certificate hasn't been approved for payment yet. It needs approving before it can be released." }, 400);
  }

  const body = await c.req.json<{ note?: string }>().catch(() => ({} as { note?: string }));
  const note = (body.note || "").trim();
  const when = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE applications_for_payment SET pay_released_at = ?, pay_released_by = ?, pay_release_note = ? WHERE id = ?",
  ).bind(when, actor, note || null, id).run();

  // Best-effort push, as the invoice release is: a Xero failure never rolls
  // back the sign-off — it's recorded on the certificate and the Push button
  // retries it. pushAfpToXero re-reads the row, so it sees the release above.
  try {
    const r = await pushAfpToXero(c.env, id);
    if ("skipped" in r) return c.json({ ok: true, pay_released_at: when, pushed: false, skipped: true, reason: r.reason });
    return c.json({ ok: true, pay_released_at: when, pushed: true, xero_po_number: r.xero_po_number });
  } catch (e) {
    return c.json({ ok: true, pay_released_at: when, pushed: false, xero_error: e instanceof Error ? e.message : String(e) });
  }
});

/** Mark as paid. */
applications.post("/:id/mark-paid", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const body = await c.req
    .json<{ payment_reference?: string }>()
    .catch(() => ({} as { payment_reference?: string }));
  const afp = await c.env.DB.prepare(
    "SELECT id, status FROM applications_for_payment WHERE id = ?",
  )
    .bind(id)
    .first<{ id: number; status: Status }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.status !== "certified") return c.json({ error: "only certified AfPs can be marked paid" }, 409);
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  await c.env.DB.prepare(
    "UPDATE applications_for_payment SET status = 'paid', paid_at = ?, paid_by = ?, payment_reference = ? WHERE id = ?",
  )
    .bind(now, actor, body.payment_reference ?? null, id)
    .run();
  return c.json({ ok: true });
});

/**
 * Delete an AfP. Drafts: anyone with projects.edit can delete. Any other
 * status: superadmin only (uses the projects.delete permission which is
 * superadmin-only by design).
 */
/**
 * Pull a SUBMITTED application back to draft — nothing certified or invoiced
 * yet, so it's safe to reopen. Restores draft-only editing (including the
 * review-line undo list). Exists because the old auto-submit could fire on
 * resolving the last review line — a submit the author never chose must be
 * reversible without a director rejection.
 */
applications.post("/:id/unsubmit", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const afp = await c.env.DB.prepare(
    "SELECT id, status, certified_at, xero_invoice_id, xero_po_id FROM applications_for_payment WHERE id = ?",
  ).bind(id).first<{ id: number; status: Status; certified_at: string | null; xero_invoice_id: string | null; xero_po_id: string | null }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.status !== "submitted") return c.json({ error: "Only a submitted application can go back to draft." }, 409);
  if (afp.certified_at) return c.json({ error: "This application is certified — it can't reopen." }, 409);
  if (afp.xero_invoice_id || afp.xero_po_id) return c.json({ error: "Already in Xero — void the invoice/bill there first." }, 409);
  await c.env.DB.prepare(
    "UPDATE applications_for_payment SET status = 'draft', submitted_at = NULL, submitted_by = NULL WHERE id = ?",
  ).bind(id).run();
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('afp', ?, 'unsubmitted', ?, '{}', ?)`,
  ).bind(String(id), c.get("userEmail"), new Date().toISOString()).run();
  return c.json({ ok: true });
});

applications.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const afp = await c.env.DB.prepare(
    "SELECT id, status FROM applications_for_payment WHERE id = ?",
  )
    .bind(id)
    .first<{ id: number; status: Status }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.status === "draft") {
    const denied = requirePermission(c, "commercial.edit");
    if (denied) return denied;
  } else {
    // Force-delete an in-flight AfP — superadmin only.
    const denied = requirePermission(c, "projects.delete");
    if (denied) return denied;
  }
  // An AfP resolved out of the email tray is back-referenced by its inbound
  // row (no ON DELETE action on that FK, so it would block the delete). Unhook
  // it first — the tray row keeps its 'resolved' history, just pointing nowhere.
  await c.env.DB.prepare("UPDATE inbound_applications SET resolved_afp_id = NULL WHERE resolved_afp_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM applications_for_payment WHERE id = ?").bind(id).run();
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('afp', ?, 'deleted', ?, ?, ?)`,
  ).bind(String(id), c.get("userEmail"), JSON.stringify({ status_at_delete: afp.status }), new Date().toISOString()).run();
  return c.json({ ok: true });
});

export type { AfpRow, AfpLineRow, Direction, Status };
