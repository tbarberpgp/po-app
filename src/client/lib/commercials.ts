// Single source of truth for the commercial forecast + the "what made up this
// number" drill-downs. Both the per-project Commercials/Materials tabs
// (ProjectDetail) and the combined group page (GroupPage) import from here, so
// the rolled-up figures can't drift from the per-contract ones — the exact bug
// class that produced a phantom group-page loss. The forecast maths is moved
// verbatim from ProjectDetail's old inline `summarise`/`forecast`.

import type {
  MaterialWithCommitment, OffBoqMaterial, ProjectCommercial, Variation, ContractItem, ApplicationForPayment,
} from "../../shared/types";
import { fmtMoney } from "./api";
import type { DrillColumn } from "../components/DrillPanel";

export type Summary = {
  priced_total: number;
  /** Everything committed on the job — against the bill AND outside it. The
   *  headline figure: an order placed off-BOQ is committed money like any
   *  other, and a total that leaves it out understates what the job has spent. */
  committed_total: number;
  /** The half of committed_total that draws on the priced bill. Remaining is
   *  measured against THIS, never the total — off-BOQ spend consumes no bill
   *  allowance, so letting it reduce Remaining would report headroom as gone
   *  when it is still there to order against. */
  boq_committed: number;
  /** The other half — spend with no bill line behind it. Same figure as
   *  unpriced_spend, named for what it is on the Committed tile. */
  off_boq_committed: number;
  remaining_total: number;
  committed_pct: number;
  unpriced_spend: number;
  /** Committed spend above budget, summed per line. Feeds forecast cost. */
  material_overspend: number;
  by_supplier: Array<{ supplier: string; items: number; priced: number; committed: number }>;
};

export type Forecast = {
  hasContract: boolean;
  ffa: number; ffc: number; forecastProfit: number; forecastGpPct: number | null;
  contingency: number;
  materialSavings: number; labourSavings: number; varProfit: number; unexpectedSpend: number;
  /** Budget removed from the forecast cost by omitted materials (whole lines +
   *  the omitted part of partial omissions), at the BOQ rate. */
  omittedValue: number;
  /** The two halves of unexpectedSpend — off-BOQ lines (the Materials tab's
   *  "Unpriced spend") and over-budget committed on BOQ items. */
  unpricedSpend: number; materialOverspend: number;
  /** Budget still to buy: BOQ quantity with no order against it, at today's
   *  rate. Already inside the contract cost — it is what's LEFT of the material
   *  budget, not extra money — so it is reported beside the levers, never added
   *  to them. */
  stillToOrder: number;
  /** Where materialOverspend lands once that buying is done at today's rate.
   *  An over-run a part-ordered sibling block is currently masking shows up
   *  here before it shows up in the cost. */
  projectedOverspend: number;
  appliedValue: number; certifiedValue: number; varApplied: number; varCertified: number;
};

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

/** Dress an off-BOQ PO item as a materials row so it sits in the same table —
 *  and the same filter, sort and Excel export — as the priced BOQ lines. It has
 *  no budget, so priced/remaining stay null and the usage bar reads as spend
 *  with nothing behind it. The id is negative because there is no material
 *  record to act on: every row action keys off `off_boq` instead. */
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

/** Supplier a material is bought from — the substitution's supplier/manufacturer
 *  once one is active, else the original BOQ manufacturer. */
export function matSupplier(m: MaterialWithCommitment): string {
  if (m.sub_id) return m.sub_supplier?.trim() || m.sub_manufacturer?.trim() || m.manufacturer?.trim() || "";
  return m.manufacturer?.trim() || "";
}

/** What you actually spend per unit on a material: an active substitution's cost
 *  (blended for a part-substitution), else the original BOQ cost. */
export function materialSpendCost(m: MaterialWithCommitment): number {
  const cost = m.cost ?? 0;
  if (m.sub_id && m.sub_cost != null) {
    if (m.sub_units != null && m.total_units != null && m.total_units > 0 && m.sub_units < m.total_units) {
      return (m.sub_units * m.sub_cost + (m.total_units - m.sub_units) * cost) / m.total_units;
    }
    return m.sub_cost;
  }
  return cost;
}

/** The rate we actually BUY at: live quoted price first, else the substitution
 *  blend / BOQ cost. Committed / called-off £ must use this on BOTH the group
 *  page and the per-block Materials tab, so the two agree. */
