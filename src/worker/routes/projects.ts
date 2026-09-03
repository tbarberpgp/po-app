import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type { Env, Variables } from "../env";
import { aliasMapsBySupplier, normText } from "../matchMemory";
import { requirePermission } from "../auth";

export const projects = new Hono<{ Bindings: Env; Variables: Variables }>();

projects.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.*, s.id AS active_snapshot_id,
            (SELECT g.name FROM site_groups g WHERE g.id = p.site_group_id) AS site_group_name,
            (SELECT g.base_project_id FROM site_groups g WHERE g.id = p.site_group_id) AS site_group_base,
            CASE WHEN p.id = 'sandbox' THEN 1 ELSE 0 END AS is_sandbox
     FROM projects p
     LEFT JOIN material_snapshots s ON s.project_id = p.id AND s.is_active = 1
     WHERE p.deleted_at IS NULL
     ORDER BY p.created_at DESC`,
  ).all();
  return c.json(rows.results);
});

/** Soft-deleted projects, with PO counts. Superadmin only. */
projects.get("/deleted", async (c) => {
  const denied = requirePermission(c, "projects.delete");
  if (denied) return denied;
  const rows = await c.env.DB.prepare(
    `SELECT p.*,
            (SELECT COUNT(*) FROM purchase_orders po
             WHERE po.project_id = p.id AND po.status != 'deleted') AS po_count
     FROM projects p
     WHERE p.deleted_at IS NOT NULL
     ORDER BY p.deleted_at DESC`,
  ).all();
  return c.json(rows.results);
});

/** Undo a project soft-delete. Restores the original code if it's free,
 * otherwise appends -1, -2, etc until a free slot opens up. */
projects.post("/:id/restore", async (c) => {
  const denied = requirePermission(c, "projects.delete");
  if (denied) return denied;

  const id = c.req.param("id");
  const project = await c.env.DB.prepare(
    "SELECT id, code FROM projects WHERE id = ? AND deleted_at IS NOT NULL",
  )
    .bind(id)
    .first<{ id: string; code: string }>();
  if (!project) return c.json({ error: "not found or not deleted" }, 404);

  // Strip the "#deleted-<timestamp>" suffix we added on delete.
  const original = project.code.split("#deleted-")[0];

  // Find a free code.
  let candidate = original;
  let suffix = 1;
  while (true) {
    const conflict = await c.env.DB.prepare(
      "SELECT 1 AS x FROM projects WHERE code = ? AND deleted_at IS NULL AND id != ?",
    )
      .bind(candidate, id)
      .first();
    if (!conflict) break;
    candidate = `${original}-${suffix++}`;
    if (suffix > 50) return c.json({ error: "too many code conflicts; please rename manually" }, 409);
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE projects
       SET deleted_at = NULL, deleted_by = NULL, deletion_reason = NULL, code = ?
       WHERE id = ?`,
  )
    .bind(candidate, id)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('project', ?, 'restored', ?, ?, ?)`,
  )
    .bind(id, c.get("userEmail"), JSON.stringify({ restored_code: candidate, original_code: original }), now)
    .run();

  return c.json({ ok: true, code: candidate });
});

projects.post("/", async (c) => {
  const denied = requirePermission(c, "projects.create");
  if (denied) return denied;
  const body = await c.req.json<{ code: string; name: string; client?: string }>();
  if (!body.code || !body.name) {
    return c.json({ error: "code and name are required" }, 400);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  try {
    await c.env.DB.prepare(
      `INSERT INTO projects (id, code, name, client, currency, created_at, created_by)
       VALUES (?, ?, ?, ?, 'GBP', ?, ?)`,
    )
      .bind(id, body.code.trim(), body.name.trim(), body.client?.trim() ?? null, now, actor)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) return c.json({ error: "Project code already exists" }, 409);
    throw e;
  }
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('project', ?, 'created', ?, ?, ?)`,
  )
    .bind(id, actor, JSON.stringify({ code: body.code, name: body.name }), now)
    .run();
  return c.json({ id });
});

