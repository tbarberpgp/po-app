// Client-side .xlsx export of a grouped site's Combined materials table —
// one row per merged material with the roll-up figures, delivery progress and
// procurement status shown on screen. Respects the active status/search filter
// (the caller passes the already-filtered rows).

import * as XLSX from "xlsx";

export type GroupMaterialExportRow = {
  item: string;
  type: string;
  supplier: string;
  unit: string | null;
  boqQty: number;
  committedQty: number;
  deliveredQty: number;
  budget: number;
  committed: number;
  variance: number;
  status: string;
  blocks: string;
};

export function generateGroupMaterialsXlsx(siteCode: string, siteName: string, rows: GroupMaterialExportRow[]): Uint8Array {
  const aoa: (string | number | null)[][] = [];
  aoa.push([`Combined materials — ${siteCode}`]);
  aoa.push([siteName]);
  aoa.push([`Exported ${new Date().toLocaleString("en-GB")}`]);
  aoa.push([]);
  aoa.push(["Material", "Type", "Supplier", "Unit", "BOQ qty", "Committed qty", "Delivered qty", "Budget £", "Committed £", "Variance £", "Status", "Blocks"]);
  for (const r of rows) {
    aoa.push([
      r.item, r.type, r.supplier, r.unit ?? "",
      r.boqQty || null, r.committedQty || null, r.deliveredQty || null,
      r.budget || null, r.committed || null, r.variance || null,
      r.status, r.blocks,
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 40 }, { wch: 22 }, { wch: 26 }, { wch: 7 },
    { wch: 11 }, { wch: 13 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    { wch: 14 }, { wch: 14 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Combined materials");
  return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
}
