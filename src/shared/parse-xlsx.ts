import * as XLSX from "xlsx";

export type ParsedMaterial = {
  item: string;
  /** Human-readable element/section label rendered in lists & filters. */
  type: string;
  /** New (MCR007+): numeric element code from col B that maps to the elements table. */
  element_code: string | null;
  manufacturer: string | null;
  pack_qty: number | null;
  pack_unit: string | null;
  cost: number | null;
  cost_unit: string | null;
  coverage_qty: number | null;
  coverage_unit: string | null;
  waste_pct: number | null;
  unit_rate: number | null;
  rate_unit: string | null;
  total_qty: number | null;
  total_qty_unit: string | null;
  total_units: number | null;       // pack-unit qty to purchase (Rolls, Boxes, ea)
  total_units_unit: string | null;  // the pack unit suppliers sell in
  material_total_cost: number | null;
  labour_unit_cost: number | null;    // labour £ per unit (col S in v2)
  labour_total_cost: number | null;   // labour £ for the whole line (col Z in v2)
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/** Is the string a candidate element code? Codes are short numeric like "10", "22", "51". */
const looksLikeElementCode = (v: unknown): boolean => {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  return /^\d{1,4}$/.test(s);
};

// ── Valuation schedule parser ─────────────────────────────────────────────

/**
 * Valuation schedule entry types. These mirror the UK Construction Act
 * payment cycle: PM submits an application; the contract specifies a due
 * date when the sum becomes owed; the client issues a payment / pay-less
 * notice by the notice date; the contractor must be paid by the final
 * date for payment.
 */
export type ParsedValuationEntry = {
  app_number: number | null;
  entry_type: "application" | "due" | "notice" | "final_payment";
  date: string;       // ISO yyyy-mm-dd
  notes: string | null;
};

// Order matters — more specific regexes first, so that e.g.
// "Final date for payment" doesn't get scooped by the looser /payment/ rule.
const ENTRY_KEYWORDS: Array<{ type: ParsedValuationEntry["entry_type"]; re: RegExp }> = [
  { type: "final_payment", re: /(final\s*date\s*for\s*payment|final\s*payment\s*date|fdp\b)/i },
  { type: "notice",        re: /(pay\s*less\s*notice|payment\s*notice|notice\s*date|^notice$)/i },
  { type: "due",           re: /(due\s*date|date\s*due|payment\s*due)/i },
  { type: "application",   re: /(application\s*date|app\s*date|afp\s*date|submission|submitted|applied)/i },
];

const MONTH_BY_NAME: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

function fmtIso(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2200) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Best-effort coerce an xlsx cell into an ISO yyyy-mm-dd string. Handles
 *  Date objects, Excel serials, all-numeric DD/MM/YYYY, and named-month
 *  formats like "14-May-2026", "14 May 2026", "May 14, 2026". */
function toIsoDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    return fmtIso(v.getFullYear(), v.getMonth() + 1, v.getDate());
  }
  if (typeof v === "number") {
    // Day-offset hints in payment schedules (e.g. "1", "7", "30") are tiny
    // integers — reject anything outside the realistic Excel-date range so
    // we don't accidentally turn "7" into 1900-01-06.
    if (v < 10000) return null;
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    if (Number.isNaN(d.getTime())) return null;
    return toIsoDate(d);
  }
  const s = String(v).trim();
  if (!s) return null;

  // YYYY-MM-DD (ISO)
  const ymd = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) return fmtIso(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));

  // DD-Mon-YYYY / DD Mon YYYY / DD.Mon.YYYY  (e.g. "14-May-2026")
  const dmn = s.match(/^(\d{1,2})[\s\-./]+([A-Za-z]{3,})[\s\-./]+(\d{2,4})$/);
  if (dmn) {
    const m = MONTH_BY_NAME[dmn[2].toLowerCase()];
    if (m) {
      const year = dmn[3].length === 2 ? 2000 + Number(dmn[3]) : Number(dmn[3]);
      return fmtIso(year, m, Number(dmn[1]));
    }
  }

  // Mon DD, YYYY / Mon DD YYYY  (e.g. "May 14, 2026")
  const nDm = s.match(/^([A-Za-z]{3,})[\s.]+(\d{1,2}),?\s+(\d{2,4})$/);
  if (nDm) {
    const m = MONTH_BY_NAME[nDm[1].toLowerCase()];
    if (m) {
      const year = nDm[3].length === 2 ? 2000 + Number(nDm[3]) : Number(nDm[3]);
      return fmtIso(year, m, Number(nDm[2]));
    }
  }

  // All-numeric DD/MM/YYYY / DD-MM-YYYY / DD.MM.YYYY (UK convention)
  const dmy = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dmy) {
    const year = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    return fmtIso(year, Number(dmy[2]), Number(dmy[1]));
  }

  // Fallback: anything Date.parse handles natively.
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return fmtIso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return null;
}

/**
 * Parse a valuation schedule .xlsx. Looks across every sheet for a header
 * row that mentions an "App #" / "Application" column AND at least one of
 * cut-off / submission / certification / payment dates. Each subsequent
 * row with date-shaped values becomes one entry per matching date column.
 *
 * Returns [] if no recognisable schedule is found (caller can still
 * record the filename for manual review).
 */
export function parseValuationScheduleXlsx(buffer: ArrayBuffer): ParsedValuationEntry[] {
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
      header: "A", defval: null, raw: false,
    });
    const result = scanSheet(rows);
    if (result.length > 0) return result;
  }
  return [];
}

