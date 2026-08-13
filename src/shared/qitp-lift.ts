// Blyth cabin lift programme dates. Update `install` here once the install date
// is known — it flows to the dashboard "Dismantle lift programme" card and the
// printed QR labels. Dates are ISO (YYYY-MM-DD); null shows as "TBC".
export const QITP_LIFT: { lift: string | null; install: string | null } = {
  lift: "2026-07-06",      // dismantle lifting starts (Rev 1: Mon 6 Jul, ~5/day)
  install: "2026-07-31",   // reinstall starts — Ground back to foundations
};

export function fmtLiftDate(d: string | null): string {
  if (!d) return "TBC";
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
