/**
 * Every project's forecast, worked out by the shared forecast maths.
 *
 * The portfolio dashboard used to carry its own copy of the forecast in SQL,
 * "mirroring" the project Overview. It drifted on the materials side and
 * reported a different forecast cost and GP% for the same job:
 *
 *   - a PO line coded to a budget line counted IN FULL as unexpected spend,
 *     where the project page folds it into that line's committed spend and
 *     counts only what goes over budget (26001: £58,314.70, 26003: £13,373.47);
 *   - omitted budget was never taken out (25008: £2,167);
 *   - substitutions were invisible, so a subbed line's savings and over-runs
 *     were both measured at the wrong rate.
 *
 * So this module assembles the SAME inputs the project page sends and calls the
 * SAME computeForecast. The maths exists once (shared/forecast.ts); this file
 * only fetches. Every figure here is per project and keyed by project id.
 */
import type { ApplicationForPayment, ContractItem, MaterialWithCommitment, ProjectCommercial, Variation } from "../shared/types";
import {
  computeForecast, summariseMaterials, withCodedCommitted,
  type Forecast, type PrelimsSummary,
} from "../shared/forecast";
import { LABOUR_POSITION } from "./labour-expended";
import { PLANT_ON_ORDER, PRELIMS_POSITION, PRELIM_LINE } from "./prelims-position";
import { plantBeyondOrders, type PlantOnOrder } from "../shared/prelims-cost";
import type { LabourPositionRow } from "../shared/labour-cost";

/** Order statuses that commit money — as every committed figure in the app. */
const COMMITTED = "('approved', 'issued', 'pending_approval')";

/**
 * Every active-snapshot material the forecast reads, for all projects at once.
 *
 * Deliberately WITHOUT the committed-spend subqueries the materials route runs
 * per row: correlated per material they read 117,793 rows of the live database
 * for one dashboard. The same figures come from the three grouped scans below
 * and are joined on in JS, which is the same arithmetic over a fraction of the
 * reads.
 */
const FORECAST_MATERIALS = `
  SELECT sn.project_id AS pid,
         m.id, m.item, m.type, m.manufacturer, m.product_id, m.element_code,
         m.cost, m.total_units, m.material_total_cost,
         e.name AS element_name,
         sub.id AS sub_id, sub.replacement_item AS sub_item, sub.replacement_cost AS sub_cost,
         sub.sub_units AS sub_units, sub.replacement_supplier AS sub_supplier,
         sub.replacement_manufacturer AS sub_manufacturer,
         CASE WHEN mo.item_key IS NOT NULL AND mo.omit_qty IS NULL THEN 1 ELSE 0 END AS omitted,
         mo.omit_qty AS omitted_qty
    FROM materials m
    JOIN material_snapshots sn ON sn.id = m.snapshot_id AND sn.is_active = 1
    LEFT JOIN elements e ON e.code = m.element_code
    LEFT JOIN material_substitutions sub ON sub.material_id = m.id AND sub.active = 1
    LEFT JOIN material_omissions mo ON mo.project_id = sn.project_id AND mo.item_key = lower(m.item)`;

/**
 * Committed quantity per (project, ordered wording). A material's committed is
 * the entry under its own wording plus, when it has been substituted, the entry
 * under the replacement's — orders for a replaced material are raised under the
 * replacement name. Call-offs are excluded: a framework already reserves the
 * value, so counting its draws too would double-spend the allowance.
 */
const COMMITTED_BY_ITEM = `
  SELECT po.project_id AS pid, lower(pl.item) AS item, COALESCE(SUM(pl.qty), 0) AS qty
    FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
   WHERE po.status IN ${COMMITTED} AND pl.is_unpriced = 0
     AND COALESCE(po.order_type, 'standard') != 'call_off'
   GROUP BY po.project_id, lower(pl.item)`;

