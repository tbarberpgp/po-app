import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";
import type { ParsedProgrammeActivity } from "../../shared/parse-programme";
import { matchActivitiesToBill } from "../../shared/match-bill";

export const programme = new Hono<{ Bindings: Env; Variables: Variables }>();

/* ── PDF programme extraction (Claude) ─────────────────────────────────────
 * Site programmes usually arrive as Gantt-chart PDFs (Asta / MS Project /
 * Excel prints), not spreadsheets. Claude reads the activity table and returns
 * rows in the same shape as the client-side Excel parser, so the existing
 * /import and /progress endpoints work unchanged. */

const PROGRAMME_TOOL: Anthropic.Tool = {
  name: "extract_programme",
  description: "Record every task row extracted from a construction works programme (Gantt chart).",
  input_schema: {
    type: "object",
    properties: {
      activities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            line_no: { type: ["integer", "null"], description: "Printed line/ID number of the row; null if none shown" },
            name: { type: "string", description: "Task name exactly as printed" },
            level: { type: "integer", description: "Outline depth — 0 for top-level summary bands, 1 for tasks under them, 2 deeper. Infer from indentation or numbering (1 / 1.1 / 1.1.1)." },
            is_summary: { type: "boolean", description: "True for summary/heading rows that group the tasks beneath them" },
            is_milestone: { type: "boolean", description: "True for zero-duration milestones (diamond markers)" },
            start: { type: ["string", "null"], description: "Start date as YYYY-MM-DD (UK programmes print dd/mm/yy — convert)" },
            finish: { type: ["string", "null"], description: "Finish date as YYYY-MM-DD" },
            duration_days: { type: ["number", "null"], description: "Duration in days if printed ('15d' → 15, '3w' → 21)" },
            pct_complete: { type: ["number", "null"], description: "% complete 0-100 if a progress column is printed" },
            predecessors: { type: ["string", "null"], description: "Predecessor references if printed (e.g. '12FS+2d')" },
          },
          required: ["name", "level", "is_summary", "is_milestone"],
        },
      },
    },
    required: ["activities"],
  },
};

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

programme.post("/:projectId/extract-pdf", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY not configured (needed to read programme PDFs)" }, 500);
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  if (!(file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))) {
    return c.json({ error: "Upload the programme as a PDF — Excel files import directly." }, 400);
  }

  const client = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 16384,
    system:
      "You are a UK construction planner reading a works programme (Gantt chart) exported to PDF from Asta Powerproject, Microsoft Project or Excel. " +
      "Extract EVERY task row of the activity table, in printed order — summary bands, tasks and milestones alike. " +
      "UK programmes print dates as dd/mm/yy or dd mmm yy: convert them to YYYY-MM-DD. " +
      "If a row shows no dates (bar-only), leave start/finish null rather than guessing. Do not invent, merge or reorder rows.",
    tools: [PROGRAMME_TOOL],
    tool_choice: { type: "tool", name: "extract_programme" },
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: bufToBase64(await file.arrayBuffer()) } },
        { type: "text", text: "Extract every task row from this works programme via extract_programme." },
      ],
    }],
  });

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const raw = (toolUse?.input ?? {}) as { activities?: Array<Record<string, unknown>> };
  const rows = Array.isArray(raw.activities) ? raw.activities : [];
  const iso = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const activities: ParsedProgrammeActivity[] = rows
    .filter((r) => typeof r.name === "string" && (r.name as string).trim())
    .map((r, i) => ({
      line_no: typeof r.line_no === "number" && Number.isFinite(r.line_no) ? Math.round(r.line_no) : null,
      level: typeof r.level === "number" && Number.isFinite(r.level) ? Math.max(0, Math.round(r.level)) : 0,
      name: (r.name as string).trim(),
      is_milestone: r.is_milestone === true,
      is_summary: r.is_summary === true,
      planned_start: iso(r.start),
      planned_finish: iso(r.finish) ?? iso(r.start),
      pct_complete: typeof r.pct_complete === "number" ? Math.min(1, Math.max(0, r.pct_complete / 100)) : 0,
      duration_days: typeof r.duration_days === "number" && Number.isFinite(r.duration_days) ? r.duration_days : null,
      predecessors: typeof r.predecessors === "string" && r.predecessors ? r.predecessors : null,
      display_order: i,
    }));
  if (!activities.length) return c.json({ error: "No task rows could be read from that PDF." }, 422);
  return c.json({ activities });
});

/**
 * Resolve to the site-group's base project. Grouped contracts (areas of one
 * physical site) share a single works programme, hosted on the base project —
 * the same model as sign-in / RAMS / deliveries. A standalone project resolves
 * to itself.
 */
export async function baseProject(db: D1Database, projectId: string): Promise<string> {
  const row = await db.prepare("SELECT site_group_id FROM projects WHERE id = ?")
    .bind(projectId).first<{ site_group_id: string | null }>();
  if (!row?.site_group_id) return projectId;
  const g = await db.prepare("SELECT base_project_id FROM site_groups WHERE id = ?")
    .bind(row.site_group_id).first<{ base_project_id: string | null }>();
  return g?.base_project_id || projectId;
}

