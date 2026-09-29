/**
 * What preliminaries do to a project's forecast cost — one rule for the Prelims
 * tab, the project and site-group forecasts and the portfolio dashboard.
 *
 * Prelims (welfare, scaffold, plant hire, site management) carry their own
 * budget: the Preliminaries lines of the pricing workbook, already inside the
 * contract cost the forecast starts from. Until this existed the forecast never
 * measured spend against it, and got prelims wrong both ways at once:
 *
 *   - every prelim order counted IN FULL as unexpected, off-BOQ spend — prelim
 *     orders are free-text lines tagged to a heading, never picked from the bill,
 *     so the forecast took them for unbudgeted money on top of the budget that
 *     already covers them;
 *   - plant hire running past its order and prelim-tagged labour claims never
 *     reached it at all, however far over they went.
 *
 * Now prelims spend is added up in one place and set against the prelims
 * budget, and only the part past the budget reaches forecast cost:
 *
 *   orders        every committed prelim order line (see PRELIM_LINE)
 *   labour        certified prelim-tagged labour claims (a subcontract PM's
 *                 time) — certified only, as all labour is counted
 *   plant         what the plant tracker has accrued past each plant-hire
 *                 order's own value: hire kept on longer than was ordered
 *
 * Measured as ONE pot per project, not per heading. The pot is the one number
 * that reliably exists — each project's prelim rows add up to its cost sheet's
 * Preliminaries line — while headings are matched by free-text wording: plant
 * hire orders are always typed "Plant hire", and live orders are typed
 * "Preliminaries" or nothing at all. Per heading, each of those would read as
 * unbudgeted and book a phantom overspend. The Prelims tab still shows the
 * per-heading split.
 *
 * Nothing here lowers forecast cost: prelims inside their budget leave it at the
 * budget, as an unfinished job's underspend is not yet a saving.
 */

/** A plant-tracker row: the hire rate is per `rate_unit` ("day" or "week"). */
export type PlantHire = {
  day_rate: number | null;
  rate_unit: string | null;
  on_hire_from: string | null;
  off_hire_to: string | null;
};

const DAY = 86_400_000;

/** Hire accrued to date on one plant-tracker row — the rate over the days it
 *  has been on hire (to its off-hire date, else today), with a weekly rate
 *  charging each week begun. The Prelims tab's long-standing calculation. */
export function plantAccrued(p: PlantHire, today: string): number {
  if (p.day_rate == null || !p.on_hire_from) return 0;
  const from = new Date(p.on_hire_from + "T00:00:00").getTime();
  const to = new Date((p.off_hire_to ?? today) + "T00:00:00").getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  const days = Math.max(1, Math.floor((to - from) / DAY) + 1);
  const units = p.rate_unit === "week" ? Math.ceil(days / 7) : days;
  return units * p.day_rate;
}

/** A plant-tracker row with the live order it was raised against. */
export type PlantOnOrder = PlantHire & { po_id: string; po_value: number };

/**
 * Plant hire run past its order: per plant-hire PO, what the tracker has accrued
 * on the items it covers beyond the PO's own value. The order is already in
 * prelims spend, so only the excess is new. Plant with no order behind it is
 * left to the Prelims tab's cross-check — it can't be told apart from hire that
 * was ordered some other way, and counting it would book that twice.
 */
export function plantBeyondOrders(rows: PlantOnOrder[], today: string): number {
  const byPo = new Map<string, { accrued: number; value: number }>();
  for (const r of rows) {
    const cur = byPo.get(r.po_id) ?? { accrued: 0, value: Number(r.po_value) || 0 };
    cur.accrued += plantAccrued(r, today);
    byPo.set(r.po_id, cur);
  }
  let over = 0;
  for (const { accrued, value } of byPo.values()) over += Math.max(0, accrued - value);
  return Math.round(over * 100) / 100;
}

/** One project's prelims pot, as `/prelims` returns it. */
export type PrelimsPosition = {
  /** Prelim rows' budget, net of omissions — else the cost sheet's line. */
  budget: number;
  /** Committed prelim order lines. */
  orders: number;
  /** Certified prelim-tagged labour claims. */
  labour: number;
  /** Plant hire accrued past its order. */
  plant: number;
};

export type PrelimsOutturn = PrelimsPosition & {
  /** orders + labour + plant. */
  spend: number;
  /** What forecast cost carries on top of the budget: max(0, spend − budget). */
  overrun: number;
};

const n = (v: number | null | undefined) => (Number.isFinite(v) ? Number(v) : 0);
const pence = (v: number) => Math.round(v * 100) / 100;

export function prelimsOutturn(p: Partial<PrelimsPosition> | null | undefined): PrelimsOutturn {
  const budget = pence(Math.max(0, n(p?.budget)));
  const orders = pence(n(p?.orders)), labour = pence(n(p?.labour)), plant = pence(n(p?.plant));
  const spend = pence(orders + labour + plant);
  return { budget, orders, labour, plant, spend, overrun: pence(Math.max(0, spend - budget)) };
}
