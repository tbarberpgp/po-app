import { Hono } from "hono";
import type { Env, Variables } from "../env";
import {
  parseContractItems, parseMaterialsSheet, parseSummaryCostSheet,
  readPricingWorkbook, reconcileCommercials,
} from "../../shared/parse-xlsx";
import type { ParsedMaterial, ParsedCommercialRow, ParsedContractItem, LabourRateLine } from "../../shared/parse-xlsx";
import { requirePermission } from "../auth";
import { loadSettings, tierForApproval } from "../approval";
import { autoTagFromBill, baseProject } from "./programme";

export const materials = new Hono<{ Bindings: Env; Variables: Variables }>();

/** When a project's priced bill becomes live (upload by a superadmin, or a
 *  pending upload approved), re-link it to any existing programme so the
 *  Materials & stock tab populates without re-importing the programme. Uses
 *  replace=true because a new upload is a NEW snapshot with new bill-line ids —
 *  any existing links point at the now-inactive snapshot and must be re-pointed,
 *  or stock demand (which only reads the active snapshot) stays empty. Best-effort
 *  — never fails the upload. */
async function relinkProgramme(db: D1Database, projectId: string): Promise<void> {
  try { await autoTagFromBill(db, await baseProject(db, projectId), true); }
  catch (e) { console.warn("programme relink skipped:", e instanceof Error ? e.message : e); }
}

/** Upload a pricing workbook for a project. Replaces the active snapshot. */
materials.post("/:projectId/upload", async (c) => {
  const denied = requirePermission(c, "materials.upload");
  if (denied) return denied;
  const projectId = c.req.param("projectId");
  const actor = c.get("userEmail");

  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?")
    .bind(projectId)
    .first();
  if (!project) return c.json({ error: "project not found" }, 404);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);

  // Parse Materials (required), Summary Cost Sheet (optional), and Pricing
  // Parse the workbook ONCE with sheets restricted to the three we read
  // (Materials, Summary Cost Sheet, Pricing). Cuts Worker CPU ~7x vs reading
  // every sheet and prevents Cloudflare's resource-limit hit on larger files.
  const buffer = await file.arrayBuffer();
  let parsed;
  let commercials;
  let contractItems;
  try {
    const wb = readPricingWorkbook(buffer);
    parsed = parseMaterialsSheet(wb);
    commercials = parseSummaryCostSheet(wb);
    contractItems = parseContractItems(wb);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "parse failed" }, 400);
  }
  if (parsed.length === 0) return c.json({ error: "No material rows found" }, 400);

  const out = await persistParsedWorkbook(c.env.DB, projectId, file.name, actor, {
    materials: parsed,
    commercials,
    contract_items: contractItems,
  }, { pending: c.get("userRole") !== "superadmin" });
  if (!out.pending) await relinkProgramme(c.env.DB, projectId);
  return c.json(out);
});

/**
 * Same as /upload but the client has already parsed the workbook locally
 * and sends the JSON results. Avoids running the xlsx zip decode + sheet
 * parse on the Worker — which can hit Cloudflare's 30s / 128MB resource
 * limits for larger pricing files. The bytes never reach the server.
 */
materials.post("/:projectId/upload-parsed", async (c) => {
  const denied = requirePermission(c, "materials.upload");
  if (denied) return denied;
  const projectId = c.req.param("projectId");
  const actor = c.get("userEmail");

  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?")
    .bind(projectId)
    .first();
  if (!project) return c.json({ error: "project not found" }, 404);

  const body = await c.req.json<{
    filename: string;
    materials: ParsedMaterial[];
    commercials?: ParsedCommercialRow[];
    contract_items?: ParsedContractItem[];
  }>();
  if (!body.filename || !Array.isArray(body.materials) || body.materials.length === 0) {
    return c.json({ error: "filename + materials[] required" }, 400);
  }

  const out = await persistParsedWorkbook(c.env.DB, projectId, body.filename, actor, {
    materials: body.materials,
    commercials: body.commercials ?? [],
    contract_items: body.contract_items ?? [],
  }, { pending: c.get("userRole") !== "superadmin" });
  if (!out.pending) await relinkProgramme(c.env.DB, projectId);
  return c.json(out);
});

/** The pending (awaiting superadmin approval) pricing upload for a project, or null. */
materials.get("/:projectId/pending-upload", async (c) => {
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(`pending_snapshot:${c.req.param("projectId")}`).first<{ value: string }>();
  if (!row?.value) return c.json(null);
  try { return c.json(JSON.parse(row.value)); } catch { return c.json(null); }
});