/** Every contract in this project's site group (incl. itself); just the project
 *  if it isn't grouped. Used to aggregate procurement across the whole site. */
async function siteMembers(db: D1Database, projectId: string): Promise<string[]> {
  const row = await db.prepare("SELECT site_group_id FROM projects WHERE id = ?")
    .bind(projectId).first<{ site_group_id: string | null }>();
  if (!row?.site_group_id) return [projectId];
  const rows = await db.prepare("SELECT id FROM projects WHERE site_group_id = ? AND deleted_at IS NULL")
    .bind(row.site_group_id).all<{ id: string }>();
  return rows.results.length ? rows.results.map((r) => r.id) : [projectId];
}

/** Is there a priced bill for this programme's scope to match against, and does it
 *  carry a material breakdown? Drives the "why is Materials & stock empty" message:
 *  no bill at all · one awaiting superadmin approval · a live bill with no component
 *  breakdown (uploaded before that feature — needs re-upload) · or just no match. */
async function billDiagnostics(db: D1Database, baseProjectId: string): Promise<{ billItems: number; components: number; pendingBill: boolean }> {
  const members = await siteMembers(db, baseProjectId);
  const ph = members.map(() => "?").join(",");
  const items = await db.prepare(
    `SELECT COUNT(*) AS n FROM contract_items ci JOIN material_snapshots s ON s.id = ci.snapshot_id
      WHERE s.project_id IN (${ph}) AND s.is_active = 1 AND ci.category != 'prelims'`,
  ).bind(...members).first<{ n: number }>();
  // Components reachable from THIS programme's linked bill lines in the live
  // snapshot — i.e. exactly what stock demand expands. (Counting the whole
  // snapshot would falsely report "ok" when a sibling block has a breakdown but
  // the lines this programme links to don't.) Best-effort: a not-yet-migrated
  // table must not 500 the caller.
  let components = 0;
  try {
    const comps = await db.prepare(
      `SELECT COUNT(*) AS n FROM contract_item_components cc
         JOIN programme_activity_items pi ON pi.contract_item_id = cc.contract_item_id
         JOIN programme_activities a ON a.id = pi.activity_id
         JOIN contract_items ci ON ci.id = cc.contract_item_id
         JOIN material_snapshots s ON s.id = ci.snapshot_id
        WHERE a.project_id = ? AND s.is_active = 1 AND cc.qty IS NOT NULL AND cc.qty > 0`,
    ).bind(baseProjectId).first<{ n: number }>();
    components = comps?.n ?? 0;
  } catch { /* table not present yet */ }
  const pend = await db.prepare(
    `SELECT COUNT(*) AS n FROM settings WHERE key IN (${members.map(() => "?").join(",")})`,
  ).bind(...members.map((m) => `pending_snapshot:${m}`)).first<{ n: number }>();
  return { billItems: items?.n ?? 0, components, pendingBill: (pend?.n ?? 0) > 0 };
}

/**
 * Best-effort auto-tag: link each un-tagged, non-summary activity to the bill
 * line it installs, matching its name against bill descriptions + component
 * material names. For a grouped site (one combined programme, per-contract
 * bills) each activity is matched against the contract whose name best fits its
 * block heading. Only links activities that have none yet — manual tags and
 * earlier auto-tags are preserved. Returns how many links were created.
 */
