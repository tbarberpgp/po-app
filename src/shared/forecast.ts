/**
 * The commercial forecast — ONE implementation, called by every screen that
 * shows a forecast figure.
 *
 * It used to live in the client lib alone, so the portfolio dashboard kept its
 * own copy of the same maths in SQL. The two drifted, quietly and only on some
 * projects: the dashboard booked a PO line coded to a budget line as unexpected
 * spend IN FULL (on 26001, £58,314.70 of it) while the project page folded it
 * into that line's committed spend and counted only the overspend; the
 * dashboard never subtracted omitted budget, and never saw substitution rates.
 * A project's own page and the portfolio table therefore reported different
 * forecast costs and different GP% for the same job.
 *
 * So the maths lives here, in shared code the worker and the browser both
 * import, and the dashboard now assembles the same inputs and calls
 * computeForecast (see worker/project-forecast.ts). Anything that changes a
 * forecast figure belongs in this file — a second implementation is the bug.
 *
 * Money formatting stays out: this module must stay importable by the worker,
 * so it depends on nothing but shared types and the budget/labour/prelims
 * rules. The drill-down builders, which format, stay in client/lib/commercials.
 */
import type {
  MaterialWithCommitment, ProjectCommercial, Variation, ContractItem, ApplicationForPayment,
} from "./types";
import { netBudgetUnits } from "./budget";
import { labourOutturn, type LabourPositionRow } from "./labour-cost";
import { prelimsOutturn } from "./prelims-cost";

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
  /** The contract the forecast is measured against — the cost sheet's Total
   *  row. Carried here so contract GP% comes off the same numbers as forecast
   *  GP% and can't be derived a second, different way. */
  contractValue: number; contractCost: number;
  ffa: number; ffc: number; forecastProfit: number; forecastGpPct: number | null;
  contingency: number;
  materialSavings: number; labourSavings: number; varProfit: number; unexpectedSpend: number;
  /** What forecast cost carries on top of the labour BOQ: certified labour past
   *  its section's budget, labour claimed with no budget at all (expenses,
   *  daywork) and variation labour past the variations' budget. Never negative
   *  — see shared/labour-cost.ts. */
  labourOverrun: number;
  /** Labour certified to date against the labour budget, and that budget — the
   *  Labour subtab's Expended and Total labour. */
  labourCertified: number; labourBudget: number;
  /** What forecast cost carries on top of the prelims budget: the prelims pot's
   *  spend (orders, certified prelim labour, plant hire past its order) past
   *  that budget. Never negative — see shared/prelims-cost.ts. */
  prelimsOverrun: number;
  /** The pot's spend and budget — the Prelims tab's Committed and budget. */
  prelimsSpend: number; prelimsBudget: number;
  /** Budget removed from the forecast cost by omitted materials (whole lines +
   *  the omitted part of partial omissions), at the BOQ rate. */
  omittedValue: number;
  /** The two halves of unexpectedSpend — off-BOQ lines (the Materials tab's
   *  "Unpriced spend") and over-budget committed on BOQ items. */
  unpricedSpend: number; materialOverspend: number;
  appliedValue: number; certifiedValue: number; varApplied: number; varCertified: number;
};


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

/**
 * Fold money CODED to a budget line into its committed quantity.
 *
 * A PO line assigned to a budget line after the fact (material_id set, wording
 * of its own) is committed against that line, but its £ can't be matched by
 * name — so it comes back from the database as `assigned_committed_value` and
 * is converted here, at the line's BUY rate, into the quantity that money
 * really buys. Doing it at the buy rate is what makes qty × rate reproduce the
 * PO's £ exactly; dividing by the BOQ cost understated it.
 *
 * Both readers fold it the same way: the Materials tab through the materials
 * route, and the forecast through worker/project-forecast. The portfolio
 * dashboard used to skip the fold entirely and book the whole coded line as
 * unexpected spend instead — £58,314.70 of it on 26001 — which is how its
 * forecast cost came adrift from the project's own page.
 */
