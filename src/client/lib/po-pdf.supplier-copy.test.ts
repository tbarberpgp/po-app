import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Everything that renders a purchase order for someone OUTSIDE the app.
 *  `notes` belongs in all of them; `internal_notes` belongs in none. */
const SUPPLIER_FACING = [
  // The PO PDF — the copy that goes to the supplier.
  "src/client/lib/po-pdf.ts",
  // The per-PO spreadsheet, which carries Notes as a header row.
  "src/client/lib/po-xlsx.ts",
  // The multi-PO bundle export.
  "src/client/lib/po-bundle-xlsx.ts",
  // Outbound email — the approver mail replays a note as "Note from <x>".
  "src/worker/notify.ts",
];

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** This guard exists because the field name is the whole trap: `notes` reads
 *  like a scratchpad, and the app sends the supplier nothing automatically, so
 *  a search for a send path comes back empty and the field looks internal. The
 *  supplier copy is a manual download. On 2026-09-24 commercial commentary —
 *  naming the supplier, saying their orders were never issued, quoting our
 *  variances — was written into `notes` on five live POs on exactly that
 *  reasoning. `internal_notes` (migration 0125) is the safe half, and it is
 *  only safe for as long as nothing on this list reads it. */
test("internal notes never reach the supplier's copy", async (t) => {
  for (const rel of SUPPLIER_FACING) {
    await t.test(`${rel} does not read internal_notes`, () => {
      const src = readFileSync(root + rel, "utf8");
      assert.ok(
        !/\binternal_notes\b/.test(src),
        `${rel} references internal_notes. That field is ours — it must not be rendered into anything that leaves the app. `
        + `If this document genuinely should carry it, that is a decision to take deliberately, not by adding a field to a template.`,
      );
    });
  }

  await t.test("the list is still pointed at files that exist", () => {
    for (const rel of SUPPLIER_FACING) {
      assert.doesNotThrow(
        () => readFileSync(root + rel, "utf8"),
        `${rel} is gone or moved — this guard is silently passing. Re-point it at wherever that rendering lives now.`,
      );
    }
  });

  await t.test("and they do still render the supplier-facing note", () => {
    // If `notes` vanished from all of them the guard above would pass for the
    // wrong reason: nothing renders anything any more.
    const rendersNotes = SUPPLIER_FACING.filter((rel) => /\bnotes\b/.test(readFileSync(root + rel, "utf8")));
    assert.ok(rendersNotes.length > 0, "no supplier-facing renderer reads `notes` — has the field been renamed?");
  });
});