export async function autoTagFromBill(db: D1Database, baseProjectId: string, replace = false): Promise<number> {
  const now = new Date().toISOString();
  // `replace` re-matches from scratch (used by the manual button): drop existing
  // bill-line tags so wrong/stale matches are corrected. Import uses replace=false
  // (additive) so it never clobbers what's already linked.
  if (replace) {
    await db.prepare(
      "DELETE FROM programme_activity_items WHERE contract_item_id IS NOT NULL AND activity_id IN (SELECT id FROM programme_activities WHERE project_id = ?)",
    ).bind(baseProjectId).run();
  }
  const baseRow = await db.prepare("SELECT site_group_id FROM projects WHERE id = ?")
    .bind(baseProjectId).first<{ site_group_id: string | null }>();
  const members = baseRow?.site_group_id
    ? (await db.prepare("SELECT id, name FROM projects WHERE site_group_id = ? AND deleted_at IS NULL")
        .bind(baseRow.site_group_id).all<{ id: string; name: string }>()).results
    : (await db.prepare("SELECT id, name FROM projects WHERE id = ?")
        .bind(baseProjectId).all<{ id: string; name: string }>()).results;

  type Item = { id: number; description: string; components: { name: string }[] };
  const memberBills: { id: string; name: string; items: Item[] }[] = [];
  for (const mem of members) {
    const items = (await db.prepare(
      `SELECT ci.id, ci.description FROM contract_items ci
         JOIN material_snapshots s ON s.id = ci.snapshot_id
        WHERE s.project_id = ? AND s.is_active = 1 AND ci.category != 'prelims'`,
    ).bind(mem.id).all<{ id: number; description: string }>()).results;
    if (!items.length) continue;
    const comps = (await db.prepare(
      `SELECT cc.contract_item_id AS cid, cc.name FROM contract_item_components cc
         JOIN contract_items ci ON ci.id = cc.contract_item_id
         JOIN material_snapshots s ON s.id = ci.snapshot_id
        WHERE s.project_id = ? AND s.is_active = 1`,
    ).bind(mem.id).all<{ cid: number; name: string }>()).results;
    const byItem = new Map<number, { name: string }[]>();
    for (const c of comps) { const a = byItem.get(c.cid) ?? []; a.push({ name: c.name }); byItem.set(c.cid, a); }
    memberBills.push({ id: mem.id, name: mem.name, items: items.map((it) => ({ id: it.id, description: it.description, components: byItem.get(it.id) ?? [] })) });
  }
  if (memberBills.length === 0) return 0;

  const acts = (await db.prepare(
    "SELECT id, name, level, is_summary, is_milestone FROM programme_activities WHERE project_id = ? ORDER BY display_order",
  ).bind(baseProjectId).all<{ id: number; name: string; level: number; is_summary: number; is_milestone: number }>()).results;
  const linked = new Set(
    (await db.prepare(
      "SELECT DISTINCT activity_id FROM programme_activity_items WHERE activity_id IN (SELECT id FROM programme_activities WHERE project_id = ?)",
    ).bind(baseProjectId).all<{ activity_id: number }>()).results.map((r) => r.activity_id),
  );

  // Loose tokens keep single-character block ids ("C") that the 3-char-min
  // tokenizer drops — needed to tell Block B / C / D contracts apart by name.
  const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
  type Member = typeof memberBills[number];
  const pickMember = (blockName: string | null): Member | null => {
    // A "BLOCK X" heading must map to the contract named for that same block.
    // If that contract's bill isn't loaded yet, return null (skip) rather than
    // mis-attributing the work to another block's bill.
    const bm = (blockName ?? "").match(/\bblock\s+([a-z0-9]+)/i);
    if (bm) {
      const letter = bm[1].toLowerCase();
      return memberBills.find((m) => new RegExp(`\\bblock\\s+${letter}\\b`, "i").test(m.name)) ?? null;
    }
    // No block heading (single-area programme): use the only contract, else the
    // best name-overlap match.
    if (memberBills.length === 1) return memberBills[0];
    const bt = loose(blockName ?? "");
    let best: Member | null = null, bestScore = 0;
    for (const m of memberBills) {
      const mt = new Set(loose(m.name));
      let s = 0; for (const t of bt) if (mt.has(t)) s++;
      if (s > bestScore) { bestScore = s; best = m; }
    }
    return best ?? memberBills[0];
  };

  const byMember = new Map<string, { id: number; name: string }[]>();
  let block: string | null = null;
  for (const a of acts) {
    // Track only the BLOCK heading (e.g. "BLOCK C …") for member-picking — a
    // section heading like "Felt (flat roof)" must not change which contract.
    if (a.is_summary && /^\s*block\b/i.test(a.name)) block = a.name;
    if (a.is_summary || a.is_milestone || linked.has(a.id)) continue;
    const mem = pickMember(block ?? a.name);
    if (!mem) continue; // block's contract bill not available yet
    const arr = byMember.get(mem.id) ?? []; arr.push({ id: a.id, name: a.name }); byMember.set(mem.id, arr);
  }

  const inserts: D1PreparedStatement[] = [];
  for (const m of memberBills) {
    const arr = byMember.get(m.id);
    if (!arr?.length) continue;
    const matches = matchActivitiesToBill(arr, m.items, 2);
    for (const [actId, billId] of matches) {
      const desc = m.items.find((x) => x.id === billId)?.description ?? null;
      inserts.push(db.prepare(
        "INSERT INTO programme_activity_items (activity_id, contract_item_id, description, created_at) VALUES (?, ?, ?, ?)",
      ).bind(actId, billId, desc, now));
    }
  }
  if (inserts.length) await db.batch(inserts);
  return inserts.length;
}

/**
 * Import a works programme (parsed client-side from Excel). The first import
 * establishes the baseline (baseline = planned). Later imports upsert by line
 * number so the agreed baseline, recorded actuals and % complete are carried
 * forward; tasks dropped from the file are removed.
 */