/** Approve the pending pricing upload → make it the live snapshot. Superadmin only. */
materials.post("/:projectId/pending-upload/approve", async (c) => {
  if (c.get("userRole") !== "superadmin") return c.json({ error: "Only a superadmin can approve a pricing upload" }, 403);
  const projectId = c.req.param("projectId");
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(`pending_snapshot:${projectId}`).first<{ value: string }>();
  let snapshotId: number | undefined;
  try { snapshotId = (JSON.parse(row?.value ?? "null") as { snapshot_id?: number } | null)?.snapshot_id; } catch { /* */ }
  if (!snapshotId) return c.json({ error: "no pending upload" }, 404);
  const exists = await c.env.DB.prepare("SELECT id FROM material_snapshots WHERE id = ? AND project_id = ?").bind(snapshotId, projectId).first();
  if (!exists) {
    await c.env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(`pending_snapshot:${projectId}`).run();
    return c.json({ error: "pending upload no longer exists" }, 409);
  }
  await c.env.DB.prepare("UPDATE material_snapshots SET is_active = 0 WHERE project_id = ? AND is_active = 1").bind(projectId).run();
  await c.env.DB.prepare("UPDATE material_snapshots SET is_active = 1 WHERE id = ?").bind(snapshotId).run();
  await c.env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(`pending_snapshot:${projectId}`).run();
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at) VALUES ('snapshot', ?, 'approved', ?, ?, ?)`,
  ).bind(String(snapshotId), c.get("userEmail"), row?.value ?? "", new Date().toISOString()).run();
  await relinkProgramme(c.env.DB, projectId);  // now-live bill links to any existing programme
  return c.json({ ok: true });
});

/** Reject the pending pricing upload → discard it. Superadmin only. */
materials.post("/:projectId/pending-upload/reject", async (c) => {
  if (c.get("userRole") !== "superadmin") return c.json({ error: "Only a superadmin can reject a pricing upload" }, 403);
  const projectId = c.req.param("projectId");
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(`pending_snapshot:${projectId}`).first<{ value: string }>();
  if (row?.value) {
    try {
      const p = JSON.parse(row.value) as { snapshot_id?: number };
      if (p.snapshot_id) await c.env.DB.prepare("DELETE FROM material_snapshots WHERE id = ? AND is_active = 0").bind(p.snapshot_id).run();
    } catch { /* */ }
  }
  await c.env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(`pending_snapshot:${projectId}`).run();
  return c.json({ ok: true });
});

/** All pending pricing uploads across projects, for the Approvals inbox. Superadmin only.
 *  Two-segment static path so it can't be shadowed by the /:projectId routes. */
materials.get("/_pending/uploads", async (c) => {
  if (c.get("userRole") !== "superadmin") return c.json([]);
  const rows = await c.env.DB.prepare(
    `SELECT s.value, p.code AS project_code, p.name AS project_name,
            substr(s.key, length('pending_snapshot:') + 1) AS project_id
     FROM settings s
     LEFT JOIN projects p ON p.id = substr(s.key, length('pending_snapshot:') + 1)
     WHERE s.key LIKE 'pending_snapshot:%'`,
  ).all<{ value: string; project_code: string | null; project_name: string | null; project_id: string }>();
  const out = rows.results.map((r) => {
    let info: Record<string, unknown> = {};
    try { info = JSON.parse(r.value); } catch { /* */ }
    return { project_id: r.project_id, project_code: r.project_code, project_name: r.project_name, ...info };
  });
  return c.json(out);
});

/**
 * Wipes the current active snapshot for the project and writes a new one
 * with all the rows from `parsed`. Used by both the multipart upload (where
 * the worker parses) and the JSON upload (where the client parses).
 */
async function persistParsedWorkbook(
  db: D1Database,
  projectId: string,
  filename: string,
  actor: string,
  parsed: {
    materials: ParsedMaterial[];
    commercials: ParsedCommercialRow[];
    contract_items: ParsedContractItem[];
  },
  opts?: { pending?: boolean },
) {
  // When `pending`, the new snapshot is parked inactive and the project keeps
  // its current live pricing until a superadmin approves it.
  const pending = opts?.pending ?? false;
  const now = new Date().toISOString();
  if (!pending) {
    await db
      .prepare("UPDATE material_snapshots SET is_active = 0 WHERE project_id = ? AND is_active = 1")
      .bind(projectId)
      .run();
  }
  const snap = await db
    .prepare(
      `INSERT INTO material_snapshots (project_id, uploaded_at, uploaded_by, filename, is_active)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(projectId, now, actor, filename, pending ? 0 : 1)
    .first<{ id: number }>();
  const snapshotId = snap!.id;

  // Batch insert materials.
  const matStmts = parsed.materials.map((m) =>
    db.prepare(
      `INSERT INTO materials (
         snapshot_id, item, type, element_code, manufacturer, pack_qty, pack_unit, cost, cost_unit,
         coverage_qty, coverage_unit, waste_pct, unit_rate, rate_unit,
         total_qty, total_qty_unit, total_units, total_units_unit, material_total_cost,
         labour_unit_cost, labour_total_cost
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      snapshotId, m.item, m.type, m.element_code, m.manufacturer,
      m.pack_qty, m.pack_unit, m.cost, m.cost_unit,
      m.coverage_qty, m.coverage_unit, m.waste_pct, m.unit_rate, m.rate_unit,
      m.total_qty, m.total_qty_unit, m.total_units, m.total_units_unit, m.material_total_cost,
      m.labour_unit_cost, m.labour_total_cost,
    ),
  );
  await db.batch(matStmts);

  if (parsed.contract_items.length > 0) {
    const ciStmts = parsed.contract_items.map((ci) =>
      db.prepare(
        `INSERT INTO contract_items
           (snapshot_id, item_no, category, section, description, qty, unit,
            sell_rate, sell_total, labour_rate, labour_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        snapshotId, ci.item_no, ci.category ?? "measured", ci.section, ci.description, ci.qty, ci.unit,
        ci.sell_rate, ci.sell_total, ci.labour_rate, ci.labour_total,
      ),
    );
    await db.batch(ciStmts);

    // Persist each bill item's component build-up (Pricing sub-rows) — the basis
    // for programme-driven material/stock demand. Resolve the inserted contract
    // item ids by item_no, then batch the components. Wrapped so a not-yet-applied
    // migration (contract_item_components) can't fail the whole pricing upload.
    try {
      const idRows = await db.prepare("SELECT id, item_no FROM contract_items WHERE snapshot_id = ?")
        .bind(snapshotId).all<{ id: number; item_no: number }>();
      const idByItemNo = new Map(idRows.results.map((r) => [r.item_no, r.id]));
      const compStmts: D1PreparedStatement[] = [];
      for (const ci of parsed.contract_items) {
        const cid = idByItemNo.get(ci.item_no);
        if (!cid || !ci.components?.length) continue;
        ci.components.forEach((comp, j) => {
          compStmts.push(db.prepare(
            `INSERT INTO contract_item_components (contract_item_id, name, girth, qty, unit, material_rate, display_order)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(cid, comp.name, comp.girth, comp.qty, comp.unit, comp.material_rate, j));
        });
      }
      if (compStmts.length) await db.batch(compStmts);
    } catch (e) {
      console.warn("bill component persist skipped (apply migration 0049_bill_components):", e instanceof Error ? e.message : e);
    }
  }

  if (parsed.commercials.length > 0) {
    // Reconcile against the materials sheet so we don't persist a broken
    // GP from the workbook (e.g. inner Measured Works Cost cell missing).
    const reconciled = reconcileCommercials(parsed.commercials, parsed.materials);
    const commStmts = reconciled.map((r) =>
      db.prepare(
        `INSERT INTO project_commercials
           (snapshot_id, category, value, cost, gross_profit, gross_profit_pct, is_total, display_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        snapshotId, r.category, r.value, r.cost, r.gross_profit,
        r.gross_profit_pct, r.is_total ? 1 : 0, r.display_order,
      ),
    );
    await db.batch(commStmts);
  }

  await db.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('snapshot', ?, 'uploaded', ?, ?, ?)`,
  )
    .bind(
      String(snapshotId), actor,
      JSON.stringify({
        filename, rows: parsed.materials.length,
        commercials: parsed.commercials.length,
        contract_items: parsed.contract_items.length,
      }),
      now,
    )
    .run();

  if (pending) {
    // Replace any earlier pending upload for this project (drop its snapshot),
    // then record this one as the project's pending pricing upload.
    const prev = await db.prepare("SELECT value FROM settings WHERE key = ?")
      .bind(`pending_snapshot:${projectId}`).first<{ value: string }>();
    if (prev?.value) {
      try {
        const p = JSON.parse(prev.value) as { snapshot_id?: number };
        if (p.snapshot_id && p.snapshot_id !== snapshotId) {
          await db.prepare("DELETE FROM material_snapshots WHERE id = ? AND is_active = 0").bind(p.snapshot_id).run();
        }
      } catch { /* ignore */ }
    }
    await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .bind(`pending_snapshot:${projectId}`, JSON.stringify({
        snapshot_id: snapshotId, filename, uploaded_at: now, uploaded_by: actor,
        rows: parsed.materials.length, commercials: parsed.commercials.length, contract_items: parsed.contract_items.length,
      })).run();
  }

  return {
    snapshot_id: snapshotId,
    pending,
    rows: parsed.materials.length,
    commercials: parsed.commercials.length,
    contract_items: parsed.contract_items.length,
  };
}

/**
 * Aggregate labour cost for the active snapshot, grouped by element code so
 * each row maps to a single cost code (PRJ.ELE.L).
 */
materials.get("/:projectId/labour-by-cost-code", async (c) => {
  const projectId = c.req.param("projectId");

  // Labour BUDGET per BOQ section (from the labour BOQ = contract_items).
  const budget = await c.env.DB.prepare(
    `SELECT COALESCE(NULLIF(TRIM(ci.section), ''), 'Other') AS section,
            COUNT(*) AS line_count,
            COALESCE(SUM(ci.labour_total), 0) AS labour_total
     FROM contract_items ci
     JOIN material_snapshots s ON s.id = ci.snapshot_id
     WHERE s.project_id = ? AND s.is_active = 1 AND ci.labour_total > 0
     GROUP BY section`,
  ).bind(projectId).all<{ section: string; line_count: number; labour_total: number }>();

  // Labour CERTIFIED per section (gross line value on certified incoming-labour
  // applications). Same `section` dimension, so % expended is real per row.
  const cert = await c.env.DB.prepare(
    `SELECT COALESCE(NULLIF(TRIM(al.section), ''), 'Other') AS section,
            COALESCE(SUM(al.cumulative_value), 0) AS expended
     FROM afp_lines al
     JOIN applications_for_payment a ON a.id = al.afp_id
     WHERE a.project_id = ? AND a.direction = 'incoming_labour'
       AND a.status IN ('certified', 'paid')
     GROUP BY section`,
  ).bind(projectId).all<{ section: string; expended: number }>();
  const certBySection = new Map(cert.results.map((r) => [r.section, r.expended ?? 0]));

  const out = budget.results
    .map((r) => ({
      section: r.section,
      line_count: r.line_count,
      labour_total: r.labour_total,
      expended: certBySection.get(r.section) ?? 0,
    }))
    .sort((a, b) => b.labour_total - a.labour_total);
  return c.json(out);
});

/** Prelims budget vs expended — prelim-tagged PO commitments + plant-tracker
 *  accrual (day-rate × days on site). Budget = the Preliminaries cost-sheet row. */
materials.get("/:projectId/prelims", async (c) => {
  const projectId = c.req.param("projectId");

  // Prelim line items live in the materials list, tagged as prelims by their
  // element ("Preliminaries") or type. Each is an expenditure heading with its
  // own budget. (Falls back to the Summary Cost Sheet's Preliminaries line for
  // the total when no prelim materials have been entered yet.)
  const prelimMats = await c.env.DB.prepare(
    `SELECT m.item AS name, COALESCE(m.material_total_cost, 0) AS budget
       FROM materials m
       JOIN material_snapshots s ON s.id = m.snapshot_id
       LEFT JOIN elements e ON e.code = m.element_code
      WHERE s.project_id = ? AND s.is_active = 1
        AND (lower(COALESCE(e.name, '')) LIKE '%prelim%' OR lower(COALESCE(m.type, '')) LIKE '%prelim%')
      ORDER BY m.item`,
  ).bind(projectId).all<{ name: string; budget: number }>();

  const budgetRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(pc.cost), 0) AS budget
       FROM project_commercials pc
       JOIN material_snapshots s ON s.id = pc.snapshot_id
      WHERE s.project_id = ? AND s.is_active = 1 AND pc.is_total = 0
        AND lower(pc.category) LIKE '%prelim%'`,
  ).bind(projectId).first<{ budget: number }>();

  const poRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(total_value), 0) AS committed, COUNT(*) AS n
       FROM purchase_orders
      WHERE project_id = ? AND category = 'prelims'
        AND COALESCE(order_type,'standard') != 'call_off'
        AND status IN ('approved','issued','pending_approval')`,
  ).bind(projectId).first<{ committed: number; n: number }>();

  const plant = await c.env.DB.prepare(
    "SELECT day_rate, rate_unit, on_hire_from, off_hire_to FROM plant_logs WHERE project_id = ?",
  ).bind(projectId).all<{ day_rate: number | null; rate_unit: string | null; on_hire_from: string | null; off_hire_to: string | null }>();
  const today = new Date().toISOString().slice(0, 10);
  let plant_accrued = 0;
  for (const p of plant.results) {
    if (p.day_rate == null || !p.on_hire_from) continue;
    const from = new Date(p.on_hire_from + "T00:00:00").getTime();
    const to = new Date((p.off_hire_to ?? today) + "T00:00:00").getTime();
    const days = Math.max(1, Math.floor((to - from) / 86_400_000) + 1);
    const units = p.rate_unit === "week" ? Math.ceil(days / 7) : days;
    plant_accrued += units * p.day_rate;
  }

  // Prelim spend broken down by prelim type (Plant, Site management, …) — taken
  // from the tagged PO line types so the Prelims tab can show where it's going.
  const byType = await c.env.DB.prepare(
    `SELECT COALESCE(NULLIF(TRIM(l.type), ''), 'Untyped') AS type,
            COALESCE(SUM(l.line_total), 0) AS committed,
            COUNT(DISTINCT l.po_id) AS po_count
       FROM po_lines l
       JOIN purchase_orders p ON p.id = l.po_id
      WHERE p.project_id = ? AND p.category = 'prelims'
        AND COALESCE(p.order_type,'standard') != 'call_off'
        AND p.status IN ('approved','issued','pending_approval')
      GROUP BY type
      ORDER BY committed DESC`,
  ).bind(projectId).all<{ type: string; committed: number; po_count: number }>();

  // Labour applications tagged as prelims (a subcontract PM's time etc.) —
  // their cumulative claim expends the heading they're tagged to.
  const labourApps = await c.env.DB.prepare(
    `SELECT COALESCE(NULLIF(TRIM(prelim_heading), ''), 'Untyped') AS type,
            COALESCE(SUM(COALESCE(cumulative_value, 0)), 0) AS committed,
            COUNT(*) AS n
       FROM applications_for_payment
      WHERE project_id = ? AND direction = 'incoming_labour' AND prelim_heading IS NOT NULL
        AND status IN ('submitted', 'certified', 'paid')
      GROUP BY type`,
  ).bind(projectId).all<{ type: string; committed: number; n: number }>();
  const labour_committed = labourApps.results.reduce((s2, r) => s2 + r.committed, 0);

  // Committed spend per prelim heading (matched on the PO line's prelim type).
  const committedByName = new Map<string, { committed: number; po_count: number }>();
  for (const r of byType.results) committedByName.set(r.type, { committed: r.committed, po_count: r.po_count });
  for (const r of labourApps.results) {
    const cur2 = committedByName.get(r.type) ?? { committed: 0, po_count: 0 };
    committedByName.set(r.type, { committed: cur2.committed + r.committed, po_count: cur2.po_count });
  }

  const headings = prelimMats.results.map((h) => {
    const c = committedByName.get(h.name);
    return {
      name: h.name,
      budget: h.budget,
      committed: c?.committed ?? 0,
      po_count: c?.po_count ?? 0,
      remaining: h.budget - (c?.committed ?? 0),
    };
  });
  // Spend tagged to a heading that isn't in the materials list (e.g. legacy or
  // "Other prelim") still needs surfacing, so append those as budget-less rows.
  for (const [name2, v2] of committedByName) {
    if (!prelimMats.results.some((h) => h.name === name2) && !headings.some((h) => h.name === name2)) {
      headings.push({ name: name2, budget: 0, committed: v2.committed, po_count: v2.po_count, remaining: -v2.committed });
    }
  }

  // Budget = sum of prelim materials when present; else the cost-sheet line.
  const matsBudget = prelimMats.results.reduce((s, h) => s + (h.budget || 0), 0);
  const budget = prelimMats.results.length > 0 ? matsBudget : (budgetRow?.budget ?? 0);

  return c.json({
    budget,
    po_committed: poRow?.committed ?? 0,
    po_count: poRow?.n ?? 0,
    labour_committed: Math.round(labour_committed * 100) / 100,
    labour_app_count: labourApps.results.reduce((s2, r) => s2 + r.n, 0),
    plant_accrued: Math.round(plant_accrued * 100) / 100,
    plant_count: plant.results.length,
    by_type: byType.results ?? [],
    headings,
  });
});

/**
 * Return the contract items (work items from the Pricing / Costing Labour
 * Only tabs) for the project's active snapshot. One row per work item with
 * both sell rate and labour rate, so the UI can render a labour BOQ.
 */
materials.get("/:projectId/contract-items", async (c) => {
  const projectId = c.req.param("projectId");
  const rows = await c.env.DB.prepare(
    `SELECT ci.*,
            -- Matched by id OR stored description, so re-uploading the pricing
            -- workbook (which re-mints contract_item ids) doesn't orphan the
            -- applied labour rates. The 5× bound drops basis-mismatch rates.
            (SELECT llr.live_rate FROM labour_live_rates llr
             WHERE (llr.contract_item_id = ci.id
                    OR (llr.description IS NOT NULL AND lower(llr.description) = lower(ci.description)))
               AND llr.project_id = ?
               AND llr.status IN ('applied', 'approved')
               AND llr.live_rate <= COALESCE(ci.labour_rate, llr.live_rate) * 5
             ORDER BY llr.applied_at DESC LIMIT 1) AS live_labour_rate
     FROM contract_items ci
     JOIN material_snapshots s ON s.id = ci.snapshot_id
     WHERE s.project_id = ? AND s.is_active = 1
     ORDER BY ci.item_no`,
  )
    .bind(projectId, projectId)
    .all();
  return c.json(rows.results);
});

// ── Live subcontractor labour rates (the labour analogue of material quotes) ──
//
// A subbie's labour rate schedule (PowerGrid cost-workbook format) is uploaded;
// we read the top-level priced items from the "Costing Labour Only" / "Ancil
// Items" tabs (col A = item, D = qty, E = unit, K = per-unit labour rate,
// M = total), match them to the BOQ labour lines by description, and store the
// agreed rate per line. Savings from Labour = (BOQ rate − live rate) × BOQ qty.

// Labour rate schedule parsing now runs in the browser (parseLabourRates in
// shared/parse-xlsx.ts) — decoding a multi-MB cost workbook on the Worker blew
// Cloudflare's 10ms CPU budget (error 1102). The Worker receives parsed rows.

/** True if `email` is a director-tier approver, project-scoped or global. */
async function isDirectorApprover(db: D1Database, email: string, projectId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 FROM approvers
     WHERE email = ? AND tier = 'director' AND (project_id IS NULL OR project_id = ?) LIMIT 1`,
  ).bind(email, projectId).first();
  return !!row;
}

/**
 * Ingest a labour rate schedule the BROWSER has parsed (rows sent as JSON).
 * Matches the priced labour items to the BOQ labour lines and stores the agreed
 * live rate per line (replacing any previous upload). Parsing is client-side
 * because decoding a multi-MB cost workbook on the Worker blows Cloudflare's
 * 10ms CPU budget (error 1102).
 */
materials.post("/:projectId/labour-rates/upload-parsed", async (c) => {
  const denied = requirePermission(c, "materials.upload");
  if (denied) return denied;
  const projectId = c.req.param("projectId");
  const body = await c.req.json<{ filename?: string; lines?: LabourRateLine[] }>();
  const filename = body.filename?.trim() || "labour schedule";
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (lines.length === 0) return c.json({ error: "no labour rate lines found — check the workbook has a recognised labour/ancil sheet" }, 400);

  const snap = await c.env.DB.prepare(
    "SELECT id FROM material_snapshots WHERE project_id = ? AND is_active = 1",
  ).bind(projectId).first<{ id: number }>();
  if (!snap) return c.json({ error: "upload a pricing workbook first" }, 400);

  const items = (await c.env.DB.prepare(
    "SELECT id, description, qty, labour_rate, labour_total FROM contract_items WHERE snapshot_id = ?",
  ).bind(snap.id).all<{ id: number; description: string; qty: number; labour_rate: number | null; labour_total: number | null }>()).results;
  const labourItems = items.filter((it) => (it.labour_total ?? 0) > 0 || (it.labour_rate ?? 0) > 0);

  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  // A re-upload replaces the prior schedule for this project.
  await c.env.DB.prepare("DELETE FROM labour_live_rates WHERE project_id = ?").bind(projectId).run();

  type Row = { contract_item_id: number; description: string; boq_rate: number; live_rate: number; qty: number; saving: number };
  const appliedLines: Row[] = [];
  const pendingLines: Row[] = [];
  const unmatchedLines: Array<{ description: string; rate: number; unit: string | null }> = [];
  const used = new Set<number>();
  const stmts: D1PreparedStatement[] = [];
  // Tokenise each BOQ description ONCE (not per uploaded line) — the matching
  // is O(lines × items) and re-tokenising inside the loop was a large share of
  // this route's CPU on the free plan's 10ms budget.
  const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length >= 2));
  const itemTokens = new Map(labourItems.map((it) => [it.id, tokens(it.description)] as const));
  const bestMatch = (needle: string) => {
    const lt = tokens(needle);
    if (lt.size === 0) return null;
    let best: typeof labourItems[number] | null = null, bestScore = 0;
    for (const it of labourItems) {
      if (used.has(it.id)) continue;
      const ct = itemTokens.get(it.id)!;
      if (ct.size === 0) continue;
      let overlap = 0;
      for (const t of lt) if (ct.has(t)) overlap++;
      const score = overlap === 0 ? 0 : overlap / (lt.size + ct.size - overlap);
      if (score > bestScore) { bestScore = score; best = it; }
    }
    return bestScore >= 0.25 ? best : null;
  };
  for (const ln of lines) {
    if ((ln.rate ?? 0) <= 0) continue; // no live rate quoted → leave line at BOQ
    const m = bestMatch(ln.description);
    if (!m) {
      unmatchedLines.push({ description: ln.description, rate: ln.rate, unit: ln.unit });
      // Persist so it can be allocated to a BOQ line later (contract_item_id 0 = unallocated).
      stmts.push(c.env.DB.prepare(
        `INSERT INTO labour_live_rates
           (project_id, snapshot_id, contract_item_id, description, qty, boq_rate, live_rate, source, status, applied_at, applied_by)
         VALUES (?, ?, 0, ?, 0, 0, ?, ?, 'unmatched', ?, ?)`,
      ).bind(projectId, snap.id, ln.description + (ln.unit ? ` (${ln.unit})` : ""), ln.rate, filename, now, actor));
      continue;
    }
    used.add(m.id);
    const boqRate = m.labour_rate ?? 0;
    const qty = m.qty ?? 0;
    // Safeguard: a live rate that INCREASES the budget (above the contract rate)
    // is held for director approval; a saving applies straight away.
    const status = ln.rate > boqRate ? "pending_approval" : "applied";
    stmts.push(c.env.DB.prepare(
      `INSERT INTO labour_live_rates
         (project_id, snapshot_id, contract_item_id, description, qty, boq_rate, live_rate, source, status, applied_at, applied_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(projectId, snap.id, m.id, m.description, qty, boqRate, ln.rate, filename, status, now, actor));
    const row: Row = { contract_item_id: m.id, description: m.description, boq_rate: boqRate, live_rate: ln.rate, qty, saving: (boqRate - ln.rate) * qty };
    (status === "pending_approval" ? pendingLines : appliedLines).push(row);
  }
  if (stmts.length > 0) await c.env.DB.batch(stmts);

  return c.json({
    applied: appliedLines.length,
    pending: pendingLines.length,
    unmatched: unmatchedLines.length,
    savings: appliedLines.reduce((s, a) => s + a.saving, 0),
    applied_lines: appliedLines,
    pending_lines: pendingLines,
    unmatched_lines: unmatchedLines,
  });
});

/** List the live labour rates for a project (all statuses), with per-line savings. */
materials.get("/:projectId/labour-rates", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, contract_item_id, description, qty, boq_rate, live_rate, source, status, applied_at, applied_by,
            (COALESCE(boq_rate, 0) - COALESCE(live_rate, 0)) * COALESCE(qty, 0) AS saving
     FROM labour_live_rates
     WHERE project_id = ?
     ORDER BY applied_at DESC, id`,
  ).bind(c.req.param("projectId")).all();
  return c.json(rows.results);
});

/** Director sign-off for a labour rate that increases the budget. */
materials.post("/:projectId/labour-rates/:id/approve", async (c) => {
  const projectId = c.req.param("projectId");
  const email = c.get("userEmail");
  if (!(await isDirectorApprover(c.env.DB, email, projectId))) {
    return c.json({ error: "Only a director-tier approver can approve a labour budget increase" }, 403);
  }
  await c.env.DB.prepare(
    "UPDATE labour_live_rates SET status = 'approved' WHERE id = ? AND project_id = ?",
  ).bind(Number(c.req.param("id")), projectId).run();
  return c.json({ ok: true });
});

/** Allocate an unmatched labour rate to a BOQ labour line. */
materials.post("/:projectId/labour-rates/:id/allocate", async (c) => {
  const denied = requirePermission(c, "materials.upload");
  if (denied) return denied;
  const projectId = c.req.param("projectId");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ contract_item_id: number }>().catch(() => null);
  if (!body?.contract_item_id) return c.json({ error: "contract_item_id required" }, 400);

  const row = await c.env.DB.prepare(
    "SELECT id, live_rate FROM labour_live_rates WHERE id = ? AND project_id = ?",
  ).bind(id, projectId).first<{ id: number; live_rate: number }>();
  if (!row) return c.json({ error: "not found" }, 404);
  const ci = await c.env.DB.prepare(
    "SELECT id, description, qty, labour_rate FROM contract_items WHERE id = ?",
  ).bind(body.contract_item_id).first<{ id: number; description: string; qty: number; labour_rate: number | null }>();
  if (!ci) return c.json({ error: "BOQ line not found" }, 400);

  const boqRate = ci.labour_rate ?? 0;
  // Same safeguard as auto-matching: a rate above the contract rate needs sign-off.
  const status = row.live_rate > boqRate ? "pending_approval" : "applied";
  await c.env.DB.prepare(
    "UPDATE labour_live_rates SET contract_item_id = ?, description = ?, qty = ?, boq_rate = ?, status = ? WHERE id = ?",
  ).bind(ci.id, ci.description, ci.qty ?? 0, boqRate, status, id).run();
  return c.json({ ok: true, status });
});

/** Remove a single live labour rate row (e.g. dismiss an unmatched line). */
materials.delete("/:projectId/labour-rates/:id", async (c) => {
  const denied = requirePermission(c, "materials.upload");
  if (denied) return denied;
  await c.env.DB.prepare("DELETE FROM labour_live_rates WHERE id = ? AND project_id = ?")
    .bind(Number(c.req.param("id")), c.req.param("projectId")).run();
  return c.json({ ok: true });
});

/** Clear all live labour rates for a project (so a fresh schedule can be uploaded). */
materials.delete("/:projectId/labour-rates", async (c) => {
  const denied = requirePermission(c, "materials.upload");
  if (denied) return denied;
  await c.env.DB.prepare("DELETE FROM labour_live_rates WHERE project_id = ?")
    .bind(c.req.param("projectId")).run();
  return c.json({ ok: true });
});

/** Manual contingency for a project — a £ buffer added to the forecast cost.
 *  Stored as a per-project key in the global settings table (no migration). */
materials.get("/:projectId/contingency", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT value FROM settings WHERE key = ?",
  ).bind(`contingency:${c.req.param("projectId")}`).first<{ value: string }>();
  const contingency = row?.value ? Number(row.value) : 0;
  return c.json({ contingency: Number.isFinite(contingency) ? contingency : 0 });
});

