// Single source of truth for the commercial forecast + the "what made up this
// number" drill-downs. Both the per-project Commercials/Materials tabs
// (ProjectDetail) and the combined group page (GroupPage) import from here, so
// the rolled-up figures can't drift from the per-contract ones — the exact bug
// class that produced a phantom group-page loss. The forecast maths is moved
// verbatim from ProjectDetail's old inline `summarise`/`forecast`.

import type {
  MaterialWithCommitment, MaterialOrder, OffBoqMaterial, POLine, Variation, ContractItem, ApplicationForPayment,
} from "../../shared/types";
import { MONEY_EPSILON, pricedBudget } from "../../shared/budget";
import {
  accumulateMaterials, effectiveSpendRate, isPrelimMaterial, matSupplier, materialSpendCost,
  netUnits, oneScope, prelimsOf, variationLabourBudget, withoutPrelims,
  type AccumulatedMaterial, type MaterialScope, type PrelimsSummary,
} from "../../shared/forecast";
import { labourOutturn, type LabourPositionRow } from "../../shared/labour-cost";
import { fmtMoney } from "./api";
import type { DrillColumn } from "../components/DrillPanel";

// The forecast maths moved to shared/forecast.ts so the worker can run the
// SAME code as the browser (see that file). Re-exported here because this is
// where every screen already imports it from.
export {
  withoutPrelims, withCodedCommitted, matSupplier, materialSpendCost, effectiveSpendRate, netUnits,
  oneScope, accumulateMaterials, isPrelimMaterial, materialOverspendOf, summariseMaterials,
  contractTotals, quoteSavingsOf, omittedMaterialValue, variationLabourBudget,
  prelimsOf, prelimLabourCertified,
  computeForecast, totalChange, labourProfit, addForecasts, sumForecasts, withCombinedOverspend,
} from "../../shared/forecast";
export type {
  Summary, Forecast, AccumulatedMaterial, MaterialScope, PrelimsSummary,
} from "../../shared/forecast";

/** One off-BOQ ("unpriced") PO line — returned by /api/projects/:id/summary so
 *  the Unpriced spend / Unexpected spend drill can list the actual lines. */
export type UnpricedLine = {
  po_id: string; line_id: number; po_number: string; supplier: string | null;
  item: string; qty: number | null; unit: string | null; line_total: number; status: string;
  /** The PO's cost category — 'materials' or 'prelims'. Prelim spend carries its
   *  own Preliminaries budget, so it reads differently from a genuinely
   *  unbudgeted material buy. */
  category?: string;
  /** The budget line this wording was coded to last time, from the learned
   *  aliases (matchMemory). A suggestion only — the cost stays in unpriced
   *  spend until someone accepts it. */
  suggested_material_id?: number;
  suggested_material_item?: string;
};

/** A row in the Materials table. `off_boq` is set on the rows that came from a
 *  purchase order rather than the pricing workbook. */
export type MatRow = MaterialWithCommitment & { off_boq?: OffBoqMaterial };

/** The purchase orders behind one materials row, newest first. A BOQ line gets
 *  them from the materials endpoint; a PO-added row already carries its own on
 *  `off_boq`. Both are `MaterialOrder`, so the breakdown reads the same either
 *  way — and a row that spans both (a BOQ line also bought off-BOQ) never
 *  counts an order twice, because the two live on different rows. */
export function materialOrders(m: MatRow): MaterialOrder[] {
  return (m.off_boq ? m.off_boq.orders : m.orders) ?? [];
}

/** Dress a PO-added item as a materials row so it sits in the same table — and
 *  the same filter, sort and Excel export — as the priced BOQ lines. Budget
 *  fields stay null either way: an uncoded buy has no budget at all, and a
 *  coded one draws on a budget that belongs to the BOQ row it was coded to (see
 *  `off_boq.coded_to_item`), never to this row — which is also why nothing may
 *  total these rows alongside the BOQ. The id is negative because there is no
 *  material record to act on: every row action keys off `off_boq` instead. */