programme.post("/:projectId/import", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const projectId = await baseProject(c.env.DB, c.req.param("projectId"));
  const actor = c.get("userEmail");

  const project = await c.env.DB.prepare(
    "SELECT id, programme_baseline_set_at FROM projects WHERE id = ?",
  ).bind(projectId).first<{ id: string; programme_baseline_set_at: string | null }>();
  if (!project) return c.json({ error: "project not found" }, 404);

  const body = await c.req.json<{ filename?: string; activities: ParsedProgrammeActivity[] }>();
  if (!Array.isArray(body.activities) || body.activities.length === 0) {
    return c.json({ error: "activities[] required" }, 400);
  }

  // Re-imports align row-for-row by display_order (always unique, 0..N) — line_no
  // can be null (heading rows) or duplicated, so it isn't a safe key.
  const acts = body.activities;
  const now = new Date().toISOString();
  const baselineSet = project.programme_baseline_set_at != null;

  if (!baselineSet) {
    // First import → clean slate, baseline = planned.
    await c.env.DB.prepare("DELETE FROM programme_activities WHERE project_id = ?").bind(projectId).run();
    const stmts = acts.map((a) =>
      c.env.DB.prepare(
        `INSERT INTO programme_activities
           (project_id, line_no, level, name, is_milestone, is_summary,
            baseline_start, baseline_finish, planned_start, planned_finish,
            pct_complete, duration_days, predecessors, display_order, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        projectId, a.line_no, a.level, a.name, a.is_milestone ? 1 : 0, a.is_summary ? 1 : 0,
        a.planned_start, a.planned_finish, a.planned_start, a.planned_finish,
        a.pct_complete, a.duration_days, a.predecessors, a.display_order, now, now, actor,
      ),
    );
    await c.env.DB.batch(stmts);
    await c.env.DB.prepare("UPDATE projects SET programme_baseline_set_at = ? WHERE id = ?").bind(now, projectId).run();
  } else {
    // Upsert by display_order, preserving baseline / actuals / pct on matched rows.
    const existing = await c.env.DB.prepare(
      "SELECT id, display_order FROM programme_activities WHERE project_id = ?",
    ).bind(projectId).all<{ id: number; display_order: number }>();
    const byOrder = new Map(existing.results.map((r) => [r.display_order, r.id]));
    const incoming = new Set(acts.map((a) => a.display_order));
    const stmts = acts.map((a) => {
      const id = byOrder.get(a.display_order);
      if (id != null) {
        return c.env.DB.prepare(
          `UPDATE programme_activities
             SET level = ?, name = ?, is_milestone = ?, is_summary = ?,
                 planned_start = ?, planned_finish = ?, duration_days = ?,
                 predecessors = ?, display_order = ?, updated_at = ?, updated_by = ?
           WHERE id = ?`,
        ).bind(
          a.level, a.name, a.is_milestone ? 1 : 0, a.is_summary ? 1 : 0,
          a.planned_start, a.planned_finish, a.duration_days,
          a.predecessors, a.display_order, now, actor, id,
        );
      }
      return c.env.DB.prepare(
        `INSERT INTO programme_activities
           (project_id, line_no, level, name, is_milestone, is_summary,
            baseline_start, baseline_finish, planned_start, planned_finish,
            pct_complete, duration_days, predecessors, display_order, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        projectId, a.line_no, a.level, a.name, a.is_milestone ? 1 : 0, a.is_summary ? 1 : 0,
        a.planned_start, a.planned_finish, a.planned_start, a.planned_finish,
        a.pct_complete, a.duration_days, a.predecessors, a.display_order, now, now, actor,
      );
    });
    // Remove tasks dropped from the file.
    const toDelete = existing.results.filter((r) => !incoming.has(r.display_order)).map((r) => r.id);
    if (toDelete.length) {
      stmts.push(
        c.env.DB.prepare(
          `DELETE FROM programme_activities WHERE id IN (${toDelete.map(() => "?").join(",")})`,
        ).bind(...toDelete),
      );
    }
    await c.env.DB.batch(stmts);
  }

  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('programme', ?, ?, ?, ?, ?)`,
  ).bind(projectId, baselineSet ? "reimported" : "imported", actor,
    JSON.stringify({ filename: body.filename ?? null, activities: acts.length }), now).run();

  // Auto-tag bill lines so material/stock demand flows without manual linking.
  // Best-effort: never let it fail the import (e.g. components table not yet migrated).
  let tagged = 0;
  try { tagged = await autoTagFromBill(c.env.DB, projectId); }
  catch (e) { console.warn("auto-tag skipped:", e instanceof Error ? e.message : e); }
  const diag = await billDiagnostics(c.env.DB, projectId).catch(() => ({ billItems: 0, pendingBill: false }));

  return c.json({ ok: true, activities: acts.length, baseline_was_set: baselineSet, tagged, ...diag });
});

/**
 * Apply a progress update from an updated programme export. Matches existing
 * activities by row order (display_order) with a name guard, then refreshes
 * % complete and forecast (planned) dates only — it never restructures the
 * programme, resets the baseline or disturbs bill-line tags. Use this at each
 * progress review; use Re-import when the programme itself is re-sequenced.
 */
programme.post("/:projectId/progress", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const projectId = await baseProject(c.env.DB, c.req.param("projectId"));
  const actor = c.get("userEmail");
  const now = new Date().toISOString();

  const body = await c.req.json<{ filename?: string; activities: ParsedProgrammeActivity[] }>();
  if (!Array.isArray(body.activities) || body.activities.length === 0) {
    return c.json({ error: "activities[] required" }, 400);
  }

  const existing = await c.env.DB.prepare(
    "SELECT id, display_order, name FROM programme_activities WHERE project_id = ?",
  ).bind(projectId).all<{ id: number; display_order: number; name: string }>();
  if (existing.results.length === 0) {
    return c.json({ error: "no programme to update — import one first" }, 409);
  }
  const byOrder = new Map(existing.results.map((r) => [r.display_order, r]));
  const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

  // Only apply where the row at this position is the same task — protects against
  // a structurally different sheet silently shifting progress onto wrong rows.
  let updated = 0, skipped = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const a of body.activities) {
    const row = byOrder.get(a.display_order);
    if (!row || norm(row.name) !== norm(a.name)) { skipped++; continue; }
    stmts.push(
      c.env.DB.prepare(
        `UPDATE programme_activities
            SET pct_complete = ?, planned_start = ?, planned_finish = ?, duration_days = ?,
                updated_at = ?, updated_by = ?
          WHERE id = ?`,
      ).bind(a.pct_complete, a.planned_start, a.planned_finish, a.duration_days, now, actor, row.id),
    );
    updated++;
  }
  if (stmts.length) await c.env.DB.batch(stmts);

  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('programme', ?, 'progress_updated', ?, ?, ?)`,
  ).bind(projectId, actor, JSON.stringify({ filename: body.filename ?? null, updated, skipped }), now).run();

  return c.json({ ok: true, updated, skipped, total: body.activities.length });
});

