// Runs the real over-billing scan (shared/line-match) against a snapshot of
// production invoices + PO lines, so its output can be checked before deploying.
//
//   npx wrangler d1 execute po_app_db --remote --json --command \
//     "SELECT i.id, i.invoice_number, i.supplier_name, i.approved_at, p.code AS proj, \
//             i.gross_amount, i.currency, i.matched_po_id, po.po_number, i.lines_json \
//        FROM invoices i LEFT JOIN projects p ON p.id=i.project_id \
//        LEFT JOIN purchase_orders po ON po.id=i.matched_po_id \
//       WHERE i.matched_po_id IS NOT NULL AND i.lines_json IS NOT NULL" > /tmp/inv.json
//   npx wrangler d1 execute po_app_db --remote --json --command \
//     "SELECT id, po_id, item, qty, unit, unit_cost FROM po_lines" > /tmp/polines.json
//   npx tsx scripts/overbill-harness.ts /tmp/inv.json /tmp/polines.json
import { readFileSync } from "node:fs";
import { scanOverbill, type InvLine, type PoLineRow } from "../src/shared/line-match";

/** wrangler --json prints an array of statement results; tolerate leading noise. */
function load<T>(path: string): T[] {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw.slice(raw.indexOf("[")))[0].results as T[];
}

type InvRow = {
  id: number; invoice_number: string | null; supplier_name: string | null; approved_at: string | null;
  proj: string | null; gross_amount: number | null; currency: string | null;
  matched_po_id: string; po_number: string | null; lines_json: string | null;
};

const [invPath, polPath] = process.argv.slice(2);
if (!invPath || !polPath) { console.error("usage: overbill-harness.ts <invoices.json> <polines.json>"); process.exit(1); }

const invoices = load<InvRow>(invPath);
const poLines = load<PoLineRow & { po_id: string }>(polPath);

const byPo = new Map<string, PoLineRow[]>();
for (const l of poLines) {
  const arr = byPo.get(l.po_id) ?? [];
  arr.push(l);
  byPo.set(l.po_id, arr);
}

const gbp = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (n: number | null) => (n == null ? "—" : n.toLocaleString("en-GB", { maximumFractionDigits: 2 }));

const hits: Array<{ inv: InvRow; lines: ReturnType<typeof scanOverbill>; excess: number }> = [];
for (const inv of invoices) {
  const pol = byPo.get(inv.matched_po_id);
  if (!pol?.length || !inv.lines_json) continue;
  let lines: InvLine[] = [];
  try { lines = JSON.parse(inv.lines_json) as InvLine[]; } catch { continue }
  const over = scanOverbill(lines, pol);
  if (over.length) hits.push({ inv, lines: over, excess: over.reduce((s, l) => s + l.excess, 0) });
}

hits.sort((a, b) => b.excess - a.excess);
console.log(`scanned ${invoices.length} invoices with a matched PO — ${hits.length} flag over-billed\n`);
let qtyOnly = 0;
for (const { inv, lines, excess } of hits) {
  const kinds = [...new Set(lines.map((l) => l.reason))].join("+");
  if (kinds === "qty") qtyOnly++;
  console.log(
    `${String(inv.id).padStart(4)} ${(inv.invoice_number ?? "").padEnd(13)} ${(inv.supplier_name ?? "").slice(0, 24).padEnd(24)}` +
    ` ${(inv.proj ?? "").padEnd(6)} inv ${gbp(inv.gross_amount ?? 0).padStart(11)}  over ${gbp(excess).padStart(10)}` +
    `  ${(inv.po_number ?? "").padEnd(18)} [${kinds}] ${inv.approved_at ? "approved" : "NOT approved"}`,
  );
  for (const l of lines) {
    console.log(`       ${l.item.slice(0, 40).padEnd(40)} ${gbp(l.billed_total).padStart(11)} vs ${gbp(l.po_total).padStart(11)}` +
      `  +${gbp(l.excess).padStart(10)}  ${l.reason}: ${qty(l.billed_qty)} @ ${l.billed_rate ?? "—"} vs ${qty(l.po_qty)} @ ${l.po_rate ?? "—"}`);
  }
}
console.log(`\ntotal excess ${gbp(hits.reduce((s, h) => s + h.excess, 0))} · ${qtyOnly} invoices flagged on quantity alone`);
