// Client-side .xlsx export of a site's training matrix — operatives down the
// side, competencies across the top, each cell the card status (Valid /
// Expiring / Expired / Pending / — none). Mirrors what the on-screen matrix
// shows so it can be printed or sent to the client / principal contractor.

import * as XLSX from "xlsx";

const STATUS_LABEL: Record<string, string> = {
  valid: "Valid",
  expiring: "Expiring",
  expired: "Expired",
  pending: "Pending",
  none: "—",
};

export function generateTrainingMatrixXlsx(
  projectCode: string,
  siteName: string,
  cols: string[],
  operatives: Array<{
    name: string;
    company: string | null;
    trade: string | null;
    inducted: boolean;
    cells: Record<string, string>;
  }>,
): Uint8Array {
  const rows: (string | number | null)[][] = [];
  rows.push([`Training matrix — ${projectCode}`]);
  rows.push([siteName]);
  rows.push([`Exported ${new Date().toLocaleString("en-GB")}`]);
  rows.push([]);
  rows.push(["Operative", "Company", "Trade", "Inducted", ...cols]);

  for (const o of operatives) {
    rows.push([
      o.name,
      o.company ?? "",
      o.trade ?? "",
      o.inducted ? "Yes" : "No",
      ...cols.map((c) => STATUS_LABEL[o.cells[c] ?? "none"] ?? "—"),
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 24 }, { wch: 20 }, { wch: 16 }, { wch: 9 }, ...cols.map(() => ({ wch: 14 }))];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Training matrix");
  return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
}
