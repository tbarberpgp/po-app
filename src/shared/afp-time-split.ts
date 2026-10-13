/**
 * Putting a time invoice's hours on the BOQ lines the work was for.
 *
 * Cladders invoice time — "4 x Operatives attended site as per instruction
 * from Power Grid, 288 hours @ £33" — and nothing on the page says which work
 * the hours went on, so ingest files the lot as Dayworks. That is right as far
 * as the document goes, but it leaves every measured section of the labour
 * budget reading £0 while the work is being done and paid for: on Blyth,
 * £41,740.80 of Cladders' time sat in Dayworks against a flashings budget that
 * read 0% spent.
 *
 * The person certifying knows what the week was for. At certification they can
 * say so: part or all of the Dayworks value moves onto named BOQ lines, and
 * whatever they don't place stays in Dayworks. The application's value never
 * changes — only where it is counted.
 *
 * Period claims only. On a period claim a BOQ line is worth exactly what it
 * says, so value moved from a Dayworks line to a BOQ line nets to the same
 * figure. On a running-total claim a BOQ line is a position to date, and
 * putting one week's hours on it would restate the subcontractor's whole
 * position — that is a different decision, and this refuses it.
 */
import { isDayworkSection } from "./afp-dayworks";

/** One BOQ line and the £ of time placed on it. */
export type TimeSplitPart = { line_id: number; amount: number };

export type TimeSplitLine = {
  id: number;
  is_adhoc: 0 | 1 | number;
  section: string | null;
  description: string;
  contract_item_id: number | null;
  variation_id?: number | null;
  contract_value: number;
  cumulative_value: number;
  display_order: number;
};

export type TimeSplitApp = {
  claim_basis: string | null;
  prelim_heading: string | null;
  claimed_amount: number | null;
  /** The figure the application was submitted at. A split must leave it alone. */
  this_period_net: number | null;
};

export type TimeSplitPlan =
  | {
    ok: true;
    /** BOQ lines that gain value: before → after, and the new % complete. */
    boq: Array<{ line_id: number; description: string; before: number; after: number; percent: number }>;
    /** Dayworks lines that give it up; after = 0 means the line goes. */
    dayworks: Array<{ line_id: number; before: number; after: number }>;
    moved: number;
    left_in_dayworks: number;
  }
  | { ok: false; error: string };

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The £ of time on an application that can be placed: its Dayworks lines. */
export function dayworksTotal(lines: TimeSplitLine[]): number {
  return r2(lines.filter((l) => l.is_adhoc && isDayworkSection(l.section))
    .reduce((s, l) => s + (l.cumulative_value ?? 0), 0));
}

/** True for a line time can be placed on: a BOQ line, not a variation. */
export function isSplittableBoqLine(l: Pick<TimeSplitLine, "is_adhoc" | "contract_item_id" | "variation_id">): boolean {
  return !l.is_adhoc && l.contract_item_id != null && l.variation_id == null;
}

/**
 * Work out what a split writes, or why it can't be done. Pure: the caller
 * applies it. Dayworks lines are drawn down in display order; one drawn to £0
 * is removed rather than left as an empty line.
 */
export function planTimeSplit(app: TimeSplitApp, lines: TimeSplitLine[], parts: TimeSplitPart[]): TimeSplitPlan {
  if (app.prelim_heading != null && app.claimed_amount != null) {
    return { ok: false, error: "This is a prelims drawdown — its value is the claimed amount, not its lines, so time can't be placed on the BOQ." };
  }
  if (app.claim_basis !== "period") {
    return { ok: false, error: "Only a period claim's time can be placed on BOQ lines. On a running total a BOQ line is the position to date, and one week's hours would restate all of it." };
  }
  // A period claim is worth the sum of its lines. If the frozen figure says
  // otherwise, something edited the lines after submission, and recomputing
  // from them would change what is being certified — so stop here.
  const lineSum = r2(lines.reduce((s, l) => s + (l.cumulative_value ?? 0), 0));
  if (Math.abs(lineSum - (app.this_period_net ?? 0)) > 0.01) {
    return { ok: false, error: `This application's lines come to £${lineSum.toFixed(2)} but it was submitted at £${(app.this_period_net ?? 0).toFixed(2)}. Reopen it and check the lines before placing its time.` };
  }
  const byId = new Map(lines.map((l) => [l.id, l]));
  const seen = new Set<number>();
  const gains = new Map<number, number>();
  for (const p of parts) {
    const amount = r2(Number(p.amount));
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Each amount placed on a BOQ line must be more than £0." };
    if (seen.has(p.line_id)) return { ok: false, error: `Line ${p.line_id} is listed twice.` };
    seen.add(p.line_id);
    const line = byId.get(p.line_id);
    if (!line) return { ok: false, error: `Line ${p.line_id} isn't on this application.` };
    if (!isSplittableBoqLine(line)) return { ok: false, error: `"${line.description}" isn't a BOQ line — time can only be placed on the labour BOQ.` };
    gains.set(p.line_id, amount);
  }
  const moved = r2([...gains.values()].reduce((s, v) => s + v, 0));
  const available = dayworksTotal(lines);
  if (moved > available + 0.005) {
    return { ok: false, error: `That places £${moved.toFixed(2)} on the BOQ, but the application only claims £${available.toFixed(2)} of time.` };
  }

  const boq = [...gains.entries()].map(([id, amount]) => {
    const l = byId.get(id)!;
    const after = r2((l.cumulative_value ?? 0) + amount);
    return {
      line_id: id, description: l.description, before: l.cumulative_value ?? 0, after,
      percent: l.contract_value > 0 ? (after * 100) / l.contract_value : 0,
    };
  });

  let owed = moved;
  const dayworks: Array<{ line_id: number; before: number; after: number }> = [];
  const dwLines = lines.filter((l) => l.is_adhoc && isDayworkSection(l.section))
    .sort((a, b) => a.display_order - b.display_order);
  for (const l of dwLines) {
    if (owed <= 0.005) break;
    const before = l.cumulative_value ?? 0;
    const take = r2(Math.min(before, owed));
    if (take <= 0) continue;
    dayworks.push({ line_id: l.id, before, after: r2(before - take) });
    owed = r2(owed - take);
  }

  return { ok: true, boq, dayworks, moved, left_in_dayworks: r2(available - moved) };
}

/**
 * Scale an earlier split to this application's time: the same lines in the
 * same proportions. `previous` is £ per contract item on the earlier claim;
 * `lineByItem` maps a contract item to this application's line. Pennies left by
 * rounding go on the largest share, so the parts add up exactly.
 */
export function scaleSplit(
  previous: Array<{ contract_item_id: number; value: number }>,
  lineByItem: Map<number, number>,
  total: number,
): TimeSplitPart[] {
  const usable = previous.filter((p) => p.value > 0 && lineByItem.has(p.contract_item_id));
  const base = usable.reduce((s, p) => s + p.value, 0);
  if (base <= 0 || total <= 0) return [];
  const parts = usable.map((p) => ({ line_id: lineByItem.get(p.contract_item_id)!, amount: r2((p.value / base) * total) }));
  const drift = r2(total - parts.reduce((s, p) => s + p.amount, 0));
  if (drift !== 0) {
    const biggest = parts.reduce((m, p) => (p.amount > m.amount ? p : m), parts[0]);
    biggest.amount = r2(biggest.amount + drift);
  }
  return parts.filter((p) => p.amount > 0);
}