export function withCodedCommitted<T extends MaterialWithCommitment & { assigned_committed_value?: number | null }>(row: T): T {
  const coded = Number(row.assigned_committed_value) || 0;
  const rate = effectiveSpendRate(row);
  if (!(coded > 0) || !(rate > 0)) return row;
  const codedQty = Math.round((coded / rate) * 1000) / 1000;
  return { ...row, committed_qty: (row.committed_qty ?? 0) + codedQty };
}

/** Budgeted quantity net of a partial omission. Whole-line omissions are
 *  filtered out separately (m.omitted); this handles the "we only need 150 of
 *  the 400" case, so every budget figure prices the reduced quantity. */
export function netUnits(m: MaterialWithCommitment): number {
  return netBudgetUnits(m);
}

/** Wording reduced to its words alone, so spacing, punctuation and case can't
 *  split one material into two. Same normalisation the combined Materials
 *  table merges rows on. */
const normMaterialName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** One material as the job actually holds it: every BOQ row describing it added
 *  together — several lines in one bill, and, when the caller passes more than
 *  one block's rows, the same material across blocks. */
export type AccumulatedMaterial = {
  /** Merge key (master product id, else normalised wording) — unique by construction. */
  key: string;
  item: string;
  budget: number;
  committed: number;
  /** The scopes this material sits on — block codes on the combined view — so a
   *  figure taken from here can say which blocks it came from. */
  scopes: string[];
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
    const cur = by.get(key) ?? { key, item: m.sub_item || m.item, budget: 0, committed: 0, scopes: [], mats: [] };
    // effectiveSpendRate (live quote first), NOT the sub-only blend: committed
    // £ must re-value committed_qty at the same rate the server folds coded £
    // in at, or a coded PO's money changes size between views.
    cur.budget += netUnits(m) * (m.cost ?? 0);
    cur.committed += (m.committed_qty ?? 0) * effectiveSpendRate(m);
    if (g.scope && !cur.scopes.includes(g.scope)) cur.scopes.push(g.scope);
    cur.mats.push(m);
    by.set(key, cur);
  }
  return [...by.values()];
}

/** A bill line that is a prelims budget line — the test the server applies
 *  (worker/prelims-position.ts `prelimRow`) and the PO form offers headings by.
 *  Prelim rows are measured by the prelims pot against the prelims budget, so
 *  the material levers — quote savings, overspend — leave them out: counting
 *  them in both would book the same prelims money twice. */
export const isPrelimMaterial = (m: Pick<MaterialWithCommitment, "element_name" | "type">): boolean =>
  /prelim/i.test(m.element_name ?? "") || /prelim/i.test(m.type ?? "");
export const withoutPrelims = (scopes: MaterialScope[]): MaterialScope[] =>
  scopes.map((g) => ({ ...g, mats: g.mats.filter((m) => !isPrelimMaterial(m)) }));

/** Committed spend above budget — measured on the ACCUMULATED material, never on
 *  a single row. A material counts as overspent only once everything the job
 *  holds for it is added up: every line in the bill, and every block in the
 *  scope being looked at. Over-ordering an item on one block that a sibling
 *  block is under budget on has not cost the site anything, and flagging it as
 *  unexpected money contradicted the Materials tab's own variance column, which
 *  has always shown the merged line. Scope is the caller's: a block's own page
 *  passes its rows and still sees its own over-run. */
