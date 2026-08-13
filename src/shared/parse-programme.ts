// Parser for a construction works programme exported to Excel. Programmes from
// Asta Powerproject, MS Project or a hand-built spreadsheet all share the same
// shape once in Excel: one row per task with Name, Duration, Start, Finish,
// % Complete and Predecessors, plus an outline/indent level for summary tasks.
//
// As with the pricing-workbook and valuation-schedule parsers, we sniff the
// header row and map columns by keyword rather than hard-coding letters, so a
// new template revision doesn't need code changes.

import * as XLSX from "xlsx";

export type ParsedProgrammeActivity = {
  line_no: number | null;
  level: number;
  name: string;
  is_milestone: boolean;
  is_summary: boolean;
  planned_start: string | null; // ISO yyyy-mm-dd
  planned_finish: string | null; // ISO yyyy-mm-dd
  pct_complete: number; // 0..1
  duration_days: number | null;
  predecessors: string | null;
  display_order: number;
};

/** Read a programme workbook. cellDates makes date cells come through as Date
 *  objects; we still cope with Excel serials and text dates as a fallback. */
export function readProgrammeWorkbook(buffer: ArrayBuffer): XLSX.WorkBook {
  return XLSX.read(buffer, { type: "array", cellDates: true });
}

const norm = (v: unknown): string =>
  String(v ?? "").toLowerCase().replace(/[\s._%-]+/g, "");

type ColMap = {
  id?: string;
  name?: string;
  level?: string;
  duration?: string;
  start?: string;
  finish?: string;
  pct?: string;
  predecessors?: string;
  milestone?: string;
  summary?: string;
};

/** Map a header row's cells (keyed A,B,C…) to programme columns. Returns the
 *  map plus a score (how many of the essential columns we found). */
function mapHeader(row: Record<string, unknown>): { map: ColMap; score: number } {
  const map: ColMap = {};
  // Each column is assigned to the FIRST role it matches, and a role is only
  // taken once. Specific roles (id, dates, duration, %) are tested before the
  // catch-all "name" so e.g. "Task ID" → id and "Activity / Task" → name.
  for (const [col, raw] of Object.entries(row)) {
    const h = norm(raw);
    if (!h) continue;
    if (!map.milestone && /^(milestone|ms)$/.test(h)) map.milestone = col;
    else if (!map.summary && /^(summary|group|heading)$/.test(h)) map.summary = col;
    else if (!map.id && /(^id$|^no$|^line$|^ref$|^item$|^seq$|^uid$|taskid|lineid|activityid)/.test(h)) map.id = col;
    else if (!map.pct && /(percentcomplete|%complete|^complete$|^progress$|progress%|^done$|^pct$|actualprog|plannedprog|^%$)/.test(h)) map.pct = col;
    else if (!map.duration && /(duration|^dur$|^days$|^length$|workingdays|^wd$)/.test(h)) map.duration = col;
    else if (!map.start && /(^start|startdate|commence|begin|plannedstart|actualstart|^begins?$)/.test(h)) map.start = col;
    else if (!map.finish && /(^finish|^end$|^ends?$|enddate|finishdate|completiondate|plannedfinish|actualfinish)/.test(h)) map.finish = col;
    else if (!map.predecessors && /(predecessor|depends|^pred|preceding|^links?$)/.test(h)) map.predecessors = col;
    else if (!map.level && /(outlinelevel|^level$|^wbs$|indent|^tier$)/.test(h)) map.level = col;
    else if (!map.name && /(activity|task|^name$|jobname|description|^element$|^operation$|^scope$|workitem|workpackage|^works?$)/.test(h)) map.name = col;
  }
  // Essentials for a usable programme: a name and at least one date.
  let score = 0;
  if (map.name) score += 2;
  if (map.start) score += 1;
  if (map.finish) score += 1;
  if (map.duration) score += 1;
  if (map.pct) score += 1;
  return { map, score };
}

/** Coerce a cell to an ISO date (yyyy-mm-dd) or null. Handles Date objects,
 *  Excel serial numbers and common UK text formats (DD/MM/YYYY, DD-Mon-YYYY). */
