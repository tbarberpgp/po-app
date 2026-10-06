// Where on a document a reader found each value, and whether to believe it.
//
// A photographed or scanned document has no text layer to check a box against,
// so a coordinate from a vision pass is an unfalsifiable guess — and measured
// against real tickets those guesses were wrong often enough to be dangerous:
// the same supplier's letterhead came back as a wide band on one scan and a
// tall strip on the next. Field boxes were withdrawn over it.
//
// They work here because the guess is made checkable. The reader is required to
// transcribe the text it believes sits inside each box, and a box survives only
// if that text really carries the value it is claimed for. A box that cannot be
// corroborated is discarded rather than drawn faintly: a box over the wrong
// number invites confirming a document against a value nobody verified, which
// is worse than no box at all.
import { textConfirms } from "./doc-fields";

/** Normalised box on the source document — fractions of width/height, top-left
 *  origin, in the image's own (unrotated) orientation. */
export type ReadRegion = { x: number; y: number; w: number; h: number };

/** Geometry only: sane normalised bounds, or null. Use on regions read back out
 *  of storage, which were verified on the way in and carry no transcription. */
export function clampRegion(r: unknown): ReadRegion | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  let x = n(o.x), y = n(o.y), w = n(o.w), h = n(o.h);
  if (x == null || y == null || w == null || h == null) return null;
  // Some responses use 0-100 instead of 0-1 — normalise.
  if (x > 1 || y > 1 || w > 1 || h > 1) { x /= 100; y /= 100; w /= 100; h /= 100; }
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x > 1 || y > 1) return null;
  // A box covering most of the page points at nothing in particular.
  if (w > 0.9 && h > 0.9) return null;
  return { x: Math.min(1, x), y: Math.min(1, y), w: Math.min(1 - Math.min(1, x), w), h: Math.min(1 - Math.min(1, y), h) };
}

/** Geometry AND corroboration: the box must be sane and its transcribed text
 *  must carry `expected`. Null when either fails, including when there is no
 *  value for the box to be about. */
export function cleanRegion(r: unknown, expected: string | number | null | undefined): ReadRegion | null {
  const want = expected == null ? "" : String(expected).trim();
  if (!want) return null;
  const box = clampRegion(r);
  if (!box) return null;
  const text = (r as Record<string, unknown>).text;
  return textConfirms(typeof text === "string" ? text : "", want) ? box : null;
}

/** JSON-schema fragment asking a reader for one region. `text` is what makes
 *  the box checkable — without it a coordinate cannot be argued with. */
export function regionSchema(what: string) {
  return {
    type: "object" as const,
    description: `Where ${what} sits ON THE DOCUMENT, as a normalized box (fractions of page width/height, top-left origin), together with the text printed inside it. Omit entirely if you cannot localise it — do not guess a position.`,
    properties: {
      x: { type: "number", description: "left edge, 0-1 fraction of page width" },
      y: { type: "number", description: "top edge, 0-1 fraction of page height" },
      w: { type: "number", description: "width, 0-1 fraction" },
      h: { type: "number", description: "height, 0-1 fraction" },
      text: { type: "string", description: "The text printed INSIDE this box, transcribed verbatim. It must actually contain the value this box is for — if the box covers a label rather than the value, move the box." },
    },
    required: ["x", "y", "w", "h", "text"],
  };
}