projects.get("/:id", async (c) => {
  const id = c.req.param("id");
  const project = await c.env.DB.prepare(
    "SELECT *, CASE WHEN id = 'sandbox' THEN 1 ELSE 0 END AS is_sandbox FROM projects WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(id)
    .first();
  if (!project) return c.json({ error: "not found" }, 404);
  const snapshot = await c.env.DB.prepare(
    "SELECT * FROM material_snapshots WHERE project_id = ? AND is_active = 1",
  )
    .bind(id)
    .first();
  // Does this job have a Quality Inspection & Test Plan? Drives whether the
  // Quality tab appears. It used to be `project.code === "26004"` in the
  // client — QITP is a general capability and the only thing tying it to one
  // job is which project happens to have a plan.
  //
  // Cabins count as well as sections: a plan being built out in either order
  // should light the tab up rather than depend on which table was filled first.
  let has_qitp = false;
  try {
    const q = await c.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM qitp_sections WHERE project_id = ?)
            + (SELECT COUNT(*) FROM qitp_cabins WHERE project_id = ?) AS n`,
    ).bind(id, id).first<{ n: number }>();
    has_qitp = (q?.n ?? 0) > 0;
  } catch { /* QITP tables predate migration 0062 — no plan, no tab */ }
  return c.json({ project, active_snapshot: snapshot, has_qitp });
});

projects.delete("/:id", async (c) => {
  const denied = requirePermission(c, "projects.delete");
  if (denied) return denied;

  const id = c.req.param("id");
  const actor = c.get("userEmail");
  const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }));
  const reason = (body.reason ?? "").trim();
  if (!reason) return c.json({ error: "deletion reason is required" }, 400);

  const project = await c.env.DB.prepare(
    "SELECT id, code FROM projects WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(id)
    .first<{ id: string; code: string }>();
  if (!project) return c.json({ error: "not found" }, 404);

  const now = new Date().toISOString();
  // Rename the code so the original is free for a fresh project (unique constraint).
  // The full original code stays visible in the audit_log details.
  const freedCode = `${project.code}#deleted-${Date.now()}`;
  await c.env.DB.prepare(
    `UPDATE projects
       SET deleted_at = ?, deleted_by = ?, deletion_reason = ?, code = ?
       WHERE id = ?`,
  )
    .bind(now, actor, reason, freedCode, id)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('project', ?, 'deleted', ?, ?, ?)`,
  )
    .bind(id, actor, JSON.stringify({ reason, original_code: project.code }), now)
    .run();
  return c.json({ ok: true });
});

/* ── Contract / client-PO extraction ─────────────────────────────────────
 * Upload the signed contract or the client's purchase order; Claude reads it
 * and returns the commercial details so the UI can offer them field-by-field
 * (nothing is applied automatically). */

const CONTRACT_TOOL: Anthropic.Tool = {
  name: "extract_contract",
  description: "Record the commercial details extracted from a construction contract or client purchase order.",
  input_schema: {
    type: "object",
    properties: {
      client_name: { type: ["string", "null"], description: "The client / employer we are contracting with (not Power Grid Projects)" },
      client_contact_name: { type: ["string", "null"] },
      client_email: { type: ["string", "null"] },
      reference: { type: ["string", "null"], description: "Contract or order reference number" },
      contract_sum: { type: ["number", "null"], description: "Contract sum / order value ex VAT, plain number" },
      payment_terms: { type: ["string", "null"], description: "Payment terms as stated, e.g. '30 days from application'" },
      application_cadence: { type: ["string", "null"], enum: ["weekly", "biweekly", "monthly", null], description: "How often applications/valuations are made, if stated" },
      retention_pct: { type: ["number", "null"], description: "Retention percentage, e.g. 3 for 3%" },
      site_address: { type: ["string", "null"], description: "Site / delivery address for the works" },
      start_date: { type: ["string", "null"], description: "Commencement date YYYY-MM-DD if stated" },
      completion_date: { type: ["string", "null"], description: "Completion date YYYY-MM-DD if stated" },
    },
    required: [],
  },
};

function contractBufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

projects.post("/:id/extract-contract", async (c) => {
  const denied = requirePermission(c, "projects.edit");
  if (denied) return denied;
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not configured (needed to read contracts)" }, 500);
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  if (!(file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))) {
    return c.json({ error: "Upload the contract as a PDF." }, 400);
  }
  const client = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 2048,
    system:
      "You are a UK construction commercial manager reading a contract, subcontract order or client purchase order issued TO Power Grid Projects Ltd. " +
      "Extract the commercial particulars. The CLIENT is the party engaging Power Grid Projects — never Power Grid Projects itself. " +
      "Numbers plain (no £ or commas); dates as YYYY-MM-DD; leave anything not stated null rather than guessing.",
    tools: [CONTRACT_TOOL],
    tool_choice: { type: "tool", name: "extract_contract" },
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: contractBufToBase64(await file.arrayBuffer()) } },
        { type: "text", text: "Extract the commercial details via extract_contract." },
      ],
    }],
  });
  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  return c.json({ extracted: toolUse?.input ?? {} });
});

projects.put("/:id", async (c) => {
  const denied = requirePermission(c, "projects.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    client?: string | null;
    client_email?: string | null;
    client_contact_name?: string | null;
    site_manager_email?: string | null;
    project_manager_email?: string | null;
    commercial_manager_email?: string | null;
    delivery_address?: string | null;
    site_contact_name?: string | null;
    site_contact_phone?: string | null;
    delivery_instructions?: string | null;
    retention_pct?: number;
    client_vat_pct?: number;
    client_retention_pct?: number;
    labour_vat_pct?: number;
    labour_retention_pct?: number;
  }>();
  const allowed = [
    "name",
    "client",
    "client_email",
    "client_contact_name",
    "site_manager_email",
    "project_manager_email",
    "commercial_manager_email",
    "payment_terms",
    "application_cadence",
    "delivery_address",
    "site_contact_name",
    "site_contact_phone",
    "delivery_instructions",
    "retention_pct",
    "client_vat_pct",
    "client_retention_pct",
    "labour_vat_pct",
    "labour_retention_pct",
  ] as const;
  const entries: Array<{ col: string; val: unknown }> = [];
  for (const k of allowed) {
    if (k in body) {
      const v = (body as Record<string, unknown>)[k];
      entries.push({ col: k, val: typeof v === "string" ? v.trim() || null : v ?? null });
    }
  }
  if (entries.length === 0) return c.json({ error: "nothing to update" }, 400);
  // Columns added by migration 0045; if it hasn't been applied to this DB yet
  // the UPDATE throws, so we retry without them rather than 500 the whole save.
  const runUpdate = async (cols: Array<{ col: string; val: unknown }>) => {
    if (cols.length === 0) return;
    await c.env.DB.prepare(`UPDATE projects SET ${cols.map((e) => `${e.col} = ?`).join(", ")} WHERE id = ?`)
      .bind(...cols.map((e) => e.val), id)
      .run();
  };
  try {
    await runUpdate(entries);
  } catch (e) {
    console.warn("project update fell back (pre-0045):", e instanceof Error ? e.message : e);
    await runUpdate(entries.filter((e) => e.col !== "project_manager_email" && e.col !== "commercial_manager_email"));
  }
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('project', ?, 'updated', ?, ?, ?)`,
  )
    .bind(id, c.get("userEmail"), JSON.stringify(body), new Date().toISOString())
    .run();
  return c.json({ ok: true });
});