export function effectiveSpendRate(m: MaterialWithCommitment): number {
  return m.live_unit_price ?? materialSpendCost(m);
}

/** Budgeted quantity net of a partial omission. Whole-line omissions are
 *  filtered out separately (m.omitted); this handles the "we only need 150 of
 *  the 400" case, so every budget figure prices the reduced quantity. */
export function netUnits(m: MaterialWithCommitment): number {
  return Math.max(0, (m.total_units ?? 0) - (m.omitted_qty ?? 0));
}

/** Wording reduced to its words alone, so spacing, punctuation and case can't
 *  split one material into two. Same normalisation the combined Materials
 *  table merges rows on. */
const normMaterialName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Quantities carry two decimals of noise from pack conversions — a line is
 *  "everything ordered" a hair short of its budgeted quantity. */
const QTY_EPS = 0.01;

/** One block's (or one bill's) slice of an accumulated material. Kept separate
 *  because whether a slice's spare budget may offset a sibling's over-run turns
 *  on this slice's own ordering position, not the material's total. */
export type MaterialPart = {
  /** Whatever the caller is splitting by — a block code on the combined view,
   *  "" when there is only one scope. */
  scope: string;
  budgetQty: number; committedQty: number;
  budget: number; committed: number;
  /** Budget quantity not yet on an order, valued at the rate we are buying at. */
  toOrder: number;
  /** Everything budgeted is on an order (or more). Only then is money left over
   *  a real saving rather than a purchase that hasn't happened yet. */
  fullyOrdered: boolean;
  mats: MaterialWithCommitment[];
};

/** One material as the job actually holds it: every BOQ row describing it added
 *  together — several lines in one bill, and, when the caller passes more than
 *  one block's rows, the same material across blocks. */
export type AccumulatedMaterial = {
  /** Merge key (master product id, else normalised wording) — unique by construction. */
  key: string;
  item: string;
  budget: number; committed: number;
  budgetQty: number; committedQty: number;
  /** Budget not yet ordered anywhere, at today's buy rate. */
  toOrder: number;
  /** Where the material lands if everything still to order is bought at that
   *  rate: committed + toOrder. */
  projected: number;
  /** Spend over budget counted TODAY. A part's spare budget nets off another
   *  part's over-run only where that part has finished ordering (see
   *  `fullyOrdered`) — money not yet spent is not a saving. */
  overspend: number;
  /** The same figure once everything still to order has been bought at today's
   *  rate. Every part is fully ordered by then, so all of them net. */
  projectedOverspend: number;
  parts: MaterialPart[];
  mats: MaterialWithCommitment[];
};

/** A set of material rows and what to call them — one entry per block on the
 *  combined view, a single unnamed entry on a block's own page. */
export type MaterialScope = { scope: string; mats: MaterialWithCommitment[] };

export const oneScope = (mats: MaterialWithCommitment[]): MaterialScope[] => [{ scope: "", mats }];

/** Merge material rows onto the material they describe: by master product where
 *  the row carries one, else by wording — and an UNLINKED row whose wording
 *  matches a linked one joins it rather than sitting alone. Mirrors the combined
 *  Materials table's merge, so a figure derived here lines up with the row a QS
 *  is actually looking at. Omitted lines are out of the job and never appear. */
