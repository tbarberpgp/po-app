import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { generateGroupMaterialsXlsx } from "../lib/group-materials-xlsx";
import { SubstituteAction } from "./MaterialSubstitute";
import { Topbar } from "./Shell";
import { ProjectProgramme } from "./Programme";
import { ProjectReports } from "./ProjectReports";
import { ProjectOperations } from "./Operations";
import { ForecastDashboard, Glance, DateCard, moneyTone, PrelimsTab, PortfolioCalendarPanel, ValuationScheduleUpload, LabourBreakdown, CommercialsHelpPanel, ProjectSettingsBlock, type ForecastDrill } from "./ProjectDetail";
import { DrillPanel, DrillKpi, type DrillData } from "./DrillPanel";
import { AssignBudgetCell } from "./AssignBudgetCell";
import {
  summariseMaterials, computeForecast, sumForecasts, contractTotals, effectiveSpendRate, matSupplier, netUnits, quoteSavingsOf,
  pricedBudgetDrill, committedDrill, materialSavingsDrill, labourSavingsDrill,
  variationProfitDrill, unpricedDrill, unexpectedSpendDrill, applicationsDrill, combineDrill,
  offBoqRow, materialAddedAt, materialModifiedAt,
  type Forecast, type UnpricedLine, type DrillBody, type MatRow,
} from "../lib/commercials";
import { can } from "../../shared/permissions";
import { combineSiteCodes } from "../../shared/site-code";
import type {
  CurrentUser, Project, MaterialWithCommitment, OffBoqMaterial, ProjectCommercial, ContractItem, Variation, ApplicationForPayment, OpsSite,
} from "../../shared/types";

type Member = { id: string; code: string; name: string; client?: string | null; payment_terms?: string | null; site_group_id?: string | null; site_group_name?: string | null; site_group_base?: string | null };
type BlockData = {
  commercials: ProjectCommercial[];
  variations: Variation[];
  contractItems: ContractItem[];
  afps: ApplicationForPayment[];
  mats: MaterialWithCommitment[];
  /** Materials ordered on this block's POs that aren't in its BOQ. Held apart
   *  from `mats` so only the materials TABLE picks them up — the forecast and
   *  the KPI rollups already count them once, as unpriced spend. */
  offBoq: OffBoqMaterial[];
  contingency: number;
  unpricedLines: UnpricedLine[];
  unpricedSpend: number;
};
type GTab = "overview" | "commercials" | "materials" | "programme" | "operations" | "reports";

const qty = (n: number | null | undefined) => (n == null ? "—" : Number(n).toLocaleString("en-GB", { maximumFractionDigits: 2 }));

export type MatStatus = "unpriced" | "to_order" | "on_order" | "called_off" | "part_delivered" | "delivered";

/** A single procurement status for a combined material from what's ordered vs
 *  delivered. committedQty = reserved (standard POs + framework reservations,
 *  excl call-offs); deliveredQty = received on site; calledOffQty = framework
 *  draw-downs. */
function statusOfMat(v: { priced: boolean; committedQty: number; calledOffQty: number; deliveredQty: number }): MatStatus {
  if (!v.priced) return "unpriced";
  const C = v.committedQty, K = v.calledOffQty, D = v.deliveredQty;
  if (C < 0.01 && K < 0.01) return "to_order";
  if (C > 0.01 && D >= C - 0.01) return "delivered";
  if (D > 0.01) return "part_delivered";
  if (K > 0.01) return "called_off";
  return "on_order";
}
const STATUS_META: Record<MatStatus, { label: string; tone: string }> = {
  to_order:       { label: "To order",       tone: "neutral" },
  on_order:       { label: "On order",       tone: "issued" },
  called_off:     { label: "Called off",     tone: "issued" },
  part_delivered: { label: "Part-delivered", tone: "warn" },
  delivered:      { label: "Delivered",      tone: "ok" },
  unpriced:       { label: "Unpriced",       tone: "neutral" },
};
/** Chip filters over the combined list. "off_boq" is not a MatStatus — where a
 *  material sits in the pipeline and whether the bill priced it are different
 *  questions, so it filters alongside the stages instead of replacing one. */
type MatChip = MatStatus | "all" | "off_boq";
const MAT_STATUS_CHIPS: Array<[MatChip, string]> = [
  ["all", "All"], ["to_order", "To order"], ["on_order", "On order"],
  ["called_off", "Called off"], ["part_delivered", "Part-delivered"],
  ["delivered", "Delivered"], ["unpriced", "Unpriced"], ["off_boq", "Off-BOQ"],
];
const STATUS_BAR: Record<MatStatus, string> = {
  delivered: "#2f9e44", part_delivered: "var(--warn)", on_order: "var(--accent)",
  called_off: "var(--accent)", to_order: "#cbd2d9", unpriced: "#cbd2d9",
};

/**
 * A grouped site (e.g. Dallas Rd Blocks B/C/D = 26001/2/3). The blocks stay
 * separate contracts; this page rolls them up using the SAME commercials maths
 * as each block's own page (../lib/commercials) so the combined figures always
 * reconcile. Every headline figure is clickable — it opens the slide-over
 * listing exactly what made it up, merged across the blocks in scope. The block
 * filter re-scopes the commercials, the forecast and the materials table.
 */