/** Mark a project complete / re-open it. Completion is a soft status flag — the
 *  project stays fully editable (POs/applications can still be raised); the
 *  workspace can filter on it. Re-open clears the flag. */
projects.post("/:id/complete", async (c) => {
  const denied = requirePermission(c, "projects.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const project = await c.env.DB.prepare(
    "SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL",
  ).bind(id).first<{ id: string }>();
  if (!project) return c.json({ error: "not found" }, 404);
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  await c.env.DB.prepare(
    "UPDATE projects SET completed_at = ?, completed_by = ? WHERE id = ?",
  ).bind(now, actor, id).run();
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('project', ?, 'completed', ?, ?, ?)`,
  ).bind(id, actor, JSON.stringify({ completed_at: now }), now).run();
  return c.json({ ok: true, completed_at: now });
});

projects.post("/:id/reopen", async (c) => {
  const denied = requirePermission(c, "projects.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const project = await c.env.DB.prepare(
    "SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL",
  ).bind(id).first<{ id: string }>();
  if (!project) return c.json({ error: "not found" }, 404);
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  await c.env.DB.prepare(
    "UPDATE projects SET completed_at = NULL, completed_by = NULL WHERE id = ?",
  ).bind(id).run();
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('project', ?, 'reopened', ?, ?, ?)`,
  ).bind(id, actor, "{}", now).run();
  return c.json({ ok: true });
});