/**
 * Money coded to a budget line under different wording, per (project, the coded
 * line's budget wording, the order line's own wording). Keeping the order's own
 * wording in the key is what lets the caller drop the rows that the name match
 * above already counted — the exclusion the materials route writes inline.
 */
const CODED_BY_ITEM = `
  SELECT po.project_id AS pid, lower(am.item) AS item, lower(pl.item) AS po_item,
         COALESCE(SUM(pl.line_total), 0) AS value
    FROM po_lines pl
    JOIN purchase_orders po ON po.id = pl.po_id
    JOIN materials am ON am.id = pl.material_id
   WHERE po.status IN ${COMMITTED}
     AND COALESCE(po.order_type, 'standard') != 'call_off'
   GROUP BY po.project_id, lower(am.item), lower(pl.item)`;

/**
 * Applied quote prices, newest first. All 95 of them come back and the caller
 * picks each line's price, because the rule that drops a rate in the wrong
 * basis (more than 5× the BOQ cost) needs that line's own cost — and picking
 * the newest in SQL and testing the bound afterwards would silently leave a
 * line unpriced where the materials route falls through to the next rate that
 * does pass. Matched by wording, not material id, so re-uploading the pricing
 * workbook doesn't orphan an applied quote.
 */
const LIVE_PRICES = `
  SELECT mlp.project_id AS pid, lower(om.item) AS item, mlp.unit_price
    FROM material_live_prices mlp
    JOIN materials om ON om.id = mlp.material_id
   WHERE mlp.status IN ('applied', 'approved')
   ORDER BY mlp.applied_at DESC`;

/** Off-BOQ spend per project — the project page's "unpriced spend". Coded lines
 *  are excluded (they belong to the line they were coded to) and so are prelim
 *  lines (the prelims pot measures those). Same rule as projects.ts's list. */
const UNPRICED_SPEND = `
  SELECT po.project_id AS pid, COALESCE(SUM(pl.line_total), 0) AS v
    FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
   WHERE po.status IN ${COMMITTED} AND pl.is_unpriced = 1 AND pl.material_id IS NULL
     AND COALESCE(po.order_type, 'standard') != 'call_off'
     AND NOT ${PRELIM_LINE}
   GROUP BY po.project_id`;

/** The labour BOQ with each line's applied live rate — what Savings from Labour
 *  is measured on. The 5× bound drops basis-mismatch rates, as materials.ts. */
const CONTRACT_ITEMS = `
  SELECT sn.project_id AS pid, ci.id, ci.description, ci.qty, ci.labour_rate,
         (SELECT llr.live_rate FROM labour_live_rates llr
           WHERE (llr.contract_item_id = ci.id
                  OR (llr.description IS NOT NULL AND lower(llr.description) = lower(ci.description)))
             AND llr.project_id = sn.project_id AND llr.status IN ('applied', 'approved')
             AND llr.live_rate <= COALESCE(ci.labour_rate, llr.live_rate) * 5
           ORDER BY llr.applied_at DESC LIMIT 1) AS live_labour_rate
    FROM contract_items ci
    JOIN material_snapshots sn ON sn.id = ci.snapshot_id AND sn.is_active = 1
   WHERE ci.labour_rate IS NOT NULL`;

/** Variations with the budgets the forecast charges against them. Absorbed
 *  labour is done inside the contract allowance, so it costs £0 — the rule the
 *  variations route applies. */
const VARIATIONS = `
  SELECT v.id, v.project_id AS pid, COALESCE(v.sell_value, 0) AS sell_value,
         COALESCE((SELECT SUM(vm.value) FROM variation_materials vm WHERE vm.variation_id = v.id), 0) AS material_budget,
         CASE WHEN COALESCE(v.labour_absorbed, 0) = 1 THEN 0
              ELSE COALESCE((SELECT SUM(vl.value) FROM variation_labour vl WHERE vl.variation_id = v.id), 0) END AS labour_budget
    FROM variations v`;

/** The applications the forecast reads: applied is the latest non-draft
 *  outgoing one, certified the latest certified/paid. */