export function GroupPage({ me }: { me: CurrentUser | null }) {
  const { groupId = "" } = useParams();
  const [members, setMembers] = useState<Member[]>([]);
  const [baseProject, setBaseProject] = useState<Project | null>(null);
  const [data, setData] = useState<Record<string, BlockData>>({});
  const canViewCommercial = can(me?.role, "commercial.view");
  const canEditCommercial = can(me?.role, "commercial.edit");
  const canEditProject = can(me?.role, "projects.edit");
  const isDirector = !!(me?.is_approver && me.approver_tiers.includes("director"));
  const [tab, setTab] = useState<GTab>("overview");
  const nav = useNavigate();
  const [block, setBlock] = useState<string>("all"); // "all" or a project id
  const [cSub, setCSub] = useState<"overview" | "prelims" | "schedule" | "applications" | "labour" | "variations" | "help">("overview"); // Commercials subtab
  // Labour subtab data for the selected block (per-contract, fetched on demand).
  const [labourRows, setLabourRows] = useState<import("../../shared/types").LabourByCostCode[]>([]);
  const [labourLive, setLabourLive] = useState<import("../../shared/types").LabourLiveRate[]>([]);
  const [matStatus, setMatStatus] = useState<MatChip>("all");
  const [matQuery, setMatQuery] = useState("");
  // Show committed £/qty or called-off £/qty in the Combined-materials table.
  const [matValueMode, setMatValueMode] = useState<"committed" | "calledoff">("committed");
  // Click-to-sort on the Combined-materials headings.
  const [matSort, setMatSort] = useState<"material" | "usage" | "rate" | "budget" | "committed" | "variance" | "status" | "added" | "modified" | "blocks" | null>(null);
  const [matSortDir, setMatSortDir] = useState<"asc" | "desc">("asc");
  function toggleMatSort(k: NonNullable<typeof matSort>) {
    if (matSort === k) { setMatSortDir((d) => (d === "asc" ? "desc" : "asc")); return; }
    setMatSort(k);
    setMatSortDir(k === "material" || k === "status" ? "asc" : "desc");
  }
  const matSortArrow = (k: NonNullable<typeof matSort>) => (matSort === k ? (matSortDir === "asc" ? " ▲" : " ▼") : "");
  const [expandedMat, setExpandedMat] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillData | null>(null);
  const [sites, setSites] = useState<OpsSite[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const canEdit = can(me?.role, "delivery.edit");
  const canRaisePO = can(me?.role, "pos.create");
  const canUploadMaterials = can(me?.role, "materials.upload");

  const load = useCallback(() => {
    api.listProjects().then((rows: Member[]) => {
      const mem = rows.filter((r) => r.site_group_id === groupId);
      setMembers(mem);
      const baseId = mem[0]?.site_group_base || mem[0]?.id;
      if (baseId) api.getProject(baseId).then((r) => setBaseProject(r.project)).catch(() => {});
      mem.forEach((m) => {
        Promise.all([
          api.listProjectCommercials(m.id).catch(() => [] as ProjectCommercial[]),
          api.listVariations(m.id).catch(() => [] as Variation[]),
          api.listContractItems(m.id).catch(() => [] as ContractItem[]),
          api.listAfps(m.id, "outgoing").catch(() => [] as ApplicationForPayment[]),
          api.listMaterials(m.id).catch(() => [] as MaterialWithCommitment[]),
          api.getContingency(m.id).then((r) => r.contingency).catch(() => 0),
          api.getProjectSummary(m.id).then((s) => ({ lines: s.unpriced_lines ?? [], spend: s.unpriced_spend ?? 0 })).catch(() => ({ lines: [] as UnpricedLine[], spend: 0 })),
          api.listOffBoqMaterials(m.id).catch(() => [] as OffBoqMaterial[]),
        ]).then(([commercials, variations, contractItems, afps, mats, contingency, summary, offBoq]) => {
          setData((p) => ({ ...p, [m.id]: { commercials, variations, contractItems, afps, mats, contingency, unpricedLines: summary.lines, unpricedSpend: summary.spend, offBoq } }));
        }).catch(() => {});
      });
    }).catch((e) => setErr(e.message));
    api.opsSites().then(setSites).catch(() => setSites([]));
  }, [groupId]);
  useEffect(() => { load(); }, [load]);
  const SHARED_FIELDS = ["client", "client_email", "client_contact_name", "site_manager_email", "project_manager_email",
    "commercial_manager_email", "payment_terms", "delivery_address", "site_contact_name", "site_contact_phone",
    "delivery_instructions", "retention_pct", "client_vat_pct", "client_retention_pct", "labour_vat_pct", "labour_retention_pct"] as const;
  const syncSharedInfo = useCallback(async () => {
    if (!baseProject) { load(); return; }
    try {
      const fresh = await api.getProject(baseProject.id);
      const base = fresh.project as unknown as Record<string, unknown>;
      setBaseProject(fresh.project);
      const payload: Record<string, unknown> = {};
      for (const k of SHARED_FIELDS) payload[k] = base[k] ?? null;
      await Promise.all(members.filter((m) => m.id !== fresh.project.id)
        .map((m) => api.updateProject(m.id, payload as Parameters<typeof api.updateProject>[1]).catch(() => {})));
    } finally { load(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseProject?.id, members.map((m) => m.id).join(","), load]);

  const refreshBlockLive = useCallback(() => {
    if (block === "all") { setLabourLive([]); return; }
    api.listLabourRates(block).then(setLabourLive).catch(() => setLabourLive([]));
  }, [block]);
  useEffect(() => {
    if (cSub !== "labour" || block === "all") { setLabourRows([]); return; }
    api.listLabourByCostCode(block).then(setLabourRows).catch(() => setLabourRows([]));
    refreshBlockLive();
  }, [cSub, block, refreshBlockLive]);
  const siteById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);

  const base = members.find((m) => m.id === (members[0]?.site_group_base || members[0]?.id)) ?? members[0] ?? null;
  const baseSite = base ? siteById.get(base.id) : undefined;
  const groupName = members[0]?.site_group_name || "Site group";
  const combinedCode = useMemo(() => combineSiteCodes(members.map((m) => m.code)), [members]);
  const scopeMembers = useMemo(() => (block === "all" ? members : members.filter((m) => m.id === block)), [members, block]);

  // Per-block forecast via the shared lib, then summed for the combined view.
  const forecastFor = (d: BlockData): Forecast => computeForecast({
    commercials: d.commercials, variations: d.variations, contractItems: d.contractItems,
    afps: d.afps, mats: d.mats, contingency: d.contingency,
    summary: summariseMaterials(d.mats, d.unpricedSpend),
  });
  const fc = useMemo<Forecast>(
    () => sumForecasts(scopeMembers.map((m) => data[m.id]).filter(Boolean).map(forecastFor)),
    [data, scopeMembers], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const contract = useMemo(() => {
    let value = 0, cost = 0;
    for (const m of scopeMembers) { const ct = contractTotals(data[m.id]?.commercials ?? []); value += ct?.value ?? 0; cost += ct?.cost ?? 0; }
    return { value, cost, gp: value - cost, gpPct: value > 0 ? (value - cost) / value : null };
  }, [data, scopeMembers]);

  const matSummary = useMemo(() => {
    let priced = 0, committed = 0, unpriced = 0, savings = 0;
    for (const m of scopeMembers) {
      const d = data[m.id]; if (!d) continue;
      const s = summariseMaterials(d.mats, d.unpricedSpend);
      priced += s.priced_total; committed += s.committed_total; unpriced += s.unpriced_spend;
      savings += quoteSavingsOf(d.mats);
    }
    return { priced, committed, remaining: priced - committed, unpriced, savings };
  }, [data, scopeMembers]);

  // Per-block commercial summary (combined view only).
  const perBlock = useMemo(() => members.map((m) => {
    const d = data[m.id];
    const f = d ? forecastFor(d) : null;
    const ct = d ? contractTotals(d.commercials) : null;
    return { code: m.code, id: m.id, value: ct?.value ?? 0, ffc: f?.ffc ?? 0, profit: f?.forecastProfit ?? 0, gpPct: f?.forecastGpPct ?? null, ready: !!d };
  }), [data, members]); // eslint-disable-line react-hooks/exhaustive-deps

  // Combined materials — matching items merged across the blocks in scope (no
  // double entries), rolling up budget / committed / delivered / Δ and keeping
  // each block's own figures for the expandable per-block breakdown. Each row
  // gets a single procurement status (to order → on order → called off →
  // part-delivered → delivered) plus "unpriced".
  const combinedMaterials = useMemo(() => {
    type Blk = { code: string; boqQty: number; committedQty: number; calledOffQty: number; deliveredQty: number; budget: number; committed: number; calledOff: number; effVal: number; mats: MatRow[] };
    type Row = {
      /** The merge key (product id or normalised name) — unique by construction,
       *  so it's the React key and expansion identity; display names may collide. */
      key: string;
      item: string; type: string; unit: string | null; supplier: Set<string>;
      boqQty: number; committedQty: number; calledOffQty: number; deliveredQty: number;
      budget: number; committed: number; calledOff: number; effVal: number; priced: boolean; blocks: Map<string, Blk>; mats: MatRow[];
      /** True when some block only knows this item from a PO, not its BOQ. */
      offBoq: boolean;
      /** Newest off-BOQ order date across the blocks — this row totals several
       *  orders, so it has to say when it was last bought. */
      lastOrdered: string | null;
      /** When this material first reached the job: its first order for an
       *  off-BOQ buy, or the upload of the bill that priced it. */
      addedAt: string | null;
      /** The last thing that happened to it — an order, a substitution, or a
       *  quote price being applied. */
      modifiedAt: string | null;
      /** Every status this item holds on SOME block — a call-off still live on
       *  one block mustn't be hidden because another block took a delivery. */
      statuses: Set<MatStatus>;
      /** Effective-name frequency across blocks — the majority wording titles
       *  the merged row, so one block's typo can't split or mislabel it. */
      names: Map<string, number>;
    };
    // Blocks punctuate the same item differently — "MG4BLK … - Charcoal" on one
    // and "MG4BLK … : Charcoal" on the next — so the key ignores punctuation
    // and spacing entirely and compares the words alone.
    const normName = (s2: string) => s2.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    // A material linked to a master product wins the key; an UNLINKED row whose
    // wording matches a linked one joins it rather than sitting alone (that's
    // what split "Capping" across blocks — one block's row carried the product
    // link, the other's didn't).
    const productByName = new Map<string, string>();
    // Wording that some block actually prices. An off-BOQ buy matching one of
    // these joins that budget row — the whole point of the combined view is
    // seeing that a block bought off-BOQ what a sibling has money for.
    const pricedNames = new Set<string>();
    for (const m of scopeMembers) {
      const d = data[m.id]; if (!d) continue;
      for (const row of d.mats) {
        if (row.omitted) continue;
        const n = normName(row.sub_item || row.item || "");
        if (!n) continue;
        pricedNames.add(n);
        if (row.product_id != null) productByName.set(n, `p:${row.product_id}`);
      }
    }
    const by = new Map<string, Row>();
    for (const m of scopeMembers) {
      const d = data[m.id]; if (!d) continue;
      // The block's BOQ plus what its POs bought outside it. An item added when
      // raising a PO is on this site just as much as a priced one, and merging
      // it here means a material bought off-BOQ on one block sits on the same
      // row as the same material priced on another.
      for (const row of [...d.mats, ...d.offBoq.map((o, i) => offBoqRow(o, i))] as MatRow[]) {
        if (row.omitted) continue; // omitted from the job — not procurement
        const norm = normName(row.sub_item || row.item || "");
        // An off-BOQ row that no block prices keeps its supplier in the key.
        // Nothing vouches for these but the wording someone typed, and the
        // generic ones — carriage, delivery, pallet charge — are billed under
        // the same word by every supplier while being entirely different money.
        // Pooled on wording alone they became a single "Mixed suppliers" line
        // whose £/unit was an average of unrelated charges.
        const key = row.off_boq && !pricedNames.has(norm)
          ? (norm ? `n:${norm}\u0000${matSupplier(row).toLowerCase()}` : "")
          : row.product_id != null ? `p:${row.product_id}` : (productByName.get(norm) ?? (norm ? `n:${norm}` : ""));
        if (!key || key === "p:") continue;
        const cur: Row = by.get(key) ?? { key, item: row.sub_item || row.item, type: row.type ?? "", unit: row.total_units_unit ?? row.sub_unit ?? row.cost_unit ?? null, supplier: new Set<string>(), boqQty: 0, committedQty: 0, calledOffQty: 0, deliveredQty: 0, budget: 0, committed: 0, calledOff: 0, effVal: 0, priced: false, offBoq: false, lastOrdered: null, addedAt: null, modifiedAt: null, blocks: new Map<string, Blk>(), mats: [], statuses: new Set<MatStatus>(), names: new Map<string, number>() };
        const effName = (row.sub_item || row.item || "").trim();
        if (effName) cur.names.set(effName, (cur.names.get(effName) ?? 0) + 1);
        const boq = netUnits(row); // budget qty net of any partial omission
        const committedQ = row.committed_qty ?? 0;
        const calledOffQ = row.called_off_qty ?? 0;
        const delivered = row.delivered_qty ?? 0;
        const bud = boq * (row.cost ?? 0);
        // Committed / called-off £ at the rate we actually buy at (live quote
        // first) — same basis as the per-block Materials tab.
        const comm = committedQ * effectiveSpendRate(row);
        const co = calledOffQ * effectiveSpendRate(row);
        const rowPriced = (row.cost ?? 0) > 0 || (row.sub_cost ?? 0) > 0 || (row.live_unit_price ?? 0) > 0;
        cur.boqQty += boq; cur.committedQty += committedQ; cur.calledOffQty += calledOffQ; cur.deliveredQty += delivered;
        cur.budget += bud; cur.committed += comm; cur.calledOff += co; cur.effVal += boq * effectiveSpendRate(row); cur.mats.push(row);
        if (rowPriced) cur.priced = true;
        if (row.off_boq) {
          cur.offBoq = true;
          const at = row.off_boq.last_ordered_at;
          if (at && (cur.lastOrdered == null || at > cur.lastOrdered)) cur.lastOrdered = at;
        }
        // Earliest signal that this material reached the job, latest signal that
        // anything happened to it. A merged row spans blocks, so both are taken
        // across every row feeding it.
        const added = materialAddedAt(row);
        const modified = materialModifiedAt(row);
        if (added && (cur.addedAt == null || added < cur.addedAt)) cur.addedAt = added;
        if (modified && (cur.modifiedAt == null || modified > cur.modifiedAt)) cur.modifiedAt = modified;
        cur.statuses.add(statusOfMat({ priced: rowPriced, committedQty: committedQ, calledOffQty: calledOffQ, deliveredQty: delivered }));
        const sup = matSupplier(row); if (sup) cur.supplier.add(sup);
        const b = cur.blocks.get(m.code) ?? { code: m.code, boqQty: 0, committedQty: 0, calledOffQty: 0, deliveredQty: 0, budget: 0, committed: 0, calledOff: 0, effVal: 0, mats: [] };
        b.boqQty += boq; b.committedQty += committedQ; b.calledOffQty += calledOffQ; b.deliveredQty += delivered; b.budget += bud; b.committed += comm; b.calledOff += co; b.effVal += boq * effectiveSpendRate(row); b.mats.push(row);
        cur.blocks.set(m.code, b);
        by.set(key, cur);
      }
    }
    return [...by.values()]
      .map((v) => ({
        ...v,
        item: [...v.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? v.item,
        delta: v.committed - v.budget,
        status: statusOfMat(v),
      }))
      .sort((a, b) => b.budget - a.budget);
  }, [data, scopeMembers]);

  // Chips count/filter by "this item holds that status on ANY block" — so the
  // group can never show fewer called-off items than one of its blocks. The
  // row's own pill still shows the merged pipeline position.
  const statusCounts = useMemo(() => {
    const c: Partial<Record<MatStatus, number>> = {};
    for (const m of combinedMaterials) for (const s of m.statuses) c[s] = (c[s] ?? 0) + 1;
    return c;
  }, [combinedMaterials]);
  const visibleMaterials = useMemo(() => combinedMaterials
    .filter((m) => matStatus === "all" || (matStatus === "off_boq" ? m.offBoq : m.statuses.has(matStatus)))
    .filter((m) => !matQuery || (m.item + " " + [...m.supplier].join(" ")).toLowerCase().includes(matQuery.toLowerCase())),
    [combinedMaterials, matStatus, matQuery]);
  const sortedMaterials = useMemo(() => {
    if (matSort == null) return visibleMaterials;
    const val = (m: typeof visibleMaterials[number]): string | number => {
      const spend = matValueMode === "calledoff" ? m.calledOff : m.committed;
      switch (matSort) {
        case "material": return m.item.toLowerCase();
        case "usage": return m.budget > 0 ? spend / m.budget : (spend > 0 ? 999 : 0);
        // Same fallback the £/unit cell displays: an off-BOQ row has no BOQ
        // quantity to divide by, but we do know what it was bought at. Without
        // this every off-BOQ material sorts as £0 and sinks to the bottom of a
        // high-to-low price sort — the exact rows you're usually looking for.
        case "rate": return m.boqQty > 0 ? m.effVal / m.boqQty
          : m.committedQty > 0 ? m.committed / m.committedQty
          : m.calledOffQty > 0 ? m.calledOff / m.calledOffQty
          : 0;
        case "budget": return m.budget;
        case "committed": return spend;
        case "variance": return spend - m.budget;
        case "status": return m.status;
        // Undated rows sort last in either direction, rather than pretending to
        // be the oldest thing on the job.
        case "added": return m.addedAt ?? "";
        case "modified": return m.modifiedAt ?? "";
        // Groups the list by which blocks a material is on; "All blocks" rows
        // land together because their key is the full block list.
        case "blocks": return [...m.blocks.keys()].sort().join(" ");
      }
    };
    const dated = matSort === "added" || matSort === "modified";
    return [...visibleMaterials].sort((a, b) => {
      const va = val(a), vb = val(b);
      // A material with no date can't be newest or oldest — park it at the
      // bottom whichever way the sort runs.
      if (dated && (va === "" || vb === "")) return va === vb ? 0 : va === "" ? 1 : -1;
      const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return matSortDir === "asc" ? c : -c;
    });
  }, [visibleMaterials, matSort, matSortDir, matValueMode]);
  function exportMaterials() {
    const bytes = generateGroupMaterialsXlsx(combinedCode, groupName, visibleMaterials.map((m) => ({
      item: m.item, type: m.type, supplier: [...m.supplier].join(", "), unit: m.unit,
      boqQty: m.boqQty, committedQty: m.committedQty, deliveredQty: m.deliveredQty,
      budget: m.budget, committed: m.committed, variance: m.delta,
      status: STATUS_META[m.status].label, blocks: [...m.blocks.keys()].sort().join(" "),
    })));
    const ab = new ArrayBuffer(bytes.byteLength); new Uint8Array(ab).set(bytes);
    const url = URL.createObjectURL(new Blob([ab], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a"); a.href = url; a.download = `materials-${combinedCode}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  }

  // Build a combined drill body by running a per-block builder over every block
  // in scope and tagging each row with its block code.
  const combined = (fn: (d: BlockData) => DrillBody, value: number): DrillBody =>
    combineDrill(scopeMembers.filter((m) => data[m.id]).map((m) => ({ block: m.code, body: fn(data[m.id]) })), fmtMoney(value));

  const openForecastDrill = (metric: ForecastDrill) => {
    const map: Record<ForecastDrill, [string, number, (d: BlockData) => DrillBody]> = {
      materials: ["Profit / loss from materials", fc.materialSavings, (d) => materialSavingsDrill(d.mats)],
      labour: ["Profit / loss from labour", fc.labourSavings, (d) => labourSavingsDrill(d.contractItems)],
      variations: ["Profit / loss from variations", fc.varProfit, (d) => variationProfitDrill(d.variations)],
      unexpected: ["Unexpected spend", fc.unexpectedSpend, (d) => unexpectedSpendDrill(d.unpricedLines, d.mats)],
      applied: ["Applied value", fc.appliedValue, (d) => applicationsDrill(d.afps, "applied")],
      certified: ["Certified value", fc.certifiedValue, (d) => applicationsDrill(d.afps, "certified")],
    };
    const [title, value, fn] = map[metric];
    const body = combined(fn, value);
    // Off-BOQ rows in the Unexpected-spend drill can be coded to a budget item
    // in place — the options come from the row's own block's materials list.
    if (metric === "unexpected" && can(me?.role, "pos.edit")) {
      const matsByBlock = new Map(scopeMembers.filter((m) => data[m.id]).map((m) => [m.code, data[m.id].mats]));
      body.columns = [...body.columns, {
        key: "__assign", label: "",
        fmt: (_v, row) => (row.__line_id != null
          ? <AssignBudgetCell poId={String(row.__po_id)} lineId={Number(row.__line_id)}
              mats={matsByBlock.get(String(row.__block)) ?? []} onAssigned={load} />
          : null),
      }];
    }
    setDrill({ title, value: fmtMoney(value), ...body });
  };
  const openMatDrill = (title: string, value: number, fn: (d: BlockData) => DrillBody) => {
    const body = combined(fn, value);
    // Any drill whose rows carry PO/line refs (e.g. Unpriced spend) gets the
    // in-place assign-to-budget picker, options scoped to the row's block.
    if (can(me?.role, "pos.edit") && body.rows.some((r) => r.__line_id != null)) {
      const matsByBlock = new Map(scopeMembers.filter((m) => data[m.id]).map((m) => [m.code, data[m.id].mats]));
      body.columns = [...body.columns, {
        key: "__assign", label: "",
        fmt: (_v, row) => (row.__line_id != null
          ? <AssignBudgetCell poId={String(row.__po_id)} lineId={Number(row.__line_id)}
              mats={matsByBlock.get(String(row.__block)) ?? []} onAssigned={load} />
          : null),
      }];
    }
    setDrill({ title, value: fmtMoney(value), ...body });
  };

  if (err) return <main className="flash error" style={{ margin: 24 }}>{err}</main>;

  const TABS: Array<[GTab, string]> = [
    ["overview", "Overview"],
    ...(canViewCommercial ? [["commercials", "Commercials"] as [GTab, string]] : []),
    ["materials", "Materials"], ["programme", "Programme"], ["operations", "Operations"], ["reports", "Reports"],
  ];
  const scopeLabel = block === "all" ? "Whole site (combined)" : `Block ${members.find((m) => m.id === block)?.code}`;

  return (
    <>
      <DrillPanel drill={drill} onClose={() => setDrill(null)} />
      <Topbar crumbs="Workspace · Projects" title={groupName} />
      <main>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-hd" style={{ flexWrap: "wrap", gap: 10 }}>
            <span className="pill" style={{ fontWeight: 700 }}>{combinedCode}</span>
            <h2 style={{ flex: 1 }}>{groupName}</h2>
            <span className="muted">{members.length} blocks · one site</span>
          </div>

          <div className="seg" style={{ margin: 16 }}>
            <button className={`seg-btn${block === "all" ? " active" : ""}`} onClick={() => setBlock("all")}>All blocks</button>
            {members.map((m) => (
              <button key={m.id} className={`seg-btn${block === m.id ? " active" : ""}`} onClick={() => setBlock(m.id)} title={m.name}>{m.code}</button>
            ))}
          </div>
        </div>

        {/* Same Project Info drop-downs as a standard project — edited once
            here on the base and mirrored to every block (one site, one set of
            facts). Block names stay their own. */}
        {baseProject && <ProjectSettingsBlock project={baseProject} canEdit={canEditProject} onSaved={syncSharedInfo} />}

        <div className="tabs" role="tablist" style={{ marginBottom: 16 }}>
          {TABS.map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab-btn${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>{label}</button>
          ))}
        </div>

        {tab === "overview" && canViewCommercial && (
          <GroupOverview
            scopeMembers={scopeMembers} data={data} fc={fc} contract={contract}
            baseId={base?.id ?? null} scopeLabel={scopeLabel} onJump={setTab} openForecastDrill={openForecastDrill}
          />
        )}

        {tab === "commercials" && canViewCommercial && (
          <>
            {/* Scope picker (Combined vs a single block) + Commercials subtabs. */}
            <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
              <select value={block} onChange={(e) => setBlock(e.target.value)} style={{ maxWidth: 280 }}>
                <option value="all">Combined — all blocks</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}
              </select>
              <div className="seg" style={{ flexWrap: "wrap" }}>
                {([["overview", "Overview"], ["prelims", "Prelims"], ["schedule", "Schedule"], ["applications", "Applications"], ["labour", "Labour"], ["variations", "Variations"], ["help", "Help"]] as const).map(([k, label]) => (
                  <button key={k} className={`seg-btn${cSub === k ? " active" : ""}`} onClick={() => setCSub(k)}>{label}</button>
                ))}
              </div>
              <span className="grow" />
              {block !== "all" && <Link to={`/projects/${block}`} className="btn ghost tiny">Open {members.find((m) => m.id === block)?.code} ›</Link>}
            </div>

            {cSub === "applications" && (
              <div className="card">
                <div className="card-hd"><h2 style={{ flex: 1 }}>Applications</h2><span className="muted" style={{ fontSize: 12.5 }}>{scopeLabel}</span></div>
                {(() => {
                  const rows = scopeMembers.flatMap((m) => (data[m.id]?.afps ?? []).map((a) => ({ ...a, code: m.code })))
                    .sort((a, b) => (b.period_end || "").localeCompare(a.period_end || ""));
                  return rows.length === 0
                    ? <div className="empty in-card"><p>No applications in this scope.</p></div>
                    : (
                      <table><thead><tr><th className="center">App</th>{block === "all" && <th className="center">Block</th>}<th>Direction</th><th>Period end</th><th className="center">Status</th><th className="num">Value</th></tr></thead>
                        <tbody>{rows.map((a) => (
                          <tr key={a.id} style={{ cursor: "pointer" }} onClick={() => nav(`/applications/${a.id}`)}>
                            <td className="center">#{a.app_number}</td>
                            {block === "all" && <td className="center">{a.code}</td>}
                            <td>{a.direction === "incoming_labour" ? "Labour (in)" : "Client (out)"}</td>
                            <td>{a.period_end}</td>
                            <td className="center"><span className="pill">{a.status}</span></td>
                            <td className="num">{fmtMoney(a.certified_amount ?? a.amount_due ?? a.total_invoice ?? 0)}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    );
                })()}
              </div>
            )}

            {cSub === "variations" && (
              <div className="card">
                <div className="card-hd"><h2 style={{ flex: 1 }}>Variations</h2><span className="muted" style={{ fontSize: 12.5 }}>{scopeLabel}</span></div>
                {(() => {
                  const rows = scopeMembers.flatMap((m) => (data[m.id]?.variations ?? []).map((v) => ({ ...v, code: m.code, pid: m.id })))
                    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
                  return rows.length === 0
                    ? <div className="empty in-card"><p>No variations in this scope.</p></div>
                    : (
                      <table><thead><tr><th className="center">VO</th>{block === "all" && <th className="center">Block</th>}<th>Description</th><th className="center">Status</th><th className="num">Sell value</th></tr></thead>
                        <tbody>{rows.map((v) => (
                          <tr key={`${v.pid}-${v.id}`} style={{ cursor: "pointer" }} onClick={() => nav(`/projects/${v.pid}`)}>
                            <td className="center">{v.variation_no}</td>
                            {block === "all" && <td className="center">{v.code}</td>}
                            <td>{v.description}</td>
                            <td className="center"><span className={`pill${v.approved_at ? " approved" : ""}`}>{v.status}</span></td>
                            <td className="num">{fmtMoney(v.sell_value)}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    );
                })()}
              </div>
            )}

            {(cSub === "prelims" || cSub === "labour") && block === "all" && (
              <div className="card"><div className="card-bd">
                <p className="muted" style={{ margin: "4px 0 10px" }}>
                  {cSub === "prelims" ? "Prelims expenditure" : "The labour BOQ"} is managed per contract — pick a block:
                </p>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  {members.map((m) => <button key={m.id} className="ghost tiny" onClick={() => setBlock(m.id)}>{m.code} — {m.name}</button>)}
                </div>
              </div></div>
            )}
            {cSub === "prelims" && block !== "all" && <PrelimsTab projectId={block} canRaisePO={canRaisePO} />}
            {cSub === "schedule" && (() => {
              // One site, one payment schedule: at combined scope the base
              // project's calendar shows, and edits fan out to every block.
              const schedId = block === "all" ? (baseProject?.id ?? members[0]?.id ?? "") : block;
              const mirrors = block === "all" ? members.map((m) => m.id).filter((mid) => mid !== schedId) : [];
              return schedId ? (
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 16 }}>
                  <PortfolioCalendarPanel projectId={schedId} />
                  <ValuationScheduleUpload projectId={schedId} canEdit={canEditCommercial} mirrorProjectIds={mirrors} />
                </div>
              ) : null;
            })()}
            {cSub === "labour" && block !== "all" && (
              <LabourBreakdown rows={labourRows} contractItems={data[block]?.contractItems ?? []} canRaiseApp={canEditCommercial}
                canApprove={isDirector} projectId={block} onRefresh={load} liveRates={labourLive} refreshLive={refreshBlockLive} />
            )}
            {cSub === "help" && <CommercialsHelpPanel />}
            {cSub === "overview" && (
          <>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{scopeLabel}</div>
            <div className="kpis">
              <DrillKpi label="Contract value" value={fmtMoney(contract.value)} />
              <DrillKpi label="Cost" value={fmtMoney(contract.cost)} />
              <DrillKpi label="Gross profit" value={fmtMoney(contract.gp)} tone={contract.gp > 0.005 ? "success" : contract.gp < -0.005 ? "danger" : "default"} />
              <DrillKpi label="GP margin" value={contract.gpPct != null ? `${(contract.gpPct * 100).toFixed(1)}%` : "—"} tone={(contract.gpPct ?? 0) >= 0.1 ? "success" : (contract.gpPct ?? 0) < 0 ? "danger" : "warn"} />
            </div>

            <ForecastDashboard f={fc} onDrill={openForecastDrill} />

            {block === "all" && members.length > 1 && (
              <div className="card" style={{ marginTop: 16 }}>
                <div className="card-hd"><h2 style={{ flex: 1 }}>By block</h2><span className="muted" style={{ fontSize: 12.5 }}>each stays its own contract</span></div>
                <table>
                  <thead><tr><th>Block</th><th className="num">Contract value</th><th className="num">Forecast cost</th><th className="num">Forecast profit</th><th className="num">GP%</th><th></th></tr></thead>
                  <tbody>
                    {perBlock.map((b) => (
                      <tr key={b.id}>
                        <td><button className="linklike" onClick={() => setBlock(b.id)} style={{ background: "none", border: 0, color: "var(--accent)", cursor: "pointer", padding: 0, font: "inherit" }}>{b.code}</button></td>
                        <td className="num">{b.ready ? fmtMoney(b.value) : "…"}</td>
                        <td className="num">{b.ready ? fmtMoney(b.ffc) : "…"}</td>
                        <td className="num" style={{ color: b.profit > 0.005 ? "var(--success)" : b.profit < -0.005 ? "var(--danger)" : undefined }}>{b.ready ? fmtMoney(b.profit) : "…"}</td>
                        <td className="num">{b.gpPct != null ? `${(b.gpPct * 100).toFixed(1)}%` : "—"}</td>
                        <td style={{ textAlign: "right" }}><Link to={`/projects/${b.id}`} className="btn ghost tiny">Open ›</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="muted" style={{ marginTop: 14, maxWidth: 680 }}>
              Each block stays its own contract for billing, certification and Xero. Figures roll up across the blocks; click any
              figure above to see exactly what makes it up. {block !== "all" && <Link to={`/projects/${block}`}>Open {members.find((m) => m.id === block)?.code} ›</Link>}
            </p>
          </>
            )}
          </>
        )}

        {/* Delivery roles (PM/site) get an operational overview — no commercials. */}
        {tab === "overview" && !canViewCommercial && (
          <>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Whole site (combined)</div>
            <div className="kpis">
              <DrillKpi label="On site now" value={String(baseSite?.on_site_now ?? 0)} sub={`${baseSite?.signins_today ?? 0} signed in today`} tone={(baseSite?.on_site_now ?? 0) > 0 ? "success" : "default"} />
              <DrillKpi label="Plant on site" value={String(baseSite?.plant_on_site ?? 0)} />
              <DrillKpi label="Blocks" value={String(members.length)} sub="one combined site" />
            </div>
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-hd"><h2 style={{ flex: 1 }}>Blocks</h2></div>
              <table>
                <thead><tr><th>Block</th><th>Name</th><th></th></tr></thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id}>
                      <td><span className="pill">{m.code}</span></td>
                      <td className="muted">{m.name}</td>
                      <td style={{ textAlign: "right" }}><Link to={`/projects/${m.id}`} className="btn ghost tiny">Open ›</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ marginTop: 14, maxWidth: 680 }}>
              Operations, sign-ins, RAMS and the programme are shared across the {members.length} blocks — use the Operations and Programme tabs above.
            </p>
          </>
        )}

        {tab === "materials" && (
          <>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{scopeLabel}</div>
            {canRaisePO && (
              <div className="card" style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "12px 16px" }}>
                  <b style={{ fontSize: 13 }}>Raise a purchase order</b>
                  <span className="muted" style={{ fontSize: 12 }}>each block is its own contract — pick one:</span>
                  {members.map((m) => (
                    <Link key={m.id} className="btn accent tiny" to={`/projects/${m.id}/new-po`} title={`Raise a PO for ${m.code} — ${m.name}`}>+ PO · {m.code}</Link>
                  ))}
                </div>
              </div>
            )}
            <div className="kpis">
              <DrillKpi label="Priced material budget" value={fmtMoney(matSummary.priced)} onOpen={() => openMatDrill("Priced material budget", matSummary.priced, (d) => pricedBudgetDrill(d.mats))} />
              <DrillKpi label="Committed" value={fmtMoney(matSummary.committed)}
                sub={matSummary.unpriced > 0.005 ? `${fmtMoney(matSummary.committed + matSummary.unpriced)} incl. off-BOQ` : undefined}
                tone={matSummary.committed > matSummary.priced ? "danger" : "default"} onOpen={() => openMatDrill("Committed cost", matSummary.committed, (d) => committedDrill(d.mats))} />
              <DrillKpi label="Remaining" value={fmtMoney(matSummary.remaining)} tone={matSummary.remaining < 0 ? "danger" : "default"} />
              <DrillKpi label="Unpriced spend" value={fmtMoney(matSummary.unpriced)}
                tone={matSummary.unpriced > 0.005 ? "danger" : "default"} onOpen={() => openMatDrill("Unpriced spend", matSummary.unpriced, (d) => unpricedDrill(d.unpricedLines))} />
              <DrillKpi label="Quote savings" value={fmtMoney(matSummary.savings)} tone={matSummary.savings > 0.005 ? "success" : matSummary.savings < -0.005 ? "danger" : "default"} onOpen={() => openMatDrill("Quote savings", matSummary.savings, (d) => materialSavingsDrill(d.mats))} />
            </div>

            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-hd">
                <h2 style={{ flex: 1 }}>Combined materials</h2>
                <span className="pill">{combinedMaterials.length}</span>
                <button className="btn ghost tiny" onClick={exportMaterials} disabled={combinedMaterials.length === 0} title="Export to Excel">Export ⤓</button>
              </div>
              {combinedMaterials.length > 0 && (
                <div className="row" style={{ gap: 8, flexWrap: "wrap", padding: "0 16px 12px", alignItems: "center" }}>
                  <div className="seg" style={{ flexWrap: "wrap" }}>
                    {MAT_STATUS_CHIPS.map(([s, label]) => {
                      const count = s === "all" ? combinedMaterials.length
                        : s === "off_boq" ? combinedMaterials.filter((m) => m.offBoq).length
                        : (statusCounts[s as MatStatus] ?? 0);
                      if (s !== "all" && count === 0) return null;
                      return (
                        <button key={s} className={`seg-btn${matStatus === s ? " active" : ""}`} onClick={() => setMatStatus(s)}>
                          {label} <span className="pill" style={{ marginLeft: 4, fontSize: 10 }}>{count}</span>
                        </button>
                      );
                    })}
                  </div>
                  <span className="grow" />
                  <select
                    value={matSort ? `${matSort}:${matSortDir}` : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) { setMatSort(null); return; }
                      const [k, d] = v.split(":");
                      setMatSort(k as NonNullable<typeof matSort>);
                      setMatSortDir(d as "asc" | "desc");
                    }}
                    title="Order the list — the column headings sort too, this just puts the useful orders in one place"
                    style={{ maxWidth: 210 }}
                  >
                    <option value="">Sort: default</option>
                    <option value="material:asc">Material A–Z</option>
                    <option value="added:desc">Date added — newest</option>
                    <option value="added:asc">Date added — oldest</option>
                    <option value="modified:desc">Date modified — newest</option>
                    <option value="rate:desc">Price £/unit — high to low</option>
                    <option value="rate:asc">Price £/unit — low to high</option>
                    <option value="blocks:asc">Blocks</option>
                  </select>
                  <select value={matValueMode} onChange={(e) => setMatValueMode(e.target.value as "committed" | "calledoff")} title="Show committed or called-off quantities" style={{ maxWidth: 170 }}>
                    <option value="committed">Qty: Committed</option>
                    <option value="calledoff">Qty: Called off</option>
                  </select>
                  <input placeholder="Search material or supplier" value={matQuery} onChange={(e) => setMatQuery(e.target.value)} style={{ maxWidth: 240 }} />
                </div>
              )}
              {combinedMaterials.length === 0
                ? <div className="empty in-card"><p>No materials loaded for {block === "all" ? "this site" : "this block"} yet.</p></div>
                : visibleMaterials.length === 0
                ? <div className="empty in-card"><p>No materials match this filter.</p></div>
                : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ minWidth: 720 }}>
                      <thead>
                        <tr>
                          <th onClick={() => toggleMatSort("material")} style={{ cursor: "pointer" }}>Material{matSortArrow("material")}</th>
                          <th className="center">Unit</th>
                          <th className="num" onClick={() => toggleMatSort("usage")} style={{ cursor: "pointer" }}>{matValueMode === "calledoff" ? "Called off" : "Committed"} / BOQ{matSortArrow("usage")}</th>
                          <th className="num" onClick={() => toggleMatSort("rate")} style={{ cursor: "pointer" }} title="What we pay per unit (live quote / substitution / BOQ); the BOQ rate shows underneath when we buy cheaper or dearer">£/unit{matSortArrow("rate")}</th>
                          <th className="num" onClick={() => toggleMatSort("budget")} style={{ cursor: "pointer" }}>Budget{matSortArrow("budget")}</th>
                          <th className="num" onClick={() => toggleMatSort("committed")} style={{ cursor: "pointer" }}>{matValueMode === "calledoff" ? "Called off" : "Committed"}{matSortArrow("committed")}</th>
                          <th className="num" onClick={() => toggleMatSort("variance")} style={{ cursor: "pointer" }}>Variance{matSortArrow("variance")}</th>
                          <th className="center" onClick={() => toggleMatSort("status")} style={{ cursor: "pointer" }}>Status{matSortArrow("status")}</th>
                          <th className="center">Blocks</th>
                          {canUploadMaterials && <th className="center" style={{ width: 110 }}></th>}
                        </tr>
                      </thead>
                      <tbody>
                        {sortedMaterials.map((m) => {
                          const open = expandedMat === m.key;
                          const useQty = matValueMode === "calledoff" ? m.calledOffQty : m.committedQty;
                          const useSpend = matValueMode === "calledoff" ? m.calledOff : m.committed;
                          const useDelta = useSpend - m.budget;
                          const pct = m.boqQty > 0 ? Math.min(100, (useQty / m.boqQty) * 100) : (useQty > 0 ? 100 : 0);
                          const meta = STATUS_META[m.status];
                          const allBlocks = members.length > 1 && m.blocks.size === members.length;
                          const budgetRate = m.boqQty > 0.005 ? m.budget / m.boqQty : null;
                          const buyRate = m.boqQty > 0.005 ? m.effVal / m.boqQty
                            : m.committedQty > 0.005 ? m.committed / m.committedQty
                            : m.calledOffQty > 0.005 ? m.calledOff / m.calledOffQty
                            : null;
                          // Only the rows with a BOQ line behind them can be substituted.
                          const subMats = m.mats.filter((x) => !x.off_boq);
                          const rateDiffers = budgetRate != null && buyRate != null && Math.abs(buyRate - budgetRate) > Math.max(0.005, budgetRate * 0.005);
                          return (
                            <Fragment key={m.key}>
                              <tr onClick={() => setExpandedMat(open ? null : m.key)} style={{ cursor: "pointer", ...(open ? { background: "var(--accent-soft)" } : {}) }}>
                                <td>
                                  <div className="row" style={{ gap: 8, alignItems: "flex-start", flexWrap: "nowrap" }}>
                                    <span className="rep-group-chev" style={{ marginTop: 2, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
                                    <div style={{ minWidth: 0 }}>
                                      <div style={{ fontWeight: 600 }}>
                                        {m.item}
                                        {m.offBoq && (
                                          <span className="pill warn" style={{ fontSize: 10, marginLeft: 6, verticalAlign: "middle" }}
                                            title={`Added on a purchase order, not in the priced BOQ — there's no budget line behind it until the PO line is assigned to one${m.lastOrdered ? `. Last ordered ${fmtDate(m.lastOrdered)}` : ""}`}>
                                            off-BOQ
                                          </span>
                                        )}
                                      </div>
                                      <div className="muted" style={{ fontSize: 11 }}>
                                        {m.supplier.size === 1 ? [...m.supplier][0] : m.supplier.size > 1 ? "Mixed suppliers" : "Supplier TBC"}
                                        {m.lastOrdered && ` · last ordered ${fmtDate(m.lastOrdered)}`}
                                      </div>
                                    </div>
                                  </div>
                                </td>
                                <td className="center muted">{m.unit ?? "—"}</td>
                                <td className="num">
                                  {useQty > 0.005 || m.boqQty > 0.005 ? <b>{qty(useQty)}</b> : "—"}
                                  {m.boqQty > 0.005 && <span className="muted"> / {qty(m.boqQty)}</span>}
                                  {m.boqQty > 0.005 && (
                                    <div style={{ height: 3, borderRadius: 2, background: "var(--line)", marginTop: 5 }}>
                                      <div style={{ height: "100%", borderRadius: 2, width: `${pct}%`, background: STATUS_BAR[m.status] }} />
                                    </div>
                                  )}
                                </td>
                                <td className="num">
                                  {buyRate != null ? (
                                    <>
                                      <span style={rateDiffers ? { color: buyRate < budgetRate! ? "#2f9e44" : "var(--danger)", fontWeight: 600 } : undefined}>{fmtMoney(buyRate)}</span>
                                      {rateDiffers && <div className="muted" style={{ fontSize: 10.5 }}>BOQ {fmtMoney(budgetRate!)}</div>}
                                    </>
                                  ) : <span className="muted">—</span>}
                                </td>
                                <td className="num">{fmtMoney(m.budget)}</td>
                                <td className="num">{useSpend ? fmtMoney(useSpend) : "—"}</td>
                                <td className="num" style={{ color: useDelta > 0.005 ? "var(--danger)" : useDelta < -0.005 ? "#2f9e44" : undefined }}>{Math.abs(useDelta) > 0.005 ? fmtMoney(useDelta) : "—"}</td>
                                <td className="center"><span className={`pill ${meta.tone} dot`}>{meta.label}</span></td>
                                <td className="center">
                                  {allBlocks
                                    ? <span className="pill">All blocks</span>
                                    : [...m.blocks.keys()].sort().map((b) => <span key={b} className="pill" style={{ marginLeft: 4, fontSize: 10 }}>{b}</span>)}
                                </td>
                                {canUploadMaterials && (
                                  <td className="center" onClick={(e) => e.stopPropagation()}>
                                    {subMats.length === 0
                                      ? null
                                      : subMats.length === 1
                                      ? <SubstituteAction material={subMats[0]} onChanged={load} />
                                      : <button className="ghost tiny" onClick={() => setExpandedMat(open ? null : m.key)} title="Expand to substitute in a specific block">Substitute…</button>}
                                  </td>
                                )}
                              </tr>
                              {/* Block breakdown as REAL rows of the same table, so every
                                  figure sits exactly under its parent column. */}
                              {open && [...m.blocks.values()].sort((a, b) => a.code.localeCompare(b.code)).map((b) => {
                                const bQty = matValueMode === "calledoff" ? b.calledOffQty : b.committedQty;
                                const bSpend = matValueMode === "calledoff" ? b.calledOff : b.committed;
                                const bDelta = bSpend - b.budget;
                                const bBudgetRate = b.boqQty > 0.005 ? b.budget / b.boqQty : null;
                                const bBuyRate = b.boqQty > 0.005 ? b.effVal / b.boqQty
                                  : b.committedQty > 0.005 ? b.committed / b.committedQty
                                  : b.calledOffQty > 0.005 ? b.calledOff / b.calledOffQty
                                  : null;
                                const bDiff = bBudgetRate != null && bBuyRate != null && Math.abs(bBuyRate - bBudgetRate) > Math.max(0.005, bBudgetRate * 0.005);
                                const bSubMats = b.mats.filter((mat) => !mat.off_boq);
                                // This block's own off-BOQ orders. The merged row above totals
                                // every block and shows only the newest date, so without this a
                                // block's earlier purchase has no date and no PO anywhere on the
                                // page — you'd have to open that block's own project page.
                                const bOrders = b.mats
                                  .flatMap((mat) => mat.off_boq?.orders ?? [])
                                  .sort((x, y) => String(y.ordered_at ?? "").localeCompare(String(x.ordered_at ?? "")));
                                // Wording this block actually used, when it isn't the wording the
                                // merged row is titled with — the check on whether a row has
                                // pooled two different things.
                                const bAliases = [...new Set(b.mats.map((mat) => (mat.sub_item || mat.item || "").trim()))]
                                  .filter((n) => n && n !== m.item);
                                return (
                                  <tr key={`${m.key}-${b.code}`} style={{ background: "var(--accent-soft)", fontSize: 12.5 }}>
                                    <td colSpan={2} style={{ paddingLeft: 42 }}>
                                      <b style={{ color: "var(--accent)" }}>{b.code}</b>{" "}
                                      <span className="muted">{members.find((x) => x.code === b.code)?.name ?? ""}</span>
                                      {bAliases.length > 0 && (
                                        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}
                                          title="This block ordered it under different wording — merged onto this row by matching words">
                                          as “{bAliases.join("”, “")}”
                                        </div>
                                      )}
                                      {bOrders.slice(0, 3).map((o) => (
                                        <div key={o.line_id} style={{ fontSize: 11, marginTop: 2 }}>
                                          <Link to={`/pos/${o.po_id}`}>{o.po_number}</Link>
                                          <span className="muted">
                                            {o.ordered_at ? ` · ${fmtDate(o.ordered_at)}` : ""} · {qty(o.qty)} {m.unit ?? ""}
                                          </span>
                                        </div>
                                      ))}
                                      {bOrders.length > 3 && (
                                        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}
                                          title={bOrders.slice(3).map((o) => `${o.po_number} · ${fmtDate(o.ordered_at)} · ${qty(o.qty)} ${m.unit ?? ""}`).join("\n")}>
                                          +{bOrders.length - 3} earlier order{bOrders.length - 3 === 1 ? "" : "s"}
                                        </div>
                                      )}
                                    </td>
                                    <td className="num">{bQty > 0.005 ? qty(bQty) : "—"}{b.boqQty > 0.005 && <span className="muted"> / {qty(b.boqQty)}</span>}</td>
                                    <td className="num">
                                      {bBuyRate != null ? (
                                        <>
                                          <span style={bDiff ? { color: bBuyRate < bBudgetRate! ? "#2f9e44" : "var(--danger)" } : undefined}>{fmtMoney(bBuyRate)}</span>
                                          {bDiff && <div className="muted" style={{ fontSize: 10.5 }}>BOQ {fmtMoney(bBudgetRate!)}</div>}
                                        </>
                                      ) : <span className="muted">—</span>}
                                    </td>
                                    <td className="num">{fmtMoney(b.budget)}</td>
                                    <td className="num">{bSpend ? fmtMoney(bSpend) : "—"}</td>
                                    <td className="num" style={{ color: bDelta > 0.005 ? "var(--danger)" : bDelta < -0.005 ? "#2f9e44" : undefined }}>{Math.abs(bDelta) > 0.005 ? fmtMoney(bDelta) : "—"}</td>
                                    <td></td>
                                    <td></td>
                                    {canUploadMaterials && (
                                      <td className="num" style={{ whiteSpace: "nowrap" }}>
                                        {bSubMats.map((mat) => (
                                          <div key={mat.id} className="row" style={{ gap: 6, justifyContent: "flex-end", flexWrap: "nowrap", marginTop: bSubMats.length > 1 ? 2 : 0 }}>
                                            {bSubMats.length > 1 && <span className="muted" style={{ fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", maxWidth: 140 }}>{mat.sub_item || mat.item}</span>}
                                            <SubstituteAction material={mat} onChanged={load} />
                                          </div>
                                        ))}
                                      </td>
                                    )}
                                  </tr>
                                );
                              })}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              <p className="muted" style={{ padding: "8px 16px 14px", fontSize: 12.5 }}>Matching materials across blocks are merged into one line — click a row to see the per-block split. Status runs to-order → on-order → called-off → part-delivered → delivered (from committed vs delivered qty). Use <b>Substitute</b> to swap a material for a different supplier / brand / spec — a material in a single block swaps from this row; one that spans blocks expands so you can substitute per block.</p>
            </div>
          </>
        )}

        {tab === "programme" && base && <ProjectProgramme projectId={base.id} canEdit={canEdit} />}
        {tab === "operations" && base && <ProjectOperations projectId={base.id} canEdit={canEdit} project={baseProject} />}
        {tab === "reports" && base && (
          <ProjectReports
            projectId={base.id}
            canEdit={canEdit}
            members={scopeMembers.map((m) => ({ id: m.id, code: m.code, name: m.name }))}
          />
        )}
      </main>
    </>
  );
}

const jumpBtn: CSSProperties = { marginLeft: "auto", background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, padding: 0, minHeight: 0, width: "auto" };
const jumpLink: CSSProperties = { background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 13, padding: 0, minHeight: 0, width: "auto" };

/** Group "at a glance" Overview — mirrors the single-project Overview card layout
 *  (ProjectDetail's OverviewAtAGlance) but aggregated across the blocks in scope:
 *  summed forecast KPIs + outturn, the shared site's on-site-today, merged key
 *  dates, and needs-attention / recent-activity gathered from every contract. The
 *  detailed by-block commercial breakdown lives on the separate Commercials tab. */
function GroupOverview({ scopeMembers, data, fc, contract, baseId, scopeLabel, onJump, openForecastDrill }: {
  scopeMembers: Member[];
  data: Record<string, BlockData>;
  fc: Forecast;
  contract: { value: number; cost: number; gp: number; gpPct: number | null };
  baseId: string | null;
  scopeLabel: string;
  onJump: (t: GTab) => void;
  openForecastDrill: (m: ForecastDrill) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [attendance, setAttendance] = useState<Awaited<ReturnType<typeof api.opsAttendance>>>([]);
  const [plant, setPlant] = useState<Awaited<ReturnType<typeof api.opsPlant>>>([]);
  const [valuations, setValuations] = useState<Awaited<ReturnType<typeof api.listValuationEntries>>>([]);
  const [pos, setPos] = useState<Array<Awaited<ReturnType<typeof api.listPOs>>[number] & { __block: string }>>([]);
  const scopeKey = scopeMembers.map((m) => m.id).join(",");

  useEffect(() => {
    if (baseId) {
      api.opsAttendance(baseId, today).then(setAttendance).catch(() => setAttendance([]));
      api.opsPlant(baseId).then(setPlant).catch(() => setPlant([]));
    }
    Promise.all(scopeMembers.map((m) => api.listValuationEntries(m.id).catch(() => [])))
      .then((arrs) => setValuations(arrs.flat())).catch(() => setValuations([]));
    Promise.all(scopeMembers.map((m) => api.listPOs({ project_id: m.id }).then((rs) => rs.map((p) => ({ ...p, __block: m.code }))).catch(() => [])))
      .then((arrs) => setPos(arrs.flat())).catch(() => setPos([]));
  }, [baseId, scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // On site today (the shared site — resolved to the base contract)
  const onSiteNow = attendance.filter((a) => !a.signed_out_at).length;
  const dayspan = (from: string | null, to: string | null) => {
    if (!from) return 0;
    const a = new Date(from + "T00:00:00").getTime();
    const b = new Date((to ?? today) + "T00:00:00").getTime();
    return Math.max(1, Math.floor((b - a) / 86_400_000) + 1);
  };
  const plantOnHire = plant.filter((p) => !p.off_hire_to).length;
  const plantAccrued = plant.reduce((s, p) => {
    if (p.day_rate == null) return s;
    const d = dayspan(p.on_hire_from, p.off_hire_to);
    return s + p.day_rate * (p.rate_unit === "week" ? Math.ceil(d / 7) : d);
  }, 0);

  // Key dates — earliest upcoming entry per type across the blocks in scope
  const nextOf = (type: string) => valuations.filter((v) => v.entry_type === type && v.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
  const nextApp = nextOf("application");
  const nextDue = nextOf("due");
  const finalDate = nextOf("final_payment");
  const fmtShort = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const hasDates = !!(nextApp || nextDue || finalDate);

  // Needs attention — merged across blocks, each tagged with its block code
  const flags: Array<{ text: string; tone: string }> = [];
  for (const m of scopeMembers) {
    const d = data[m.id]; if (!d) continue;
    for (const a of d.afps.filter((x) => x.direction === "outgoing" && x.status === "submitted")) flags.push({ text: `${m.code} · AfP #${a.app_number} awaiting certification`, tone: "var(--warn)" });
    const openVars = d.variations.filter((v) => v.status === "open").length;
    if (openVars > 0) flags.push({ text: `${m.code} · ${openVars} open variation${openVars === 1 ? "" : "s"}`, tone: "var(--warn)" });
  }

  // Recent activity — merged VOs / AfPs / POs across blocks, newest first
  const acts: Array<{ date: string; text: string; sub: string }> = [];
  for (const m of scopeMembers) {
    const d = data[m.id]; if (!d) continue;
    for (const v of d.variations) if (v.created_at) acts.push({ date: v.created_at, text: `${m.code} · VO${v.variation_no} raised`, sub: (v.description ?? "").slice(0, 40) });
    for (const a of d.afps) { const dt = a.submitted_at ?? a.created_at; if (dt) acts.push({ date: dt, text: `${m.code} · AfP #${a.app_number} ${a.status.replace(/_/g, " ")}`, sub: a.cumulative_value != null ? fmtMoney(a.cumulative_value) : "" }); }
  }
  for (const p of pos) if (p.created_at) acts.push({ date: p.created_at, text: `${p.__block} · PO ${p.po_number} ${p.status.replace(/_/g, " ")}`, sub: p.total_value != null ? fmtMoney(p.total_value) : "" });
  acts.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const recent = acts.slice(0, 6);
  const fmtAct = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

  const profitDelta = fc.forecastProfit - contract.gp;
  const up = profitDelta >= 0;
  const marginDeltaPts = fc.forecastGpPct != null && contract.gpPct != null ? (fc.forecastGpPct - contract.gpPct) * 100 : null;

  return (
    <>
      <div className="eyebrow" style={{ marginBottom: 6 }}>{scopeLabel}</div>
      <div className="kpis">
        <DrillKpi label="Forecast final account" value={fmtMoney(fc.ffa)} sub={`Contract ${fmtMoney(contract.value)}`} />
        <DrillKpi label="Forecast final cost" value={fmtMoney(fc.ffc)} sub={`Budget ${fmtMoney(contract.cost)}`} />
        <DrillKpi label="Forecast profit" value={fmtMoney(fc.forecastProfit)} tone={moneyTone(fc.forecastProfit)} sub={`${up ? "▲ +" : "▼ "}${fmtMoney(profitDelta)} vs contract`} />
        <DrillKpi label="Forecast GP margin" value={fc.forecastGpPct != null ? `${(fc.forecastGpPct * 100).toFixed(1)}%` : "—"} tone={(fc.forecastGpPct ?? 0) >= 0.1 ? "success" : (fc.forecastGpPct ?? 0) < 0 ? "danger" : "warn"} sub={marginDeltaPts != null ? `${marginDeltaPts >= 0 ? "+" : ""}${marginDeltaPts.toFixed(1)} pts vs contract` : undefined} />
      </div>

      <ForecastDashboard f={fc} sections={["levers"]} onDrill={openForecastDrill} />

      <div className="dash-grid" style={{ marginTop: 16 }}>
        {/* LEFT */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card card-padded">
            <div className="card-hd" style={{ padding: 0, marginBottom: 10, alignItems: "baseline" }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Key dates</h3>
              <button onClick={() => onJump("commercials")} style={jumpBtn}>Schedule →</button>
            </div>
            {!hasDates ? <div className="muted" style={{ fontSize: 13 }}>No upcoming valuation dates across the blocks.</div> : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 14 }}>
                {nextApp && <DateCard label="Next application" date={fmtShort(nextApp.date)} sub={nextApp.app_number ? `AfP #${nextApp.app_number}` : ""} />}
                {nextDue && <DateCard label="Next due date" date={fmtShort(nextDue.date)} sub={nextDue.app_number ? `val #${nextDue.app_number}` : ""} />}
                {finalDate && <DateCard label="Final date for pmt" date={fmtShort(finalDate.date)} sub={finalDate.app_number ? `val #${finalDate.app_number}` : ""} navy />}
              </div>
            )}
          </div>

          <div className="card card-padded">
            <div className="card-hd" style={{ padding: 0, marginBottom: 10, alignItems: "baseline" }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>On site today</h3>
              <button onClick={() => onJump("operations")} style={jumpBtn}>Operations →</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <Glance label="On site now" value={String(onSiteNow)} tone={onSiteNow > 0 ? "success" : "default"} />
              <Glance label="Signed in today" value={String(attendance.length)} />
              <Glance label="Plant on hire" value={String(plantOnHire)} />
              <Glance label="Plant accrued" value={fmtMoney(plantAccrued)} />
            </div>
          </div>

          <div className="card card-padded">
            <div className="card-hd" style={{ padding: 0, marginBottom: 8 }}><h3 style={{ margin: 0, fontSize: 14 }}>Blocks</h3></div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {scopeMembers.map((m) => (
                <Link key={m.id} to={`/projects/${m.id}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--line)", padding: "9px 0", textDecoration: "none", color: "var(--ink)" }}>
                  <span style={{ fontSize: 13 }}><span className="pill" style={{ marginRight: 8 }}>{m.code}</span>{m.name}</span>
                  <span className="muted">›</span>
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card card-padded">
            <div className="card-hd" style={{ padding: 0, marginBottom: 8, alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Needs attention</h3>
              <span className={`pill ${flags.length ? "warn" : "ok"}`} style={{ marginLeft: "auto" }}>{flags.length || "0"}</span>
            </div>
            {flags.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>All clear — nothing outstanding across the blocks.</div> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {flags.map((fl, i) => (
                  <div key={i} className="row" style={{ alignItems: "center", gap: 10 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: fl.tone, flex: "0 0 auto" }} />
                    <span style={{ flex: 1, fontSize: 13 }}>{fl.text}</span>
                    <button onClick={() => onJump("commercials")} style={jumpLink}>View</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card card-padded">
            <div className="card-hd" style={{ padding: 0, marginBottom: 8 }}><h3 style={{ margin: 0, fontSize: 14 }}>Recent activity</h3></div>
            {recent.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>No recent activity.</div> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {recent.map((a, i) => (
                  <div key={i} className="row" style={{ alignItems: "baseline", gap: 10 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 999, background: i === 0 ? "var(--accent)" : "var(--line-strong)", flex: "0 0 auto", transform: "translateY(-1px)" }} />
                    <span style={{ flex: 1, fontSize: 13 }}>{a.text}{a.sub ? <span className="muted"> · {a.sub}</span> : null}</span>
                    <span className="muted num" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{fmtAct(a.date)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card card-padded">
            <div className="card-hd" style={{ padding: 0, marginBottom: 6 }}><h3 style={{ margin: 0, fontSize: 14 }}>Jump to</h3></div>
            {(([["commercials", "Commercials · Applications"], ["materials", "Materials · call-offs"], ["operations", "Operations · Attendance"]] as Array<[GTab, string]>)).map(([t, label]) => (
              <button key={t} onClick={() => onJump(t)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "none", border: "none", borderBottom: "1px solid var(--line)", padding: "10px 0", cursor: "pointer", width: "100%", font: "inherit", color: "var(--ink)", minHeight: 0 }}>
                <span style={{ fontSize: 13 }}>{label}</span>
                <span className="muted">›</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
