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
  total_units: number | null;       // col V — qty to purchase in pack units (Rolls, Boxes, ea)
  total_units_unit: string | null;  // col W — the pack unit suppliers sell in
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

/**
 * Parse the Materials sheet of a PowerGrid pricing workbook.
 *
 * Two layouts are supported and auto-detected by scanning for the header row:
 *
 * Legacy (BNC001-era): headers on row 5, data row 6+, col B = free-text "Type",
 * no element-name column.
 *
 * New (MCR007+): headers on row 4, data row 5+, col B = numeric Element Code
 * that matches the `elements` master table; col Z = Element Name.
 *
 * Data columns (identical between layouts apart from B/Z):
 *   A  item (full descriptor)        B  type / element code
 *   C  manufacturer                  D  pack_qty       E  pack_unit
 *   F  cost                          G  cost_unit
 *   H  coverage_qty                  I  coverage_unit
 *   L  waste_pct                     M  coverage_inc_waste
 *   O  unit_rate (cost / coverage)   P  rate_unit
 *   T  total_qty                     U  total_qty_unit
 *   V  total_units (pack units)      W  total_units_unit
 *   X  material_total_cost           Z  element_name (new layout only)
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

  // Find the header row. It's the first row in the top ~15 rows whose col B
  // contains "Type" or "Element Code" (case-insensitive, hyphens stripped).
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const b = String(rows[i]["B"] ?? "")
      .toLowerCase()
      .replace(/[\s-]+/g, "");
    if (b === "type" || b === "elementcode") {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx < 0) {
    // Fall back to the legacy assumption (row 5 → index 4).
    headerRowIdx = 4;
  }

  const out: ParsedMaterial[] = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const item = str(r["A"]);
    const b = r["B"];
    if (!item || b === null || b === undefined || String(b).trim() === "") continue;

    // New layout: col B is a numeric code, col Z is the descriptive element
    // name. Display column ("type") comes from Z; element_code captures B.
    // Legacy layout: col B is the descriptive label; no element code is known.
    let displayType: string;
    let elementCode: string | null;
    if (looksLikeElementCode(b)) {
      elementCode = String(b).trim();
      displayType = str(r["Z"]) ?? elementCode;
    } else {
      elementCode = null;
      displayType = String(b).trim();
    }

    out.push({
      item,
      type: displayType,
      element_code: elementCode,
      manufacturer: str(r["C"]),
      pack_qty: num(r["D"]),
      pack_unit: str(r["E"]),
      cost: num(r["F"]),
      cost_unit: str(r["G"]),
      coverage_qty: num(r["H"]),
      coverage_unit: str(r["I"]),
      waste_pct: num(r["L"]),
      unit_rate: num(r["O"]),
      rate_unit: str(r["P"]),
      total_qty: num(r["T"]),
      total_qty_unit: str(r["U"]),
      total_units: num(r["V"]),
      total_units_unit: str(r["W"]),
      material_total_cost: num(r["X"]),
    });
  }
  return out;
}