const AFPS = `
  SELECT a.project_id AS pid, a.direction, a.status, a.app_number, a.cumulative_value,
         a.prelim_heading, a.claimed_amount
    FROM applications_for_payment a`;

const lc = (v: unknown) => String(v ?? "").toLowerCase();
const spendKey = (pid: string, item: unknown) => `${pid}|${lc(item)}`;

/** The three grouped scans, keyed for lookup by (project, wording). */
export type SpendIndex = {
  /** Quantity ordered under each wording. */
  committed: Map<string, number>;
  /** Money coded to a budget line, with the wording the order itself used. */
  coded: Map<string, Array<{ poItem: string; value: number }>>;
  /** Applied quote prices, newest first. */
  livePrices: Map<string, number[]>;
};

export function indexSpend(
  committed: Array<{ pid: string; item: string; qty: number }>,
  coded: Array<{ pid: string; item: string; po_item: string; value: number }>,
  livePrices: Array<{ pid: string; item: string; unit_price: number }>,
): SpendIndex {
  const ix: SpendIndex = { committed: new Map(), coded: new Map(), livePrices: new Map() };
  for (const r of committed) ix.committed.set(spendKey(r.pid, r.item), r.qty);
  for (const r of coded) {
    const k = spendKey(r.pid, r.item);
    ix.coded.set(k, [...(ix.coded.get(k) ?? []), { poItem: lc(r.po_item), value: r.value }]);
  }
  for (const r of livePrices) {           // rows arrive newest first
    const k = spendKey(r.pid, r.item);
    ix.livePrices.set(k, [...(ix.livePrices.get(k) ?? []), r.unit_price]);
  }
  return ix;
}

/**
 * Put the committed spend and applied price onto one budget line — the
 * materials route's rules, off the grouped scans:
 *
 *   - quantity ordered under the line's own wording, plus its substitution's
 *     (orders for a replaced material are raised under the replacement name);
 *   - money coded to the line under any OTHER wording, which
 *     withCodedCommitted turns into quantity at the buy rate — wording the
 *     quantity match already counted is dropped so it can't count twice;
 *   - the newest applied price that isn't in the wrong basis (the 5×-the-BOQ
 *     -cost bound), falling through to the next one that passes, as the route
 *     does, rather than leaving the line unpriced.
 */
export function attachSpend<T extends MaterialWithCommitment & { pid: string }>(m: T, ix: SpendIndex): T {
  const own = lc(m.item), subItem = m.sub_item ? lc(m.sub_item) : null;
  const qty = (ix.committed.get(spendKey(m.pid, own)) ?? 0)
    + (subItem && subItem !== own ? ix.committed.get(spendKey(m.pid, subItem)) ?? 0 : 0);
  const coded = (ix.coded.get(spendKey(m.pid, own)) ?? [])
    .filter((c) => c.poItem !== own && (subItem == null || c.poItem !== subItem))
    .reduce((s, c) => s + c.value, 0);
  const live = (ix.livePrices.get(spendKey(m.pid, own)) ?? []).find((pr) => pr <= (m.cost ?? pr) * 5) ?? null;
  return withCodedCommitted({ ...m, committed_qty: qty, live_unit_price: live, assigned_committed_value: coded });
}

export type ProjectForecast = Forecast & {
  /** The prelims pot, as the Prelims tab shows it. */
  prelimPoCount: number;
};

/**
 * Run the shared forecast for every project. Returns a map keyed by project id;
 * a project with no priced bill still gets an entry (its forecast reads zero).
 */
