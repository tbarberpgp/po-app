// Single source of truth for the commercial forecast + the "what made up this
// number" drill-downs. Both the per-project Commercials/Materials tabs
// (ProjectDetail) and the combined group page (GroupPage) import from here, so
// the rolled-up figures can't drift from the per-contract ones — the exact bug
// class that produced a phantom group-page loss. The forecast maths is moved
// verbatim from ProjectDetail's old inline `summarise`/`forecast`.

import type {
  MaterialWithCommitment, ProjectCommercial, Variation, ContractItem, ApplicationForPayment,
} from "../../shared/types";
import { fmtMoney } from "./api";
import type { DrillColumn } from "../components/DrillPanel";

export type Summary = {
  priced_total: number;
  committed_total: number;
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
  appliedValue: number; certifiedValue: number; varApplied: number; varCertified: number;
};

/** One off-BOQ ("unpriced") PO line — returned by /api/projects/:id/summary so
 *  the Unpriced spend / Unexpected spend drill can list the actual lines. */
export type UnpricedLine = {
  po_id: string; line_id: number; po_number: string; supplier: string | null;
  item: string; qty: number | null; unit: string | null; line_total: number; status: string;
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

/** Budgeted quantity net of a partial omission. Whole-line omissions are
 *  filtered out separately (m.omitted); this handles the "we only need 150 of
 *  the 400" case, so every budget figure prices the reduced quantity. */
export function netUnits(m: MaterialWithCommitment): number {
  return Math.max(0, (m.total_units ?? 0) - (m.omitted_qty ?? 0));
}

export function summariseMaterials(mats: MaterialWithCommitment[], unpricedSpend: number): Summary {
  // Omitted materials are out of the job — they contribute nothing to budget,
  // committed or overspend.
  mats = mats.filter((m) => !m.omitted);
  let priced = 0, committed = 0, overspend = 0;
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
    overspend += Math.max(0, matCommitted - matPriced);
    const sup = matSupplier(m) || "—";
    const cur = bySup.get(sup) ?? { items: 0, priced: 0, committed: 0 };
    cur.items += 1;
    cur.priced += matPriced;
    cur.committed += matCommitted;
    bySup.set(sup, cur);
  }
  return {
    priced_total: priced,
    committed_total: committed,
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
    unpricedSpend: 0, materialOverspend: 0,
    appliedValue: 0, certifiedValue: 0, varApplied: 0, varCertified: 0,
  });

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
export function committedDrill(mats: MaterialWithCommitment[]): DrillBody {
  const rows = mats
    .filter((m) => (m.committed_qty ?? 0) > 0)
    .map((m) => {
      const rate = materialSpendCost(m);
      return { item: m.sub_item || m.item, supplier: matSupplier(m) || "—", qty: m.committed_qty, rate, committed: (m.committed_qty ?? 0) * rate };
    })
    .sort((a, b) => b.committed - a.committed);
  return {
    columns: [
      { key: "item", label: "Material" },
      { key: "supplier", label: "Supplier", align: "center" },
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
    .map((l) => ({ po: l.po_number, supplier: l.supplier || "—", item: l.item, qty: l.qty, line_total: l.line_total, status: l.status, __po_id: l.po_id, __line_id: l.line_id }))
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
    note: "Purchase-order lines raised outside the priced BOQ (call-offs excluded).",
  };
}

/** Unexpected spend = off-BOQ unpriced lines + over-budget material lines.
 *  Off-BOQ rows carry hidden PO/line refs (__po_id/__line_id) so the drill
 *  drawer can offer "assign to a budget item" in place. */
export function unexpectedSpendDrill(lines: UnpricedLine[], mats: MaterialWithCommitment[]): DrillBody {
  const offBoq = lines.map((l) => ({
    kind: "Off-BOQ", detail: `${l.po_number} · ${l.item}`, amount: l.line_total,
    __po_id: l.po_id, __line_id: l.line_id,
  }));
  const over = mats
    .filter((m) => !m.omitted)
    .map((m) => {
      const budget = netUnits(m) * (m.cost ?? 0);
      const committed = (m.committed_qty ?? 0) * materialSpendCost(m);
      return { kind: "Over budget", detail: m.sub_item || m.item, amount: Math.max(0, committed - budget) };
    })
    .filter((r) => r.amount > 0.005);
  const rows = [...offBoq, ...over].sort((a, b) => b.amount - a.amount);
  return {
    columns: [
      { key: "kind", label: "Type", align: "left" },
      { key: "detail", label: "Detail" },
      { key: "amount", label: "Amount", align: "right", fmt: money },
    ],
    rows, total: money(sum(rows, "amount")),
    note: "Off-BOQ purchases plus committed spend above a material line's budget — both pull through to forecast cost.",
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
