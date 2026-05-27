// Valuation schedule: per-project planned dates (cutoff / submission /
// certification / payment) plus an upload metadata endpoint for a PDF/xlsx
// schedule, and the portfolio calendar feed.

import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";
import { parseValuationScheduleXlsx } from "../../shared/parse-xlsx";

export const valuations = new Hono<{ Bindings: Env; Variables: Variables }>();

const ENTRY_TYPES = ["application", "due", "notice", "final_payment"] as const;
type EntryType = typeof ENTRY_TYPES[number];

/**
 * Display labels for each entry type. These appear in the portfolio
 * calendar feed and downstream UI; keeping a single source of truth here
 * means we can rename in one place.
 */
const ENTRY_LABELS: Record<EntryType, string> = {
  application: "Application",
  due: "Due date",
  notice: "Notice",
  final_payment: "Final date for payment",
};

/** List valuation schedule entries for one project. */
valuations.get("/project/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const rows = await c.env.DB.prepare(
    `SELECT id, app_number, entry_type, date, notes, created_at, created_by
     FROM valuation_schedule_entries WHERE project_id = ? ORDER BY date, app_number`,
  )
    .bind(projectId)
    .all();
  return c.json(rows.results);
});

/** Add a single schedule entry. */
valuations.post("/project/:projectId", async (c) => {
  const denied = requirePermission(c, "projects.edit");
  if (denied) return denied;
  const projectId = c.req.param("projectId");
  const body = await c.req.json<{
    app_number?: number | null;
    entry_type: EntryType;
    date: string;
    notes?: string;
  }>();
  if (!ENTRY_TYPES.includes(body.entry_type)) return c.json({ error: "invalid entry_type" }, 400);
  if (!body.date) return c.json({ error: "date required" }, 400);

  const now = new Date().toISOString();
  const inserted = await c.env.DB.prepare(
    `INSERT INTO valuation_schedule_entries
       (project_id, app_number, entry_type, date, notes, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      projectId, body.app_number ?? null, body.entry_type, body.date,
      body.notes ?? null, now, c.get("userEmail"),
    )
    .first<{ id: number }>();
  return c.json({ id: inserted?.id });
});

/** Delete a schedule entry. */
valuations.delete("/entries/:id", async (c) => {
  const denied = requirePermission(c, "projects.edit");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM valuation_schedule_entries WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ ok: true });
});

/** Record that a valuation schedule file was uploaded for a project. */
valuations.post("/project/:projectId/upload-meta", async (c) => {
  const denied = requirePermission(c, "projects.edit");
  if (denied) return denied;
  const projectId = c.req.param("projectId");
  const body = await c.req.json<{ filename: string }>();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE projects
     SET valuation_schedule_filename = ?,
         valuation_schedule_uploaded_at = ?,
         valuation_schedule_uploaded_by = ?
     WHERE id = ?`,
  )
    .bind(body.filename, now, c.get("userEmail"), projectId)
    .run();
  return c.json({ ok: true });
});

/**
 * Upload an .xlsx valuation schedule. Parses the sheet, creates one entry
 * per detected date column per app row, records the filename + uploaded_at
 * on the project, and (by default) replaces the existing entries so a
 * re-upload of the same file doesn't create duplicates.
 */