export async function forecastByProject(db: D1Database, today: string): Promise<Map<string, ProjectForecast>> {
  const [mats, committedRows, codedRows, livePriceRows, commercials, variations, contractItems, afps, contingencies, unpriced, labourRows, prelims, plant] =
    await Promise.all([
      db.prepare(FORECAST_MATERIALS).all<MaterialWithCommitment & { pid: string }>(),
      db.prepare(COMMITTED_BY_ITEM).all<{ pid: string; item: string; qty: number }>(),
      db.prepare(CODED_BY_ITEM).all<{ pid: string; item: string; po_item: string; value: number }>(),
      db.prepare(LIVE_PRICES).all<{ pid: string; item: string; unit_price: number }>(),
      db.prepare(
        `SELECT sn.project_id AS pid, c.value, c.cost, c.is_total, c.category
           FROM project_commercials c JOIN material_snapshots sn ON sn.id = c.snapshot_id
          WHERE sn.is_active = 1`,
      ).all<ProjectCommercial & { pid: string }>(),
      db.prepare(VARIATIONS).all<Variation & { pid: string }>(),
      db.prepare(CONTRACT_ITEMS).all<ContractItem & { pid: string }>(),
      db.prepare(AFPS).all<ApplicationForPayment & { pid: string }>(),
      db.prepare("SELECT key, value FROM settings WHERE key LIKE 'contingency:%'").all<{ key: string; value: string }>(),
      db.prepare(UNPRICED_SPEND).all<{ pid: string; v: number }>(),
      db.prepare(LABOUR_POSITION).all<{ pid: string; section: string; budget: number; saving: number; boq_expended: number; variation_expended: number; other_expended: number }>(),
      db.prepare(PRELIMS_POSITION).all<{ pid: string; budget: number; orders: number; po_count: number; labour: number }>(),
      db.prepare(PLANT_ON_ORDER).all<PlantOnOrder & { pid: string }>(),
    ]);

  const group = <T extends { pid: string }>(rows: { results: T[] }) => {
    const m = new Map<string, T[]>();
    for (const r of rows.results) m.set(r.pid, [...(m.get(r.pid) ?? []), r]);
    return m;
  };
  const matsBy = group(mats), comBy = group(commercials), varBy = group(variations);
  const itemsBy = group(contractItems), afpBy = group(afps), labBy = group(labourRows), plantBy = group(plant);
  const unpricedBy = new Map(unpriced.results.map((r) => [r.pid, r.v]));
  const index = indexSpend(committedRows.results, codedRows.results, livePriceRows.results);
  const potBy = new Map(prelims.results.map((r) => [r.pid, r] as const));
  const contBy = new Map<string, number>();
  for (const r of contingencies.results) {
    const n = Number(r.value);
    contBy.set(r.key.slice("contingency:".length), Number.isFinite(n) ? n : 0);
  }

  const out = new Map<string, ProjectForecast>();
  for (const pid of new Set([...comBy.keys(), ...matsBy.keys(), ...potBy.keys(), ...afpBy.keys()])) {
    // The coded fold is what the Materials tab does before anything reads a row.
    const rows = (matsBy.get(pid) ?? []).map((m) => attachSpend(m, index));
    const pot = potBy.get(pid);
    const prelimsSummary: PrelimsSummary = {
      budget: pot?.budget ?? 0,
      po_committed: pot?.orders ?? 0,
      labour_committed: pot?.labour ?? 0,
      plant_beyond_orders: plantBeyondOrders(plantBy.get(pid) ?? [], today),
    };
    const f = computeForecast({
      commercials: comBy.get(pid) ?? [],
      variations: varBy.get(pid) ?? [],
      contractItems: itemsBy.get(pid) ?? [],
      afps: afpBy.get(pid) ?? [],
      mats: rows,
      contingency: contBy.get(pid) ?? 0,
      summary: summariseMaterials(rows, unpricedBy.get(pid) ?? 0),
      labour: (labBy.get(pid) ?? []).map((r): LabourPositionRow => ({
        section: r.section, labour_total: r.budget, saving: r.saving,
        boq_expended: r.boq_expended, variation_expended: r.variation_expended, other_expended: r.other_expended,
      })),
      prelims: prelimsSummary,
    });
    out.set(pid, { ...f, prelimPoCount: pot?.po_count ?? 0 });
  }
  return out;
}
