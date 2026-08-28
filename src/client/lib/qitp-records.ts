import { zip } from "fflate";

/** Batch-download cabin quality records as a ZIP.
 *
 *  Built in the browser rather than the Worker on purpose. Each record takes
 *  Browser Rendering five to ten seconds, so a batch of any size would blow
 *  through a Worker's CPU budget and its concurrent-session limit long before
 *  it finished. Doing it here means no limit on batch size, a real progress
 *  count for the person waiting, and the ability to stop half way.
 *
 *  Records are fetched one at a time — deliberately. Browser Rendering caps
 *  concurrent sessions, and the endpoint already retries on that; hammering it
 *  in parallel would just turn retries into failures.
 */

export type BatchProgress = { done: number; total: number; current: string };
export type BatchResult = { ok: number; failed: string[]; cancelled: boolean };

export type CabinRef = { number: string; token: string };

export async function downloadCabinRecords(
  cabins: CabinRef[],
  projectCode: string,
  onProgress: (p: BatchProgress) => void,
  isCancelled: () => boolean,
): Promise<BatchResult> {
  const files: Record<string, Uint8Array> = {};
  const failed: string[] = [];
  let done = 0;
  let cancelled = false;

  for (const c of cabins) {
    if (isCancelled()) { cancelled = true; break; }
    onProgress({ done, total: cabins.length, current: c.number });
    try {
      const res = await fetch(`/pub/cabin/${c.token}/pdf`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      files[`${projectCode}-QITP-${c.number}.pdf`] = new Uint8Array(await res.arrayBuffer());
    } catch {
      failed.push(c.number);   // one bad cabin must not lose the whole batch
    }
    done += 1;
    onProgress({ done, total: cabins.length, current: c.number });
  }

  const names = Object.keys(files);
  if (names.length) {
    // level 0 = store. PDFs are already compressed; deflating them again costs
    // seconds of CPU on a big batch and saves almost nothing.
    const data = await new Promise<Uint8Array>((resolve, reject) => {
      zip(files, { level: 0 }, (err, out) => (err ? reject(err) : resolve(out)));
    });
    const stamp = new Date().toISOString().slice(0, 10);
    // Copy into a buffer typed as a plain ArrayBuffer — fflate's Uint8Array is
    // declared over ArrayBufferLike, which BlobPart won't accept.
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    saveBlob(new Blob([buf], { type: "application/zip" }), `${projectCode}-quality-records-${stamp}.zip`);
  }

  return { ok: names.length, failed, cancelled };
}

/** Download a single cabin's record, named the same way as it is inside a batch. */
export function cabinRecordUrl(token: string): string {
  return `/pub/cabin/${token}/pdf`;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously can cancel the download
  // in some browsers before it has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
