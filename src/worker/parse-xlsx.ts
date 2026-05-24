import * as XLSX from "xlsx";

export type ParsedMaterial = {
  item: string;
  type: string;
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

/**
 * Parse the Materials sheet of a PowerGrid pricing workbook.
 *
 * Column map (header row = 5, data starts row 6) — see Materials tab:
 *   A  item (full descriptor)        B  type        C  manufacturer
 *   D  pack_qty   E  pack_unit       F  cost        G  cost_unit
 *   H  coverage_qty                  I  coverage_unit
 *   L  waste_pct                     M  coverage_inc_waste
 *   O  unit_rate (cost / coverage)   P  rate_unit
 *   T  total_qty (in measurement units, e.g. m²)   U  total_qty_unit
 *   V  total_units (in pack units — what we order)  W  total_units_unit
 *   X  material_total_cost (priced material budget for line)
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

  const out: ParsedMaterial[] = [];
  // Data starts row 6 (1-indexed); sheet_to_json gives 0-indexed array.
  for (let i = 5; i < rows.length; i++) {
    const r = rows[i];
    const item = str(r["A"]);
    const type = str(r["B"]);
    if (!item || !type) continue; // skip blank/separator rows

    out.push({
      item,
      type,
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