export function accumulateMaterials(scopes: MaterialScope[]): AccumulatedMaterial[] {
  const live = scopes.map((g) => ({ scope: g.scope, mats: g.mats.filter((m) => !m.omitted) }));
  const productByName = new Map<string, string>();
  for (const g of live) for (const m of g.mats) {
    const n = normMaterialName(m.sub_item || m.item || "");
    if (n && m.product_id != null) productByName.set(n, `p:${m.product_id}`);
  }
  const by = new Map<string, AccumulatedMaterial>();
  for (const g of live) for (const m of g.mats) {
    const norm = normMaterialName(m.sub_item || m.item || "");
    const key = m.product_id != null ? `p:${m.product_id}` : (productByName.get(norm) ?? (norm ? `n:${norm}` : ""));
    if (!key) continue;
    const cur = by.get(key) ?? {
      key, item: m.sub_item || m.item, budget: 0, committed: 0, budgetQty: 0, committedQty: 0,
      toOrder: 0, projected: 0, overspend: 0, projectedOverspend: 0, parts: [], mats: [],
    };
    let part = cur.parts.find((p) => p.scope === g.scope);
    if (!part) { part = { scope: g.scope, budgetQty: 0, committedQty: 0, budget: 0, committed: 0, toOrder: 0, fullyOrdered: false, mats: [] }; cur.parts.push(part); }
    // effectiveSpendRate (live quote first), NOT the sub-only blend: committed
    // £ must re-value committed_qty at the same rate the server folds coded £
    // in at, or a coded PO's money changes size between views.
    const rate = effectiveSpendRate(m);
    part.budgetQty += netUnits(m);
    part.committedQty += m.committed_qty ?? 0;
    part.budget += netUnits(m) * (m.cost ?? 0);
    part.committed += (m.committed_qty ?? 0) * rate;
    part.toOrder += Math.max(0, netUnits(m) - (m.committed_qty ?? 0)) * rate;
    part.mats.push(m);
    cur.mats.push(m);
    by.set(key, cur);
  }
  for (const a of by.values()) {
    for (const p of a.parts) {
      p.fullyOrdered = p.committedQty + QTY_EPS >= p.budgetQty;
      a.budget += p.budget; a.committed += p.committed;
      a.budgetQty += p.budgetQty; a.committedQty += p.committedQty;
      a.toOrder += p.toOrder;
    }
    a.projected = a.committed + a.toOrder;
    // A part that has finished ordering brings its whole position, over or
    // under; one still ordering brings only its over-run — its spare budget is
    // a purchase still to come, and letting that mask a sibling's over-order
    // was the figure quietly under-reporting the job.
    a.overspend = Math.max(0, a.parts.reduce(
      (s, p) => s + (p.fullyOrdered ? p.committed - p.budget : Math.max(0, p.committed - p.budget)), 0));
    a.projectedOverspend = Math.max(0, a.projected - a.budget);
  }
  return [...by.values()];
}

/** Committed spend above budget — measured on the ACCUMULATED material, never on
 *  a single row. A material counts as overspent only once everything the job
 *  holds for it is added up: every line in the bill, and every block in the
 *  scope being looked at. Over-ordering an item on one block that a sibling has
 *  FINISHED buying under budget has cost the site nothing, and flagging it
 *  contradicted the Materials tab's own variance column. A sibling still
 *  ordering is a different matter — see `AccumulatedMaterial.overspend`. */
export function materialOverspendOf(scopes: MaterialScope[]): number {
  return accumulateMaterials(scopes).reduce((s, a) => s + a.overspend, 0);
}

/** Where material overspend lands once everything still on the bill has been
 *  bought at today's rate. Spare budget nets freely here — by then it has all
 *  been spent — so this is the over-run that survives the rest of the buying,
 *  as against `materialOverspendOf`, which is only what has happened so far. */
export function projectedOverspendOf(scopes: MaterialScope[]): number {
  return accumulateMaterials(scopes).reduce((s, a) => s + a.projectedOverspend, 0);
}

/** Budget with nothing ordered against it yet, at the rate we are buying at. */
export function toOrderValueOf(scopes: MaterialScope[]): number {
  return accumulateMaterials(scopes).reduce((s, a) => s + a.toOrder, 0);
}

export function summariseMaterials(mats: MaterialWithCommitment[], unpricedSpend: number): Summary {
  // Omitted materials are out of the job — they contribute nothing to budget,
  // committed or overspend.
  mats = mats.filter((m) => !m.omitted);
  let priced = 0, committed = 0;
  const overspend = materialOverspendOf(oneScope(mats));
  const bySup = new Map<string, { items: number; priced: number; committed: number }>();
  for (const m of mats) {
    const cost = m.cost ?? 0;
    // effectiveSpendRate (live quote first), NOT the sub-only blend: committed
    // £ must re-value committed_qty at the same rate the server folds coded £
    // in at, or a coded PO's money changes size between the two views.
    const spendCost = effectiveSpendRate(m);
    const matPriced = netUnits(m) * cost;
    const matCommitted = (m.committed_qty ?? 0) * spendCost;
    priced += matPriced;
    committed += matCommitted;
    const sup = matSupplier(m) || "—";
    const cur = bySup.get(sup) ?? { items: 0, priced: 0, committed: 0 };
    cur.items += 1;
    cur.priced += matPriced;
    cur.committed += matCommitted;
    bySup.set(sup, cur);
  }
  return {
    priced_total: priced,
    // The total is what the job has committed; Remaining and the percentage
    // stay on the BOQ half, because that is what the allowance is drawn from.
    committed_total: committed + unpricedSpend,
    boq_committed: committed,
    off_boq_committed: unpricedSpend,
    remaining_total: priced - committed,
    committed_pct: priced > 0 ? (committed / priced) * 100 : 0,
    unpriced_spend: unpricedSpend,
    material_overspend: overspend,
    by_supplier: [...bySup.entries()]
      .map(([supplier, v]) => ({ supplier, ...v }))
      .filter((s) => s.priced > 0)
      .sort((a, b) => b.priced - a.priced),
  };
}

