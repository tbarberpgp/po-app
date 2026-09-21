// The two download buttons that sit in a PO register's card header — Excel to
// work in, PDF to send. Shared by the project's Purchase orders tab and the
// workspace list so the pair can't drift apart; what each export contains is
// decided by the `opts` its caller hands over.

import { useState } from "react";
import { generatePoListXlsx } from "../lib/po-list-xlsx";
import { downloadPdf, generatePoListPdf } from "../lib/po-list-pdf";
import type { PoListExport, PoRegisterRow } from "../lib/po-register";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function PoRegisterExport({ rows, opts, filename }: {
  /** Exactly the rows on screen — filters, search and sort included. */
  rows: PoRegisterRow[];
  opts: PoListExport;
  /** Download-name stem, e.g. "purchase-orders-26004". */
  filename: string;
}) {
  const [busy, setBusy] = useState<"xlsx" | "pdf" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run(kind: "xlsx" | "pdf") {
    setBusy(kind); setErr(null);
    try {
      if (kind === "pdf") {
        downloadPdf(await generatePoListPdf(rows, opts), `${filename}.pdf`);
      } else {
        const bytes = generatePoListXlsx(rows, opts);
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
    } finally { setBusy(null); }
  }

  return (
    <>
      {err && <span style={{ fontSize: 11, color: "var(--danger)" }}>{err}</span>}
      <button className="btn ghost tiny" disabled={busy != null || rows.length === 0} onClick={() => void run("xlsx")}
        title="Download the orders listed below as a spreadsheet — with order type, approval, delivery and payment columns to filter on">
        {busy === "xlsx" ? "Preparing…" : "⤓ Excel"}
      </button>
      <button className="btn ghost tiny" disabled={busy != null || rows.length === 0} onClick={() => void run("pdf")}
        title="Download this register as a PDF — the same table, ready to send on">
        {busy === "pdf" ? "Preparing…" : "⤓ PDF"}
      </button>
    </>
  );
}