projects.get("/:id/summary", async (c) => {
  const id = c.req.param("id");
  // Spend outside the priced BOQ — the unpriced PO lines still in play (not
  // rejected). Returned as the actual lines (not just a sum) so the UI can drill
  // into "what made up unpriced spend". Call-offs are EXCLUDED: a framework
  // reserves the value and its call-offs draw within it, so counting call-off
  // lines here would double-book (matches the committed/forecast-cost rule).
  // Lines CODED to a budget line (material_id set) are excluded: their £ folds
  // into that material's committed spend, so listing them here too would tell
  // the story twice. Assigning a line from the Unexpected-spend drill is what
  // moves it from this list into the budget.
  const unpricedLines = await c.env.DB.prepare(
    `SELECT po.id AS po_id, pl.id AS line_id, po.po_number AS po_number, po.supplier AS supplier,
            pl.item AS item, pl.qty AS qty, pl.unit AS unit,
            COALESCE(pl.line_total, 0) AS line_total, po.status AS status,
            -- Prelim orders (welfare, plant, scaffold) carry their own
            -- Preliminaries budget, so which category a line came from decides
            -- whether this money is genuinely unbudgeted. Surfaced on the drill
            -- rather than left for a database query to answer.
            COALESCE(po.category, 'materials') AS category
     FROM po_lines pl
     JOIN purchase_orders po ON po.id = pl.po_id
     WHERE po.project_id = ?
       AND po.status IN ('approved', 'issued', 'pending_approval')
       AND pl.is_unpriced = 1
       AND pl.material_id IS NULL
       AND COALESCE(po.order_type, 'standard') != 'call_off'
     ORDER BY pl.line_total DESC`,
  )
    .bind(id)
    .all<{ po_id: string; line_id: number; po_number: string; supplier: string | null; item: string; qty: number | null; unit: string | null; line_total: number; status: string; category: string }>();

  const counts = await c.env.DB.prepare(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(total_value), 0) AS v
     FROM purchase_orders WHERE project_id = ? GROUP BY status`,
  )
    .bind(id)
    .all<{ status: string; n: number; v: number }>();

  // Framework lines on THIS project where live call-off draws exceed the
  // agreed qty or the line's budgeted value — same live check as the
  // portfolio dashboard signal, scoped to one project for the project page's
  // own "Needs attention" card.
  const overdrawnRows = await c.env.DB.prepare(
    `SELECT * FROM (
       SELECT po.id AS po_id, pl.id AS line_id, po.po_number AS po_number, po.supplier AS supplier,
              pl.item AS item, pl.unit AS unit, pl.qty AS framework_qty, pl.line_total AS framework_value,
              COALESCE((
                SELECT SUM(cl.qty) FROM po_lines cl JOIN purchase_orders cp ON cp.id = cl.po_id
                 WHERE cp.parent_po_id = po.id AND cp.status IN ('approved','issued','pending_approval')
                   AND lower(cl.item) = lower(pl.item)
              ), 0) AS drawn_qty,
              COALESCE((
                SELECT SUM(cl.line_total) FROM po_lines cl JOIN purchase_orders cp ON cp.id = cl.po_id
                 WHERE cp.parent_po_id = po.id AND cp.status IN ('approved','issued','pending_approval')
                   AND lower(cl.item) = lower(pl.item)
              ), 0) AS drawn_value
         FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
        WHERE po.project_id = ? AND po.order_type = 'framework' AND po.status != 'deleted'
     ) WHERE drawn_qty > framework_qty + 0.0001 OR drawn_value > framework_value + 0.005`,
  )
    .bind(id)
    .all<{
      po_id: string; line_id: number; po_number: string; supplier: string | null; item: string; unit: string;
      framework_qty: number; framework_value: number; drawn_qty: number; drawn_value: number;
    }>();

  const unpriced_spend = unpricedLines.results.reduce((s, r) => s + (r.line_total ?? 0), 0);

  // Codings this project's team has already made. Assigning a PO line to a
  // budget line records the mapping (learnAliases in pos.ts, kind
  // 'budget_item') so "the same mapping never has to be made by hand twice" —
  // but until now only the invoice matcher read those aliases back. The person
  // who patiently taught the app that this supplier's "Carriage" belongs to a
  // particular budget line got no benefit on the screen where they taught it,
  // and coded it again the next month.
  //
  // Suggested, never applied: the £ still sits in unpriced spend until someone
  // accepts it. Auto-coding at this point would silently move money between
  // budget lines, and at PO creation it would also change approval routing —
  // a wrongly-learned alias could let an order auto-approve.
  const suggestions = new Map<number, { material_id: number; item: string }>();
  if (unpricedLines.results.length > 0) {
    try {
      const [aliases, mats] = await Promise.all([
        aliasMapsBySupplier(c.env.DB, "budget_item"),
        c.env.DB.prepare(
          `SELECT m.id, m.item FROM materials m
             JOIN material_snapshots s ON s.id = m.snapshot_id
            WHERE s.project_id = ? AND s.is_active = 1`,
        ).bind(id).all<{ id: number; item: string }>(),
      ]);
      // target_norm (the budget line's wording) back to a material on THIS
      // project — an alias learned on another job still applies here, as long
      // as this project's bill carries a line with the same wording.
      const byNorm = new Map<string, { material_id: number; item: string }>();
      for (const m of mats.results) {
        const k = normText(m.item);
        if (k && !byNorm.has(k)) byNorm.set(k, { material_id: m.id, item: m.item });
      }
      for (const l of unpricedLines.results) {
        const key = normText(l.item);
        if (!key) continue;
        // Supplier-specific memory first, then the catch-all bucket — the same
        // precedence aliasMap applies.
        const target = aliases.get(normText(l.supplier))?.get(key) ?? aliases.get("")?.get(key);
        const hit = target ? byNorm.get(target) : undefined;
        if (hit) suggestions.set(l.line_id, hit);
      }
    } catch { /* no memory table yet — no suggestions, everything else stands */ }
  }

  return c.json({
    unpriced_spend,
    unpriced_lines: unpricedLines.results.map((l) => {
      const s = suggestions.get(l.line_id);
      return s ? { ...l, suggested_material_id: s.material_id, suggested_material_item: s.item } : l;
    }),
    by_status: counts.results,
    overdrawn_framework_lines: overdrawnRows.results,
  });
});

// ── Contract register (Commercials → Contract) ──────────────────────────────
// Risk register + key contract items. Commercial readers see them; commercial
// editors maintain them.

projects.get("/:id/contract-register", async (c) => {
  const denied = requirePermission(c, "commercial.view");
  if (denied) return denied;
  const id = c.req.param("id");
  const [risks, items] = await Promise.all([
    c.env.DB.prepare(
      `SELECT * FROM project_risks WHERE project_id = ?
        ORDER BY status = 'closed', likelihood * impact DESC, created_at`,
    ).bind(id).all(),
    c.env.DB.prepare(
      `SELECT * FROM project_key_items WHERE project_id = ?
        ORDER BY status = 'done', due_date IS NULL, due_date, created_at`,
    ).bind(id).all(),
  ]);
  return c.json({ risks: risks.results, key_items: items.results });
});

projects.post("/:id/risks", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const b = await c.req.json<{ title?: string; category?: string; likelihood?: number; impact?: number; mitigation?: string; owner?: string; cost_exposure?: number }>();
  const title = (b.title ?? "").trim();
  if (!title) return c.json({ error: "title required" }, 400);
  const clamp = (n: unknown) => Math.min(5, Math.max(1, Math.round(Number(n) || 3)));
  const row = await c.env.DB.prepare(
    `INSERT INTO project_risks (project_id, title, category, likelihood, impact, mitigation, owner, cost_exposure, created_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`,
  ).bind(
    id, title, b.category?.trim() || null, clamp(b.likelihood), clamp(b.impact),
    b.mitigation?.trim() || null, b.owner?.trim() || null,
    b.cost_exposure != null && Number.isFinite(Number(b.cost_exposure)) ? Number(b.cost_exposure) : null,
    new Date().toISOString(), c.get("userEmail") ?? null,
  ).first();
  return c.json(row);
});

projects.patch("/risks/:riskId", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const b = await c.req.json<Record<string, unknown>>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  const clamp = (n: unknown) => Math.min(5, Math.max(1, Math.round(Number(n) || 3)));
  for (const k of ["title", "category", "mitigation", "owner"] as const) {
    if (k in b) { sets.push(`${k} = ?`); binds.push(typeof b[k] === "string" && (b[k] as string).trim() ? (b[k] as string).trim() : null); }
  }
  if ("likelihood" in b) { sets.push("likelihood = ?"); binds.push(clamp(b.likelihood)); }
  if ("impact" in b) { sets.push("impact = ?"); binds.push(clamp(b.impact)); }
  if ("cost_exposure" in b) {
    sets.push("cost_exposure = ?");
    binds.push(b.cost_exposure != null && Number.isFinite(Number(b.cost_exposure)) ? Number(b.cost_exposure) : null);
  }
  if ("status" in b) {
    const st = b.status === "closed" ? "closed" : "open";
    sets.push("status = ?", "closed_at = ?");
    binds.push(st, st === "closed" ? new Date().toISOString() : null);
  }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  binds.push(c.req.param("riskId"));
  const row = await c.env.DB.prepare(`UPDATE project_risks SET ${sets.join(", ")} WHERE id = ? RETURNING *`).bind(...binds).first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

projects.delete("/risks/:riskId", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  await c.env.DB.prepare("DELETE FROM project_risks WHERE id = ?").bind(c.req.param("riskId")).run();
  return c.json({ ok: true });
});

projects.post("/:id/key-items", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const b = await c.req.json<{ title?: string; detail?: string; due_date?: string }>();
  const title = (b.title ?? "").trim();
  if (!title) return c.json({ error: "title required" }, 400);
  const row = await c.env.DB.prepare(
    `INSERT INTO project_key_items (project_id, title, detail, due_date, created_at, created_by)
     VALUES (?,?,?,?,?,?) RETURNING *`,
  ).bind(
    id, title, b.detail?.trim() || null, b.due_date?.slice(0, 10) || null,
    new Date().toISOString(), c.get("userEmail") ?? null,
  ).first();
  return c.json(row);
});

projects.patch("/key-items/:itemId", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const b = await c.req.json<Record<string, unknown>>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if ("title" in b && typeof b.title === "string" && b.title.trim()) { sets.push("title = ?"); binds.push(b.title.trim()); }
  if ("detail" in b) { sets.push("detail = ?"); binds.push(typeof b.detail === "string" && b.detail.trim() ? b.detail.trim() : null); }
  if ("due_date" in b) { sets.push("due_date = ?"); binds.push(typeof b.due_date === "string" && b.due_date ? b.due_date.slice(0, 10) : null); }
  if ("status" in b) {
    const st = b.status === "done" ? "done" : "open";
    sets.push("status = ?", "done_at = ?");
    binds.push(st, st === "done" ? new Date().toISOString() : null);
  }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  binds.push(c.req.param("itemId"));
  const row = await c.env.DB.prepare(`UPDATE project_key_items SET ${sets.join(", ")} WHERE id = ? RETURNING *`).bind(...binds).first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

projects.delete("/key-items/:itemId", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  await c.env.DB.prepare("DELETE FROM project_key_items WHERE id = ?").bind(c.req.param("itemId")).run();
  return c.json({ ok: true });
});