/** Contract value/cost = the sheet's "Total" row (already includes Prelims and
 *  nets any Directors Adjustment). */
export function contractTotals(rows: ProjectCommercial[]): { value: number; cost: number } | null {
  const total = rows.find((r) => r.is_total === 1);
  if (!total) return null;
  return { value: total.value ?? 0, cost: total.cost ?? 0 };
}

/** Quote savings to date = how much cheaper applied supplier quotes are than the
 *  BOQ-budgeted cost, on the priced (BOQ) quantity. Positive = saving. */
export function quoteSavingsOf(mats: MaterialWithCommitment[]): number {
  // An omitted line isn't being bought, so it can't save anything — its whole
  // budget comes out via omittedMaterialValue instead.
  // The buy rate is the applied quote price first, else an approved
  // substitution's (blended) rate — the same effectiveSpendRate the committed
  // figures use, so a cheaper substitution pulls through to the forecast just
  // like a cheaper quote. A line with neither buys at BOQ cost (delta 0).
  return mats
    .filter((m) => !m.omitted && m.cost != null)
    .reduce((s, m) => {
      const buy = effectiveSpendRate(m);
      if (buy <= 0) return s; // zero-rate data can't claim a 100% saving
      return s + ((m.cost! - buy) * netUnits(m));
    }, 0);
}

/** Budget value taken OUT of the job by omissions, at the BOQ rate: whole
 *  omitted lines plus the omitted portion of partial ones. The forecast final
 *  cost starts from the pricing workbook's cost total, which still includes
 *  these lines, so it has to be reduced by this — otherwise omitting an item
 *  changes the Materials tab but never reaches the forecast. */
export function omittedMaterialValue(mats: MaterialWithCommitment[]): number {
  return mats.reduce((s, m) => {
    const cost = m.cost ?? 0;
    const units = m.total_units ?? 0;
    if (m.omitted) return s + units * cost;
    return s + Math.min(Math.max(0, m.omitted_qty ?? 0), units) * cost;
  }, 0);
}

export function computeForecast(input: {
  commercials: ProjectCommercial[];
  variations: Variation[];
  contractItems: ContractItem[];
  afps: ApplicationForPayment[];
  mats: MaterialWithCommitment[];
  contingency: number;
  summary: Summary;
}): Forecast {
  const { commercials, variations, contractItems, afps, mats, contingency, summary } = input;
  const total = commercials.find((r) => r.is_total === 1);
  const ct = contractTotals(commercials);
  const contractValue = ct?.value ?? (total?.value ?? 0);
  const contractCost = ct?.cost ?? (total?.cost ?? 0);

  const varSell = variations.reduce((s, v) => s + (v.sell_value ?? 0), 0);
  const varCost = variations.reduce((s, v) => s + (v.material_budget ?? 0) + (v.labour_budget ?? 0), 0);
  const varProfit = varSell - varCost;
  const varApplied = variations.reduce((s, v) => s + (v.revenue_applied ?? 0), 0);
  const varCertified = variations.reduce((s, v) => s + (v.revenue_certified ?? 0), 0);

  const materialSavings = quoteSavingsOf(mats);
  const labourSavings = contractItems.reduce((s, ci) => {
    if (ci.live_labour_rate == null || ci.labour_rate == null) return s;
    return s + ((ci.labour_rate - ci.live_labour_rate) * (ci.qty ?? 0));
  }, 0);

  const ffa = contractValue + varSell;
  const unexpectedSpend = summary.unpriced_spend + summary.material_overspend;
  const scopes = oneScope(mats);
  // contractCost is the pricing workbook's cost total — it still contains any
  // line since omitted, so take those out or the forecast never moves.
  const omittedValue = omittedMaterialValue(mats);
  const ffc = contractCost + varCost - materialSavings - labourSavings - omittedValue + contingency + unexpectedSpend;
  const forecastProfit = ffa - ffc;
  const forecastGpPct = ffa > 0 ? forecastProfit / ffa : null;

  const outgoing = afps.filter((a) => a.direction === "outgoing");
  const latestOf = (rows: ApplicationForPayment[]) =>
    rows.reduce<ApplicationForPayment | null>((best, a) => (best == null || a.app_number > best.app_number ? a : best), null);
  const appliedValue = latestOf(outgoing.filter((a) => a.status !== "draft"))?.cumulative_value ?? 0;
  const certifiedValue = latestOf(outgoing.filter((a) => a.status === "certified" || a.status === "paid"))?.cumulative_value ?? 0;

  return {
    hasContract: !!total,
    ffa, ffc, forecastProfit, forecastGpPct, contingency,
    materialSavings, labourSavings, varProfit, unexpectedSpend, omittedValue,
    unpricedSpend: summary.unpriced_spend, materialOverspend: summary.material_overspend,
    stillToOrder: toOrderValueOf(scopes), projectedOverspend: projectedOverspendOf(scopes),
    appliedValue, certifiedValue, varApplied, varCertified,
  };
}