export function offBoqRow(o: OffBoqMaterial, idx: number): MatRow {
  return {
    id: -(idx + 1), snapshot_id: 0,
    item: o.item, type: o.type?.trim() || "Additional", element_code: null,
    manufacturer: o.manufacturer,
    pack_qty: null, pack_unit: o.unit, cost: null, cost_unit: null,
    coverage_qty: null, coverage_unit: null, waste_pct: null,
    unit_rate: null, rate_unit: null,
    total_qty: null, total_qty_unit: null,
    total_units: null, total_units_unit: o.unit,
    material_total_cost: null, labour_unit_cost: null, labour_total_cost: null,
    committed_qty: o.committed_qty,
    called_off_qty: o.called_off_qty,
    framework_reserved_qty: o.framework_reserved_qty,
    remaining_qty: null,
    // The rate paid — there's no BOQ rate to compare it against, so it reads in
    // the Live column and prices the row's committed £ in the Excel export.
    live_unit_price: o.unit_cost || null,
    off_boq: o,
  };
}

/** When this material first reached the job: the first order for an off-BOQ buy,
 *  or the upload of the bill that priced it. Materials rows carry no timestamp of
 *  their own, so this is assembled from what the job does record — which means
 *  every line in one bill shares a date, and it separates bills rather than lines
 *  within a bill. */
export function materialAddedAt(m: MatRow): string | null {
  if (m.off_boq) {
    return m.off_boq.orders.reduce<string | null>(
      (earliest, o) => (o.ordered_at && (earliest == null || o.ordered_at < earliest) ? o.ordered_at : earliest),
      null,
    );
  }
  return m.snapshot_uploaded_at ?? null;
}

/** The last thing that happened to it — a new order, a substitution, or a quote
 *  price being applied — falling back to when it was added. Orders are dated by
 *  their PO, so a line added to an old order by amendment reads as that order's
 *  date rather than the day it was typed. */
export function materialModifiedAt(m: MatRow): string | null {
  return [
    m.off_boq?.last_ordered_at ?? m.last_ordered_at ?? null,
    m.sub_created_at ?? null,
    m.live_price_applied_at ?? null,
    materialAddedAt(m),
  ].reduce<string | null>((best, at) => (at && (best == null || at > best) ? at : best), null);
}

/** The first unit that actually says something, falling back through however
 *  many candidates the caller has.
 *
 *  Every unit chain used to be written `a ?? b ?? "ea"`, which is wrong for this
 *  data: `??` only steps over null and undefined, and the unit columns hold the
 *  EMPTY STRING far more often than null — 166 of 565 po_lines, with not a
 *  single null among them. So the chain stopped at the first blank and handed
 *  back "" instead of the default, and a picker prefilled from a previous order
 *  came up with an empty Unit box.
 *
 *  Pass the default last (`pickUnit(a, b, "ea")`) to keep it visible at the call
 *  site rather than buried in here. */
export function pickUnit(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    const v = c?.trim();
    if (v) return v;
  }
  return "";
}

/** What a budget line is worth and how much of that is still unspent — the pair
 *  the budget pickers show under each option ("£8,340.00 budgeted · £1,120.00
 *  left"). Money is the decision those dropdowns actually serve: can this line
 *  absorb the cost being coded to it. The budgeted *quantity* they used to show
 *  answered a question nobody asks at that moment.
 *
 *  Both figures come off the same definitions the Materials tab and the forecast
 *  use — net budgeted units × BOQ cost, less committed re-valued at the buy rate
 *  (live quote → substitution blend → BOQ cost) — so a picker can't quote
 *  headroom the tab it codes into disagrees with. A lump-sum line (Mansafe,
 *  smoke-vent kits: priced as one figure, no units) has nothing to multiply, so
 *  it falls back to the workbook's own total for the line; a line whose units
 *  were omitted keeps the omission's £0 rather than resurrecting that total. */
export function budgetMoneyHint(m: MaterialWithCommitment): string[] {
  return budgetMoney(m)?.words ?? ["no priced budget"];
}

