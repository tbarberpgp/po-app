// "Arrived deliveries" from WhatsApp messages that aren't a delivery note:
// a text like "BOC Delivery of 5 bottles of gas. 4 empties returned", or a
// photo of a pallet captioned "rooflights arrived". The scanner reads these as
// arrival REPORTS — weaker evidence than a signed ticket, so they land in the
// same inbox but flagged, and always wait for a person to confirm.

/** Words that make a message worth reading as a possible arrival. Deliberately
 *  wide — the read itself decides whether goods actually came ("not received
 *  yet", "you should have a delivery tomorrow" are turned away there). */
const ARRIVAL_WORDS = /\b(deliver(ed|y|ies)|receiv(ed|e)|arriv(ed|al|es)|dropped(\s+off)?|turned\s+up|came\s+(in|today|this)|collected|offloaded|unloaded|craned)\b/i;

export function looksLikeArrivalText(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (t.length < 4) return false;
  // Forwarded project emails ride in the same table; they aren't site reports.
  if (/^project email\b/i.test(t)) return false;
  return ARRIVAL_WORDS.test(t);
}

/** The SQL-side prefilter for the same words, so the scan only ever pulls
 *  candidate text rows. Must stay a superset of looksLikeArrivalText. */
export const ARRIVAL_SQL_LIKE = [
  "%deliver%", "%receiv%", "%arriv%", "%dropped%", "%turned up%", "%came %",
  "%collected%", "%offloaded%", "%unloaded%", "%craned%",
];

/** Reports only from messages sent on or after this date. Earlier history was
 *  never read this way; replaying months of chat would bury the inbox in
 *  deliveries long since booked or invoiced. */
export const ARRIVAL_REPORTS_FROM = "2026-11-01";

/** How far apart a caption and its photo can be sent and still be paired —
 *  Andrew's BOC text and his photo of the cylinders were 3½ hours apart. */
export const PAIR_WINDOW_MS = 4 * 3_600_000;

export function withinPairWindow(a: string, b: string): boolean {
  const ta = Date.parse(a), tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) <= PAIR_WINDOW_MS;
}
