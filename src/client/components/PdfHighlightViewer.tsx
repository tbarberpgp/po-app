// PDF viewer that draws coloured highlight boxes over the values the reader
// picked up (invoice number, PO reference, dates, amounts) — so you can see at
// a glance WHERE on the document each field came from, like the design's
// "information pickup" overlay. Renders with pdf.js (lazy-loaded); highlights
// come from matching the extracted values against the PDF's own text layer, so
// they need no stored coordinates. Image files have no text layer — callers
// keep their <img> path for those.
import { useEffect, useRef, useState } from "react";

export type HighlightTarget = {
  /** The exact value the reader extracted (multiple written forms are derived). */
  value: string;
  /** CSS colour for the box (used at low alpha for fill, full for border). */
  color: string;
  label: string;
};

/** Lowercased alphanumerics only — tolerant of spacing/commas/currency marks. */
function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The written forms a value might take on the document. */
function variants(t: HighlightTarget): string[] {
  const v = t.value.trim();
  const out = new Set<string>([norm(v)]);
  // ISO date → the common UK renderings ("29 June 2026", "29/06/2026", …).
  const d = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (d) {
    const [, y, m, day] = d;
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const mon = months[Number(m) - 1] ?? "";
    const dayN = String(Number(day));
    for (const f of [
      `${dayN} ${mon} ${y}`, `${dayN} ${mon.slice(0, 3)} ${y}`,
      `${day}/${m}/${y}`, `${dayN}/${Number(m)}/${y}`, `${day}.${m}.${y}`, `${day}-${m}-${y}`,
      `${y}-${m}-${day}`,
    ]) out.add(norm(f));
  }
  // Amount → with/without thousands separators and decimals.
  const n = Number(v);
  if (Number.isFinite(n) && /^[\d,.\s£]+$/.test(v)) {
    out.add(norm(n.toFixed(2)));
    out.add(norm(n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
  }
  return [...out].filter((x) => x.length >= 4);
}

type Box = { left: number; top: number; width: number; height: number; color: string; label: string };

export function PdfHighlightViewer({ url, targets, showHighlights = true }: {
  url: string;
  targets: HighlightTarget[];
  showHighlights?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<Array<{ canvas: HTMLCanvasElement; boxes: Box[]; w: number; h: number }>>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPages([]); setErr(null);
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const doc = await pdfjs.getDocument({ url, withCredentials: true }).promise;
        const hostWidth = Math.max(320, (hostRef.current?.clientWidth ?? 640) - 4);
        const wanted = targets.flatMap((t) => variants(t).map((v) => ({ v, color: t.color, label: t.label })));
        const rendered: Array<{ canvas: HTMLCanvasElement; boxes: Box[]; w: number; h: number }> = [];
        for (let p = 1; p <= Math.min(doc.numPages, 6); p++) {
          const page = await doc.getPage(p);
          const base = page.getViewport({ scale: 1 });
          const scale = hostWidth / base.width;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width * (window.devicePixelRatio || 1));
          canvas.height = Math.floor(viewport.height * (window.devicePixelRatio || 1));
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          const ctx = canvas.getContext("2d")!;
          ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
          await page.render({ canvasContext: ctx, viewport, canvas }).promise;

          // Match extracted values against the page's text items and box them.
          const boxes: Box[] = [];
          const tc = await page.getTextContent();
          for (const item of tc.items as Array<{ str: string; transform: number[]; width: number; height: number }>) {
            const textN = norm(item.str);
            if (textN.length < 4) continue;
            const hit = wanted.find((w) => textN.includes(w.v) || (textN.length >= 6 && w.v.includes(textN)));
            if (!hit) continue;
            const tx = pdfjs.Util.transform(viewport.transform, item.transform);
            const fontH = Math.hypot(tx[2], tx[3]);
            boxes.push({
              left: tx[4] - 2,
              top: tx[5] - fontH - 1,
              width: item.width * scale + 4,
              height: fontH + 4,
              color: hit.color,
              label: hit.label,
            });
          }
          rendered.push({ canvas, boxes, w: viewport.width, h: viewport.height });
          if (!alive) return;
        }
        if (alive) setPages(rendered);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "couldn't render the PDF");
      }
    })();
    return () => { alive = false; };
    // targets identity churns per render — key off the values actually used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, JSON.stringify(targets)]);

  if (err) return <iframe title="document" className="vframe" src={url} />;

  return (
    <div ref={hostRef} style={{ width: "100%" }}>
      {pages.length === 0 && <div className="muted" style={{ padding: 20, fontSize: 12.5 }}>Rendering the document…</div>}
      {pages.map((pg, i) => (
        <div key={i} style={{ position: "relative", width: pg.w, height: pg.h, margin: "0 auto 10px", background: "#fff", boxShadow: "0 6px 26px rgba(0,0,0,.3)" }}>
          <div ref={(el) => { if (el && !el.hasChildNodes()) el.appendChild(pg.canvas); }} />
          {showHighlights && pg.boxes.map((b, j) => (
            <span key={j} title={b.label} style={{
              position: "absolute", left: b.left, top: b.top, width: b.width, height: b.height,
              background: `color-mix(in srgb, ${b.color} 22%, transparent)`,
              outline: `1.5px solid ${b.color}`, borderRadius: 3, pointerEvents: "none",
            }} />
          ))}
        </div>
      ))}
    </div>
  );
}