/** The same answer with the figures still as numbers, and the committed total
 *  that stands between them — for callers with room to show the subtraction
 *  rather than only its result. Null wherever `budgetMoneyHint` says "no priced
 *  budget": there is nothing to take a remainder of. */
export type BudgetMoney = {
  /** What the budget line is priced at, in £. */
  budget: number;
  /** £ committed against it across every live order — not just the one the
   *  reader happens to be looking at. */
  committed: number;
  /** Headroom. Negative means the line is over. */
  left: number;
  /** ["£32,192.16 budgeted", "£13,228.90 left" | "£240.00 over"]. */
  words: [string, string];
};

/** Budgeted and what is left of it, worded in one place. Every reader of a
 *  budget line says it the same way, whether the tally reached them as a
 *  materials row to price or as a figure the API had already totalled. */
function moneyPair(budget: number, committed: number): BudgetMoney {
  const left = budget - committed;
  return {
    budget, committed, left,
    words: [
      `${fmtMoney(budget)} budgeted`,
      left < -MONEY_EPSILON
        ? `${fmtMoney(-left)} over`
        // Half a penny of float noise is not an over-run — and a line
        // committed to the penny reads "£0.00 left", never "-£0.00 left".
        : `${fmtMoney(Math.max(0, left))} left`,
    ],
  };
}

export function budgetMoney(m: MaterialWithCommitment): BudgetMoney | null {
  const budget = pricedBudget(m);
  if (!(budget > 0)) return null;
  return moneyPair(budget, (m.committed_qty ?? 0) * effectiveSpendRate(m));
}

/** The same pair for a PO line, whose money GET /api/pos/:id has already
 *  totalled against the budget line the cost is coded to — `budget_priced` and
 *  `budget_committed`, recomputed there against today's budget by the rule in
 *  shared/committed-spend.ts. So there is no materials row to price here, and
 *  no second fetch to make: the figures travel with the order.
 *
 *  They are the BUDGET LINE's, not this line's share of it — committed counts
 *  every live order drawing on it, this one included — so two lines of one
 *  order coded to the same budget line quote one figure between them. Null
 *  where the API sends none: a line coded to nothing, a lump-rate line, or any
 *  line on a call-off, whose ceiling is its framework's remaining and not the
 *  BOQ allowance.
 *
 *  Against `budgetMoney` on the same budget line this can differ by pennies —
 *  20p at worst across the live order book, and not a disagreement about what
 *  is committed. The materials route folds coded £ back into a QUANTITY at the
 *  buy rate, rounded to 3dp, which the picker then re-multiplies; this figure
 *  is the orders' own £, never re-valued, which is what the over-budget test
 *  requires (shared/budget.ts). A picker listing every budget line on the job
 *  has no PO to read, so it keeps pricing materials rows itself. */
export function poLineBudgetMoney(l: POLine): BudgetMoney | null {
  const budget = l.budget_priced ?? 0;
  if (!(budget > 0)) return null;
  return moneyPair(budget, l.budget_committed ?? 0);
}


// ── Drill-down builders ─────────────────────────────────────────────────────
// Each returns the body of a DrillData (columns + rows, optional total/note);
// the caller supplies the title and headline value. Rows are plain objects.

export type DrillBody = {
  columns: DrillColumn[];
  rows: Array<Record<string, unknown>>;
  total?: string;
  totalLabel?: string;
  note?: string;
};

const money = (v: unknown) => fmtMoney(Number(v) || 0);
const qtyFmt = (v: unknown) => (v == null || v === "" ? "—" : Number(v).toLocaleString("en-GB", { maximumFractionDigits: 2 }));
const sum = (rows: Array<Record<string, unknown>>, key: string) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
/** Where prelim orders went — they used to be listed among the off-BOQ lines. */
const PRELIMS_ELSEWHERE = " Prelim orders aren't here: they draw on the prelims budget and are measured against it under Profit/Loss from Prelims.";
const unpricedNote = () =>
  `Purchase-order lines raised outside the priced BOQ (call-offs excluded).${PRELIMS_ELSEWHERE}`;