/** Re-run bill auto-tagging for any activities that aren't linked yet. */
programme.post("/:projectId/auto-tag", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const projectId = await baseProject(c.env.DB, c.req.param("projectId"));
  try {
    const tagged = await autoTagFromBill(c.env.DB, projectId, true);
    const diag = await billDiagnostics(c.env.DB, projectId);
    return c.json({ ok: true, tagged, ...diag });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "auto-tag failed" }, 500);
  }
});

/** List the programme activities for a project, in document order. */
programme.get("/:projectId", async (c) => {
  const pid = await baseProject(c.env.DB, c.req.param("projectId"));
  const rows = await c.env.DB.prepare(
    "SELECT * FROM programme_activities WHERE project_id = ? ORDER BY display_order",
  ).bind(pid).all();
  return c.json(rows.results);
});

/** Update progress / actual dates on a single activity. */
programme.patch("/:projectId/activities/:id", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const projectId = await baseProject(c.env.DB, c.req.param("projectId"));
  const b = await c.req.json<{
    pct_complete?: number;
    actual_start?: string | null;
    actual_finish?: string | null;
    planned_start?: string | null;
    planned_finish?: string | null;
  }>();

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (b.pct_complete !== undefined) { sets.push("pct_complete = ?"); vals.push(Math.max(0, Math.min(1, b.pct_complete))); }
  if (b.actual_start !== undefined) { sets.push("actual_start = ?"); vals.push(b.actual_start || null); }
  if (b.actual_finish !== undefined) { sets.push("actual_finish = ?"); vals.push(b.actual_finish || null); }
  if (b.planned_start !== undefined) { sets.push("planned_start = ?"); vals.push(b.planned_start || null); }
  if (b.planned_finish !== undefined) { sets.push("planned_finish = ?"); vals.push(b.planned_finish || null); }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  sets.push("updated_at = ?", "updated_by = ?");
  vals.push(new Date().toISOString(), c.get("userEmail"));

  await c.env.DB.prepare(
    `UPDATE programme_activities SET ${sets.join(", ")} WHERE id = ? AND project_id = ?`,
  ).bind(...vals, id, projectId).run();
  return c.json({ ok: true });
});

/** Re-baseline: snapshot the current plan as the agreed baseline. */
programme.post("/:projectId/baseline", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const projectId = await baseProject(c.env.DB, c.req.param("projectId"));
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE programme_activities SET baseline_start = planned_start, baseline_finish = planned_finish, updated_at = ? WHERE project_id = ?",
  ).bind(now, projectId).run();
  await c.env.DB.prepare("UPDATE projects SET programme_baseline_set_at = ? WHERE id = ?").bind(now, projectId).run();
  return c.json({ ok: true });
});

/** Clear the whole programme for a project. */
programme.delete("/:projectId", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const projectId = await baseProject(c.env.DB, c.req.param("projectId"));
  await c.env.DB.prepare("DELETE FROM programme_activities WHERE project_id = ?").bind(projectId).run();
  await c.env.DB.prepare("UPDATE projects SET programme_baseline_set_at = NULL WHERE id = ?").bind(projectId).run();
  return c.json({ ok: true });
});

// ── Bill-line links → component material / stock demand ────────────────────

