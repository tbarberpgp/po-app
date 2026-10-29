/** Which failed invoice reads are worth trying again on their own.
 *
 *  The hourly mail pull runs on whichever Cloudflare machine is free, and on
 *  2026-10-28 one run landed somewhere the Claude API refused outright
 *  ("403 Request not allowed") — three invoices arrived with no lines while
 *  every run either side read fine. Refusals, rate limits, overloads and
 *  network blips clear up by themselves, so those get retried; a file the app
 *  can't read at all ("Upload the invoice as a PDF…") never will, and retrying
 *  it would only burn a Claude call every hour. */
export function isRetryableExtractError(err: string | null | undefined): boolean {
  const e = (err ?? "").trim();
  if (!e) return false;
  if (/^(403|408|409|429|5\d\d)\b/.test(e)) return true;
  return /overloaded|rate.?limit|timed? ?out|timeout|connection|network|fetch failed|ECONNRESET|socket/i.test(e);
}

/** How long a failed read keeps being retried. Past this, someone has either
 *  typed it in by hand or it needs a person to look at it anyway. */
export const EXTRACT_RETRY_DAYS = 7;
/** Reads re-attempted per hourly run — each one is a Claude call. */
export const EXTRACT_RETRY_BATCH = 5;
