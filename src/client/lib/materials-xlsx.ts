// Client-side .xlsx export of a project's materials list — including the
// framework call-off columns (called-off to date, reserved-awaiting-call-off)
// so the "Called off" view on the Materials tab can be pulled into Excel. Takes
// whatever rows are currently shown (so it respects the active filter) and adds
// a "Total called off £" line at the foot.

import * as XLSX from "xlsx";
import type { MaterialWithCommitment } from "../../shared/types";

const supplierOf = (m: MaterialWithCommitment) => m.sub_supplier ?? m.sub_manufacturer ?? m.manufacturer ?? "";
const unitSpend = (m: MaterialWithCommitment) => m.live_unit_price ?? m.sub_cost ?? m.cost ?? 0;

export function generateMaterialsXlsx(mats: MaterialWithCommitment[], projectCode: string, scopeLabel: string): Uint8Array {
  const rows: (string | number | null)[][] = [];
  rows.push([`Materials — ${projectCode}`]);
  rows.push([scopeLabel]);
  rows.push([`Exported ${new Date().toLocaleString("en-GB")}`]);
  rows.push([]);
  rows.push([
    "Type", "Item", "Supplier", "Unit",
    "BOQ unit £", "Live unit £",
    "Priced qty", "Committed qty", "Called-off qty", "Reserved (framework) qty", "Remaining qty",
    "Budget £", "Committed £", "Called-off £",
  ]);

  let coTotal = 0;
  for (const m of mats) {
    const priced = m.total_units ?? 0;
    const committed = m.committed_qty ?? 0;
    const calledOff = m.called_off_qty ?? 0;
    const reserved = Math.max(0, (m.framework_reserved_qty ?? 0) - calledOff);
    const spend = unitSpend(m);
    const coVal = calledOff * spend;
    coTotal += coVal;
    rows.push([
      m.type ?? "", m.sub_item || m.item || "", supplierOf(m), m.total_units_unit ?? m.pack_unit ?? "",
      m.sub_cost ?? m.cost ?? null, m.live_unit_price ?? null,
      priced || null, committed || null, calledOff || null, reserved || null, m.remaining_qty ?? null,
      priced * (m.cost ?? 0) || null, committed * spend || null, coVal || null,
    ]);
  }
  rows.push([]);
  rows.push(["", "", "", "", "", "", "", "", "", "", "", "", "Total called off £", coTotal]);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 10 }, { wch: 36 }, { wch: 22 }, { wch: 8 },
    { wch: 11 }, { wch: 11 },
    { wch: 10 }, { wch: 12 }, { wch: 13 }, { wch: 20 }, { wch: 12 },
    { wch: 12 }, { wch: 12 }, { wch: 13 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Materials");
  return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
}