/** Bill lines linked to one activity (what work it installs). */
programme.get("/:projectId/activities/:activityId/items", async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      `SELECT pi.id, pi.contract_item_id, pi.material_id, pi.qty, pi.unit, pi.description,
              ci.description AS bill_name, ci.qty AS bill_qty, ci.unit AS bill_unit,
              (SELECT COUNT(*) FROM contract_item_components cc WHERE cc.contract_item_id = pi.contract_item_id) AS component_count
         FROM programme_activity_items pi
         LEFT JOIN contract_items ci ON ci.id = pi.contract_item_id
        WHERE pi.activity_id = ?
        ORDER BY pi.id`,
    ).bind(c.req.param("activityId")).all();
    return c.json(rows.results);
  } catch {
    // Fallback without the component_count subquery (table not yet migrated).
    const rows = await c.env.DB.prepare(
      `SELECT pi.id, pi.contract_item_id, pi.material_id, pi.qty, pi.unit, pi.description,
              ci.description AS bill_name, ci.qty AS bill_qty, ci.unit AS bill_unit, 0 AS component_count
         FROM programme_activity_items pi
         LEFT JOIN contract_items ci ON ci.id = pi.contract_item_id
        WHERE pi.activity_id = ? ORDER BY pi.id`,
    ).bind(c.req.param("activityId")).all();
    return c.json(rows.results);
  }
});