function scanSheet(rows: Array<Record<string, unknown>>): ParsedValuationEntry[] {
  // Pass 1 — column-oriented layout (rows are valuations, columns are dates).
  // Header row contains date column labels; optionally an "App #" column too.
  for (let h = 0; h < Math.min(20, rows.length); h++) {
    const headerRow = rows[h];
    const colMap = readHeaderRow(headerRow);
    if (colMap.dateCols.length === 0) continue;
    const out: ParsedValuationEntry[] = [];
    let consecutiveEmpty = 0;
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i];
      const appNum = colMap.appCol
        ? coerceAppNumber(r[colMap.appCol])
        : null;
      const notes = colMap.notesCol ? str(r[colMap.notesCol]) : null;
      let foundAny = false;
      for (const dc of colMap.dateCols) {
        const iso = toIsoDate(r[dc.col]);
        if (!iso) continue;
        foundAny = true;
        out.push({
          app_number: appNum,
          entry_type: dc.type,
          date: iso,
          notes,
        });
      }
      // Stop after 2+ empty rows in a row — likely past the data block.
      if (!foundAny && Object.values(r).every((v) => v == null || v === "")) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) break;
      } else {
        consecutiveEmpty = 0;
      }
    }
    if (out.length > 0) return out;
  }

  // Pass 2 — transposed layout (column A holds entry-type labels and each
  // row to the right is a different valuation's dates for that type).
  const transposed = scanTransposed(rows);
  if (transposed.length > 0) return transposed;

  return [];
}

/**
 * Parse a transposed schedule where the leftmost column lists entry types
 * and each subsequent column is a separate valuation cycle:
 *
 *           | App 1       | App 2       | App 3       |
 *  Application | 30 Apr     | 31 May      | 30 Jun      |
 *  Due       | 15 May      | 15 Jun      | 15 Jul      |
 *  Notice    | 18 May      | 18 Jun      | 18 Jul      |
 *  Final pmt | 30 May      | 30 Jun      | 30 Jul      |
 */
function scanTransposed(rows: Array<Record<string, unknown>>): ParsedValuationEntry[] {
  if (rows.length === 0) return [];
  // Identify the label column — the column where multiple cells in different
  // rows match an entry-type keyword.
  const candidateCols = ["A", "B", "C"];
  for (const labelCol of candidateCols) {
    const labelRows: Array<{ rowIdx: number; type: ParsedValuationEntry["entry_type"] }> = [];
    for (let i = 0; i < rows.length; i++) {
      const v = rows[i][labelCol];
      if (v == null) continue;
      const label = String(v).toLowerCase().replace(/\s+/g, " ").trim();
      for (const { type, re } of ENTRY_KEYWORDS) {
        if (re.test(label)) {
          if (!labelRows.some((l) => l.type === type)) labelRows.push({ rowIdx: i, type });
          break;
        }
      }
    }
    if (labelRows.length < 2) continue;

    // The header row above the first label is where app numbers / period
    // labels typically live. Scan it for app numbers in the remaining cols.
    const firstLabelRow = labelRows[0].rowIdx;
    const cols = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const labelColIdx = cols.indexOf(labelCol);

    // Try the row immediately above the first entry-type row as the app-#
    // header. If empty, scan upward up to 3 rows for an app-numbered row.
    let appHeaderRow: Record<string, unknown> | null = null;
    for (let r = firstLabelRow - 1; r >= Math.max(0, firstLabelRow - 3); r--) {
      const candidate = rows[r];
      const hasNumbers = Object.entries(candidate).some(([col, v]) => {
        const idx = cols.indexOf(col);
        if (idx <= labelColIdx) return false;
        return v != null && coerceAppNumber(v) != null;
      });
      if (hasNumbers) { appHeaderRow = candidate; break; }
    }

    const out: ParsedValuationEntry[] = [];
    for (const { rowIdx, type } of labelRows) {
      const row = rows[rowIdx];
      for (const [col, v] of Object.entries(row)) {
        const ci = cols.indexOf(col);
        if (ci <= labelColIdx) continue;
        const iso = toIsoDate(v);
        if (!iso) continue;
        const appNum = appHeaderRow ? coerceAppNumber(appHeaderRow[col]) : null;
        out.push({ app_number: appNum, entry_type: type, date: iso, notes: null });
      }
    }
    if (out.length > 0) return out;
  }
  return [];
}

function coerceAppNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v);
  const m = String(v).match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readHeaderRow(row: Record<string, unknown>): {
  appCol: string | null;
  notesCol: string | null;
  dateCols: Array<{ col: string; type: ParsedValuationEntry["entry_type"] }>;
} {
  let appCol: string | null = null;
  let notesCol: string | null = null;
  const dateCols: Array<{ col: string; type: ParsedValuationEntry["entry_type"] }> = [];
  for (const [col, raw] of Object.entries(row)) {
    if (raw == null || raw === "") continue;
    const label = String(raw).toLowerCase().replace(/\s+/g, " ").trim();
    // Header that identifies which valuation cycle this row is for.
    // Match: "App #/no/number", "Application …", "Val. / Valuation …",
    // "AfP …", "Cycle", "Period …", or a bare "#" / "no.".
    if (
      !appCol &&
      /^(app(?:lication)?\.?\s*(?:#|no\.?|number)?$|val(?:uation)?\.?\s*(?:#|no\.?|number)?$|afp\s*(?:#|no\.?|number)?$|cycle$|period\s*(?:#|no\.?|number)?$|no\.?$|^#$)/i.test(label)
    ) {
      appCol = col;
    }
    if (!notesCol && /^(notes?|comment|remark)/i.test(label)) notesCol = col;
    // Match against the most-specific patterns first; stop at the first hit
    // so a single column maps to a single entry type.
    if (!dateCols.some((d) => d.col === col)) {
      for (const { type, re } of ENTRY_KEYWORDS) {
        if (re.test(label)) {
          dateCols.push({ col, type });
          break;
        }
      }
    }
  }
  return { appCol, notesCol, dateCols };
}

export type ContractCategory = "prelims" | "measured" | "ancil";

/** A material/labour sub-row that builds up a bill item, from the Pricing tab
 *  (col B name, col C girth/usage, col D qty, col E unit, col F material rate). */
export type ParsedBillComponent = {
  name: string;
  girth: number | null;
  qty: number | null;
  unit: string | null;
  material_rate: number | null;
};

export type ParsedContractItem = {
  item_no: number;
  /** Which value section this line belongs to (Summary Cost Sheet roll-up). */
  category: ContractCategory;
  section: string | null;
  description: string;
  qty: number;
  unit: string | null;
  sell_rate: number;
  sell_total: number;
  labour_rate: number | null;
  labour_total: number | null;
  /** Component materials that build up this bill item (Pricing sub-rows). */
  components: ParsedBillComponent[];
};

/**
 * Parse the work item list from the Pricing and Costing-Labour-Only tabs and
 * merge by document position. The two tabs share the same row layout, so the
 * Nth priced work item on Pricing == the Nth work item on Costing Labour Only
 * (both anchor off the BOQ work breakdown).
 *
 * Row classification per tab:
 *   col A populated AND col D & col K numeric  → work item
 *   col A populated AND col D/K missing        → section header
 *   col A empty                                → material sub-row (ignored)
 *
 * Headers are on row 6 (1-indexed); data starts row 7 onward.
 */
type ScanRow = { section: string | null; description: string; qty: number; unit: string | null; rate: number; total: number; labour: number; components: ParsedBillComponent[] };

/**
 * Scan a Pricing/Ancil-style sheet (A=item, D=qty, E=unit, K=rate, M=total).
 *   col A populated + col D & col K numeric  → work item
 *   col A populated + col D/K missing        → section header
 *   col A empty + col B populated            → material/labour sub-row
 *   col A empty + col B empty                → subtotal row (ignored)
 * Each work item's `labour` is the sum of its sub-rows' col I (Labour Value);
 * subtotal rows are skipped so the item's labour isn't double-counted. The
 * measured tabs ignore this (labour comes from the Costing-Labour-Only sheet),
 * but the Ancil tab has no separate labour sheet so we read labour from here.
 * Stops at a "Total" or "COSTING" row so the cost-version block at the bottom
 * of the Ancil Items tab isn't double-counted.
 */
function scanPricingStyle(ws: XLSX.WorkSheet): ScanRow[] {
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { header: "A", defval: null, raw: true });
  const out: ScanRow[] = [];
  let section: string | null = null;
  let current: ScanRow | null = null;
  for (const r of rows) {
    const a = str(r["A"]);
    if (a && /^(total|costing)$/i.test(a)) break;  // stop before the cost block
    if (!a) {
      // Sub-component row (col B set) → it's a material/labour line that builds
      // up the open bill item. Capture it (name/girth/qty/unit/rate) and add its
      // labour value. Subtotal rows (col B empty) carry the already-summed
      // labour — skip them.
      const bname = str(r["B"]);
      if (current && bname) {
        const lab = num(r["I"]);
        if (lab != null) current.labour += lab;
        current.components.push({
          name: bname, girth: num(r["C"]), qty: num(r["D"]), unit: str(r["E"]), material_rate: num(r["F"]),
        });
      }
      continue;
    }
    const d = num(r["D"]);
    const k = num(r["K"]);
    const m = num(r["M"]);
    if (d == null || k == null) { section = a; current = null; continue; }  // section header
    current = { section, description: a, qty: d, unit: str(r["E"]), rate: k, total: m ?? d * k, labour: 0, components: [] };
    out.push(current);
  }
  return out;
}

/**
 * Scan the Prelims tab. Layout: A=Ref, B=Description, C=Qty, D=Unit,
 * G=Total Cost, H=Rate, I=Value. Section rows have a whole-number Ref
 * (1.00, 2.00 → "Management", "Design"); detail rows are 1.01, 1.02…
 * We keep detail rows with a non-zero Value and skip the section subtotals.
 */
function scanPrelims(ws: XLSX.WorkSheet): ScanRow[] {
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { header: "A", defval: null, raw: true });
  const out: ScanRow[] = [];
  let section: string | null = null;
  for (const r of rows) {
    const ref = str(r["A"]);
    const desc = str(r["B"]);
    if (!ref || !desc) continue;
    const refNum = num(ref);
    if (refNum != null && Number.isInteger(refNum)) { section = desc; continue; }  // section subtotal row
    const value = num(r["I"]);
    if (value == null || value === 0) continue;  // excluded / nil lines aren't claimable
    out.push({
      section,
      description: desc,
      qty: num(r["C"]) ?? 1,
      unit: str(r["D"]),
      rate: num(r["H"]) ?? value,
      total: value,
      labour: 0,  // prelims carry no subcontract labour
      components: [],
    });
  }
  return out;
}