/** Sum two forecasts (used to combine per-block forecasts on the group page). */
export function addForecasts(a: Forecast, b: Forecast): Forecast {
  const ffa = a.ffa + b.ffa, ffc = a.ffc + b.ffc;
  const forecastProfit = ffa - ffc;
  return {
    hasContract: a.hasContract || b.hasContract,
    ffa, ffc, forecastProfit, forecastGpPct: ffa > 0 ? forecastProfit / ffa : null,
    contingency: a.contingency + b.contingency,
    materialSavings: a.materialSavings + b.materialSavings,
    labourSavings: a.labourSavings + b.labourSavings,
    varProfit: a.varProfit + b.varProfit,
    unexpectedSpend: a.unexpectedSpend + b.unexpectedSpend,
    omittedValue: a.omittedValue + b.omittedValue,
    unpricedSpend: a.unpricedSpend + b.unpricedSpend,
    materialOverspend: a.materialOverspend + b.materialOverspend,
    stillToOrder: a.stillToOrder + b.stillToOrder,
    projectedOverspend: a.projectedOverspend + b.projectedOverspend,
    appliedValue: a.appliedValue + b.appliedValue,
    certifiedValue: a.certifiedValue + b.certifiedValue,
    varApplied: a.varApplied + b.varApplied,
    varCertified: a.varCertified + b.varCertified,
  };
}

export const sumForecasts = (fs: Forecast[]): Forecast =>
  fs.reduce(addForecasts, {
    hasContract: false, ffa: 0, ffc: 0, forecastProfit: 0, forecastGpPct: null, contingency: 0,
    materialSavings: 0, labourSavings: 0, varProfit: 0, unexpectedSpend: 0, omittedValue: 0,
    unpricedSpend: 0, materialOverspend: 0, stillToOrder: 0, projectedOverspend: 0,
    appliedValue: 0, certifiedValue: 0, varApplied: 0, varCertified: 0,
  });

/** Re-base a combined forecast's material overspend on the materials merged
 *  across every block in scope, and pull forecast cost / profit / GP% along with
 *  it. Summing per-block forecasts adds up each block's own over-runs, so a
 *  material the site as a whole has finished buying inside budget still landed
 *  in Unexpected spend because one block had over-ordered it — the figure
 *  disagreed with the combined Materials table, which nets the blocks into one
 *  line. Every other lever stays a straight sum; only overspend (and its
 *  projection) needs the whole scope in view to be measured at all.
 *
 *  The per-block figures underneath (each block's own page, and the By block
 *  table) keep their own over-runs — a block IS its own contract — so the
 *  combined cost can now sit below the sum of the blocks' costs by exactly the
 *  over-runs its siblings cover. */