/** Priced material budget = Σ BOQ qty × BOQ cost over priced lines. */
export function pricedBudgetDrill(mats: MaterialWithCommitment[]): DrillBody {
  const rows = mats
    .filter((m) => !m.omitted && netUnits(m) > 0 && (m.cost ?? 0) > 0)
    .map((m) => ({ item: m.item, qty: netUnits(m), cost: m.cost, priced: netUnits(m) * (m.cost ?? 0) }))
    .sort((a, b) => b.priced - a.priced);
  return {
    columns: [
      { key: "item", label: "Material" },
      { key: "qty", label: "BOQ qty", align: "right", fmt: qtyFmt },
      { key: "cost", label: "£/unit", align: "right", fmt: money },
      { key: "priced", label: "Budget", align: "right", fmt: money },
    ],
    rows, total: money(sum(rows, "priced")),
  };
}

/** Committed cost = Σ committed qty × spend cost (excludes call-offs, mirrors the
 *  materials list). */
/** What makes up the Committed figure. Takes the off-BOQ lines as well as the
 *  BOQ materials, because the tile now totals both — a drill that listed only
 *  the bill half would never add up to the number it is explaining. */
export function committedDrill(mats: MaterialWithCommitment[], offBoq: UnpricedLine[] = []): DrillBody {
  const boqRows = mats
    .filter((m) => (m.committed_qty ?? 0) > 0)
    .map((m) => {
      const rate = materialSpendCost(m);
      return { item: m.sub_item || m.item, supplier: matSupplier(m) || "—", against: "Budget line", qty: m.committed_qty, rate, committed: (m.committed_qty ?? 0) * rate };
    });
  const offRows = offBoq.map((l) => ({
    item: l.item, supplier: l.supplier || "—", against: "Off-BOQ",
    qty: l.qty, rate: l.qty ? l.line_total / l.qty : 0, committed: l.line_total,
  }));
  const rows = [...boqRows, ...offRows].sort((a, b) => b.committed - a.committed);
  return {
    columns: [
      { key: "item", label: "Material" },
      { key: "supplier", label: "Supplier", align: "center" },
      { key: "against", label: "Against", align: "center" },
      { key: "qty", label: "Committed qty", align: "right", fmt: qtyFmt },
      { key: "rate", label: "£/unit", align: "right", fmt: money },
      { key: "committed", label: "Committed", align: "right", fmt: money },
    ],
    rows, total: money(sum(rows, "committed")),
  };
}

/** Over-budget material lines: committed £ above the line's BOQ budget. */
export function overspendDrill(mats: MaterialWithCommitment[]): DrillBody {
  const rows = mats
    .filter((m) => !m.omitted)
    .map((m) => {
      const budget = netUnits(m) * (m.cost ?? 0);
      const committed = (m.committed_qty ?? 0) * materialSpendCost(m);
      return { item: m.sub_item || m.item, budget, committed, over: Math.max(0, committed - budget) };
    })
    .filter((r) => r.over > 0.005)
    .sort((a, b) => b.over - a.over);
  return {
    columns: [
      { key: "item", label: "Material" },
      { key: "budget", label: "Budget", align: "right", fmt: money },
      { key: "committed", label: "Committed", align: "right", fmt: money },
      { key: "over", label: "Over budget", align: "right", fmt: money },
    ],
    rows, total: money(sum(rows, "over")),
    note: "Lines where committed spend (after any substitution) exceeds the BOQ budget for that material.",
  };
}

/** Quote savings per line = (BOQ cost − live price) × BOQ qty, over quoted lines
 *  (positive = saving, negative = the quote came in dearer). */
