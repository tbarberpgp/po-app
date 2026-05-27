// Applications for Payment (AfP) — both outgoing (PowerGrid → client) and
// incoming labour (subcontractor → PowerGrid). The same shape backs both via
// the `direction` field; for the first ship we only expose the outgoing AfP
// to clients in the UI.

import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";

export const applications = new Hono<{ Bindings: Env; Variables: Variables }>();

type Direction = "outgoing" | "incoming_labour";
type Status = "draft" | "submitted" | "certified" | "paid";

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
 */
async function recalcTotals(db: D1Database, afpId: number): Promise<void> {
  const afp = await db
    .prepare(
      `SELECT id, project_id, direction, app_number, retention_pct, vat_pct, status
       FROM applications_for_payment WHERE id = ?`,
    )
    .bind(afpId)
    .first<{
      id: number; project_id: string; direction: Direction; app_number: number;
      retention_pct: number; vat_pct: number; status: Status;
    }>();
  if (!afp || afp.status !== "draft") return;

  const lines = await db
    .prepare(
      "SELECT contract_value, percent_complete, cumulative_value FROM afp_lines WHERE afp_id = ?",
    )
    .bind(afpId)
    .all<{ contract_value: number; percent_complete: number; cumulative_value: number }>();
  const contractSum = lines.results.reduce((s, l) => s + (l.contract_value ?? 0), 0);
  const cumulative = lines.results.reduce((s, l) => s + (l.cumulative_value ?? 0), 0);

  // Previously certified = sum of certified_amount on prior AfPs for the same
  // (project, direction). If an earlier app is still 'submitted' (not yet
  // certified) we treat its cumulative_value as the previous certified
  // anchor so we never double-claim work between overlapping apps.
  const priors = await db
    .prepare(
      `SELECT COALESCE(certified_amount, cumulative_value, 0) AS prev_value
       FROM applications_for_payment
       WHERE project_id = ? AND direction = ? AND app_number < ?
         AND status IN ('submitted', 'certified', 'paid')`,
    )
    .bind(afp.project_id, afp.direction, afp.app_number)
    .all<{ prev_value: number }>();
  const previousCertified = priors.results.reduce((s, p) => s + (p.prev_value ?? 0), 0);

  const thisPeriodNet = Math.max(0, cumulative - previousCertified);
  const retentionAmount = thisPeriodNet * (afp.retention_pct / 100);
  const amountDue = thisPeriodNet - retentionAmount;
  const vatAmount = amountDue * (afp.vat_pct / 100);
  const totalInvoice = amountDue + vatAmount;

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

// ── Routes ─────────────────────────────────────────────────────────────────

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

/** Get one AfP with lines + the prior-AfPs context for "previously certified". */
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
    .all();

  const priors = await c.env.DB.prepare(
    `SELECT app_number, period_end, status, certified_amount, cumulative_value, total_invoice
     FROM applications_for_payment
     WHERE project_id = ? AND direction = ? AND app_number < ?
     ORDER BY app_number`,
  )
    .bind((afp as AfpRow).project_id, (afp as AfpRow).direction, (afp as AfpRow).app_number)
    .all();

  return c.json({ afp, lines: lines.results, prior_apps: priors.results });
});

/**
 * Create a draft AfP. Seeds afp_lines from the active snapshot's contract_items
 * (sell rate by default; labour rate when direction='incoming_labour'). Each
 * seeded line starts at 0% complete.
 */
