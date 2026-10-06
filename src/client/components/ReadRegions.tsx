// Drawing where a value was read from, on documents that have no text layer.
//
// Photographed delivery tickets and scanned invoices can't be highlighted the
// way a born-digital PDF can — there is no text layer to match against, only
// the reader's own account of where it looked. Those coordinates were once
// drawn unchecked, pointed at the wrong text often enough to be withdrawn, and
// are drawn again now only because the server throws away any box whose
// transcribed contents don't carry the value it is claimed for
// (shared/read-regions). Everything here therefore assumes its boxes are
// already corroborated: it draws what it is given and says nothing about what
// it isn't.
export type DrawnRegion = {
  key: string;
  label: string;
  color: string;
  value: string;
  box: { x: number; y: number; w: number; h: number };
};

/** Coloured boxes over a document image.
 *
 *  The image itself may be rotated for display (site photos are routinely shot
 *  sideways) while the boxes are in the image's own unrotated coordinates — so
 *  the overlay takes the SAME transform over the SAME layout box, and the two
 *  stay registered. */
export function RegionBoxes({ regions, transform }: { regions: DrawnRegion[]; transform?: string }) {
  if (!regions.length) return null;
  return (
    <span aria-hidden style={{ position: "absolute", inset: 0, transform, pointerEvents: "none" }}>
      {regions.map((r) => (
        <span key={r.key} title={`${r.label}: ${r.value}`} style={{
          position: "absolute",
          left: `${r.box.x * 100}%`, top: `${r.box.y * 100}%`,
          width: `${r.box.w * 100}%`, height: `${r.box.h * 100}%`,
          background: `color-mix(in srgb, ${r.color} 22%, transparent)`,
          outline: `1.5px solid ${r.color}`, borderRadius: 3,
        }} />
      ))}
    </span>
  );
}

/** A zoomed patch of the document showing the text a field was read from.
 *
 *  This is the check a box alone can't give you. Put beside the extracted
 *  value, it turns "the app says PO-26003-0040" into "the paper says
 *  PO-26003-0040" — and a crop that comes back showing the letterhead is
 *  self-evidently not the PO number, where a box over the letterhead can still
 *  look authoritative. The patch is a piece of the unrotated image, so it takes
 *  the upright rotation itself. */
export function FieldCrop({ url, box, rot = 0, dims, width = 168 }: {
  url: string;
  box: { x: number; y: number; w: number; h: number };
  rot?: number;
  dims: { w: number; h: number } | null;
  width?: number;
}) {
  const quarter = rot === 90 || rot === 270;
  // Keep the patch's own proportions so the text isn't stretched; fall back to
  // a squat strip until the document's natural size is known.
  const aspect = dims ? (box.h * dims.h) / Math.max(1, box.w * dims.w) : 0.28;
  const height = Math.max(26, Math.min(120, Math.round(width * (quarter ? 1 / Math.max(aspect, 0.15) : aspect))));
  return (
    <div style={{
      width, height, overflow: "hidden", position: "relative",
      border: "1px solid var(--line)", borderRadius: 5, background: "#fff", flex: "0 0 auto",
    }}>
      <div style={{
        position: "absolute", inset: 0,
        backgroundImage: `url(${url})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${100 / Math.max(box.w, 0.001)}% ${100 / Math.max(box.h, 0.001)}%`,
        backgroundPosition: `${(box.x / Math.max(1 - box.w, 0.001)) * 100}% ${(box.y / Math.max(1 - box.h, 0.001)) * 100}%`,
        transform: rot ? `rotate(${rot}deg)` : undefined,
      }} />
    </div>
  );
}