export function materialSavingsDrill(mats: MaterialWithCommitment[]): DrillBody {
  // Same buy-rate basis as quoteSavingsOf: applied quote price first, else the
  // approved substitution's rate — so the drill's rows sum to the headline.
  const rows = mats
    .filter((m) => !m.omitted && m.cost != null && !isPrelimMaterial(m))
    .map((m) => {
      const buy = effectiveSpendRate(m);
      return {
        item: m.sub_item || m.item,
        via: m.live_unit_price != null ? "quote" : (m.sub_id ? "substitution" : ""),
        boq: m.cost, live: buy, qty: netUnits(m),
        saving: buy > 0 ? (m.cost! - buy) * netUnits(m) : 0,
      };
    })
    .filter((r) => Math.abs(r.saving) > 0.005)
    .sort((a, b) => b.saving - a.saving);
  return {
    columns: [
      { key: "item", label: "Material" },
      { key: "via", label: "Via" },
      { key: "boq", label: "BOQ £/u", align: "right", fmt: money },
      { key: "live", label: "Buy £/u", align: "right", fmt: money },
      { key: "qty", label: "Qty", align: "right", fmt: qtyFmt },
      { key: "saving", label: "Saving", align: "right", fmt: money },
    ],
    rows, total: money(sum(rows, "saving")),
  };
}

/** Profit / loss from labour, line by line: each live subcontract rate's saving
 *  against the BOQ, then every pound forecast cost carries because certified
 *  labour went past its budget or never had one. The rows add up to the lever
 *  (labourProfit) — savings less the overrun. */
export function labourDrill(items: ContractItem[], rows: LabourPositionRow[], variations: Variation[]): DrillBody {
  const savings = items
    .filter((ci) => ci.live_labour_rate != null && ci.labour_rate != null)
    .map((ci) => {
      const qty = ci.qty ?? 0;
      return {
        description: ci.description, why: "Live rate vs BOQ",
        budget: ci.labour_rate! * qty, actual: ci.live_labour_rate! * qty,
        effect: (ci.labour_rate! - ci.live_labour_rate!) * qty,
      };
    })
    .filter((r) => Math.abs(r.effect) > 0.005)
    .sort((a, b) => b.effect - a.effect);
  const why = { over_budget: "Certified past its budget", unbudgeted: "No labour budget", variations: "Past the variations' labour budget" } as const;
  const overruns = labourOutturn(rows, variationLabourBudget(variations)).lines.map((l) => ({
    description: l.section, why: why[l.kind], budget: l.budget, actual: l.certified, effect: -l.over,
  }));
  const all = [...savings, ...overruns];
  return {
    columns: [
      { key: "description", label: "Labour item / section" },
      { key: "why", label: "Why" },
      { key: "budget", label: "Budget", align: "right", fmt: money },
      { key: "actual", label: "Live / certified", align: "right", fmt: money },
      { key: "effect", label: "Profit / loss", align: "right", fmt: money },
    ],
    rows: all, total: money(sum(all, "effect")),
    note: "Certified labour only — a submitted claim moves the forecast once it's certified. An underspend isn't counted as a saving until the work is done; live subcontract rates are where labour savings come from.",
  };
}

/** Profit / loss from prelims: the pot's spend per heading against its budget.
 *  Measured as one pot, so only the total past the budget reaches forecast
 *  cost — a heading over its own line while the pot has room adds nothing. */
export function prelimsDrill(p: PrelimsSummary | null | undefined): DrillBody {
  const o = prelimsOf(p);
  const rows: Array<Record<string, unknown>> = (p?.headings ?? [])
    .filter((h) => Math.abs(h.budget) > 0.005 || Math.abs(h.committed) > 0.005)
    .map((h) => ({ what: h.name, budget: h.budget, spent: h.committed }));
  if (o.plant > 0.005) rows.push({ what: "Plant hire kept past its order", budget: 0, spent: o.plant });
  // A bill with no prelim rows takes its budget from the cost sheet's one
  // Preliminaries line, which no heading holds.
  const unheld = o.budget - sum(rows, "budget");
  if (unheld > 0.005) rows.push({ what: "Preliminaries (cost sheet)", budget: unheld, spent: 0 });
  return {
    columns: [
      { key: "what", label: "Prelims" },
      { key: "budget", label: "Budget", align: "right", fmt: money },
      { key: "spent", label: "Spent", align: "right", fmt: money },
    ],
    rows, total: money(o.spend), totalLabel: "Spent",
    note: `Orders, certified prelim labour claims and plant hire past its order, against the ${fmtMoney(o.budget)} prelims budget as one pot. ` +
      (o.overrun > 0.005
        ? `${fmtMoney(o.overrun)} past it, which forecast cost carries.`
        : `${fmtMoney(o.budget - o.spend)} of it still to spend, so nothing is added to forecast cost.`),
  };
}

