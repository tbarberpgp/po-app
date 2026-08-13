// Throwaway: verify the RAMS parser against a real .docx.
//   npx tsx scripts/rams-harness.ts "/path/to/RAMS.docx"
import { readFileSync } from "node:fs";
import { parseRamsDocx } from "../src/shared/parse-rams";

const path = process.argv[2];
const { doc, media } = parseRamsDocx(new Uint8Array(readFileSync(path)));
console.log("TITLE:", doc.title);
console.log("SECTIONS:", doc.sections.length);
for (const s of doc.sections) {
  const counts: Record<string, number> = {};
  for (const b of s.blocks) counts[b.type] = (counts[b.type] || 0) + 1;
  const rr = s.blocks.find((b) => b.type === "riskRegister") as { rows: unknown[] } | undefined;
  console.log(`  [${s.number ?? "—"}] ${s.title}  ${JSON.stringify(counts)}${rr ? "  RISK_ROWS=" + rr.rows.length : ""}`);
}
console.log("MEDIA:", Object.keys(media));
const rr = doc.sections.flatMap((s) => s.blocks).find((b) => b.type === "riskRegister") as { rows: unknown[] } | undefined;
if (rr) console.log("FIRST RISK ROW:", JSON.stringify(rr.rows[0], null, 1));