materials.post("/:projectId/contingency", async (c) => {
  const denied = requirePermission(c, "commercial.edit");
  if (denied) return denied;
  const body = await c.req.json<{ contingency: number }>().catch(() => null);
  const amount = Number(body?.contingency);
  if (!Number.isFinite(amount)) return c.json({ error: "contingency must be a number" }, 400);
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  ).bind(`contingency:${c.req.param("projectId")}`, String(Math.round(amount * 100) / 100)).run();
  return c.json({ ok: true, contingency: Math.round(amount * 100) / 100 });
});

/** Return the commercials (Value / Cost / GP / GP%) for the project's active snapshot. */
materials.get("/:projectId/commercials", async (c) => {
  const projectId = c.req.param("projectId");
  const rows = await c.env.DB.prepare(
    `SELECT c.*
     FROM project_commercials c
     JOIN material_snapshots s ON s.id = c.snapshot_id
     WHERE s.project_id = ? AND s.is_active = 1
     ORDER BY c.display_order`,
  )
    .bind(projectId)
    .all();
  return c.json(rows.results);
});

/**
 * List materials for the project's active snapshot, with committed quantities
 * (sum of approved/issued PO line qty for the same item name) and remaining allowance.
 */
materials.get("/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const snap = await c.env.DB.prepare(
    "SELECT id FROM material_snapshots WHERE project_id = ? AND is_active = 1",
  )
    .bind(projectId)
    .first<{ id: number }>();
  if (!snap) return c.json([]);

  const rows = await c.env.DB.prepare(
    `SELECT m.*,
            -- Reserved against this item: frameworks + standard POs. Call-offs are
            -- EXCLUDED — a framework reserves its full quantity and its call-offs
            -- draw down within that reservation, so counting them too would
            -- double-spend the allowance. PO lines are matched by the ORIGINAL
            -- item name OR the active substitution's replacement name — orders
            -- for a replaced material are raised under the replacement wording.
            COALESCE((
              SELECT SUM(pl.qty)
              FROM po_lines pl
              JOIN purchase_orders po ON po.id = pl.po_id
              WHERE po.project_id = ?
                AND po.status IN ('approved', 'issued', 'pending_approval')
                AND COALESCE(po.order_type, 'standard') != 'call_off'
                AND (lower(pl.item) = lower(m.item)
                     OR (sub.replacement_item IS NOT NULL AND lower(pl.item) = lower(sub.replacement_item)))
                AND pl.is_unpriced = 0
            ), 0)
            -- Costs CODED to this line after the fact (retro POs assigned via
            -- material_id under different wording) fold in AFTER the query, in
            -- JS, at the line's BUY rate (live quote / substitution / BOQ) —
            -- dividing by the BOQ rate here and re-valuing at the buy rate on
            -- the client understated committed £ whenever the two differed.
            AS committed_qty,
            -- The coded costs as raw £ — folded into committed_qty in JS at
            -- the line's buy rate (see the post-query map).
            COALESCE((
              SELECT SUM(pl.line_total)
              FROM po_lines pl
              JOIN purchase_orders po ON po.id = pl.po_id
              WHERE po.project_id = ?
                AND po.status IN ('approved', 'issued', 'pending_approval')
                AND COALESCE(po.order_type, 'standard') != 'call_off'
                AND lower(pl.item) != lower(m.item)
                AND (sub.replacement_item IS NULL OR lower(pl.item) != lower(sub.replacement_item))
                AND pl.material_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM materials am WHERE am.id = pl.material_id AND lower(am.item) = lower(m.item))
            ), 0) AS assigned_committed_value,
            -- Of that reserved amount, how much has actually been called off (the
            -- solid fill inside the lighter reserved band on the usage bars).
            -- Matched by name or the substitution's name…
            COALESCE((
              SELECT SUM(pl.qty)
              FROM po_lines pl
              JOIN purchase_orders po ON po.id = pl.po_id
              WHERE po.project_id = ?
                AND po.status IN ('approved', 'issued', 'pending_approval')
                AND COALESCE(po.order_type, 'standard') = 'call_off'
                AND (lower(pl.item) = lower(m.item)
                     OR (sub.replacement_item IS NOT NULL AND lower(pl.item) = lower(sub.replacement_item)))
                AND pl.is_unpriced = 0
            ), 0)
            -- …plus call-off lines CODED to this line under different wording
            -- (a replaced product called off then assigned to the BOQ item —
            -- incl. "unpriced" additional lines). Same £→qty conversion as the
            -- committed fold, so pack units stay comparable.
            + ROUND(COALESCE((
              SELECT SUM(pl.line_total)
              FROM po_lines pl
              JOIN purchase_orders po ON po.id = pl.po_id
              WHERE po.project_id = ?
                AND po.status IN ('approved', 'issued', 'pending_approval')
                AND COALESCE(po.order_type, 'standard') = 'call_off'
                AND lower(pl.item) != lower(m.item)
                AND (sub.replacement_item IS NULL OR lower(pl.item) != lower(sub.replacement_item))
                AND pl.material_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM materials am WHERE am.id = pl.material_id AND lower(am.item) = lower(m.item))
            ) / NULLIF(m.cost, 0), 0), 3) AS called_off_qty,
            -- How much of the reserved amount sits on framework orders (vs firm
            -- standard POs). Lets the bar show framework-reserved-but-not-yet-
            -- called as a lighter band.
            COALESCE((
              SELECT SUM(pl.qty)
              FROM po_lines pl
              JOIN purchase_orders po ON po.id = pl.po_id
              WHERE po.project_id = ?
                AND po.status IN ('approved', 'issued', 'pending_approval')
                AND COALESCE(po.order_type, 'standard') = 'framework'
                AND (lower(pl.item) = lower(m.item)
                     OR (sub.replacement_item IS NOT NULL AND lower(pl.item) = lower(sub.replacement_item)))
                AND pl.is_unpriced = 0
            ), 0)
            + ROUND(COALESCE((
              SELECT SUM(pl.line_total)
              FROM po_lines pl
              JOIN purchase_orders po ON po.id = pl.po_id
              WHERE po.project_id = ?
                AND po.status IN ('approved', 'issued', 'pending_approval')
                AND COALESCE(po.order_type, 'standard') = 'framework'
                AND lower(pl.item) != lower(m.item)
                AND (sub.replacement_item IS NULL OR lower(pl.item) != lower(sub.replacement_item))
                AND pl.material_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM materials am WHERE am.id = pl.material_id AND lower(am.item) = lower(m.item))
            ) / NULLIF(m.cost, 0), 0), 3) AS framework_reserved_qty,
            -- Omitted from this job. omit_qty NULL = the whole line (excluded
            -- from rollups, hidden by default); a value = partial omission,
            -- reducing the budgeted quantity but keeping the line visible.
            EXISTS(SELECT 1 FROM material_omissions mo
                    WHERE mo.project_id = ? AND mo.item_key = lower(m.item)
                      AND mo.omit_qty IS NULL) AS omitted,
            (SELECT mo.omit_qty FROM material_omissions mo
              WHERE mo.project_id = ? AND mo.item_key = lower(m.item)) AS omitted_qty,
            pr.element_code AS product_element_code,
            e.name        AS element_name,
            -- Latest applied live price (most recent applied_at wins). Matched by
            -- item name within the project — NOT material_id — so re-uploading the
            -- pricing workbook (which mints new material ids) doesn't orphan the
            -- applied quote savings. Old snapshots' material rows persist, so the
            -- live price still resolves onto the equivalent item in the new snapshot.
            (SELECT mlp.unit_price
             FROM material_live_prices mlp
             JOIN materials om ON om.id = mlp.material_id
             WHERE mlp.project_id = ?
               AND lower(om.item) = lower(m.item)
               AND mlp.status IN ('applied', 'approved')
               AND mlp.unit_price <= COALESCE(m.cost, mlp.unit_price) * 5
             ORDER BY mlp.applied_at DESC LIMIT 1) AS live_unit_price,
            (SELECT s.name
             FROM material_live_prices mlp
             JOIN materials om       ON om.id = mlp.material_id
             JOIN supplier_quotes q  ON q.id = mlp.quote_id
             JOIN suppliers s        ON s.id = q.supplier_id
             WHERE mlp.project_id = ?
               AND lower(om.item) = lower(m.item)
               AND mlp.status IN ('applied', 'approved')
               AND mlp.unit_price <= COALESCE(m.cost, mlp.unit_price) * 5
             ORDER BY mlp.applied_at DESC LIMIT 1) AS live_supplier_name,
            (SELECT COUNT(*) FROM material_live_prices mlp
             JOIN materials om ON om.id = mlp.material_id
             WHERE mlp.project_id = ?
               AND lower(om.item) = lower(m.item)
               AND mlp.status = 'pending_approval') AS pending_price_count,
            -- Active substitution (if any): replacement item/manufacturer/cost
            sub.id                       AS sub_id,
            sub.kind                     AS sub_kind,
            sub.replacement_item         AS sub_item,
            sub.replacement_manufacturer AS sub_manufacturer,
            sub.replacement_supplier     AS sub_supplier,
            sub.replacement_cost         AS sub_cost,
            sub.replacement_unit         AS sub_unit,
            sub.replacement_total_units  AS sub_total_units,
            sub.sub_units                AS sub_units,
            sub.replacement_product_id   AS sub_product_id,
            sub.replacement_quote_line_id AS sub_quote_line_id,
            sub.reason                   AS sub_reason,
            sub.created_at               AS sub_created_at,
            sub.created_by               AS sub_created_by,
            -- Pending PART substitution awaiting approval (not yet effective)
            psub.id                      AS pending_sub_id,
            psub.replacement_item        AS pending_sub_item,
            psub.replacement_manufacturer AS pending_sub_manufacturer,
            psub.replacement_supplier    AS pending_sub_supplier,
            psub.replacement_cost        AS pending_sub_cost,
            psub.replacement_unit        AS pending_sub_unit,
            psub.sub_units               AS pending_sub_units,
            psub.kind                    AS pending_sub_kind,
            psub.approval_tier           AS pending_sub_tier,
            psub.created_by              AS pending_sub_by
     FROM materials m
     LEFT JOIN products pr ON pr.id = m.product_id
     LEFT JOIN elements e ON e.code = m.element_code
     LEFT JOIN material_substitutions sub
            ON sub.material_id = m.id AND sub.active = 1
     LEFT JOIN material_substitutions psub
            ON psub.material_id = m.id AND psub.active = 0 AND psub.status = 'pending_approval'
     WHERE m.snapshot_id = ?
     ORDER BY COALESCE(m.element_code, m.type), m.item`,
  )
    .bind(projectId, projectId, projectId, projectId, projectId, projectId, projectId, projectId, projectId, projectId, projectId, snap.id)
    .all<Record<string, unknown> & { committed_qty: number; called_off_qty: number; framework_reserved_qty: number; total_units: number | null }>();

  // Delivered-to-date per item. A delivery's received qty is attributed to the PO
  // LINE its note best matches (word overlap) — e.g. "19 packs of Kingspan…" lands
  // on the Kingspan line, not spread across the whole PO. Only if nothing matches
  // do we fall back to apportioning by line-qty share. Keyed by item name (the same
  // match used for committed_qty) in pack units, so it lines up with committed_qty.
  const deliveredByItem = new Map<string, number>();
  try {
    const [deliveries, poLines] = await Promise.all([
      c.env.DB.prepare(
        `SELECT po_id, received_qty, expected_qty, status, description FROM site_deliveries
          WHERE project_id = ? AND po_id IS NOT NULL`,
      ).bind(projectId).all<{ po_id: string; received_qty: number | null; expected_qty: number | null; status: string | null; description: string | null }>(),
      c.env.DB.prepare(
        // A line's material link wins over its printed wording, so deliveries
        // of a replaced product attribute to the original BOQ item.
        `SELECT pl.po_id AS po_id, lower(COALESCE(am.item, pl.item)) AS item_l, pl.qty AS qty
           FROM po_lines pl
           JOIN purchase_orders po ON po.id = pl.po_id
           LEFT JOIN materials am ON am.id = pl.material_id
          WHERE po.project_id = ?
            AND po.status IN ('approved', 'issued', 'pending_approval')`,
      ).bind(projectId).all<{ po_id: string; item_l: string; qty: number }>(),
    ]);
    const wordSet = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []));
    const poMap = new Map<string, { total: number; lines: Array<{ item_l: string; qty: number; words: Set<string> }> }>();
    for (const l of poLines.results) {
      const g = poMap.get(l.po_id) ?? { total: 0, lines: [] };
      g.total += l.qty ?? 0; g.lines.push({ item_l: l.item_l, qty: l.qty ?? 0, words: wordSet(l.item_l) });
      poMap.set(l.po_id, g);
    }
    for (const d of deliveries.results) {
      const g = poMap.get(d.po_id); if (!g || g.total <= 0) continue;
      const received = d.received_qty != null ? d.received_qty
        : d.status === "received" ? (d.expected_qty ?? g.total) : 0;
      if (received <= 0) continue;
      // Best-matching line by shared words with the delivery note.
      const dw = wordSet(d.description ?? "");
      let best: { item_l: string } | null = null; let bestScore = 0;
      for (const l of g.lines) {
        let score = 0; for (const w of l.words) if (dw.has(w)) score++;
        if (score > bestScore) { bestScore = score; best = l; }
      }
      if (best && bestScore >= 2) {
        deliveredByItem.set(best.item_l, (deliveredByItem.get(best.item_l) ?? 0) + received);
      } else {
        for (const l of g.lines) deliveredByItem.set(l.item_l, (deliveredByItem.get(l.item_l) ?? 0) + (l.qty / g.total) * received);
      }
    }
  } catch { /* pre-reconciliation deliveries table — degrade to no delivered qty */ }

  // Budget is tracked in pack units (col V) since POs are raised in pack units.
  // Deliveries land under whichever wording the PO line used — for a replaced
  // material that's the substitution's name, so count both.
  // The rate this line is actually BOUGHT at — live quoted price first, else
  // the substitution's (blended) rate, else BOQ cost. Coded £ folds into
  // committed_qty at this rate so qty is physical (a £5k order at the £27.58
  // buy rate is the m² that money really buys) and the client's qty × buy-rate
  // reproduces the PO's £ exactly instead of understating it.
  const buyRate = (r: Record<string, unknown>): number => {
    const cost = Number(r.cost) || 0;
    const subCost = r.sub_id != null && r.sub_cost != null ? Number(r.sub_cost) : null;
    const subUnits = Number(r.sub_units);
    const totalUnits = Number(r.total_units);
    const blended = subCost == null ? cost
      : Number.isFinite(subUnits) && subUnits > 0 && Number.isFinite(totalUnits) && totalUnits > 0 && subUnits < totalUnits
        ? (subUnits * subCost + (totalUnits - subUnits) * cost) / totalUnits
        : subCost;
    const live = r.live_unit_price != null ? Number(r.live_unit_price) : null;
    return live ?? blended;
  };
  const result = rows.results.map((raw) => {
    const codedValue = Number((raw as Record<string, unknown>).assigned_committed_value) || 0;
    const rate = buyRate(raw as Record<string, unknown>);
    const codedQty = codedValue > 0 && rate > 0 ? Math.round((codedValue / rate) * 1000) / 1000 : 0;
    const r: typeof raw = { ...raw, committed_qty: (raw.committed_qty ?? 0) + codedQty };
    return {
    ...r,
    // Remaining draws down the budget net of any partial omission.
    remaining_qty:
      r.total_units == null
        ? null
        : Math.max(0, (r.total_units ?? 0) - (Number((r as Record<string, unknown>).omitted_qty) || 0)) - (r.committed_qty ?? 0),
    delivered_qty:
      (deliveredByItem.get(String(r.item ?? "").toLowerCase()) ?? 0)
      + (r.sub_item && String(r.sub_item).toLowerCase() !== String(r.item ?? "").toLowerCase()
          ? deliveredByItem.get(String(r.sub_item).toLowerCase()) ?? 0
          : 0),
    };
  });
  return c.json(result);
});