export function parseContractItems(input: ArrayBuffer | XLSX.WorkBook): ParsedContractItem[] {
  const wb = input instanceof ArrayBuffer ? readPricingWorkbook(input) : input;
  const findSheet = (...names: string[]) => {
    const lc = names.map((n) => n.toLowerCase());
    const name = wb.SheetNames.find((n) => lc.includes(n.toLowerCase()));
    return name ? wb.Sheets[name] : undefined;
  };

  // ── Measured works (Pricing tab + position-matched labour sheet) ──────
  const sellSheet = findSheet("pricing");
  const labourSheet = findSheet("costing labour only", "labour costing", "labour cost");
  const measuredRaw: Array<ScanRow & { labour_rate: number | null; labour_total: number | null }> = [];
  if (sellSheet) {
    const sell = scanPricingStyle(sellSheet);
    const labour = labourSheet ? scanPricingStyle(labourSheet) : [];
    const usedLabour = new Set<number>();
    sell.forEach((s, i) => {
      const l = labour[i];
      // Position-based match, cross-checked on qty + unit (descriptions can
      // differ between Pricing and the labour sheet for the same BOQ line).
      const ok = l && Math.abs(l.qty - s.qty) < 0.0001 && (l.unit ?? "") === (s.unit ?? "");
      if (ok) usedLabour.add(i);
      measuredRaw.push({ ...s, labour_rate: ok ? l!.rate : null, labour_total: ok ? l!.total : null });
    });
    // Fallback pass: when the labour sheet is maintained separately from the
    // Pricing tab (e.g. MCR010 Block D), rows drift and position matching
    // misses the tail. Re-bind the leftovers by description tokens + the same
    // strict qty/unit cross-check, so a shifted row can't mis-bind.
    const tokens = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 2));
    for (const m of measuredRaw) {
      if (m.labour_rate != null || m.labour_total != null) continue;
      const mt = tokens(m.description);
      if (mt.size === 0) continue;
      let best = -1, bestScore = 0;
      labour.forEach((l, j) => {
        if (usedLabour.has(j)) return;
        if (Math.abs(l.qty - m.qty) >= 0.0001 || (l.unit ?? "") !== (m.unit ?? "")) return;
        const lt = tokens(l.description);
        let overlap = 0;
        for (const w of mt) if (lt.has(w)) overlap++;
        const score = overlap === 0 ? 0 : overlap / (mt.size + lt.size - overlap);
        if (score > bestScore) { bestScore = score; best = j; }
      });
      if (best >= 0 && bestScore >= 0.25) {
        usedLabour.add(best);
        m.labour_rate = labour[best].rate;
        m.labour_total = labour[best].total;
      }
    }
  }

  // ── Ancil Items (same layout as Pricing; value only, no labour sheet) ──
  const ancilSheet = findSheet("ancil items", "ancillary items", "ancils");
  const ancilRaw = ancilSheet ? scanPricingStyle(ancilSheet) : [];

  // ── Prelims ───────────────────────────────────────────────────────────
  const prelimsSheet = findSheet("prelims", "preliminaries");
  const prelimsRaw = prelimsSheet ? scanPrelims(prelimsSheet) : [];

  // Combine in Summary Cost Sheet order: Prelims → Measured → Ancil.
  const combined: Array<Omit<ParsedContractItem, "item_no">> = [
    ...prelimsRaw.map((s) => ({
      category: "prelims" as const, section: s.section, description: s.description,
      qty: s.qty, unit: s.unit, sell_rate: s.rate, sell_total: s.total,
      labour_rate: null, labour_total: null, components: s.components,
    })),
    ...measuredRaw.map((s) => ({
      category: "measured" as const, section: s.section, description: s.description,
      qty: s.qty, unit: s.unit, sell_rate: s.rate, sell_total: s.total,
      labour_rate: s.labour_rate, labour_total: s.labour_total, components: s.components,
    })),
    ...ancilRaw.map((s) => ({
      category: "ancil" as const, section: s.section, description: s.description,
      qty: s.qty, unit: s.unit, sell_rate: s.rate, sell_total: s.total,
      // Ancil labour comes from the item's own sub-rows (col I), not a separate
      // labour sheet. Null when the item carries no labour (e.g. supply-only).
      labour_total: s.labour > 0 ? s.labour : null,
      labour_rate: s.labour > 0 && s.qty ? s.labour / s.qty : null,
      components: s.components,
    })),
  ];
  return combined.map((c, i) => ({ item_no: i + 1, ...c }));
}

export type ParsedCommercialRow = {
  category: string;
  value: number | null;
  cost: number | null;
  gross_profit: number | null;
  gross_profit_pct: number | null;
  is_total: boolean;
  display_order: number;
};

/**
 * Cross-check the Summary Cost Sheet figures against the Materials sheet. We've
 * seen workbooks (MCR009) ship with a broken/empty cell in the inner
 * "Measured Works" Cost — leading to an 88% GP that should be ~9%. The
 * Materials sheet's column Y + Z (material total + labour total) is the
 * authoritative cost for measured works; this function uses that to fix
 * up the commercials rows so the displayed numbers actually obey
 *   Cost = Materials + Labour
 *   GP   = Value − Cost
 * for the rows we can derive.
 */