/** Variation profit per VO = sell − (material + labour budget). */
export function variationProfitDrill(variations: Variation[]): DrillBody {
  const rows = variations
    .map((v) => {
      const cost = (v.material_budget ?? 0) + (v.labour_budget ?? 0);
      return { ref: `VO ${v.variation_no}`, description: v.description, sell: v.sell_value ?? 0, cost, profit: (v.sell_value ?? 0) - cost };
    })
    .sort((a, b) => b.profit - a.profit);
  return {
    columns: [
      { key: "ref", label: "Variation", align: "left" },
      { key: "description", label: "Description" },
      { key: "sell", label: "Sell", align: "right", fmt: money },
      { key: "cost", label: "Cost", align: "right", fmt: money },
      { key: "profit", label: "Profit", align: "right", fmt: money },
    ],
    rows, total: money(sum(rows, "profit")),
  };
}

/** Off-BOQ unpriced PO lines (from the /summary endpoint). */
export function unpricedDrill(lines: UnpricedLine[]): DrillBody {
  // Rows carry hidden PO/line refs so the drawer can offer "assign to a
  // budget item" in place (same affordance as the unexpected-spend drill).
  const rows = lines
    .map((l) => ({ po: l.po_number, supplier: l.supplier || "—", item: l.item, qty: l.qty, line_total: l.line_total, status: l.status, __po_id: l.po_id, __line_id: l.line_id, __suggest_id: l.suggested_material_id, __suggest_item: l.suggested_material_item }))
    .sort((a, b) => b.line_total - a.line_total);
  return {
    columns: [
      { key: "po", label: "PO", align: "left" },
      { key: "supplier", label: "Supplier", align: "center" },
      { key: "item", label: "Item" },
      { key: "qty", label: "Qty", align: "right", fmt: qtyFmt },
      { key: "line_total", label: "Value", align: "right", fmt: money },
    ],
    rows, total: money(sum(rows, "line_total")),
    note: unpricedNote(),
  };
}

/** Off-BOQ half of Unexpected spend. Rows carry hidden PO/line refs
 *  (__po_id/__line_id) so the drill drawer can offer "assign to a budget item"
 *  in place. */
const offBoqSpendRows = (lines: UnpricedLine[]) => lines.map((l) => ({
  kind: "Off-BOQ",
  detail: `${l.po_number} · ${l.item}`, amount: l.line_total,
  __po_id: l.po_id, __line_id: l.line_id,
  __suggest_id: l.suggested_material_id, __suggest_item: l.suggested_material_item,
}));

/** Which blocks a merged material actually sits on — "All blocks" when it spans
 *  the lot, so a wide site doesn't print the whole code list on every row. */
const scopeLabel = (a: AccumulatedMaterial, scopes: MaterialScope[]) =>
  (a.scopes.length === scopes.length && scopes.length > 1 ? "All blocks" : [...a.scopes].sort().join(" "));

/** Over-budget half, one row per ACCUMULATED material (see materialOverspendOf):
 *  a material appears only if everything the scope holds for it, added together,
 *  is committed above its budget — and then at that net amount, not the worst
 *  row's. Over the scope's whole material list these rows sum to exactly the
 *  overspend in the headline figure. */
const overBudgetRows = (scopes: MaterialScope[]) => accumulateMaterials(withoutPrelims(scopes))
  .map((a) => ({ kind: "Over budget", detail: a.item, amount: a.committed - a.budget, __scope: scopeLabel(a, scopes) }))
  .filter((r) => r.amount > 0.005);

