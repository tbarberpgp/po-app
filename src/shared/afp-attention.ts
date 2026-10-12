/**
 * The hand-raised "needs attention" flag on an application for payment
 * (migration 0135).
 *
 * Some problems only a person can find — an app figure that disagrees with the
 * invoice it was read from, a document uploaded twice. The flag carries a note
 * saying what is wrong; it shows on the application and under the dashboard's
 * Needs attention, and never changes the application's figures.
 */

/** Longest note kept. A flag is a pointer to the problem, not the working. */
export const ATTENTION_NOTE_MAX = 1000;

/** The note to store, or null to clear the flag. Blank or whitespace-only text
 *  clears it — an empty flag would sit on the dashboard saying nothing. */
export function normaliseAttentionNote(note: unknown): string | null {
  if (typeof note !== "string") return null;
  const t = note.trim();
  return t ? t.slice(0, ATTENTION_NOTE_MAX) : null;
}