export function reconcileCommercials(
  commercials: ParsedCommercialRow[],
  materials: ParsedMaterial[],
): ParsedCommercialRow[] {
  if (commercials.length === 0) return commercials;
  const materialsGrandTotal = materials.reduce(
    (s, m) => s + (m.material_total_cost ?? 0) + (m.labour_total_cost ?? 0),
    0,
  );
  if (materialsGrandTotal === 0) return commercials;

  const out = commercials.map((r) => ({ ...r }));

  // Find every row that is the "Measured Works" category. Workbooks have
  // either one (just the measured works total) or two (parent total + inner
  // "Measured Works" / "Measured works" sub-row beneath Ancil Items).
  const measuredIdxs: number[] = [];
  for (let i = 0; i < out.length; i++) {
    if (/^\s*measured\s*works\s*$/i.test(out[i].category)) measuredIdxs.push(i);
  }
  if (measuredIdxs.length === 0) return out;

  // Inner row is the last occurrence; parent is the first (only when 2+).
  const innerIdx = measuredIdxs[measuredIdxs.length - 1];
  const parentIdx = measuredIdxs.length >= 2 ? measuredIdxs[0] : -1;
  const totalIdx = out.findIndex((r) => r.is_total || /^\s*total\s*$/i.test(r.category));
  const prelimsIdx = out.findIndex((r) => /^\s*prelim/i.test(r.category));
  const directorsIdx = out.findIndex((r) => /director/i.test(r.category));
  const prelimsCost = prelimsIdx >= 0 ? (out[prelimsIdx].cost ?? 0) : 0;
  const directorsCost = directorsIdx >= 0 ? (out[directorsIdx].cost ?? 0) : 0;
  const sheetTotalCost = totalIdx >= 0 ? out[totalIdx].cost : null;
  const closeTo = (a: number | null, b: number | null) =>
    a != null && b != null && Math.abs(a - b) <= Math.max(50, Math.abs(b) * 0.01);
  const recomputeGp = (r: ParsedCommercialRow) => {
    if (r.value != null && r.cost != null) {
      r.gross_profit = r.value - r.cost;
      r.gross_profit_pct = r.value > 0 ? r.gross_profit / r.value : 0;
    }
  };

  // ── Is the workbook's cost side already sound? It is when the Total cost
  //    matches the Materials grand total (col Y+Z — the authority) AND the
  //    components add up (prelims + measured + directors ≈ total). Then every
  //    figure, including the per-section measured / ancil split, is the sheet's
  //    own correct number (e.g. MCR007 Block B, MCR009 Block C): trust it and
  //    only refresh GP = Value − Cost. Overwriting a sound sheet is what used to
  //    double-count the prelims and zero-out the ancillaries' cost. ──
  const topMeasuredCost = parentIdx >= 0 ? out[parentIdx].cost : out[innerIdx].cost;
  if (
    closeTo(sheetTotalCost, materialsGrandTotal) &&
    topMeasuredCost != null &&
    closeTo(prelimsCost + topMeasuredCost + directorsCost, sheetTotalCost)
  ) {
    out.forEach(recomputeGp);
    return out;
  }

  // Otherwise the cost side is broken (e.g. an empty inner Measured Works cost
  // cell → an absurd ~88% GP). Rebuild from the Materials sheet. If the grand
  // total already includes the preliminaries (some workbooks list PM/SM/QS etc.
  // as Materials rows, so the grand total == the sheet Total), net them off
  // first — mirroring the sheet's `H20 = Materials!Z87 − SUM(prelims)` — so the
  // Preliminaries line isn't added a second time in the total below.
  const prelimsEmbedded = prelimsCost > 0 && closeTo(materialsGrandTotal, sheetTotalCost);
  const measuredCostFromMaterials = prelimsEmbedded
    ? materialsGrandTotal - prelimsCost
    : materialsGrandTotal;

  // If the inner row's cost is materially off (or zero), overwrite from the
  // materials sum. Tolerance is the larger of £50 or 0.5%.
  const inner = out[innerIdx];
  const tol = Math.max(50, measuredCostFromMaterials * 0.005);
  if (Math.abs((inner.cost ?? 0) - measuredCostFromMaterials) > tol) {
    inner.cost = measuredCostFromMaterials;
    if (inner.value != null) {
      inner.gross_profit = inner.value - measuredCostFromMaterials;
      inner.gross_profit_pct = inner.value > 0 ? inner.gross_profit / inner.value : 0;
    }
  }

  // Parent Measured Works cost = inner Measured Works cost. The Materials
  // sheet sum is the AUTHORITY for everything inside Measured Works
  // (including Ancil items — there's no separate row in the Materials sheet
  // for ancillaries, they're folded in). The Ancil Items "Cost" cell some
  // workbooks (MCR009) carry is unreliable / often a manual stand-in; we
  // ignore it to avoid double-counting.
  if (parentIdx >= 0) {
    const parent = out[parentIdx];
    parent.cost = inner.cost ?? 0;
    if (parent.value != null) {
      parent.gross_profit = parent.value - parent.cost;
      parent.gross_profit_pct = parent.value > 0 ? parent.gross_profit / parent.value : 0;
    }
  }
  // Ancil Items: blank the cost out so the UI doesn't show a stale figure
  // that we no longer trust (its value column stays as a sub-breakdown).
  const ancilIdx = out.findIndex((r) => /^\s*ancil/i.test(r.category));
  if (ancilIdx >= 0) {
    out[ancilIdx].cost = null;
    out[ancilIdx].gross_profit = null;
    out[ancilIdx].gross_profit_pct = null;
  }

  // Total cost = Preliminaries (top) + Measured Works (parent) + Directors Adj.
  // With prelims now netted out of Measured Works above, this no longer
  // double-counts them.
  if (totalIdx >= 0) {
    const measuredTopCost = parentIdx >= 0 ? (out[parentIdx].cost ?? 0) : (inner.cost ?? 0);
    const total = out[totalIdx];
    total.cost = prelimsCost + measuredTopCost + directorsCost;
    if (total.value != null) {
      total.gross_profit = total.value - total.cost;
      total.gross_profit_pct = total.value > 0 ? total.gross_profit / total.value : 0;
    }
  }

  return out;
}

/**
 * Parse the "Summary Cost Sheet" tab — the project commercials breakdown.
 *
 * The layout puts the per-category labels in column E and the four numeric
 * columns (Value, Cost, GP, GP%) somewhere to the right. The exact columns
 * vary by template revision, so we sniff the header row instead of
 * hard-coding letters.
 *
 * Returns the rows in document order (typically Total first, then each
 * category). Empty/separator rows are skipped.
 */