const UNEXPECTED_COLUMNS: DrillColumn[] = [
  { key: "kind", label: "Type", align: "left" },
  { key: "detail", label: "Detail" },
  { key: "amount", label: "Amount", align: "right", fmt: money },
];
const unexpectedNote = () =>
  `Off-BOQ purchases plus committed spend above a material's budget — both pull through to forecast cost. A material is listed only where its total across the scope shown is over budget, so an over-run covered by the same material elsewhere doesn't appear.${PRELIMS_ELSEWHERE}`;

/** Unexpected spend = off-BOQ unpriced lines + over-budget materials. */
export function unexpectedSpendDrill(lines: UnpricedLine[], mats: MaterialWithCommitment[]): DrillBody {
  const over = overBudgetRows(oneScope(mats)).map(({ __scope, ...r }) => r); // eslint-disable-line @typescript-eslint/no-unused-vars
  const rows = [...offBoqSpendRows(lines), ...over].sort((a, b) => b.amount - a.amount);
  return {
    columns: UNEXPECTED_COLUMNS,
    rows, total: money(sum(rows, "amount")),
    note: unexpectedNote(),
  };
}

/** Combined-scope Unexpected spend. Off-BOQ lines stay on the block whose PO
 *  raised them (the Assign control offers that block's budget lines), while the
 *  over-budget rows are accumulated across every block at once — the whole point
 *  of the combined view — and name the blocks they span, not any single one. */
export function combinedUnexpectedSpendDrill(
  blocks: Array<{ block: string; lines: UnpricedLine[]; mats: MaterialWithCommitment[] }>,
  total?: string,
): DrillBody {
  const scopes: MaterialScope[] = blocks.map((b) => ({ scope: b.block, mats: b.mats }));
  const offBoq = blocks.flatMap((b) => offBoqSpendRows(b.lines).map((r) => ({ __block: b.block, ...r })));
  const over = overBudgetRows(scopes).map(({ __scope, ...r }) => ({ __block: __scope, ...r }));
  const rows = [...offBoq, ...over].sort((a, b) => b.amount - a.amount);
  return {
    columns: [{ key: "__block", label: "Block", align: "left" }, ...UNEXPECTED_COLUMNS],
    rows, total: total ?? money(sum(rows, "amount")),
    note: unexpectedNote(),
  };
}

/** Outgoing applications behind the Applied / Certified figure. */
export function applicationsDrill(afps: ApplicationForPayment[], mode: "applied" | "certified"): DrillBody {
  const outgoing = afps
    .filter((a) => a.direction === "outgoing" && (mode === "applied" ? a.status !== "draft" : (a.status === "certified" || a.status === "paid")))
    .sort((a, b) => a.app_number - b.app_number)
    .map((a) => ({ app: `App ${a.app_number}`, period_end: a.period_end, status: a.status, cumulative_value: a.cumulative_value ?? 0 }));
  return {
    columns: [
      { key: "app", label: "Application", align: "left" },
      { key: "period_end", label: "Period end", align: "center" },
      { key: "status", label: "Status", align: "center" },
      { key: "cumulative_value", label: "Cumulative", align: "right", fmt: money },
    ],
    rows: outgoing,
    note: `The ${mode} figure is the latest application's cumulative value (not the sum of the column).`,
  };
}

/** Merge per-block drill bodies into one combined body with a leading Block
 *  column. `total` is supplied by the caller (the already-combined figure). */
export function combineDrill(perBlock: Array<{ block: string; body: DrillBody }>, total?: string): DrillBody {
  const base = perBlock.find((p) => p.body.rows.length)?.body ?? perBlock[0]?.body;
  const columns: DrillColumn[] = [{ key: "__block", label: "Block", align: "left" }, ...(base?.columns ?? [])];
  const rows = perBlock.flatMap((p) => p.body.rows.map((r) => ({ __block: p.block, ...r })));
  return { columns, rows, total, totalLabel: base?.totalLabel, note: base?.note };
}
