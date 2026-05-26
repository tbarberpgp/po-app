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
    });
  }
  return out;
}
