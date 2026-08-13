// Client-side .xlsx generator for an Application for Payment. Produces a
// single-sheet workbook the recipient can open in Excel, mark up, and send
// back. Sections are grouped with bold headers and subtotals; the headline
// totals box sits at the top.

import * as XLSX from "xlsx";
import { afpDocLabel } from "../../shared/types";
import type { AfpDetail } from "../../shared/types";

type Row = (string | number | null)[];

export function generateAfpXlsx(detail: AfpDetail): Uint8Array {
  const { afp, lines } = detail;
  const rows: Row[] = [];

  // ── Header block ──
  rows.push([`${afpDocLabel(afp.direction, afp.status).toUpperCase()} #${afp.app_number}`]);
  rows.push([`${afp.project_code ?? ""} — ${afp.project_name ?? ""}`]);
  rows.push([`Client: ${afp.project_client ?? ""}`]);
  rows.push([`Period ending: ${formatDate(afp.period_end)}`]);
  rows.push([`Status: ${afp.status.toUpperCase()}`]);
  rows.push([`Date raised: ${formatDate(afp.created_at)}`]);
  rows.push([]);

  // ── Headline totals ──
  rows.push(["Headline figures"]);
  rows.push(["Contract sum", "", "", "", "", afp.contract_sum ?? 0]);
  rows.push(["Cumulative value of works", "", "", "", "", afp.cumulative_value ?? 0]);
  rows.push(["Previously certified", "", "", "", "", afp.previous_certified ?? 0]);
  rows.push(["This period (net)", "", "", "", "", afp.this_period_net ?? 0]);
  rows.push([`Retention (${afp.retention_pct}%)`, "", "", "", "", -(afp.retention_amount ?? 0)]);
  rows.push(["Amount due (ex VAT)", "", "", "", "", afp.amount_due ?? 0]);
  rows.push([`VAT (${afp.vat_pct}%)`, "", "", "", "", afp.vat_amount ?? 0]);
  rows.push(["TOTAL INVOICE", "", "", "", "", afp.total_invoice ?? 0]);
  rows.push([]);

  // ── Line items ──
  // The two trailing columns ("% certified" / "Certified £") are left blank for
  // the recipient to fill in and return — that's the certificate. The inbound
  // clientcerts@ parser reads those certified columns (to the right of the
  // applied figures) rather than the applied ones.
  const isOutgoing = afp.direction === "outgoing";
  rows.push(["Works claimed"]);
  rows.push([
    "Section", "Item", "Qty", "Unit", "Rate £", "Contract £", "% complete", "Cumulative £",
    ...(isOutgoing ? ["% certified", "Certified £"] : []),
  ]);

  // Group by section preserving document order
  type Grp = { section: string; lines: AfpDetail["lines"] };
  const groups: Grp[] = [];
  for (const l of lines) {
    const sec = l.section ?? "—";
    const last = groups[groups.length - 1];
    if (!last || last.section !== sec) groups.push({ section: sec, lines: [l] });
    else last.lines.push(l);
  }

  for (const g of groups) {
    let sectionTotal = 0;
    let sectionCum = 0;
    for (const l of g.lines) {
      rows.push([
        g.section,
        l.description + (l.is_adhoc ? " (variation)" : ""),
        l.qty ?? "",
        l.unit ?? "",
        round2(l.rate),
        round2(l.contract_value),
        round2(l.percent_complete),
        round2(l.cumulative_value),
        ...(isOutgoing ? ["", ""] : []),   // % certified / Certified £ — client fills in
      ]);
      sectionTotal += l.contract_value;
      sectionCum += l.cumulative_value;
    }
    rows.push([
      `${g.section} subtotal`, "", "", "", "",
      round2(sectionTotal), "", round2(sectionCum),
    ]);
    rows.push([]);
  }

  rows.push([
    "TOTAL", "", "", "", "",
    round2(afp.contract_sum ?? 0), "", round2(afp.cumulative_value ?? 0),
  ]);

  // ── Build the sheet ──
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 22 }, // section
    { wch: 50 }, // item
    { wch: 10 }, // qty
    { wch: 8 },  // unit
    { wch: 11 }, // rate
    { wch: 14 }, // contract £
    { wch: 11 }, // %
    { wch: 14 }, // cumulative £
    ...(isOutgoing ? [{ wch: 11 }, { wch: 14 }] : []),  // % certified / Certified £
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `AfP #${afp.app_number}`);
  // Write to ArrayBuffer (no Node fs dependency in the browser).
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return new Uint8Array(out);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
