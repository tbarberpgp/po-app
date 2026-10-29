import { zip } from "fflate";
import { saveBlob, type BatchProgress, type BatchResult } from "./qitp-records";

/** Batch-download site reports as a ZIP of separate PDFs — one file per report.
 *
 *  Built in the browser, like the QITP batch (see qitp-records.ts), but three
 *  reports at a time rather than one: each PDF is a Browser Rendering pass of
 *  tens of seconds, and strictly one-by-one made a 19-report project take most
 *  of an hour. Three stays under the binding's concurrent-session cap (the
 *  server also retries a busy launch). A report the server couldn't render
 *  (5xx, network drop, timeout) is tried again after a pause, one at a time —
 *  Browser Rendering refuses new browsers for minutes at a stretch when another
 *  batch (a cabin export, say) is holding sessions, and those reports used to
 *  be dropped. Only one that still fails after every retry is skipped and
 *  named; it never sinks the batch.
 */

const PARALLEL = 3;
const PER_REPORT_TIMEOUT_MS = 180_000;
/** Pause before each retry round. ~100s in all, past the few-minute outages
 *  seen on the binding (2026-10-29). */
const RETRY_WAITS_MS = [10_000, 30_000, 60_000];

class PdfError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

async function fetchPdf(id: number): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(`/api/site-reports/${id}/pdf`, { signal: AbortSignal.timeout(PER_REPORT_TIMEOUT_MS) });
  } catch (e) {
    throw new PdfError(e instanceof Error ? e.message : "network error", true);
  }
  // 4xx (no permission, report deleted) won't change on a retry.
  if (!res.ok) throw new PdfError(`HTTP ${res.status}`, res.status >= 500 || res.status === 429);
  return new Uint8Array(await res.arrayBuffer());
}

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
  const progress = (current: string) => onProgress({ done, total: reports.length, current });

  // Waits out a retry pause, but notices Stop within half a second.
  async function pause(ms: number) {
    for (let t = 0; t < ms && !isCancelled(); t += 500) await new Promise((r) => setTimeout(r, 500));
  }

  progress("");
  let pending = reports;
  for (let round = 0; pending.length && !cancelled; round++) {
    if (round > 0) {
      progress(`retrying ${pending.length}`);
      await pause(RETRY_WAITS_MS[round - 1]);
      if (isCancelled()) { cancelled = true; break; }
    }
    const lastRound = round === RETRY_WAITS_MS.length;
    const queue = pending;
    const retry: ReportRef[] = [];
    let next = 0;
    async function worker() {
      while (next < queue.length) {
        if (isCancelled()) { cancelled = true; return; }
        const r = queue[next++];
        const label = fileName(r);
        try {
          const bytes = await fetchPdf(r.id);
          // Two reports can share a name (a regenerated period) — keep both.
          files[files[`${label}.pdf`] ? `${label} (${r.id}).pdf` : `${label}.pdf`] = bytes;
        } catch (e) {
          if (e instanceof PdfError && e.retryable && !lastRound) { retry.push(r); continue; }
          failed.push(label);
        }
        done += 1;
        progress(label);
      }
    }
    // First pass three at a time; retries one at a time, to ease off a busy binding.
    const width = round === 0 ? PARALLEL : 1;
    await Promise.all(Array.from({ length: Math.min(width, queue.length) }, worker));
    // Retries keep the original order, so the zip still fills in date order.
    pending = queue.filter((r) => retry.includes(r));
  }

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
