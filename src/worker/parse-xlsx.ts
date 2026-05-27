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

export type ParsedValuationEntry = {
  app_number: number | null;
  entry_type: "cutoff" | "submission" | "certification" | "payment";
  date: string;       // ISO yyyy-mm-dd
  notes: string | null;
};

const ENTRY_KEYWORDS: Record<ParsedValuationEntry["entry_type"], RegExp> = {
  cutoff: /(cut\s*[-]?\s*off|valuation\s*date)/i,
  submission: /(submission|application\s*date|submitted)/i,
  certification: /(certif|certify|cert\.?\s*date)/i,
  payment: /(payment|paid|due\s*date)/i,
};

/** Best-effort coerce an xlsx cell into an ISO yyyy-mm-dd string. */
function toIsoDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof v === "number") {
    // Excel serial date number (days since 1899-12-30)
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    if (Number.isNaN(d.getTime())) return null;
    return toIsoDate(d);
  }
  const s = String(v).trim();
  if (!s) return null;
  // Try DD/MM/YYYY, DD-MM-YYYY, or anything Date.parse handles.
  const dmy = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dmy) {
    const [, dd, mm, yy] = dmy;
    const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
    const month = Number(mm);
    const day = Number(dd);
    if (year > 1900 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return toIsoDate(new Date(t));
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
  // Try every row in the first 20 as a candidate header row. A valid header
  // contains an "App #" column (or similar) and at least one date column.
  for (let h = 0; h < Math.min(20, rows.length); h++) {
    const headerRow = rows[h];
    const colMap = readHeaderRow(headerRow);
    if (!colMap.appCol || colMap.dateCols.length === 0) continue;
    // Header looks good — extract rows beneath it.
    const out: ParsedValuationEntry[] = [];
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i];
      const appRaw = r[colMap.appCol];
      const appNum = appRaw == null ? null : Number(String(appRaw).replace(/[^0-9]/g, ""));
      const notes = colMap.notesCol ? str(r[colMap.notesCol]) : null;
      let foundAny = false;
      for (const dc of colMap.dateCols) {
        const iso = toIsoDate(r[dc.col]);
        if (!iso) continue;
        foundAny = true;
        out.push({
          app_number: Number.isFinite(appNum) && appNum! > 0 ? appNum : null,
          entry_type: dc.type,
          date: iso,
          notes,
        });
      }
      // Stop scanning once we hit a fully-empty row (likely the totals/footer)
      if (!foundAny && Object.values(r).every((v) => v == null || v === "")) break;
    }
    if (out.length > 0) return out;
  }
  return [];
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
    // App # / Application No / etc.
    if (!appCol && /(app\s*[#no]|application\s*(?:no|number|#))/i.test(label)) appCol = col;
    if (!notesCol && /^(notes?|comment|remark)/i.test(label)) notesCol = col;
    for (const [type, re] of Object.entries(ENTRY_KEYWORDS) as Array<[ParsedValuationEntry["entry_type"], RegExp]>) {
      if (re.test(label)) {
        // Avoid double-counting if a label matches multiple regexes (e.g.
        // "Application date" hits both `submission` and `app` if not careful).
        if (!dateCols.some((d) => d.col === col)) dateCols.push({ col, type });
      }
    }
  }
  return { appCol, notesCol, dateCols };
}

export type ParsedContractItem = {
  item_no: number;
  section: string | null;
  description: string;
  qty: number;
  unit: string | null;
  sell_rate: number;
  sell_total: number;
  labour_rate: number | null;
  labour_total: number | null;
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
export function parseContractItems(buffer: ArrayBuffer): ParsedContractItem[] {
  const wb = XLSX.read(buffer, { type: "array" });
  const sellSheet = wb.Sheets[wb.SheetNames.find((n) => n.toLowerCase() === "pricing") ?? ""];
  if (!sellSheet) return [];
  const labourSheet = wb.Sheets[wb.SheetNames.find((n) => n.toLowerCase() === "costing labour only") ?? ""];

  const scan = (ws: XLSX.WorkSheet): { items: Array<{ section: string | null; description: string; qty: number; unit: string | null; rate: number; total: number }> } => {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
      header: "A", defval: null, raw: true,
    });
    const out: Array<{ section: string | null; description: string; qty: number; unit: string | null; rate: number; total: number }> = [];
    let section: string | null = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const a = str(r["A"]);
      if (!a) continue;
      const d = num(r["D"]);
      const k = num(r["K"]);
      const m = num(r["M"]);
      if (d == null || k == null) {
        // section header (col A populated but no numeric qty / rate)
        section = a;
        continue;
      }
      out.push({
        section,
        description: a,
        qty: d,
        unit: str(r["E"]),
        rate: k,
        total: m ?? d * k,
      });
    }
    return { items: out };
  };

  const sell = scan(sellSheet);
  const labour = labourSheet ? scan(labourSheet) : { items: [] };

  return sell.items.map((s, i) => {
    const l = labour.items[i];
    // Only treat the labour row as a match if the description matches — if the
    // tabs diverge we skip the labour rate rather than silently mis-aligning.
    const labourMatches = l && l.description === s.description;
    return {
      item_no: i + 1,
      section: s.section,
      description: s.description,
      qty: s.qty,
      unit: s.unit,
      sell_rate: s.rate,
      sell_total: s.total,
      labour_rate: labourMatches ? l.rate : null,
      labour_total: labourMatches ? l.total : null,
    };
  });
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
export function parseSummaryCostSheet(buffer: ArrayBuffer): ParsedCommercialRow[] {
  const wb = XLSX.read(buffer, { type: "array" });
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
export function parseMaterialsSheet(buffer: ArrayBuffer): ParsedMaterial[] {
  const wb = XLSX.read(buffer, { type: "array" });
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
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const item = str(r[m.item]);
    const code = r[m.type_or_code];
    if (!item || code === null || code === undefined || String(code).trim() === "") continue;

    let displayType: string;
    let elementCode: string | null;
    if (m.hasElementCode && looksLikeElementCode(code)) {
      elementCode = String(code).trim();
      const nameCol = m.element_name;
      displayType = (nameCol ? str(r[nameCol]) : null) ?? elementCode;
    } else {
      elementCode = null;
      displayType = String(code).trim();
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