// ── Material omissions ────────────────────────────────────────────────────
// Mark a BOQ material as not needed for this job. Name-keyed per project so
// snapshot re-uploads keep the omission.

materials.post("/:projectId/omit", async (c) => {
  const denied = requirePermission(c, "materials.upload");
  if (denied) return denied;
  const projectId = c.req.param("projectId");
  const body = await c.req.json<{ item?: string; qty?: number }>().catch(() => ({} as { item?: string; qty?: number }));
  const item = (body.item ?? "").trim().toLowerCase();
  if (!item) return c.json({ error: "item required" }, 400);
  // qty absent/null = omit the whole line; a positive number = partial omission.
  let qty: number | null = null;
  if (body.qty != null) {
    qty = Number(body.qty);
    if (!Number.isFinite(qty) || qty <= 0) return c.json({ error: "qty must be a positive number" }, 400);
  }
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO material_omissions (project_id, item_key, omit_qty, created_by) VALUES (?,?,?,?)",
  ).bind(projectId, item, qty, c.get("userEmail") ?? null).run();
  return c.json({ ok: true });
});

materials.post("/:projectId/restore-omitted", async (c) => {
  const denied = requirePermission(c, "materials.upload");
  if (denied) return denied;
  const projectId = c.req.param("projectId");
  const body = await c.req.json<{ item?: string }>().catch(() => ({} as { item?: string }));
  const item = (body.item ?? "").trim().toLowerCase();
  if (!item) return c.json({ error: "item required" }, 400);
  await c.env.DB.prepare(
    "DELETE FROM material_omissions WHERE project_id = ? AND item_key = ?",
  ).bind(projectId, item).run();
  return c.json({ ok: true });
});