export function parseSummaryCostSheet(input: ArrayBuffer | XLSX.WorkBook): ParsedCommercialRow[] {
  const wb = input instanceof ArrayBuffer ? readPricingWorkbook(input) : input;
  const sheetName = wb.SheetNames.find((n) => n.toLowerCase() === "summary cost sheet");
  if (!sheetName) return [];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    header: "A",
    defval: null,
    raw: true,
  });

  // Find the header row (it contains "Value" and "GP%" or similar).
  let headerIdx = -1;
  let labelCol = "E";
  let valueCol = "G";
  let costCol = "H";
  let gpCol = "I";
  let gpPctCol = "J";
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const r = rows[i];
    const cells = Object.entries(r);
    const valueEntry = cells.find(([, v]) => typeof v === "string" && v.toLowerCase().trim() === "value");
    // Match "GP" (no %) and "GP%" as distinct columns — the regex previously
    // matched both because % was optional.
    const gpPlainEntry = cells.find(([, v]) => typeof v === "string" && /^gp$/i.test(String(v).trim()));
    const gpPctEntry = cells.find(([, v]) => typeof v === "string" && /^gp\s*%$/i.test(String(v).trim()));
    if (valueEntry && (gpPlainEntry || gpPctEntry)) {
      headerIdx = i;
      valueCol = valueEntry[0];
      const cols = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const valueColIdx = cols.indexOf(valueCol);
      // Cost is usually the column immediately after Value.
      costCol = cols[valueColIdx + 1];
      gpCol = gpPlainEntry?.[0] ?? cols[valueColIdx + 2];
      gpPctCol = gpPctEntry?.[0] ?? cols[valueColIdx + 3];
      // Label column is usually 2 to the left of Value.
      labelCol = cols[Math.max(0, valueColIdx - 2)];
      break;
    }
  }
  if (headerIdx < 0) return [];

  const out: ParsedCommercialRow[] = [];
  let order = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const label = str(r[labelCol]);
    const value = num(r[valueCol]);
    const cost = num(r[costCol]);
    const gp = num(r[gpCol]);
    const gpPct = num(r[gpPctCol]);
    // Skip if there's no label AND no numeric content — pure separator row.
    if (!label) continue;
    // Skip rows that are just notes ("Clarifications" etc.) — they have a
    // label but no value/cost.
    if (value == null && cost == null && gp == null) continue;

    out.push({
      category: label,
      value,
      cost,
      gross_profit: gp,
      gross_profit_pct: gpPct,
      is_total: /^total$/i.test(label),
      display_order: order++,
    });
  }
  return out;
}

/** Normalise a header cell for comparison: lowercase, strip spaces and hyphens. */
const normHeader = (v: unknown): string =>
  String(v ?? "").toLowerCase().replace(/[\s-]+/g, "");

/**
 * Column letter map for a single layout of the Materials sheet. We support
 * three layouts so spreadsheet revisions don't require code changes here:
 *
 *   "legacy"  BNC001-era: col B was a free-text "Type" label and there was
 *             no element-name column at all.
 *   "v1"      MCR007 (initial): col B became the numeric Element Code, col Z
 *             held the descriptive Element Name. Manufacturer stayed in C.
 *   "v2"      MCR007 (current): Element Name moved next to Element Code at
 *             col C, pushing Manufacturer to D and shifting every numeric
 *             column right by one letter.
 */
type Layout = "legacy" | "v1" | "v2";

type ColumnMap = {
  item: string;
  type_or_code: string;      // col B in all three layouts
  hasElementCode: boolean;   // true when col B is numeric, not free-text
  element_name?: string;     // C in v2, Z in v1, absent in legacy
  manufacturer: string;
  pack_qty: string;
  pack_unit: string;
  cost: string;
  cost_unit: string;
  coverage_qty: string;
  coverage_unit: string;
  waste_pct: string;
  unit_rate: string;
  rate_unit: string;
  total_qty: string;
  total_qty_unit: string;
  total_units: string;
  total_units_unit: string;
  material_total_cost: string;
  labour_unit_cost: string;
  labour_total_cost: string;
};

const LEGACY: ColumnMap = {
  item: "A", type_or_code: "B", hasElementCode: false,
  manufacturer: "C",
  pack_qty: "D", pack_unit: "E",
  cost: "F", cost_unit: "G",
  coverage_qty: "H", coverage_unit: "I",
  waste_pct: "L",
  unit_rate: "O", rate_unit: "P",
  total_qty: "T", total_qty_unit: "U",
  total_units: "V", total_units_unit: "W",
  material_total_cost: "X",
  labour_unit_cost: "R",         // legacy may not have labour — falls back to null
  labour_total_cost: "Y",
};

const V1: ColumnMap = { ...LEGACY, hasElementCode: true, element_name: "Z" };

const V2: ColumnMap = {
  item: "A", type_or_code: "B", hasElementCode: true,
  element_name: "C",
  manufacturer: "D",
  pack_qty: "E", pack_unit: "F",
  cost: "G", cost_unit: "H",
  coverage_qty: "I", coverage_unit: "J",
  waste_pct: "M",
  unit_rate: "P", rate_unit: "Q",
  total_qty: "U", total_qty_unit: "V",
  total_units: "W", total_units_unit: "X",
  material_total_cost: "Y",
  labour_unit_cost: "S",         // v2 shifted everything one column right
  labour_total_cost: "Z",
};

/** Detect the layout from the header row's cell contents. */
function detectLayout(headerRow: Record<string, unknown>): Layout {
  const b = normHeader(headerRow["B"]);
  const c = normHeader(headerRow["C"]);
  // v2: Element Name landed in col C.
  if (c === "elementname") return "v2";
  // v1: Element Code in B but C is still the Manufacturer column.
  if (b === "elementcode") return "v1";
  // legacy: free-text Type in B.
  return "legacy";
}

function mapFor(layout: Layout): ColumnMap {
  return layout === "v2" ? V2 : layout === "v1" ? V1 : LEGACY;
}

/**
 * Parse the Materials sheet of a PowerGrid pricing workbook. See the {@link Layout}
 * comments above for the supported revisions and how column letters shift.
 */
/**
 * Read just the sheets we actually use. The pricing workbook has a dozen
 * tabs (Pricing, Costing, Prelims, About, Elements, …) — parsing them all
 * burns Worker CPU and on a slow connection bumps into Cloudflare's
 * resource limits. Sheet-restricted reads are ~7× faster.
 */
// The labour-rate sheet has shipped under three names across the MCR series
// ("Costing Labour Only" MCR007, "Labour Costing" MCR009, "Labour Cost"
// MCR010). List all so the sheet-restricted read picks up whichever exists.
const USED_SHEETS = [
  "Materials",
  "Summary Cost Sheet",
  "Pricing",
  "Costing Labour Only",
  "Labour Costing",
  "Labour Cost",
  "Prelims",
  "Ancil Items",
];

export function readPricingWorkbook(buffer: ArrayBuffer): XLSX.WorkBook {
  return XLSX.read(buffer, { type: "array", sheets: USED_SHEETS });
}