function toISO(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v.getTime())) {
    return iso(v.getFullYear(), v.getMonth() + 1, v.getDate());
  }
  if (typeof v === "number" && isFinite(v)) {
    // Excel serial date.
    const dc = XLSX.SSF?.parse_date_code?.(v);
    if (dc && dc.y) return iso(dc.y, dc.m, dc.d);
    return null;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    // DD/MM/YYYY or DD-MM-YYYY (UK).
    let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
    if (m) {
      const d = +m[1], mo = +m[2];
      let y = +m[3];
      if (y < 100) y += 2000;
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return iso(y, mo, d);
    }
    // DD-Mon-YYYY / DD Mon YY.
    m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-](\d{2,4})$/);
    if (m) {
      const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const mo = months.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
      let y = +m[3];
      if (y < 100) y += 2000;
      if (mo) return iso(y, mo, +m[1]);
    }
    const t = Date.parse(s);
    if (!isNaN(t)) {
      const d = new Date(t);
      return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Percent → 0..1. Accepts 0.5, 50, "50%", "100". */
function toPct(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v > 1 ? Math.min(v / 100, 1) : Math.max(v, 0);
  const m = String(v).match(/-?\d+(\.\d+)?/);
  if (!m) return 0;
  const n = parseFloat(m[0]);
  return n > 1 ? Math.min(n / 100, 1) : Math.max(n, 0);
}

/** Duration text → working days. "5", "5 days", "5d", "2 wks" (→10), "1 mon". */
function toDuration(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const s = String(v).toLowerCase();
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  if (/\bw|wk|week/.test(s)) n *= 5;
  else if (/\bmon|month/.test(s)) n *= 20;
  return n;
}

function truthy(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "number") return v !== 0;
  return /^(y|yes|true|1|✓|x)/i.test(String(v).trim());
}

/** Pick the sheet most likely to be the programme and parse its activities. */
export function parseProgrammeSheet(input: ArrayBuffer | XLSX.WorkBook): ParsedProgrammeActivity[] {
  const wb = input instanceof ArrayBuffer ? readProgrammeWorkbook(input) : input;

  // Choose the best sheet + header row across the workbook.
  let best: { sheet: string; headerIdx: number; map: ColMap; score: number } | null = null;
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { header: "A", defval: null, raw: true });
    for (let i = 0; i < Math.min(25, rows.length); i++) {
      const { map, score } = mapHeader(rows[i]);
      // Need at least a name column and one date column to be a programme.
      if (map.name && (map.start || map.finish) && score > (best?.score ?? 0)) {
        best = { sheet: sheetName, headerIdx: i, map, score };
      }
    }
  }
  if (!best) return [];

  const ws = wb.Sheets[best.sheet];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { header: "A", defval: null, raw: true });
  const { map } = best;
  const out: ParsedProgrammeActivity[] = [];
  let order = 0;
  let blankRun = 0;
  let curHeadingLevel = -1;

  for (let i = best.headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const rawName = map.name ? r[map.name] : null;
    const name = rawName == null ? "" : String(rawName);
    const nameTrim = name.trim();
    if (!nameTrim) {
      // Section/block heading rows put their text in column A (not the task
      // column) and carry no dates. Capture them as summary rows so the
      // programme keeps its structure ("BLOCK D", "Felt (flat roof)", …).
      const aRaw = map.name !== "A" ? r["A"] : null;
      const aText = aRaw == null ? "" : String(aRaw).trim();
      if (aText && aText.length <= 90) {
        const lvl = /^\s*block\b/i.test(aText) ? 0 : 1;
        curHeadingLevel = lvl;
        out.push({
          line_no: null, level: lvl, name: aText, is_milestone: false, is_summary: true,
          planned_start: null, planned_finish: null, pct_complete: 0, duration_days: null,
          predecessors: null, display_order: order++,
        });
        blankRun = 0;
        continue;
      }
      if (++blankRun > 8) break; // long gap → end of the task list
      continue;
    }
    blankRun = 0;

    const start = map.start ? toISO(r[map.start]) : null;
    const finish = map.finish ? toISO(r[map.finish]) : null;
    const duration = map.duration ? toDuration(r[map.duration]) : null;

    // Skip rows that are clearly not tasks (no dates and no duration) — e.g.
    // notes or section spacers that happen to carry text in the name column.
    if (!start && !finish && duration == null) continue;

    const idRaw = map.id ? r[map.id] : null;
    const lineNo = typeof idRaw === "number" ? idRaw : (idRaw != null && /^\d+$/.test(String(idRaw).trim()) ? parseInt(String(idRaw), 10) : null);

    // Level: explicit column, else infer from leading whitespace in the name
    // (Asta/manual programmes indent sub-tasks).
    let level = 0;
    if (map.level) {
      const lv = r[map.level];
      level = typeof lv === "number" ? Math.max(0, Math.round(lv) - (lv >= 1 ? 1 : 0)) : 0;
    } else if (curHeadingLevel >= 0) {
      // Nest tasks beneath the section heading they fall under.
      level = curHeadingLevel + 1;
    } else {
      const lead = name.match(/^(\s+)/);
      if (lead) level = Math.min(Math.floor(lead[1].length / 2), 5);
    }

    const isMilestone = (map.milestone && truthy(r[map.milestone])) ||
      duration === 0 || (!!start && !!finish && start === finish);
    const isSummary = (map.summary && truthy(r[map.summary])) || false;

    out.push({
      line_no: lineNo,
      level,
      name: nameTrim,
      is_milestone: !!isMilestone,
      is_summary: !!isSummary,
      planned_start: start,
      planned_finish: finish,
      pct_complete: map.pct ? toPct(r[map.pct]) : 0,
      duration_days: duration,
      predecessors: map.predecessors && r[map.predecessors] != null ? String(r[map.predecessors]).trim() || null : null,
      display_order: order++,
    });
  }
  return out;
}