export function materialOverspendOf(scopes: MaterialScope[]): number {
  return accumulateMaterials(withoutPrelims(scopes)).reduce((s, a) => s + Math.max(0, a.committed - a.budget), 0);
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
    .filter((m) => !m.omitted && m.cost != null && !isPrelimMaterial(m))
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

/** The variations' labour budget forecast cost already carries. Absorbed
 *  variations come back from the API with a £0 labour budget, so they count as
 *  nothing here too. */
export const variationLabourBudget = (variations: Variation[]): number =>
  variations.reduce((s, v) => s + (v.labour_budget ?? 0), 0);

/** The Prelims tab's pot as `/prelims` returns it — the fields the forecast and
 *  its drill read. */
export type PrelimsSummary = {
  budget: number;
  po_committed: number;
  labour_committed: number;
  plant_beyond_orders?: number;
  headings?: Array<{ name: string; budget: number; committed: number }>;
};

/** The pot's outturn, worked out by the one shared rule (shared/prelims-cost). */
export const prelimsOf = (p: PrelimsSummary | null | undefined) =>
  prelimsOutturn(p ? { budget: p.budget, orders: p.po_committed, labour: p.labour_committed, plant: p.plant_beyond_orders ?? 0 } : null);

/** Certified prelim-tagged labour claims — a subcontract PM's time and the like,
 *  drawn on the Preliminaries allowance rather than the labour BOQ, so it isn't
 *  labour expended. It is still money the job owes, so cost-to-date counts it.
 *  The rule PRELIM_LABOUR_BY_PROJECT applies on the worker for the dashboard. */
export function prelimLabourCertified(afps: ApplicationForPayment[]): number {
  return afps
    .filter((a) => a.direction === "incoming_labour" && (a.status === "certified" || a.status === "paid")
      && a.prelim_heading != null && a.claimed_amount != null)
    .reduce((s, a) => s + (a.cumulative_value ?? a.claimed_amount ?? 0), 0);
}

export function computeForecast(input: {
  commercials: ProjectCommercial[];
  variations: Variation[];
  contractItems: ContractItem[];
  afps: ApplicationForPayment[];
  mats: MaterialWithCommitment[];
  contingency: number;
  summary: Summary;
  /** The Labour subtab's per-section position (`/labour-by-cost-code`). Left
   *  out, certified labour doesn't reach the forecast — which is how it was. */
  labour?: LabourPositionRow[];
  /** The Prelims tab's pot (`/prelims`). Left out, prelims add nothing. */
  prelims?: PrelimsSummary | null;
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
  // contractCost is the pricing workbook's cost total — it still contains any
  // line since omitted, so take those out or the forecast never moves.
  const omittedValue = omittedMaterialValue(mats);
  // Certified labour past its budget — or with no budget — is cost the workbook
  // total doesn't hold. Without it the forecast kept every labour overrun off
  // the books and GP% kept margin the job was no longer making.
  const labour = labourOutturn(input.labour ?? [], variationLabourBudget(variations));
  // Prelims past the prelims budget. Prelim orders no longer sit in unexpected
  // spend (the unpriced list leaves them out), so this is the only place they
  // reach forecast cost — and only what the pot's spend exceeds its budget by.
  const prelims = prelimsOf(input.prelims);
  const ffc = contractCost + varCost - materialSavings - labourSavings - omittedValue + contingency + unexpectedSpend
    + labour.overrun + prelims.overrun;
  const forecastProfit = ffa - ffc;
  const forecastGpPct = ffa > 0 ? forecastProfit / ffa : null;

  const outgoing = afps.filter((a) => a.direction === "outgoing");
  const latestOf = (rows: ApplicationForPayment[]) =>
    rows.reduce<ApplicationForPayment | null>((best, a) => (best == null || a.app_number > best.app_number ? a : best), null);
  const appliedValue = latestOf(outgoing.filter((a) => a.status !== "draft"))?.cumulative_value ?? 0;
  const certifiedValue = latestOf(outgoing.filter((a) => a.status === "certified" || a.status === "paid"))?.cumulative_value ?? 0;

  return {
    hasContract: !!total,
    contractValue, contractCost,
    ffa, ffc, forecastProfit, forecastGpPct, contingency,
    materialSavings, labourSavings, varProfit, unexpectedSpend, omittedValue,
    labourOverrun: labour.overrun, labourCertified: labour.certified, labourBudget: labour.budget,
    prelimsOverrun: prelims.overrun, prelimsSpend: prelims.spend, prelimsBudget: prelims.budget,
    unpricedSpend: summary.unpriced_spend, materialOverspend: summary.material_overspend,
    appliedValue, certifiedValue, varApplied, varCertified,
  };
}

/** Every lever added up — what the forecast says the job will make or lose
 *  against the contract it was priced at. Identical by construction to
 *  `forecastProfit − contract gross profit`: the same terms, rearranged (see the
 *  test). Keep the two in step — anything that joins forecast cost belongs here
 *  too, or the tile and the Forecast outturn row start telling different
 *  stories, which is what contingency did until 2026-09-03. */
export const totalChange = (f: Forecast): number =>
  f.materialSavings + f.labourSavings - f.labourOverrun - f.prelimsOverrun + f.varProfit + f.omittedValue - f.unexpectedSpend - f.contingency;

/** The Profit/Loss from Labour lever: live-rate savings less what certified
 *  labour has cost past its budget. One number, so the tile, its drill and
 *  Total Change can't disagree about labour. */
export const labourProfit = (f: Forecast): number => f.labourSavings - f.labourOverrun;

/** Sum two forecasts (used to combine per-block forecasts on the group page). */
export function addForecasts(a: Forecast, b: Forecast): Forecast {
  const ffa = a.ffa + b.ffa, ffc = a.ffc + b.ffc;
  const forecastProfit = ffa - ffc;
  return {
    hasContract: a.hasContract || b.hasContract,
    contractValue: a.contractValue + b.contractValue, contractCost: a.contractCost + b.contractCost,
    ffa, ffc, forecastProfit, forecastGpPct: ffa > 0 ? forecastProfit / ffa : null,
    contingency: a.contingency + b.contingency,
    materialSavings: a.materialSavings + b.materialSavings,
    labourSavings: a.labourSavings + b.labourSavings,
    labourOverrun: a.labourOverrun + b.labourOverrun,
    labourCertified: a.labourCertified + b.labourCertified,
    labourBudget: a.labourBudget + b.labourBudget,
    prelimsOverrun: a.prelimsOverrun + b.prelimsOverrun,
    prelimsSpend: a.prelimsSpend + b.prelimsSpend,
    prelimsBudget: a.prelimsBudget + b.prelimsBudget,
    varProfit: a.varProfit + b.varProfit,
    unexpectedSpend: a.unexpectedSpend + b.unexpectedSpend,
    omittedValue: a.omittedValue + b.omittedValue,
    unpricedSpend: a.unpricedSpend + b.unpricedSpend,
    materialOverspend: a.materialOverspend + b.materialOverspend,
    appliedValue: a.appliedValue + b.appliedValue,
    certifiedValue: a.certifiedValue + b.certifiedValue,
    varApplied: a.varApplied + b.varApplied,
    varCertified: a.varCertified + b.varCertified,
  };
}

export const sumForecasts = (fs: Forecast[]): Forecast =>
  fs.reduce(addForecasts, {
    hasContract: false, contractValue: 0, contractCost: 0, ffa: 0, ffc: 0, forecastProfit: 0, forecastGpPct: null, contingency: 0,
    materialSavings: 0, labourSavings: 0, varProfit: 0, unexpectedSpend: 0, omittedValue: 0,
    labourOverrun: 0, labourCertified: 0, labourBudget: 0,
    prelimsOverrun: 0, prelimsSpend: 0, prelimsBudget: 0,
    unpricedSpend: 0, materialOverspend: 0,
    appliedValue: 0, certifiedValue: 0, varApplied: 0, varCertified: 0,
  });

/** Re-base a combined forecast's material overspend on the materials merged
 *  across every block in scope, and pull forecast cost / profit / GP% along with
 *  it. Summing per-block forecasts adds up each block's own over-runs, so a
 *  material the site as a whole is inside budget for still landed in Unexpected
 *  spend because one block had over-ordered it — the figure disagreed with the
 *  combined Materials table, which nets the blocks into one line. Every other
 *  lever stays a straight sum; only overspend needs the whole scope in view to
 *  be measured at all.
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
    forecastGpPct: fc.ffa > 0 ? forecastProfit / fc.ffa : null,
  };
}