applications.post("/project/:projectId", async (c) => {
  const denied = requirePermission(c, "projects.edit");
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
    "SELECT id, retention_pct FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<{ id: string; retention_pct: number }>();
  if (!project) return c.json({ error: "project not found" }, 404);

  const direction: Direction = body.direction ?? "outgoing";
  if (direction === "incoming_labour" && !body.counterparty_supplier_id) {
    return c.json({ error: "counterparty_supplier_id required for incoming_labour" }, 400);
  }

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
       (project_id, direction, app_number, period_end, notes, retention_pct,
        counterparty_supplier_id, status, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?) RETURNING id`,
  )
    .bind(
      projectId, direction, appNumber, body.period_end, body.notes ?? null,
      project.retention_pct, body.counterparty_supplier_id ?? null, now, actor,
    )
    .first<{ id: number }>();
  const afpId = inserted!.id;

  // Seed lines from contract_items. Pick rate based on direction.
  const items = await c.env.DB.prepare(
    `SELECT id, item_no, section, description, qty, unit, sell_rate, sell_total, labour_rate, labour_total
     FROM contract_items WHERE snapshot_id = ? ORDER BY item_no`,
  )
    .bind(snap.id)
    .all<{
      id: number; item_no: number; section: string | null;
      description: string; qty: number; unit: string | null;
      sell_rate: number; sell_total: number;
      labour_rate: number | null; labour_total: number | null;
    }>();

  const stmts = items.results.map((it, idx) => {
    const rate = direction === "incoming_labour"
      ? (it.labour_rate ?? 0)
      : it.sell_rate;
    const total = direction === "incoming_labour"
      ? (it.labour_total ?? 0)
      : it.sell_total;
    return c.env.DB.prepare(
      `INSERT INTO afp_lines
         (afp_id, contract_item_id, section, description, unit, qty, rate,
          contract_value, percent_complete, cumulative_value, is_adhoc, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`,
    ).bind(
      afpId, it.id, it.section, it.description, it.unit, it.qty, rate, total, idx + 1,
    );
  });
  if (stmts.length > 0) await c.env.DB.batch(stmts);

  await recalcTotals(c.env.DB, afpId);
  return c.json({ id: afpId, app_number: appNumber });
});

/** Update header fields (period_end, notes, retention_pct, vat_pct) while draft. */
applications.patch("/:id", async (c) => {
  const denied = requirePermission(c, "projects.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    period_end?: string;
    notes?: string;
    retention_pct?: number;
    vat_pct?: number;
  }>();
  const cur = await c.env.DB.prepare(
    "SELECT status FROM applications_for_payment WHERE id = ?",
  )
    .bind(id)
    .first<{ status: Status }>();
  if (!cur) return c.json({ error: "not found" }, 404);
  if (cur.status !== "draft") return c.json({ error: "AfP is not editable in this status" }, 409);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.period_end != null) { sets.push("period_end = ?"); vals.push(body.period_end); }
  if (body.notes != null) { sets.push("notes = ?"); vals.push(body.notes); }
  if (body.retention_pct != null) { sets.push("retention_pct = ?"); vals.push(body.retention_pct); }
  if (body.vat_pct != null) { sets.push("vat_pct = ?"); vals.push(body.vat_pct); }
  if (sets.length === 0) return c.json({ ok: true });
  vals.push(id);
  await c.env.DB.prepare(
    `UPDATE applications_for_payment SET ${sets.join(", ")} WHERE id = ?`,
  )
    .bind(...vals)
    .run();
  await recalcTotals(c.env.DB, id);
  return c.json({ ok: true });
});

/** Set percent_complete on a line (and recompute the AfP totals). */
applications.patch("/lines/:lineId", async (c) => {
  const denied = requirePermission(c, "projects.edit");
  if (denied) return denied;
  const lineId = Number(c.req.param("lineId"));
  const body = await c.req.json<{
    percent_complete?: number;
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
  if (line.afp_status !== "draft") return c.json({ error: "AfP not editable" }, 409);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.percent_complete != null) {
    const pct = Math.max(0, Math.min(100, body.percent_complete));
    sets.push("percent_complete = ?");
    sets.push("cumulative_value = ? * ? / 100");
    vals.push(pct, line.contract_value, pct);
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

  // Re-derive cumulative_value if contract_value changed (ad-hoc edits).
  await c.env.DB.prepare(
    "UPDATE afp_lines SET cumulative_value = contract_value * percent_complete / 100 WHERE id = ?",
  )
    .bind(lineId)
    .run();

  await recalcTotals(c.env.DB, line.afp_id);
  return c.json({ ok: true });
});

/** Add an ad-hoc / variation line to a draft AfP. */
applications.post("/:id/lines", async (c) => {
  const denied = requirePermission(c, "projects.edit");
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
  const denied = requirePermission(c, "projects.edit");
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

/** Move from draft → submitted. Freezes the totals. */
applications.post("/:id/submit", async (c) => {
  const denied = requirePermission(c, "projects.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const afp = await c.env.DB.prepare(
    "SELECT id, status FROM applications_for_payment WHERE id = ?",
  )
    .bind(id)
    .first<{ id: number; status: Status }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.status !== "draft") return c.json({ error: "only drafts can be submitted" }, 409);
  await recalcTotals(c.env.DB, id); // make sure totals are fresh before freezing
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  await c.env.DB.prepare(
    "UPDATE applications_for_payment SET status = 'submitted', submitted_at = ?, submitted_by = ? WHERE id = ?",
  )
    .bind(now, actor, id)
    .run();
  return c.json({ ok: true });
});

/** Move from submitted → certified, with optional certified_amount override. */
applications.post("/:id/certify", async (c) => {
  const denied = requirePermission(c, "projects.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const body = await c.req
    .json<{ certified_amount?: number; notes?: string }>()
    .catch(() => ({} as { certified_amount?: number; notes?: string }));
  const afp = await c.env.DB.prepare(
    "SELECT id, status, amount_due FROM applications_for_payment WHERE id = ?",
  )
    .bind(id)
    .first<{ id: number; status: Status; amount_due: number | null }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.status !== "submitted") return c.json({ error: "only submitted AfPs can be certified" }, 409);
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
  return c.json({ ok: true, certified_amount: certified });
});

/** Mark as paid. */
applications.post("/:id/mark-paid", async (c) => {
  const denied = requirePermission(c, "projects.edit");
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

/** Delete a draft AfP. */
applications.delete("/:id", async (c) => {
  const denied = requirePermission(c, "projects.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const afp = await c.env.DB.prepare(
    "SELECT id, status FROM applications_for_payment WHERE id = ?",
  )
    .bind(id)
    .first<{ id: number; status: Status }>();
  if (!afp) return c.json({ error: "not found" }, 404);
  if (afp.status !== "draft") return c.json({ error: "only drafts can be deleted" }, 409);
  await c.env.DB.prepare("DELETE FROM applications_for_payment WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

export type { AfpRow, AfpLineRow, Direction, Status };