// ── Material substitutions ────────────────────────────────────────────────

type SubKind = "like_for_like" | "equivalent_spec" | "variation";

/**
 * Swap one material for another on the BOQ. Source can be a master product,
 * a supplier quote line, or freeform fields. The original material row stays
 * — only POs raised AFTER the swap pick up the replacement's defaults; the
 * BOQ allowance still draws down against the original material_id so
 * reporting stays consistent.
 *
 * Creating a new substitution while another is active auto-reverts the old
 * one (its `active` flag flips to 0, audit-trailed).
 */
materials.post("/:materialId/substitute", async (c) => {
  const denied = requirePermission(c, "materials.upload");
  if (denied) return denied;
  const materialId = Number(c.req.param("materialId"));
  if (!Number.isInteger(materialId)) return c.json({ error: "invalid material id" }, 400);

  const body = await c.req.json<{
    kind?: SubKind;
    reason?: string | null;
    notes?: string | null;
    // Replacement sources (any combination; latter overrides former)
    product_id?: number | null;
    quote_line_id?: number | null;
    // Freeform / overrides
    replacement_item?: string;
    replacement_manufacturer?: string | null;
    replacement_supplier?: string | null;
    replacement_cost?: number | null;
    replacement_unit?: string | null;
    replacement_total_units?: number | null;
    sub_units?: number | null;   // qty being substituted (part-sub); null/full = whole swap
  }>();

  const material = await c.env.DB.prepare(
    `SELECT m.id, m.item, m.total_units, m.pack_unit,
            s.project_id AS project_id
     FROM materials m JOIN material_snapshots s ON s.id = m.snapshot_id
     WHERE m.id = ?`,
  )
    .bind(materialId)
    .first<{ id: number; item: string; total_units: number | null; pack_unit: string | null; project_id: string }>();
  if (!material) return c.json({ error: "material not found" }, 404);

  // Resolve replacement fields from each source, then layer overrides.
  let item: string | null = null;
  let manufacturer: string | null = null;
  let supplier: string | null = null;
  let cost: number | null = null;
  let unit: string | null = null;

  if (body.product_id) {
    const p = await c.env.DB.prepare(
      `SELECT description, manufacturer, supplier, unit, unit_cost
       FROM products WHERE id = ?`,
    )
      .bind(body.product_id)
      .first<{ description: string; manufacturer: string | null; supplier: string | null; unit: string | null; unit_cost: number | null }>();
    if (!p) return c.json({ error: "product not found" }, 404);
    item = p.description;
    manufacturer = p.manufacturer;
    supplier = p.supplier;
    cost = p.unit_cost;
    unit = p.unit;
  }
  if (body.quote_line_id) {
    const q = await c.env.DB.prepare(
      `SELECT l.raw_description, l.raw_unit, l.unit_price,
              s.name AS supplier_name
       FROM supplier_quote_lines l
       JOIN supplier_quotes qq ON qq.id = l.quote_id
       JOIN suppliers s        ON s.id = qq.supplier_id
       WHERE l.id = ?`,
    )
      .bind(body.quote_line_id)
      .first<{ raw_description: string; raw_unit: string | null; unit_price: number | null; supplier_name: string }>();
    if (!q) return c.json({ error: "quote line not found" }, 404);
    item = item ?? q.raw_description;
    unit = unit ?? q.raw_unit;
    cost = cost ?? q.unit_price;
    supplier = supplier ?? q.supplier_name;
  }
  // Freeform overrides win (if provided)
  if (body.replacement_item != null) item = body.replacement_item;
  if (body.replacement_manufacturer !== undefined) manufacturer = body.replacement_manufacturer;
  if (body.replacement_supplier !== undefined) supplier = body.replacement_supplier;
  if (body.replacement_cost !== undefined) cost = body.replacement_cost;
  if (body.replacement_unit !== undefined) unit = body.replacement_unit;

  if (!item || !item.trim()) {
    return c.json({ error: "replacement_item (or a product/quote source) is required" }, 400);
  }

  const kind: SubKind = body.kind ?? "like_for_like";
  const now = new Date().toISOString();
  const actor = c.get("userEmail");

  // A PART substitution diverts only some of the BOQ quantity to the
  // replacement; the remainder stays on the original. sub_units below the
  // material's total_units triggers it. A full swap (sub_units null/>= total)
  // keeps the original behaviour.
  const total = material.total_units;
  const subUnits = typeof body.sub_units === "number" && body.sub_units > 0 ? body.sub_units : null;
  const isPart = subUnits != null && total != null && subUnits < total;
  // Replacement qty defaults to the substituted portion (part) or the BOQ qty (full).
  const totalUnits = body.replacement_total_units ?? (isPart ? subUnits : material.total_units);

  // Any new proposal supersedes a prior pending one for this material.
  await c.env.DB.prepare(
    `UPDATE material_substitutions SET status = 'superseded'
     WHERE material_id = ? AND active = 0 AND status = 'pending_approval'`,
  ).bind(materialId).run();

  if (isPart) {
    // Part substitutions need approval before they take effect: stored
    // inactive + pending. The existing effective (approved) sub, if any, stays
    // live until this one is approved. Tier bands on the £ value being diverted.
    const settings = await loadSettings(c.env.DB);
    const subValue = (subUnits ?? 0) * (cost ?? 0);
    const tier = tierForApproval(subValue, false, settings);
    const inserted = await c.env.DB.prepare(
      `INSERT INTO material_substitutions
         (material_id, project_id, replacement_product_id, replacement_quote_line_id,
          replacement_item, replacement_manufacturer, replacement_supplier,
          replacement_cost, replacement_unit, replacement_total_units, sub_units,
          kind, reason, notes, active, status, approval_tier, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending_approval', ?, ?, ?)
       RETURNING id`,
    )
      .bind(
        materialId, material.project_id, body.product_id ?? null, body.quote_line_id ?? null,
        item.trim(), manufacturer ?? null, supplier ?? null,
        cost ?? null, unit ?? material.pack_unit ?? null, totalUnits ?? null, subUnits,
        kind, body.reason ?? null, body.notes ?? null, tier, now, actor,
      )
      .first<{ id: number }>();
    return c.json({ id: inserted?.id, ok: true, pending: true, approval_tier: tier });
  }

  // Full swap — effective immediately (existing behaviour). Auto-revert any
  // existing active substitution for this material.
  await c.env.DB.prepare(
    `UPDATE material_substitutions
     SET active = 0, reverted_at = ?, reverted_by = ?,
         reverted_reason = COALESCE(reverted_reason, 'superseded by new substitution')
     WHERE material_id = ? AND active = 1`,
  )
    .bind(now, actor, materialId)
    .run();

  const inserted = await c.env.DB.prepare(
    `INSERT INTO material_substitutions
       (material_id, project_id,
        replacement_product_id, replacement_quote_line_id,
        replacement_item, replacement_manufacturer, replacement_supplier,
        replacement_cost, replacement_unit, replacement_total_units, sub_units,
        kind, reason, notes,
        active, status, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'approved', ?, ?)
     RETURNING id`,
  )
    .bind(
      materialId, material.project_id,
      body.product_id ?? null, body.quote_line_id ?? null,
      item.trim(), manufacturer ?? null, supplier ?? null,
      cost ?? null, unit ?? material.pack_unit ?? null, totalUnits ?? null, null,
      kind, body.reason ?? null, body.notes ?? null,
      now, actor,
    )
    .first<{ id: number }>();

  return c.json({ id: inserted?.id, ok: true });
});