export function parseMaterialsSheet(input: ArrayBuffer | XLSX.WorkBook): ParsedMaterial[] {
  const wb = input instanceof ArrayBuffer ? readPricingWorkbook(input) : input;
  const sheetName = wb.SheetNames.find((n) => n.toLowerCase() === "materials");
  if (!sheetName) {
    throw new Error("Workbook does not contain a 'Materials' sheet");
  }
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    header: "A",
    defval: null,
    raw: true,
  });

  // Find the header row by scanning the top of the sheet for "Type" or
  // "Element Code" in col B.
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const b = normHeader(rows[i]["B"]);
    if (b === "type" || b === "elementcode") {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx < 0) headerRowIdx = 4; // fall back to legacy row 5 (0-indexed 4)

  const layout = detectLayout(rows[headerRowIdx]);
  const m = mapFor(layout);

  const out: ParsedMaterial[] = [];
  let blankRun = 0;
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const item = str(r[m.item]);
    const code = r[m.type_or_code];
    const codeStr = code == null ? "" : String(code).trim();
    const elementName = m.element_name ? str(r[m.element_name]) : null;
    const manufacturerRaw = r[m.manufacturer];
    const hasCost = num(r[m.cost]) != null;

    // The real Materials list is one contiguous block. Some workbooks keep a
    // cost/rate staging area further down (e.g. the Ancil fall-arrest & smoke-
    // vent rate breakdowns) separated by a run of blank rows — stop at that gap
    // so those calc rows don't surface as bogus materials / unlinked suggestions.
    const rowEmpty = !item && !codeStr && !elementName && !hasCost && manufacturerRaw == null;
    if (rowEmpty) {
      if (out.length > 0 && ++blankRun >= 6) break;
      continue;
    }
    blankRun = 0;

    // A genuine material row has an item name plus *some* classifying data — an
    // element code, an element name, or a cost. Some workbooks leave the Element
    // Code column blank but still fill the element name + cost (e.g. MCR009);
    // requiring a code there dropped every row. Pure separator rows are skipped.
    if (!item || (!codeStr && !elementName && !hasCost)) continue;
    // A real manufacturer is text; a number in that column flags a staging/calc
    // row (a rate or ratio), not a material line — skip it.
    if (typeof manufacturerRaw === "number") continue;

    let displayType: string;
    let elementCode: string | null;
    if (m.hasElementCode && looksLikeElementCode(code)) {
      elementCode = codeStr;
      displayType = elementName ?? elementCode;
    } else {
      elementCode = null;
      displayType = codeStr || elementName || "—";
    }

    out.push({
      item,
      type: displayType,
      element_code: elementCode,
      manufacturer: str(r[m.manufacturer]),
      pack_qty: num(r[m.pack_qty]),
      pack_unit: str(r[m.pack_unit]),
      cost: num(r[m.cost]),
      cost_unit: str(r[m.cost_unit]),
      coverage_qty: num(r[m.coverage_qty]),
      coverage_unit: str(r[m.coverage_unit]),
      waste_pct: num(r[m.waste_pct]),
      unit_rate: num(r[m.unit_rate]),
      rate_unit: str(r[m.rate_unit]),
      total_qty: num(r[m.total_qty]),
      total_qty_unit: str(r[m.total_qty_unit]),
      total_units: num(r[m.total_units]),
      total_units_unit: str(r[m.total_units_unit]),
      material_total_cost: num(r[m.material_total_cost]),
      labour_unit_cost: num(r[m.labour_unit_cost]),
      labour_total_cost: num(r[m.labour_total_cost]),
    });
  }
  return out;
}

// ── Labour rate schedule (subcontractor cost workbook) ─────────────────────
// Shared so the BROWSER parses the workbook — the Worker's 10ms CPU budget
// can't decode a multi-MB cost workbook (that's Cloudflare error 1102). The
// Worker only receives the parsed rows.

export type LabourRateLine = { description: string; qty: number; unit: string | null; rate: number; total: number };

/** Parse a cell to a number, rejecting header text like "Qty". */
function numCellLR(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.replace(/[£,\s]/g, "");
    if (t === "" || !/^-?\d*\.?\d+$/.test(t)) return null;
    return Number(t);
  }
  return null;
}

/** Read top-level priced labour items from a PowerGrid labour cost workbook.
 *  Column positions are sniffed from the header row so both layouts work: the
 *  full cost workbook (Qty=D, Rate=K, Total=M) and the simplified supplier-facing
 *  labour schedule (Qty=D, Rate=F, Total=H). Falls back to the full-format
 *  defaults if a sheet has no recognisable "Item …" header. */
