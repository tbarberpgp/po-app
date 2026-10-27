import { zip } from "fflate";
import { saveBlob, type BatchProgress, type BatchResult } from "./qitp-records";

/** Batch-download site reports as a ZIP of separate PDFs — one file per report.
 *
 *  Built in the browser, like the QITP batch (see qitp-records.ts), but three
 *  reports at a time rather than one: each PDF is a Browser Rendering pass of
 *  tens of seconds, and strictly one-by-one made a 19-report project take most
 *  of an hour. Three stays under the binding's concurrent-session cap (the
 *  server also retries a busy launch). One failed or stuck report is skipped
 *  and named, not fatal to the batch.
 */

const PARALLEL = 3;
const PER_REPORT_TIMEOUT_MS = 180_000;

export type ReportRef = {
  id: number;
  project_id: string | null;
  project_code: string | null;
  period_type: "daily" | "weekly";
  period_start: string;
};

// "26004 Weekly report 2026-11-01.pdf" — ISO date so the zip lists in date order.
const fileName = (r: ReportRef) =>
  `${r.project_id ? (r.project_code ?? "Project") : "Portfolio"} ${r.period_type === "daily" ? "Daily" : "Weekly"} report ${r.period_start}`
    .replace(/[\\/:*?"<>|]+/g, "-");

export async function downloadReportsZip(
  reports: ReportRef[],
  zipName: string,
  onProgress: (p: BatchProgress) => void,
  isCancelled: () => boolean,
): Promise<BatchResult> {
  const files: Record<string, Uint8Array> = {};
  const failed: string[] = [];
  let done = 0;
  let cancelled = false;
  let next = 0;

  async function worker() {
    while (next < reports.length) {
      if (isCancelled()) { cancelled = true; return; }
      const r = reports[next++];
      const label = fileName(r);
      try {
        const res = await fetch(`/api/site-reports/${r.id}/pdf`, { signal: AbortSignal.timeout(PER_REPORT_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        // Two reports can share a name (a regenerated period) — keep both.
        files[files[`${label}.pdf`] ? `${label} (${r.id}).pdf` : `${label}.pdf`] = bytes;
      } catch {
        failed.push(label);
      }
      done += 1;
      onProgress({ done, total: reports.length, current: label });
    }
  }
  onProgress({ done, total: reports.length, current: "" });
  await Promise.all(Array.from({ length: Math.min(PARALLEL, reports.length) }, worker));

  const names = Object.keys(files);
  if (names.length) {
    // level 0 = store; PDFs are already compressed.
    const data = await new Promise<Uint8Array>((resolve, reject) => {
      zip(files, { level: 0 }, (err, out) => (err ? reject(err) : resolve(out)));
    });
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    saveBlob(new Blob([buf], { type: "application/zip" }), zipName);
  }

  return { ok: names.length, failed, cancelled };
}

/** One-line outcome for the flash notice after a batch. */
export function zipNotice(r: BatchResult): string {
  const parts = [`Downloaded ${r.ok} report${r.ok === 1 ? "" : "s"} as a .zip`];
  if (r.cancelled) parts.push("stopped early");
  if (r.failed.length) parts.push(`${r.failed.length} couldn't render: ${r.failed.join(", ")}`);
  return r.ok === 0 && !r.cancelled ? `No reports downloaded — ${r.failed.length} couldn't render.` : parts.join(" · ") + ".";
}