valuations.post("/project/:projectId/upload", async (c) => {
  const denied = requirePermission(c, "projects.edit");
  if (denied) return denied;
  const projectId = c.req.param("projectId");
  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?")
    .bind(projectId)
    .first();
  if (!project) return c.json({ error: "project not found" }, 404);

  const form = await c.req.formData();
  const file = form.get("file");
  const replace = form.get("replace") !== "false"; // default: replace
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  const name = file.name.toLowerCase();
  const actor = c.get("userEmail");
  const now = new Date().toISOString();

  // Non-xlsx (e.g. PDF): just record metadata — we can't parse.
  if (!name.endsWith(".xlsx") && !name.endsWith(".xlsm") && !name.endsWith(".xls")) {
    await c.env.DB.prepare(
      `UPDATE projects
       SET valuation_schedule_filename = ?, valuation_schedule_uploaded_at = ?,
           valuation_schedule_uploaded_by = ?
       WHERE id = ?`,
    )
      .bind(file.name, now, actor, projectId)
      .run();
    return c.json({ ok: true, parsed: false, entries_created: 0, filename: file.name });
  }

  let entries;
  try {
    entries = parseValuationScheduleXlsx(await file.arrayBuffer());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "parse failed" }, 400);
  }

  if (replace) {
    await c.env.DB.prepare("DELETE FROM valuation_schedule_entries WHERE project_id = ?")
      .bind(projectId)
      .run();
  }
  if (entries.length > 0) {
    const stmts = entries.map((e) =>
      c.env.DB.prepare(
        `INSERT INTO valuation_schedule_entries
           (project_id, app_number, entry_type, date, notes, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(projectId, e.app_number, e.entry_type, e.date, e.notes, now, actor),
    );
    await c.env.DB.batch(stmts);
  }

  await c.env.DB.prepare(
    `UPDATE projects
     SET valuation_schedule_filename = ?, valuation_schedule_uploaded_at = ?,
         valuation_schedule_uploaded_by = ?
     WHERE id = ?`,
  )
    .bind(file.name, now, actor, projectId)
    .run();

  return c.json({
    ok: true,
    parsed: true,
    entries_created: entries.length,
    filename: file.name,
  });
});

/**
 * Portfolio calendar — combines planned schedule entries + actual AfP
 * period-end dates across every project. Used by the Commercials tab's
 * left-hand calendar.
 *
 * Each row: { date, project_id, project_code, kind, label, app_number? }
 * where `kind` is one of:
 *   scheduled-cutoff / scheduled-submission / scheduled-certification / scheduled-payment
 *   afp-period-end (with status hint)
 */
valuations.get("/_portfolio", async (c) => {
  const from = c.req.query("from") ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const to = c.req.query("to") ?? new Date(Date.now() + 180 * 86400_000).toISOString().slice(0, 10);

  const scheduled = await c.env.DB.prepare(
    `SELECT v.id, v.date, v.entry_type, v.app_number, v.notes,
            p.id AS project_id, p.code AS project_code, p.name AS project_name
     FROM valuation_schedule_entries v
     JOIN projects p ON p.id = v.project_id
     WHERE p.deleted_at IS NULL AND v.date BETWEEN ? AND ?
     ORDER BY v.date, p.code`,
  )
    .bind(from, to)
    .all<{
      id: number; date: string; entry_type: EntryType; app_number: number | null; notes: string | null;
      project_id: string; project_code: string; project_name: string;
    }>();

  const afps = await c.env.DB.prepare(
    `SELECT a.id, a.app_number, a.period_end, a.status, a.direction,
            p.id AS project_id, p.code AS project_code, p.name AS project_name
     FROM applications_for_payment a
     JOIN projects p ON p.id = a.project_id
     WHERE p.deleted_at IS NULL AND a.period_end BETWEEN ? AND ?
     ORDER BY a.period_end, p.code`,
  )
    .bind(from, to)
    .all<{
      id: number; app_number: number; period_end: string; status: string; direction: string;
      project_id: string; project_code: string; project_name: string;
    }>();

  const items: Array<{
    date: string;
    project_id: string;
    project_code: string;
    project_name: string;
    kind: string;
    label: string;
    app_number: number | null;
    afp_id?: number;
    status?: string;
  }> = [];
  for (const s of scheduled.results) {
    items.push({
      date: s.date,
      project_id: s.project_id,
      project_code: s.project_code,
      project_name: s.project_name,
      kind: `scheduled-${s.entry_type}`,
      label: (ENTRY_LABELS[s.entry_type as EntryType] ?? s.entry_type) +
        (s.app_number ? ` #${s.app_number}` : ""),
      app_number: s.app_number,
    });
  }
  for (const a of afps.results) {
    items.push({
      date: a.period_end,
      project_id: a.project_id,
      project_code: a.project_code,
      project_name: a.project_name,
      kind: "afp-period-end",
      label: `AfP #${a.app_number} period-end (${a.status})`,
      app_number: a.app_number,
      afp_id: a.id,
      status: a.status,
    });
  }
  items.sort((x, y) => x.date.localeCompare(y.date));
  return c.json(items);
});