export function withCombinedOverspend(fc: Forecast, scopes: MaterialScope[]): Forecast {
  const materialOverspend = materialOverspendOf(scopes);
  const unexpectedSpend = fc.unpricedSpend + materialOverspend;
  const ffc = fc.ffc - fc.unexpectedSpend + unexpectedSpend;
  const forecastProfit = fc.ffa - ffc;
  return {
    ...fc, materialOverspend, unexpectedSpend, ffc, forecastProfit,
    projectedOverspend: projectedOverspendOf(scopes),
    forecastGpPct: fc.ffa > 0 ? forecastProfit / fc.ffa : null,
  };
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
const categoryFmt = (v: unknown) => (v === "prelims" ? "Prelim" : "Material");
/** How much of a set of off-BOQ lines sits on PRELIM orders. Prelims are
 *  budgeted separately (Commercials → Prelims), so this slice of the figure is
 *  not unbudgeted material spend in the way the rest of it is. */
const prelimTotal = (lines: UnpricedLine[]) =>
  lines.reduce((s, l) => s + (l.category === "prelims" ? (l.line_total ?? 0) : 0), 0);
const prelimSuffix = (lines: UnpricedLine[]) => {
  const p = prelimTotal(lines);
  return p > 0.005
    ? ` Of this, ${fmtMoney(p)} is on prelim orders (welfare, plant, scaffold), which carry their own Preliminaries budget.`
    : "";
};
const unpricedNote = (lines: UnpricedLine[]) =>
  `Purchase-order lines raised outside the priced BOQ (call-offs excluded).${prelimSuffix(lines)}`;

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
    .filter((m) => !m.omitted && m.cost != null)
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

/** Labour savings per line = (BOQ rate − live rate) × qty over rated items. */
export function labourSavingsDrill(items: ContractItem[]): DrillBody {
  const rows = items
    .filter((ci) => ci.live_labour_rate != null && ci.labour_rate != null)
    .map((ci) => ({ description: ci.description, boq: ci.labour_rate, live: ci.live_labour_rate, qty: ci.qty, saving: (ci.labour_rate! - ci.live_labour_rate!) * (ci.qty ?? 0) }))
    .filter((r) => Math.abs(r.saving) > 0.005)
    .sort((a, b) => b.saving - a.saving);
  return {
    columns: [
      { key: "description", label: "Labour item" },
      { key: "boq", label: "BOQ rate", align: "right", fmt: money },
      { key: "live", label: "Live rate", align: "right", fmt: money },
      { key: "qty", label: "Qty", align: "right", fmt: qtyFmt },
      { key: "saving", label: "Saving", align: "right", fmt: money },
    ],
    rows, total: money(sum(rows, "saving")),
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
    .map((l) => ({ po: l.po_number, supplier: l.supplier || "—", item: l.item, qty: l.qty, line_total: l.line_total, status: l.status, category: l.category ?? "materials", __po_id: l.po_id, __line_id: l.line_id, __suggest_id: l.suggested_material_id, __suggest_item: l.suggested_material_item }))
    .sort((a, b) => b.line_total - a.line_total);
  return {
    columns: [
      { key: "po", label: "PO", align: "left" },
      { key: "supplier", label: "Supplier", align: "center" },
      { key: "item", label: "Item" },
      { key: "category", label: "Cost", align: "center", fmt: categoryFmt },
      { key: "qty", label: "Qty", align: "right", fmt: qtyFmt },
      { key: "line_total", label: "Value", align: "right", fmt: money },
    ],
    rows, total: money(sum(rows, "line_total")),
    note: unpricedNote(lines),
  };
}

/** Off-BOQ half of Unexpected spend. Rows carry hidden PO/line refs
 *  (__po_id/__line_id) so the drill drawer can offer "assign to a budget item"
 *  in place. */
const offBoqSpendRows = (lines: UnpricedLine[]) => lines.map((l) => ({
  kind: l.category === "prelims" ? "Off-BOQ · prelim" : "Off-BOQ",
  detail: `${l.po_number} · ${l.item}`, amount: l.line_total,
  __po_id: l.po_id, __line_id: l.line_id,
  __suggest_id: l.suggested_material_id, __suggest_item: l.suggested_material_item,
}));

/** Which blocks a merged material actually sits on — "All blocks" when it spans
 *  the lot, so a wide site doesn't print the whole code list on every row. */
const scopeLabel = (a: AccumulatedMaterial, scopes: MaterialScope[]) => {
  const on = a.parts.map((p) => p.scope).filter(Boolean).sort();
  return on.length === scopes.length && scopes.length > 1 ? "All blocks" : on.join(" ");
};

/** Over-budget half, one row per ACCUMULATED material (see materialOverspendOf):
 *  a material appears only where the money already spent on it is above budget
 *  once its parts are netted — and then at that net amount, not the worst row's.
 *  Over the scope's whole material list these rows sum to exactly the overspend
 *  in the headline figure. `still` says how much of the material is yet to be
 *  bought, because an over-run standing at £0 today because a block hasn't
 *  started ordering is a different position from one that is finished. */
const overBudgetRows = (scopes: MaterialScope[]) => accumulateMaterials(scopes)
  .filter((a) => a.overspend > 0.005)
  .map((a) => ({
    kind: "Over budget", detail: a.item, amount: a.overspend,
    still: a.toOrder, projected: a.projectedOverspend, __scope: scopeLabel(a, scopes),
  }));

const UNEXPECTED_COLUMNS: DrillColumn[] = [
  { key: "kind", label: "Type", align: "left" },
  { key: "detail", label: "Detail" },
  { key: "still", label: "Still to order", align: "right", fmt: (v) => (v == null ? "—" : money(v)) },
  { key: "amount", label: "Amount", align: "right", fmt: money },
];
const unexpectedNote = (lines: UnpricedLine[]) =>
  `Off-BOQ purchases plus committed spend above a material's budget — both pull through to forecast cost. A material is listed only where the parts of it that have FINISHED ordering are over budget together; budget a block hasn't ordered against yet can't cover an over-run, so it doesn't net here. See Still to order for where those land.${prelimSuffix(lines)}`;

/** Unexpected spend = off-BOQ unpriced lines + over-budget materials. */
export function unexpectedSpendDrill(lines: UnpricedLine[], mats: MaterialWithCommitment[]): DrillBody {
  const over = overBudgetRows(oneScope(mats)).map(({ __scope, projected, ...r }) => r); // eslint-disable-line @typescript-eslint/no-unused-vars
  const rows = [...offBoqSpendRows(lines), ...over].sort((a, b) => b.amount - a.amount);
  return {
    columns: UNEXPECTED_COLUMNS,
    rows, total: money(sum(rows, "amount")),
    note: unexpectedNote(lines),
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
  const over = overBudgetRows(scopes).map(({ __scope, projected, ...r }) => ({ __block: __scope, ...r })); // eslint-disable-line @typescript-eslint/no-unused-vars
  const rows = [...offBoq, ...over].sort((a, b) => b.amount - a.amount);
  return {
    columns: [{ key: "__block", label: "Block", align: "left" }, ...UNEXPECTED_COLUMNS],
    rows, total: total ?? money(sum(rows, "amount")),
    note: unexpectedNote(blocks.flatMap((b) => b.lines)),
  };
}

/** Still to order: every material with BOQ quantity nothing has been ordered
 *  against yet, and where each lands if the rest is bought at today's rate.
 *  This is the other side of the Unexpected-spend rule — an over-run a block
 *  hasn't finished buying into isn't in the cost yet, and this is where it can
 *  be seen coming. The money is already inside the contract cost: it is what's
 *  LEFT of the material budget, not spend on top of it. */
export function stillToOrderDrill(scopes: MaterialScope[], total?: string): DrillBody {
  const multi = scopes.filter((g) => g.scope).length > 1;
  const rows = accumulateMaterials(scopes)
    .filter((a) => a.toOrder > 0.005)
    .map((a) => ({
      __block: scopeLabel(a, scopes),
      detail: a.item,
      budget: a.budget, committed: a.committed, still: a.toOrder,
      projected: a.projected, variance: a.projected - a.budget,
    }))
    .sort((a, b) => b.still - a.still);
  return {
    columns: [
      ...(multi ? [{ key: "__block", label: "Block", align: "left" } as DrillColumn] : []),
      { key: "detail", label: "Material" },
      { key: "budget", label: "Budget", align: "right", fmt: money },
      { key: "committed", label: "Committed", align: "right", fmt: money },
      { key: "still", label: "Still to order", align: "right", fmt: money },
      { key: "projected", label: "Projected", align: "right", fmt: money },
      { key: "variance", label: "vs budget", align: "right", fmt: money },
    ],
    rows, total: total ?? money(sum(rows, "still")), totalLabel: "Still to order",
    note: "Budget with no order against it yet, valued at the rate we're buying at today. Projected = committed + still to order, so \"vs budget\" is where the material lands if the rest is bought at that rate — a positive figure is an over-run already in the pipeline. None of this is extra money: it is the unspent part of the material budget, already inside forecast cost.",
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