export function parseLabourRates(buf: ArrayBuffer): LabourRateLine[] {
  // Two-phase read: list sheet names first (cheap), then decode ONLY the sheets
  // we scan — the schedule is sometimes the full multi-MB pricing workbook.
  const allNames = XLSX.read(buf, { type: "array", bookSheets: true }).SheetNames ?? [];
  const out: LabourRateLine[] = [];
  const targeted = allNames.filter((n) => /costing labour|labour cost|labour only|ancil/i.test(n));
  const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const scan = (book: XLSX.WorkBook, names: string[]) => {
    for (const name of names) {
      const ws = book.Sheets[name];
      if (!ws) continue;
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][];
      // Defaults = full cost-workbook layout (Qty=D, Rate=K, Total=M, Unit=E).
      let qtyCol = 3, rateCol = 10, totalCol = 12, unitCol = 4, dataStart = 0;
      for (let i = 0; i < Math.min(rows.length, 14); i++) {
        const hdr = rows[i];
        if (!Array.isArray(hdr) || norm(hdr[0]) !== "item") continue;
        const labels = hdr.map(norm);
        const find = (pred: (h: string) => boolean, fromRight = false) => {
          const idxs = labels.map((h, j) => [h, j] as const).filter(([h]) => h && pred(h)).map(([, j]) => j);
          return idxs.length ? (fromRight ? idxs[idxs.length - 1] : idxs[0]) : -1;
        };
        const q = find((h) => h.includes("qty"));
        const r = [find((h) => h === "rate"), find((h) => h === "labourrate"), find((h) => h.includes("rate") && !h.includes("material"))].find((x) => x >= 0) ?? -1;
        const t = find((h) => h.includes("total"), true);
        const u = find((h) => h === "unit");
        if (q >= 0) { qtyCol = q; unitCol = q + 1; }
        if (r >= 0) rateCol = r;
        if (t >= 0) totalCol = t;
        if (u >= 0) unitCol = u;
        dataStart = i + 1;
        break;
      }
      for (let i = dataStart; i < rows.length; i++) {
        const r = rows[i];
        if (!Array.isArray(r)) continue;
        const item = typeof r[0] === "string" ? r[0].trim() : "";
        if (!item || /^total$/i.test(item)) continue;
        const qty = numCellLR(r[qtyCol]);
        const rate = numCellLR(r[rateCol]);
        const total = numCellLR(r[totalCol]);
        if (qty == null && total == null) continue;
        if (rate == null && total == null) continue;
        out.push({
          description: item.replace(/\s+/g, " "),
          qty: qty ?? 0,
          unit: typeof r[unitCol] === "string" ? (r[unitCol] as string) : null,
          rate: rate ?? (qty ? (total ?? 0) / qty : 0),
          total: total ?? 0,
        });
      }
    }
  };
  const wb = XLSX.read(buf, { type: "array", sheets: targeted.length ? targeted : undefined });
  scan(wb, targeted.length ? targeted : allNames);
  // Belt & braces: if no *labour* sheet matched (only Ancil), or targeted yielded
  // nothing, decode the remaining sheets so a rename can't silently drop rates.
  const matchedLabourSheet = targeted.some((n) => !/ancil/i.test(n));
  if ((out.length === 0 || !matchedLabourSheet) && targeted.length > 0 && targeted.length < allNames.length) {
    const rest = allNames.filter((n) => !targeted.includes(n));
    scan(XLSX.read(buf, { type: "array", sheets: rest }), rest);
  }
  return out;
}

// Canonical row shape + validation live in shared/operatives-import.ts (used by
// both browser preview and Worker import); re-exported here so existing imports
// from this module keep resolving.
export type { OperativeImportRow } from "./operatives-import";
import type { OperativeImportRow } from "./operatives-import";

/**
 * Parse a flat operatives spreadsheet (one person per row) into import rows.
 * Sniffs the header so column order/wording can vary: separate first_name +
 * last_name columns are preferred, but a single combined Name column is split
 * on the first space. Mobile / Email / Company / Trade / Emergency contact are
 * matched on keyword. Values are trimmed; `row` is the 1-based sheet row (for
 * error reporting). Validation + de-dupe are the caller's job.
 */
export function parseOperatives(buf: ArrayBuffer): OperativeImportRow[] {
  const wb = XLSX.read(buf, { type: "array" });
  const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z]/g, "");
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null }) as unknown[][];
    let headerIdx = -1;
    let cols: Record<string, number> = {};
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const hdr = rows[i];
      if (!Array.isArray(hdr)) continue;
      const labels = hdr.map(norm);
      const findCol = (preds: Array<(h: string) => boolean>) => {
        for (const pred of preds) {
          const j = labels.findIndex((h) => h && pred(h));
          if (j >= 0) return j;
        }
        return -1;
      };
      const firstCol = findCol([(h) => h === "firstname" || h === "forename" || h === "givenname" || h === "first"]);
      const lastCol = findCol([(h) => h === "lastname" || h === "surname" || h === "familyname" || h === "last"]);
      const nameCol = findCol([
        (h) => h === "name" || h === "fullname" || h === "operative" || h === "operativename",
      ]);
      if (firstCol < 0 && lastCol < 0 && nameCol < 0) continue; // need at least one name column
      cols = {
        first: firstCol,
        last: lastCol,
        name: nameCol,
        mobile: findCol([(h) => h.includes("mobile") || h.includes("phone") || h.includes("tel")]),
        email: findCol([(h) => h.includes("email") || h.includes("mail")]),
        company: findCol([(h) => h.includes("company") || h.includes("employer") || h.includes("subcontractor") || h.includes("subbie")]),
        trade: findCol([(h) => h.includes("trade") || h.includes("role") || h.includes("occupation") || h.includes("skill")]),
        emergency: findCol([(h) => h.includes("emergency") || h.includes("nextofkin") || h.includes("kin") || h === "ice"]),
      };
      headerIdx = i;
      break;
    }
    if (headerIdx < 0) continue;
    const cell = (r: unknown[], c: number) => (c >= 0 ? String(r[c] ?? "").trim() : "");
    const out: OperativeImportRow[] = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!Array.isArray(r)) continue;
      let first = cell(r, cols.first);
      let last = cell(r, cols.last);
      // Fall back to splitting a single combined Name column on the first space.
      if (!first && !last && cols.name >= 0) {
        const full = cell(r, cols.name);
        const sp = full.indexOf(" ");
        if (sp > 0) { first = full.slice(0, sp).trim(); last = full.slice(sp + 1).trim(); }
        else { first = full; last = ""; }
      }
      const rec: OperativeImportRow = {
        first_name: first, last_name: last,
        mobile: cell(r, cols.mobile), email: cell(r, cols.email),
        company: cell(r, cols.company), trade: cell(r, cols.trade),
        emergency_contact: cell(r, cols.emergency), row: i + 1,
      };
      if (!rec.first_name && !rec.last_name && !rec.mobile && !rec.email && !rec.company && !rec.trade && !rec.emergency_contact) continue;
      out.push(rec);
    }
    if (out.length) return out;
  }
  return [];
}