/** Link a bill line to an activity. Its component materials drive stock demand. */
programme.post("/:projectId/activities/:activityId/items", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const activityId = c.req.param("activityId");
  const b = await c.req.json<{ contract_item_id?: number; material_id?: number; qty?: number; description?: string; unit?: string }>();
  let description = b.description ?? null;
  let unit = b.unit ?? null;
  if (b.contract_item_id) {
    const ci = await c.env.DB.prepare("SELECT description, unit FROM contract_items WHERE id = ?")
      .bind(b.contract_item_id).first<{ description: string; unit: string | null }>();
    if (ci) { description = description ?? ci.description; unit = unit ?? ci.unit; }
  } else if (b.material_id) {
    const m = await c.env.DB.prepare("SELECT item, total_units_unit, cost_unit FROM materials WHERE id = ?")
      .bind(b.material_id).first<{ item: string; total_units_unit: string | null; cost_unit: string | null }>();
    if (m) { description = description ?? m.item; unit = unit ?? (m.total_units_unit || m.cost_unit); }
  }
  const row = await c.env.DB.prepare(
    `INSERT INTO programme_activity_items (activity_id, contract_item_id, material_id, description, qty, unit, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(activityId, b.contract_item_id ?? null, b.material_id ?? null, description, b.qty ?? null, unit, new Date().toISOString()).first<{ id: number }>();
  return c.json({ ok: true, id: row?.id });
});

/** Remove a link. */
programme.delete("/:projectId/items/:itemId", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  await c.env.DB.prepare("DELETE FROM programme_activity_items WHERE id = ?").bind(c.req.param("itemId")).run();
  return c.json({ ok: true });
});

/**
 * Stock / procurement demand for the whole site. Each bill line linked to a
 * programme activity is expanded into its component materials (cost-sheet
 * quantities); we sum those per material, date them by the earliest activity
 * that needs them, and compare to what's on order (approved/issued POs). Bills
 * are per-contract but the programme is shared, so we aggregate across every
 * contract in the site group — the schedule covers the entire site.
 */
programme.get("/:projectId/stock-demand", async (c) => {
  const members = await siteMembers(c.env.DB, c.req.param("projectId"));
  const ph = members.map(() => "?").join(",");
  // Core demand: each linked bill line expanded into its component materials,
  // summed per material and dated by the earliest activity that needs it. No
  // per-row correlated subqueries here — the old on-order / delivered subqueries
  // scanned po_lines / site_deliveries for EVERY component row and timed out on
  // D1 at real data volumes (which silently returned an empty tab). Those are now
  // two bulk passes, merged below.
  const rows = (await c.env.DB.prepare(
    `WITH linked AS (
       SELECT pi.contract_item_id AS cid, MIN(a.planned_start) AS needed, MAX(a.pct_complete) AS pct
         FROM programme_activity_items pi
         JOIN programme_activities a ON a.id = pi.activity_id
        WHERE pi.contract_item_id IS NOT NULL
        GROUP BY pi.contract_item_id
     )
     SELECT s.project_id AS block_id, p.name AS block, cc.name AS item, cc.unit AS unit,
            SUM(cc.qty) AS required_qty, SUM(cc.qty * COALESCE(l.pct, 0)) AS installed,
            MIN(l.needed) AS needed_by
       FROM linked l
       JOIN contract_items ci ON ci.id = l.cid
       JOIN material_snapshots s ON s.id = ci.snapshot_id
       JOIN projects p ON p.id = s.project_id
       JOIN contract_item_components cc ON cc.contract_item_id = l.cid
      WHERE s.project_id IN (${ph}) AND s.is_active = 1 AND cc.qty IS NOT NULL AND cc.qty > 0
      GROUP BY s.project_id, lower(cc.name), cc.unit
      ORDER BY p.name, needed_by IS NULL, needed_by, required_qty DESC`,
  ).bind(...members).all<{ block_id: string; block: string; item: string; unit: string; required_qty: number; installed: number; needed_by: string | null }>()).results;
  if (!rows.length) return c.json([]);

  // On order: approved/issued/pending PO lines, grouped per block + material.
  const orders = (await c.env.DB.prepare(
    `SELECT po.project_id AS block_id, lower(pl.item) AS item, SUM(pl.qty) AS qty
       FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
      WHERE po.project_id IN (${ph}) AND po.status IN ('approved','issued','pending_approval') AND pl.is_unpriced = 0
      GROUP BY po.project_id, lower(pl.item)`,
  ).bind(...members).all<{ block_id: string; item: string; qty: number }>()).results;
  const onOrder = new Map(orders.map((o) => [`${o.block_id}|${o.item}`, o.qty ?? 0]));

  // Deliveries received across the site — matched to a material by name substring
  // in JS (avoids a per-row LIKE table scan).
  const deliveries = (await c.env.DB.prepare(
    `SELECT lower(description) AS descr, received_qty AS qty FROM site_deliveries
      WHERE project_id IN (${ph}) AND received_qty IS NOT NULL AND description IS NOT NULL`,
  ).bind(...members).all<{ descr: string; qty: number }>()).results;

  // Active substitutions on the live bill: swap the displayed material to the
  // chosen replacement so the to-order list reflects what'll actually be ordered.
  // Matched by name (cost-sheet component ↔ Materials-list item) — best-effort.
  const subRows = (await c.env.DB.prepare(
    `SELECT lower(m.item) AS orig, ms.replacement_item AS repl
       FROM material_substitutions ms
       JOIN materials m ON m.id = ms.material_id
       JOIN material_snapshots s ON s.id = m.snapshot_id
      WHERE s.project_id IN (${ph}) AND s.is_active = 1 AND ms.status = 'approved' AND ms.replacement_item IS NOT NULL`,
  ).bind(...members).all<{ orig: string; repl: string }>()).results;
  const subByItem = new Map(subRows.map((s) => [s.orig, s.repl]));

  const out = rows.map((r) => {
    const name = (r.item || "").toLowerCase();
    if (!name) return { ...r, on_order: 0, delivered: 0, substituted_from: null };
    const repl = subByItem.get(name) ?? null;
    const replName = repl ? repl.toLowerCase() : null;
    // On-order / delivered count POs raised under the original component name AND
    // (where substituted) the replacement product name.
    const onOrderQty = (onOrder.get(`${r.block_id}|${name}`) ?? 0) + (replName ? (onOrder.get(`${r.block_id}|${replName}`) ?? 0) : 0);
    const delivered = deliveries.reduce((sum, d) =>
      sum + (d.descr && (d.descr.includes(name) || (replName && d.descr.includes(replName))) ? (d.qty || 0) : 0), 0);
    return { ...r, item: repl ?? r.item, substituted_from: repl ? r.item : null, on_order: onOrderQty, delivered };
  });
  return c.json(out);
});

/**
 * Portfolio roll-up across every programme (one per site / standalone project).
 * Returns health metrics so the sidebar Programme workspace can flag slippage
 * and what's live this week.
 */
programme.get("/_portfolio/summary", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT a.project_id, a.name, a.is_summary, a.level, a.display_order,
            a.duration_days, a.pct_complete,
            a.planned_start, a.planned_finish, a.baseline_finish, a.actual_finish,
            p.code AS project_code, p.name AS project_name, p.site_group_id,
            sg.name AS group_name
       FROM programme_activities a JOIN projects p ON p.id = a.project_id
       LEFT JOIN site_groups sg ON sg.id = p.site_group_id
      WHERE p.deleted_at IS NULL AND p.id <> 'sandbox'`,
  ).all<{
    project_id: string; name: string; is_summary: number; level: number; display_order: number;
    duration_days: number | null; pct_complete: number;
    planned_start: string | null; planned_finish: string | null; baseline_finish: string | null; actual_finish: string | null;
    project_code: string; project_name: string; site_group_id: string | null; group_name: string | null;
  }>();

  // Member contracts per site group, so a combined programme's blocks can map to
  // the real project they belong to (BLOCK C → 26002 Block C) and deep-link there.
  const memberRows = await c.env.DB.prepare(
    `SELECT id, code, name, site_group_id FROM projects
      WHERE site_group_id IS NOT NULL AND deleted_at IS NULL ORDER BY code`,
  ).all<{ id: string; code: string; name: string; site_group_id: string }>();
  type Member = { id: string; code: string; name: string };
  const membersByGroup = new Map<string, Member[]>();
  for (const m of memberRows.results) {
    const a = membersByGroup.get(m.site_group_id) ?? [];
    a.push({ id: m.id, code: m.code, name: m.name });
    membersByGroup.set(m.site_group_id, a);
  }
  // Match a "BLOCK X" heading to the member contract whose name carries the same
  // block id — the same loose block-letter match used when auto-tagging the bill.
  const matchBlock = (heading: string, members: Member[]): Member | null => {
    const m = heading.toLowerCase().match(/\bblock\s+([a-z0-9]+)/);
    if (!m) return null;
    const re = new RegExp(`\\bblock\\s+${m[1]}\\b`, "i");
    return members.find((mem) => re.test(mem.name)) ?? null;
  };

  const today = new Date().toISOString().slice(0, 10);
  const wkEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const byProj = new Map<string, typeof rows.results>();
  for (const r of rows.results) { const a = byProj.get(r.project_id) ?? []; a.push(r); byProj.set(r.project_id, a); }

  // Roll up a set of activities into health metrics (weighted % complete, latest
  // finish, slippage vs baseline, what's live this week, overdue tasks).
  const rowMetrics = (items: typeof rows.results) => {
    let wsum = 0, w = 0, tasks = 0; let pf: string | null = null, bf: string | null = null;
    let activeNow = 0, overdue = 0;
    for (const a of items) {
      const d = a.duration_days ?? 1;
      if (!a.is_summary) { wsum += (a.pct_complete || 0) * d; w += d; tasks++; }
      if (a.planned_finish && (!pf || a.planned_finish > pf)) pf = a.planned_finish;
      if (a.baseline_finish && (!bf || a.baseline_finish > bf)) bf = a.baseline_finish;
      if (!a.is_summary && (a.pct_complete || 0) < 1) {
        if (a.planned_start && a.planned_finish && a.planned_start <= wkEnd && a.planned_finish >= today) activeNow++;
        if (a.planned_finish && a.planned_finish < today) overdue++;
      }
    }
    const slip = pf && bf ? Math.round((+new Date(pf) - +new Date(bf)) / 86400000) : null;
    return { tasks, pct_complete: w > 0 ? wsum / w : 0, planned_finish: pf, baseline_finish: bf, slip_days: slip, active_this_week: activeNow, overdue };
  };

  type OutRow = {
    id: string; project_id: string; title: string; subtitle: string | null; is_block: boolean;
    activities: number; pct_complete: number; planned_finish: string | null; baseline_finish: string | null;
    slip_days: number | null; active_this_week: number; overdue: number;
  };
  const out: OutRow[] = [];

  // Stable ordering: by site/contract name, with a site's blocks kept together
  // in programme order.
  const entries = [...byProj.entries()].sort((a, b) => {
    const an = (a[1][0].group_name || a[1][0].project_name || "").toLowerCase();
    const bn = (b[1][0].group_name || b[1][0].project_name || "").toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  for (const [pid, actsRaw] of entries) {
    const acts = [...actsRaw].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    const first = acts[0];
    const grouped = !!first.site_group_id;

    // Split the programme into its top-level BLOCK sections (level-0 summary
    // rows). Tasks before the first block heading fall into a "General" section.
    const blocks: { name: string; items: typeof acts }[] = [];
    const lead: typeof acts = [];
    let cur: { name: string; items: typeof acts } | null = null;
    for (const a of acts) {
      if (a.is_summary && a.level === 0) { cur = { name: a.name, items: [] }; blocks.push(cur); }
      else if (cur) cur.items.push(a);
      else lead.push(a);
    }
    const blocksWithTasks = blocks.filter((b) => b.items.some((x) => !x.is_summary));

    if (blocksWithTasks.length >= 2) {
      // Break the combined programme out — one row per block, each mapped to the
      // real contract it represents so the row deep-links to that project.
      const members = first.site_group_id ? (membersByGroup.get(first.site_group_id) ?? []) : [];
      const sections: { name: string; items: typeof acts }[] = [];
      if (lead.some((x) => !x.is_summary)) sections.push({ name: "General", items: lead });
      sections.push(...blocksWithTasks);
      sections.forEach((sec, i) => {
        const m = rowMetrics(sec.items);
        const contract = sec.name === "General" ? null : matchBlock(sec.name, members);
        out.push({
          id: `${pid}:${i}`,
          // Deep-link to the matched contract; fall back to the base project.
          project_id: contract ? contract.id : pid,
          title: contract ? `${contract.code} · ${contract.name}` : sec.name,
          subtitle: contract ? (first.group_name ?? null) : (grouped ? (first.group_name ?? null) : `${first.project_code} · ${first.project_name}`),
          is_block: true, activities: m.tasks,
          pct_complete: m.pct_complete, planned_finish: m.planned_finish, baseline_finish: m.baseline_finish,
          slip_days: m.slip_days, active_this_week: m.active_this_week, overdue: m.overdue,
        });
      });
    } else {
      // Single (un-blocked) programme — one row for the whole thing.
      const m = rowMetrics(acts);
      out.push({
        id: pid, project_id: pid,
        title: grouped && first.group_name ? first.group_name : `${first.project_code} · ${first.project_name}`,
        subtitle: grouped && first.group_name ? "Combined programme" : null,
        is_block: false, activities: m.tasks,
        pct_complete: m.pct_complete, planned_finish: m.planned_finish, baseline_finish: m.baseline_finish,
        slip_days: m.slip_days, active_this_week: m.active_this_week, overdue: m.overdue,
      });
    }
  }
  return c.json(out);
});