/** List substitution history (all rows) for a project. */
materials.get("/:projectId/substitutions", async (c) => {
  const projectId = c.req.param("projectId");
  const rows = await c.env.DB.prepare(
    `SELECT sub.*,
            m.item AS original_item,
            m.manufacturer AS original_manufacturer,
            m.cost AS original_cost,
            m.total_units AS original_total_units,
            m.total_units_unit AS original_unit
     FROM material_substitutions sub
     JOIN materials m ON m.id = sub.material_id
     WHERE sub.project_id = ?
     ORDER BY sub.created_at DESC`,
  )
    .bind(projectId)
    .all();
  return c.json(rows.results);
});

/** Revert an active substitution. */
materials.delete("/substitutions/:id", async (c) => {
  const denied = requirePermission(c, "materials.upload");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const body = await c.req
    .json<{ reason?: string }>()
    .catch(() => ({} as { reason?: string }));
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE material_substitutions
     SET active = 0, reverted_at = ?, reverted_by = ?, reverted_reason = ?
     WHERE id = ? AND active = 1`,
  )
    .bind(now, c.get("userEmail"), body.reason ?? null, id)
    .run();
  return c.json({ ok: true });
});

/** Pending PART substitutions awaiting approval, for the Approvals inbox.
 *  Static path — registered so it never collides with /:projectId/substitutions. */
materials.get("/substitutions/_pending", async (c) => {
  const denied = requirePermission(c, "masterdata.read");
  if (denied) return denied;
  const tier = c.req.query("tier");
  const projectId = c.req.query("project_id");
  const where: string[] = ["sub.active = 0", "sub.status = 'pending_approval'"];
  const params: (string | number)[] = [];
  if (tier) { where.push("sub.approval_tier = ?"); params.push(tier); }
  if (projectId) { where.push("sub.project_id = ?"); params.push(projectId); }
  const rows = await c.env.DB.prepare(
    `SELECT sub.id, sub.material_id, sub.project_id, sub.kind, sub.reason,
            sub.replacement_item, sub.replacement_manufacturer, sub.replacement_supplier,
            sub.replacement_cost, sub.replacement_unit, sub.sub_units,
            sub.approval_tier, sub.created_at, sub.created_by,
            m.item AS material_item, m.element_code AS material_element_code,
            m.cost AS original_cost, m.total_units AS original_total_units,
            m.total_units_unit AS original_unit,
            p.code AS project_code, p.name AS project_name
       FROM material_substitutions sub
       JOIN materials m ON m.id = sub.material_id
       JOIN projects  p ON p.id = sub.project_id
      WHERE ${where.join(" AND ")}
      ORDER BY sub.created_at DESC`,
  ).bind(...params).all();
  return c.json(rows.results);
});

/** Approve or reject a pending part-substitution. Approving makes it the
 *  effective sub (active=1) and reverts whatever was effective before. */
materials.post("/substitutions/:id/decide", async (c) => {
  const denied = requirePermission(c, "suppliers.manage");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ action: "approve" | "reject"; reason?: string }>();
  if (body.action !== "approve" && body.action !== "reject") {
    return c.json({ error: "action must be 'approve' or 'reject'" }, 400);
  }
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  const row = await c.env.DB.prepare(
    "SELECT id, material_id, status FROM material_substitutions WHERE id = ?",
  ).bind(id).first<{ id: number; material_id: number; status: string }>();
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "pending_approval") return c.json({ error: "already decided" }, 409);

  if (body.action === "reject") {
    await c.env.DB.prepare(
      "UPDATE material_substitutions SET status = 'rejected', rejected_at = ?, rejected_by = ?, rejection_reason = ? WHERE id = ?",
    ).bind(now, actor, body.reason ?? null, id).run();
    return c.json({ ok: true });
  }
  // Approve: revert the previously-effective sub first, then activate this one.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE material_substitutions
         SET active = 0, reverted_at = ?, reverted_by = ?,
             reverted_reason = COALESCE(reverted_reason, 'superseded by approved part-substitution')
       WHERE material_id = ? AND active = 1`,
    ).bind(now, actor, row.material_id),
    c.env.DB.prepare(
      "UPDATE material_substitutions SET status = 'approved', active = 1, approved_at = ?, approved_by = ? WHERE id = ?",
    ).bind(now, actor, id),
  ]);
  return c.json({ ok: true });
});
