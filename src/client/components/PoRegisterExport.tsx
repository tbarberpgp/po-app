// The two download buttons that sit in a PO register's card header — Excel to
// work in, PDF to send. Shared by the project's Purchase orders tab and the
// workspace list so the pair can't drift apart; what each export contains is
// decided by the `opts` its caller hands over.

import { useState } from "react";
import { api } from "../lib/api";
import { generatePoListXlsx } from "../lib/po-list-xlsx";
import { generatePoBundleXlsx } from "../lib/po-bundle-xlsx";
import { downloadPdf, generatePoListPdf } from "../lib/po-list-pdf";
import type { PoXlsxInput } from "../lib/po-xlsx";
import type { PoListExport, PoRegisterRow } from "../lib/po-register";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** How many order-detail reads to have in flight at once. The list endpoint
 *  doesn't carry line items, so a full export is one round trip per order;
 *  a handful at a time keeps a big job quick without flooding the worker. */
const DETAIL_CONCURRENCY = 6;

export function PoRegisterExport({ rows, opts, filename, detailed }: {
  /** Exactly the rows on screen — filters, search and sort included. */
  rows: PoRegisterRow[];
  opts: PoListExport;
  /** Download-name stem, e.g. "purchase-orders-26004". */
  filename: string;
  /** Make the Excel download the full workbook — every order's lines and
   *  receipts, not just the register. Costs a read per order, so it's offered
   *  on a project's register and not on the whole-workspace one. */
  detailed?: boolean;
}) {
  const [busy, setBusy] = useState<"xlsx" | "pdf" | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /** Every order's full record, read a few at a time, back in screen order. */
  async function loadDetails(): Promise<PoXlsxInput[]> {
    const queue = rows.map((r) => r.id);
    const byId = new Map<string, PoXlsxInput>();
    let done = 0;
    await Promise.all(
      Array.from({ length: Math.min(DETAIL_CONCURRENCY, queue.length) }, async () => {
        for (;;) {
          const id = queue.shift();
          if (!id) return;
          const full = await api.getPO(id);
          byId.set(id, { ...full, parent_po_number: full.parent?.po_number ?? null });
          setProgress(`${++done} / ${rows.length}`);
        }
      }),
    );
    // The pool finishes out of order; the workbook should read in the order the
    // screen listed them.
    return rows.map((r) => byId.get(r.id)).filter((d): d is PoXlsxInput => d != null);
  }

  async function run(kind: "xlsx" | "pdf") {
    setBusy(kind); setErr(null); setProgress(null);
    try {
      if (kind === "pdf") {
        downloadPdf(await generatePoListPdf(rows, opts), `${filename}.pdf`);
      } else {
        const bytes = detailed
          ? generatePoBundleXlsx(await loadDetails(), opts)
          : generatePoListXlsx(rows, opts);
        // Copy into a plain ArrayBuffer — a Uint8Array over WASM memory isn't
        // a valid Blob part in every browser.
        const ab = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(ab).set(bytes);
        const url = URL.createObjectURL(new Blob([ab], { type: XLSX_MIME }));
        const a = document.createElement("a");
        a.href = url; a.download = `${filename}.xlsx`; a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "export failed");
    } finally { setBusy(null); setProgress(null); }
  }

  const excelTitle = detailed
    ? "Download every order on this project as a spreadsheet — the register, every line of every order (with cost code and budget line), and every delivery logged"
    : "Download the orders listed below as a spreadsheet — with order type, approval, delivery and payment columns to filter on";

  return (
    <>
      {err && <span style={{ fontSize: 11, color: "var(--danger)" }}>{err}</span>}
      <button className="btn ghost tiny" disabled={busy != null || rows.length === 0} onClick={() => void run("xlsx")}
        title={excelTitle}>
        {busy === "xlsx" ? (progress ? `${progress}…` : "Preparing…") : "⤓ Excel"}
      </button>
      <button className="btn ghost tiny" disabled={busy != null || rows.length === 0} onClick={() => void run("pdf")}
        title="Download this register as a PDF — the same table, ready to send on">
        {busy === "pdf" ? "Preparing…" : "⤓ PDF"}
      </button>
    </>
  );
}
