import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtDate, fmtMoney, fmtQty } from "../lib/api";
import { PAYMENT_TERMS_OPTIONS, APPLICATION_CADENCES } from "../../shared/payment-terms";
import { ContractUpload } from "./ContractUpload";
import { ContractPanel } from "./ContractPanel";
import { Topbar } from "./Shell";
import { can } from "../../shared/permissions";
import { VariationsView } from "./VariationsView";
import { ProjectOperations } from "./Operations";
import { ProjectProgramme } from "./Programme";
import { ProjectReports } from "./ProjectReports";
import { QitpDashboard } from "./QitpDashboard";
import { SubBadge, SubstituteAction } from "./MaterialSubstitute";
import type { ApplicationForPayment, CurrentUser, LabourByCostCode, MaterialWithCommitment, OffBoqMaterial, Project, ProjectCommercial, PurchaseOrder } from "../../shared/types";
import {
  summariseMaterials, computeForecast, matSupplier, contractTotals, effectiveSpendRate, quoteSavingsOf,
  pricedBudgetDrill, committedDrill, materialSavingsDrill,
  labourSavingsDrill, variationProfitDrill, unpricedDrill, unexpectedSpendDrill, applicationsDrill,
  offBoqRow, materialAddedAt, materialModifiedAt, type Forecast, type MatRow,
} from "../lib/commercials";
import { DrillPanel, DrillKpi, type DrillData } from "./DrillPanel";
import { AssignBudgetCell } from "./AssignBudgetCell";
import { generateMaterialsXlsx } from "../lib/materials-xlsx";

type Tab = "overview" | "materials" | "pos" | "commercials" | "programme" | "operations" | "reports" | "quality";
type CommercialsSubtab = "breakdown" | "prelims" | "schedule" | "applications" | "labour" | "variations" | "contract" | "help";
type MaterialsSubtab = "list" | "pos" | "help";

type ProjectPORow = PurchaseOrder & { project_code: string; project_name: string };

export function ProjectDetail({ me }: { me: CurrentUser | null }) {
  const nav = useNavigate();
  const canRaisePO = can(me?.role, "pos.create");
  const canUploadMaterials = can(me?.role, "materials.upload");
  const canEditProject = can(me?.role, "projects.edit");
  const canEditDelivery = can(me?.role, "delivery.edit");
  const canEditCommercial = can(me?.role, "commercial.edit");
  const canViewCommercial = can(me?.role, "commercial.view");
  const canDeleteProject = can(me?.role, "projects.delete");
  // Director-tier approvers sign off a variation's new budget for expenditure.
  const isDirector = !!(me?.is_approver && me.approver_tiers.includes("director"));
  const isSuperadmin = me?.role === "superadmin";
  const [showDelete, setShowDelete] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleting, setDeleting] = useState(false);
  const { id } = useParams<{ id: string }>();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.getProject>> | null>(null);
  const [poSummary, setPoSummary] = useState<Awaited<ReturnType<typeof api.getProjectSummary>> | null>(null);
  const [mats, setMats] = useState<MaterialWithCommitment[]>([]);
  // Materials that only exist on this project's POs. Deliberately NOT merged
  // into `mats`: their £ is already reported as unpriced spend, so folding them
  // into the budget rollups would bill the job for them twice.
  const [offBoq, setOffBoq] = useState<OffBoqMaterial[]>([]);
  const [commercials, setCommercials] = useState<ProjectCommercial[]>([]);
  const [contingency, setContingency] = useState(0);
  const [pendingUpload, setPendingUpload] = useState<Awaited<ReturnType<typeof api.getPendingUpload>>>(null);
  const [labour, setLabour] = useState<LabourByCostCode[]>([]);
  const [contractItems, setContractItems] = useState<import("../../shared/types").ContractItem[]>([]);
  const [afps, setAfps] = useState<ApplicationForPayment[]>([]);
  const [variations, setVariations] = useState<import("../../shared/types").Variation[]>([]);
  const [projectPOs, setProjectPOs] = useState<ProjectPORow[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [drill, setDrill] = useState<DrillData | null>(null);
  // One-shot: when set, the Operations tab jumps to Deliveries and opens the
  // check-in form. Driven by the "Check in a delivery" topbar action (the
  // primary action on phones, where deliveries get logged far more than POs).
  const [autoOpenDelivery, setAutoOpenDelivery] = useState(false);
  const [matSubtab, setMatSubtab] = useState<MaterialsSubtab>("list");
  const [filter, setFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("");
  const [orderFilter, setOrderFilter] = useState<"" | "framework" | "calloff" | "omitted" | "offboq">(""); // framework/call-off/off-BOQ/omitted filter
  // Whether the materials table's quantity column shows committed (incl. framework
  // reservation) or only what's actually been called off against frameworks.
  const [qtyMode, setQtyMode] = useState<"committed" | "calledoff">("committed");
  // Click-to-sort on the materials table headings.
  const [sortKey, setSortKey] = useState<"type" | "item" | "supplier" | "boq" | "live" | "priced" | "committed" | "remaining" | "rate" | "added" | "modified" | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function toggleSort(k: NonNullable<typeof sortKey>) {
    if (sortKey === k) { setSortDir((d) => (d === "asc" ? "desc" : "asc")); return; }
    setSortKey(k);
    // Text columns read best A→Z; number columns read best high→low first.
    setSortDir(k === "type" || k === "item" || k === "supplier" ? "asc" : "desc");
  }
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function load() {
    if (!id) return;
    api.getProject(id).then(setInfo).catch((e) => setErr(e.message));
    api.listMaterials(id).then(setMats).catch((e) => setErr(e.message));
    api.listOffBoqMaterials(id).then(setOffBoq).catch(() => setOffBoq([]));
    api.listProjectCommercials(id).then(setCommercials).catch(() => setCommercials([]));
    api.getContingency(id).then((r) => setContingency(r.contingency)).catch(() => setContingency(0));
    api.getPendingUpload(id).then(setPendingUpload).catch(() => setPendingUpload(null));
    api.listLabourByCostCode(id).then(setLabour).catch(() => setLabour([]));
    api.listContractItems(id).then(setContractItems).catch(() => setContractItems([]));
    api.listVariations(id).then(setVariations).catch(() => setVariations([]));
    // Fetch BOTH directions so the Outgoing/Incoming labour toggle has data
    // for either side without re-fetching when the user flips it.
    Promise.all([
      api.listAfps(id, "outgoing"),
      api.listAfps(id, "incoming_labour"),
    ])
      .then(([out, inc]) => setAfps([...out, ...inc]))
      .catch(() => setAfps([]));
    api.getProjectSummary(id).then(setPoSummary).catch((e) => setErr(e.message));
    api.listPOs({ project_id: id })
      .then((rs) => setProjectPOs(rs as ProjectPORow[]))
      .catch(() => setProjectPOs([]));
  }
  useEffect(load, [id]);

  async function toggleComplete() {
    if (!id || !info) return;
    setBusy(true); setErr(null);
    try {
      if (info.project.completed_at) await api.reopenProject(id);
      else await api.completeProject(id);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "couldn't update project status");
    } finally { setBusy(false); }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f || !id) return;
    setBusy(true); setErr(null); setNotice(null);
    try {
      const res = await api.uploadMaterials(id, f);
      // Guard against silent blank-Overview uploads: if the workbook's
      // "Summary Cost Sheet" has no values, materials import but there are no
      // commercials (no contract value / forecast). Flag it loudly instead of
      // leaving the Overview looking empty.
      if (res.rows > 0 && res.commercials === 0) {
        setNotice(
          `Imported ${res.rows} material rows, but the workbook's “Summary Cost Sheet” came through with no figures — so there's no contract value or commercials. Those totals are formula-driven, so this usually means the file was saved without recalculating: open it in Excel, press save, then re-upload and the contract value will import.`,
        );
      }
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const summary = useMemo(() => summariseMaterials(mats, poSummary?.unpriced_spend ?? 0), [mats, poSummary]);

  const pricedCount = mats.filter((m) => (m.total_units ?? 0) > 0).length;
  // Quote savings = buy rate (applied quote OR approved substitution) vs the
  // BOQ-budgeted cost, on the priced quantity — the shared quoteSavingsOf
  // basis, so this card always equals the forecast's materials lever.
  const quotedMats = mats.filter((m) => !m.omitted && m.cost != null && (m.live_unit_price != null || m.sub_id != null));
  const quoteSavings = quoteSavingsOf(mats);
  // Omitted materials hide from every view except the explicit "Omitted"
  // filter (where they can be restored).
  const omittedCount = mats.filter((m) => m.omitted).length;
  // Off-BOQ rows always list, regardless of "Show full library": they aren't
  // part of the priced library, and they're being bought on this job whether or
  // not the workbook knows about them. They carry no `omitted` flag, so the
  // filter below drops them from the Omitted view on its own.
  const offBoqRows = useMemo(() => offBoq.map((o, i) => offBoqRow(o, i)), [offBoq]);
  const baseList: MatRow[] = [
    ...(showAll ? mats : mats.filter((m) => (m.total_units ?? 0) > 0)),
    ...offBoqRows,
  ].filter((m) => (orderFilter === "omitted" ? !!m.omitted : !m.omitted));
  const types = [...new Set(baseList.map((m) => m.type))].sort();
  const suppliers = [...new Set(baseList.map((m) => matSupplier(m) || "—"))].sort();
  const visible = baseList
    .filter((m) => !typeFilter || m.type === typeFilter)
    .filter((m) => !supplierFilter || (matSupplier(m) || "—") === supplierFilter)
    .filter((m) => !orderFilter || orderFilter === "omitted"
      || (orderFilter === "offboq" ? !!m.off_boq
        : orderFilter === "calloff" ? (m.called_off_qty ?? 0) > 0.0001
        : (m.framework_reserved_qty ?? 0) > 0.0001))
    .filter((m) => !filter || (m.item + (m.sub_item ?? "") + matSupplier(m)).toLowerCase().includes(filter.toLowerCase()));
  // Click-to-sort: value per material for the active sort column. Called-off mode
  // sorts the qty column by called-off; otherwise by committed.
  const sortValue = (m: MatRow, k: NonNullable<typeof sortKey>): string | number => {
    switch (k) {
      case "type": return (m.type ?? "").toLowerCase();
      case "item": return ((m.sub_item ?? m.item) ?? "").toLowerCase();
      case "supplier": return (matSupplier(m) ?? "").toLowerCase();
      case "boq": return m.sub_cost ?? m.cost ?? 0;
      case "live": return m.live_unit_price ?? -1;
      case "priced": return m.total_units ?? 0;
      case "committed": return qtyMode === "calledoff" ? (m.called_off_qty ?? 0) : (m.committed_qty ?? 0);
      case "remaining": return m.remaining_qty ?? 0;
      // What we actually pay: live quote → substitution blend → BOQ cost, and
      // for an off-BOQ row the rate it was bought at. Sorting on the BOQ cost
      // column instead would read £0 for everything bought off the bill.
      case "rate": return effectiveSpendRate(m);
      // Undated rows sort last in either direction (handled below) rather than
      // posing as the oldest thing on the job.
      case "added": return materialAddedAt(m) ?? "";
      case "modified": return materialModifiedAt(m) ?? "";
    }
  };
  const sortedVisible = sortKey == null ? visible : [...visible].sort((a, b) => {
    const va = sortValue(a, sortKey), vb = sortValue(b, sortKey);
    // A material with no date can't be newest or oldest — park it at the bottom
    // whichever way the sort runs.
    if ((sortKey === "added" || sortKey === "modified") && (va === "" || vb === "")) {
      return va === vb ? 0 : va === "" ? 1 : -1;
    }
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return sortDir === "asc" ? c : -c;
  });
  const sortArrow = (k: NonNullable<typeof sortKey>) => (sortKey === k ? (sortDir === "asc" ? " ▲" : " ▼") : "");
  // Call-off rollup for the filtered set — "what's been called off to date" (and
  // what's still reserved on a framework awaiting call-off). Unit cost = the
  // effective spend rate (live quote → substitution → BOQ cost).
  // Shared with the group page so both price call-offs identically (live
  // quote → substitution blend → BOQ cost).
  const unitSpend = (m: MaterialWithCommitment) => effectiveSpendRate(m);
  const calledOffValue = visible.reduce((s, m) => s + (m.called_off_qty ?? 0) * unitSpend(m), 0);
  const reservedValue = visible.reduce((s, m) => s + Math.max(0, (m.framework_reserved_qty ?? 0) - (m.called_off_qty ?? 0)) * unitSpend(m), 0);
  const calledOffCount = visible.filter((m) => (m.called_off_qty ?? 0) > 0.0001).length;
  function exportMaterialsXlsx() {
    const scope = orderFilter === "calloff" ? "Called off to date" : orderFilter === "framework" ? "On a framework" : "All materials";
    const code = info?.project.code ?? "project";
    const bytes = generateMaterialsXlsx(visible, code, scope);
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const url = URL.createObjectURL(new Blob([ab], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a"); a.href = url; a.download = `materials-${code}${orderFilter ? `-${orderFilter}` : ""}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  }

  // ── Forecast: the commercial dashboard shown on the Overview tab ──────────
  async function saveContingency(amount: number) {
    if (!id) return;
    setContingency(amount); // optimistic — forecast recomputes immediately
    try { await api.setContingency(id, amount); }
    catch { api.getContingency(id).then((r) => setContingency(r.contingency)).catch(() => {}); }
  }

  // Forecast outturn — computed by the shared commercials module so the group
  // page (and dashboard) roll up from the exact same maths and can't drift.
  const forecast = useMemo(
    () => computeForecast({ commercials, variations, contractItems, afps, mats, contingency, summary }),
    [commercials, variations, contractItems, afps, mats, contingency, summary],
  );

  // Open the slide-over listing exactly what makes up a forecast lever / applied
  // figure (the same builders the group page uses).
  const forecastDrill = (m: ForecastDrill) => {
    switch (m) {
      case "materials": setDrill({ title: "Profit / loss from materials", value: fmtMoney(forecast.materialSavings), ...materialSavingsDrill(mats) }); break;
      case "labour": setDrill({ title: "Profit / loss from labour", value: fmtMoney(forecast.labourSavings), ...labourSavingsDrill(contractItems) }); break;
      case "variations": setDrill({ title: "Profit / loss from variations", value: fmtMoney(forecast.varProfit), ...variationProfitDrill(variations) }); break;
      case "unexpected": {
        const body = unexpectedSpendDrill(poSummary?.unpriced_lines ?? [], mats);
        // Off-BOQ rows can be coded to a budget item right from the drill.
        if (can(me?.role, "pos.edit")) {
          body.columns = [...body.columns, {
            key: "__assign", label: "",
            fmt: (_v, row) => (row.__line_id != null
              ? <AssignBudgetCell poId={String(row.__po_id)} lineId={Number(row.__line_id)} mats={mats}
                            suggestId={row.__suggest_id as number | undefined} suggestItem={row.__suggest_item as string | undefined}
                  onAssigned={() => { if (id) { api.getProjectSummary(id).then(setPoSummary).catch(() => {}); api.listMaterials(id).then(setMats).catch(() => {}); } }} />
              : null),
          }];
        }
        setDrill({ title: "Unexpected spend", value: fmtMoney(forecast.unexpectedSpend), ...body });
        break;
      }
      case "applied": setDrill({ title: "Applied value", value: fmtMoney(forecast.appliedValue), ...applicationsDrill(afps, "applied") }); break;
      case "certified": setDrill({ title: "Certified value", value: fmtMoney(forecast.certifiedValue), ...applicationsDrill(afps, "certified") }); break;
    }
  };

  // PO tab notification = only purchase orders awaiting approval.
  const poPendingCount = projectPOs.filter((p) => p.status === "pending_approval").length;

  if (!info) return <main className="muted">Loading…</main>;

  // Raising a PO lives on the Materials tab (not the project header), per the
  // design system. Sits alongside the quote-upload action in the sub-nav.
  const matActions = (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto" }}>
      {canRaisePO && id && <Link className="btn accent tiny" to={`/projects/${id}/new-po`}>+ Raise PO</Link>}
      {canRaisePO && id && <Link className="btn ghost tiny" to={`/projects/${id}/new-plant-po`}>+ Plant hire</Link>}
      {canUploadMaterials && id && <ProjectQuoteUpload projectId={id} disabled={mats.length === 0} />}
    </div>
  );

  return (
    <>
      <DrillPanel drill={drill} onClose={() => setDrill(null)} />
      <Topbar
        crumbs={<><Link to="/">Projects</Link> / {info.project.code}</>}
        title={info.project.name}
        actions={
          <>
            {canEditProject && (
              <button className="ghost" onClick={toggleComplete} disabled={busy}>
                {info.project.completed_at ? "Re-open project" : "Mark complete"}
              </button>
            )}
            {canDeleteProject && (
              <button className="danger hide-on-mobile" onClick={() => setShowDelete(true)}>Delete project</button>
            )}
            {canEditProject && (
              <button
                className="btn accent"
                onClick={() => { setTab("operations"); setAutoOpenDelivery(true); }}
              >
                + Check in a delivery
              </button>
            )}
          </>
        }
      />
      <main>
        {err && <div className="flash error">{err}</div>}
        {notice && <div className="flash info">{notice}</div>}
        {info.project.is_sandbox ? (
          <div className="flash info" style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span aria-hidden style={{ fontSize: 16 }}>🧪</span>
            <div>
              <strong>This is the demo / sandbox project.</strong> Play freely — raise POs, check in deliveries, generate reports.
              It never pushes to Xero or sends real emails, it's kept out of the dashboard, and it resets to a clean baseline every night.
            </div>
          </div>
        ) : null}
        <div className="row" style={{ gap: 10, alignItems: "center", marginTop: 0, flexWrap: "wrap" }}>
          {info.project.completed_at && (
            <span className="pill approved" title={`Completed ${fmtDate(info.project.completed_at)}${info.project.completed_by ? ` by ${info.project.completed_by}` : ""}`}>
              ✓ Completed{info.project.completed_at ? ` · ${fmtDate(info.project.completed_at)}` : ""}
            </span>
          )}
          {info.project.client && <span className="muted">Client · {info.project.client}</span>}
          {info.project.payment_terms && <span className="muted">Terms · {info.project.payment_terms}</span>}
        </div>

        {showDelete && (
          <div className="card">
            <div className="card-hd"><h3>Delete {info.project.code}</h3></div>
            <div className="card-bd">
              <p className="muted" style={{ marginTop: 0 }}>
                Soft-deletes the project. It vanishes from the Projects list and dashboards,
                its purchase orders disappear too, and its committed value rolls off the books.
                The audit trail is preserved and the project code <b>{info.project.code}</b> is
                freed for re-use. Superadmin only.
              </p>
              <label>Reason (required)</label>
              <textarea
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                rows={3}
                placeholder="e.g. project cancelled, duplicate of another job, raised in error…"
                style={{ resize: "vertical" }}
              />
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  className="danger"
                  disabled={deleting || !deleteReason.trim()}
                  onClick={async () => {
                    if (!id) return;
                    setDeleting(true); setErr(null);
                    try {
                      await api.deleteProject(id, deleteReason.trim());
                      nav("/");
                    } catch (e) {
                      setErr(e instanceof Error ? e.message : "delete failed");
                      setDeleting(false);
                    }
                  }}
                >
                  {deleting ? "Deleting…" : "Confirm delete"}
                </button>
                <button className="ghost" onClick={() => setShowDelete(false)}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        <ProjectSettingsBlock project={info.project} onSaved={load} canEdit={canEditProject} />

        <nav className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "overview"}
            className={`tab-btn${tab === "overview" ? " active" : ""}`}
            onClick={() => setTab("overview")}
          >
            Overview
          </button>
          {(commercials.length > 0 || labour.length > 0) && can(me?.role, "commercial.view") && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "commercials"}
              className={`tab-btn${tab === "commercials" ? " active" : ""}`}
              onClick={() => setTab("commercials")}
            >
              Commercials
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={tab === "materials"}
            className={`tab-btn${tab === "materials" ? " active" : ""}`}
            onClick={() => setTab("materials")}
          >
            Materials
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "pos"}
            className={`tab-btn${tab === "pos" ? " active" : ""}`}
            onClick={() => setTab("pos")}
          >
            Purchase orders{poPendingCount > 0 && <span className="count" title="Awaiting approval">{poPendingCount}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "programme"}
            className={`tab-btn${tab === "programme" ? " active" : ""}`}
            onClick={() => setTab("programme")}
          >
            Programme
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "operations"}
            className={`tab-btn${tab === "operations" ? " active" : ""}`}
            onClick={() => setTab("operations")}
          >
            Operations
          </button>
          {info.has_qitp && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "quality"}
              className={`tab-btn${tab === "quality" ? " active" : ""}`}
              onClick={() => setTab("quality")}
            >
              Quality
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={tab === "reports"}
            className={`tab-btn${tab === "reports" ? " active" : ""}`}
            onClick={() => setTab("reports")}
          >
            Reports
          </button>
        </nav>

        {tab === "materials" && pendingUpload && (
          <PendingUploadBanner pending={pendingUpload} isSuper={isSuperadmin} projectId={id ?? ""} onChanged={load} />
        )}

        {tab === "quality" ? (
          <QitpDashboard me={me} embedded />
        ) : tab === "operations" ? (
          <ProjectOperations
            projectId={id ?? ""}
            canEdit={canEditDelivery}
            project={info.project}
            autoOpenDelivery={autoOpenDelivery}
            onDeliveryFormOpened={() => setAutoOpenDelivery(false)}
          />
        ) : tab === "programme" ? (
          <ProjectProgramme projectId={id ?? ""} canEdit={canEditDelivery} />
        ) : tab === "reports" ? (
          <ProjectReports projectId={id ?? ""} canEdit={canEditDelivery} />
        ) : tab === "commercials" ? (
          <CommercialsBreakdown
            rows={commercials}
            projectId={id ?? ""}
            canEdit={canEditCommercial}
            canRaisePO={canRaisePO}
            canApprove={isDirector}
            afps={afps}
            onAfpsRefresh={load}
            labour={labour}
            contractItems={contractItems}
            forecast={forecast}
            onForecastDrill={forecastDrill}
            contingency={contingency}
            onSetContingency={saveContingency}
          />
        ) : tab === "pos" ? (
          <>
            <div className="row" style={{ marginBottom: 16, alignItems: "center", gap: 8 }}>
              <h2 style={{ flex: 1, margin: 0, fontSize: 18 }}>Purchase orders</h2>
              {canRaisePO && id && <Link className="btn accent" to={`/projects/${id}/new-po`}>+ Raise PO</Link>}
              {canRaisePO && id && <Link className="btn ghost" to={`/projects/${id}/new-plant-po`}>+ Plant hire</Link>}
            </div>
            <ProjectPOsPanel rows={projectPOs} />
          </>
        ) : tab === "materials" && matSubtab === "help" ? (
          <>
            <MaterialsSubnav active="help" onChange={setMatSubtab}
              right={matActions} />
            <MaterialsHelpPanel />
          </>
        ) : (
        <>
        {tab === "materials" && (
          <MaterialsSubnav active="list" onChange={setMatSubtab}
            right={matActions} />
        )}
        {(mats.length > 0 || (tab === "materials" && offBoqRows.length > 0)) && (
          <>
            {tab === "overview" && commercials.length > 0 && canViewCommercial && (
              <CommercialsHeadlineKpis rows={commercials} />
            )}
            {tab === "overview" && commercials.length > 0 && canViewCommercial && <ForecastDashboard f={forecast} sections={["forecast"]} />}
            {tab === "overview" && commercials.length > 0 && canViewCommercial && (
              <OverviewAtAGlance projectId={id ?? ""} forecast={forecast} commercials={commercials} afps={afps} variations={variations} projectPOs={projectPOs} canViewCommercial={canViewCommercial} overdrawnFrameworkCount={poSummary?.overdrawn_framework_lines?.length ?? 0} onJump={setTab} />
            )}

            {/* Delivery roles (PM/site) don't see commercials — they get an operational overview. */}
            {tab === "overview" && !canViewCommercial && (
              <OperationalOverview projectId={id ?? ""} projectPOs={projectPOs} onJump={setTab} />
            )}

            {tab === "overview" && commercials.length === 0 && canViewCommercial && (
              <div className="flash info">
                <strong>No commercials for this project.</strong> The pricing workbook's
                “Summary Cost Sheet” came through with no calculated contract total — those
                cells are formula-driven, so the file likely needs recalculating. Open the
                workbook in Excel, press save, then re-upload; the contract value, GP and
                forecast will then appear (only the material budget shows below).
              </div>
            )}

            {(tab === "materials" || (tab === "overview" && commercials.length === 0)) && (
            <div className="kpis">
              <DrillKpi label="Priced material budget" value={fmtMoney(summary.priced_total)}
                onOpen={() => setDrill({ title: "Priced material budget", value: fmtMoney(summary.priced_total), ...pricedBudgetDrill(mats) })} />
              {/* The headline is everything committed on the job. The split sits
                  underneath, because the two halves behave differently: only the
                  budget half draws on the allowance that Remaining reports. */}
              <DrillKpi label="Committed" value={fmtMoney(summary.committed_total)}
                sub={summary.off_boq_committed > 0.005
                  ? `${fmtMoney(summary.boq_committed)} against budget · ${fmtMoney(summary.off_boq_committed)} off-BOQ`
                  : `${summary.committed_pct.toFixed(0)}% of budget`}
                tone={summary.boq_committed > summary.priced_total ? "danger" : "default"}
                onOpen={() => setDrill({ title: "Committed cost", value: fmtMoney(summary.committed_total), ...committedDrill(mats, poSummary?.unpriced_lines ?? []) })} />
              {/* Measured against the priced bill only — off-BOQ spend consumes no
                  allowance, so it must not appear to eat headroom that is still
                  there to order against. The label says so. */}
              <Kpi label="Remaining" value={fmtMoney(summary.remaining_total)}
                sub={summary.remaining_total < 0 ? `Over by ${fmtMoney(Math.abs(summary.remaining_total))}` : "Against the priced budget"}
                tone={summary.remaining_total < 0 ? "danger" : summary.remaining_total === 0 ? "success" : "default"} />
              <DrillKpi label="Unpriced spend" value={fmtMoney(summary.unpriced_spend)}
                sub={summary.unpriced_spend > 0 ? "Outside the BOQ" : "None"}
                tone={summary.unpriced_spend > 0 ? "danger" : "default"}
                onOpen={() => {
                  const body = unpricedDrill(poSummary?.unpriced_lines ?? []);
                  // Same in-place "assign to a budget item" as the unexpected-spend drill.
                  if (can(me?.role, "pos.edit")) {
                    body.columns = [...body.columns, {
                      key: "__assign", label: "",
                      fmt: (_v, row) => (row.__line_id != null
                        ? <AssignBudgetCell poId={String(row.__po_id)} lineId={Number(row.__line_id)} mats={mats}
                            suggestId={row.__suggest_id as number | undefined} suggestItem={row.__suggest_item as string | undefined}
                            onAssigned={() => { if (id) { api.getProjectSummary(id).then(setPoSummary).catch(() => {}); api.listMaterials(id).then(setMats).catch(() => {}); } }} />
                        : null),
                    }];
                  }
                  setDrill({ title: "Unpriced spend", value: fmtMoney(summary.unpriced_spend), ...body });
                }} />
              {quotedMats.length > 0 && (
                <DrillKpi
                  label="Quote savings"
                  value={fmtMoney(quoteSavings)}
                  sub={`vs BOQ · ${quotedMats.length} item${quotedMats.length === 1 ? "" : "s"} quoted`}
                  tone={quoteSavings > 0.005 ? "success" : quoteSavings < -0.005 ? "danger" : "default"}
                  onOpen={() => setDrill({ title: "Quote savings", value: fmtMoney(quoteSavings), ...materialSavingsDrill(mats) })}
                />
              )}
            </div>
            )}

            {tab === "materials" && matSubtab === "list" && summary.by_supplier.length > 0 && (
            <div className="card">
              <div className="card-hd"><h2>By supplier</h2></div>
              <table>
                <thead>
                  <tr>
                    <th>Supplier</th>
                    <th className="num">Items</th>
                    <th className="num">Priced</th>
                    <th className="num">Committed</th>
                    <th className="num">Remaining</th>
                    <th style={{ width: 200 }}>Usage</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.by_supplier.map((s) => {
                    const pct = s.priced > 0 ? Math.min(100, (s.committed / s.priced) * 100) : 0;
                    const over = s.committed > s.priced && s.priced > 0;
                    const exact = s.priced > 0 && Math.abs(s.committed - s.priced) < 0.005;
                    return (
                      <tr key={s.supplier}>
                        <td>{s.supplier}</td>
                        <td className="num">{s.items}</td>
                        <td className="num">{fmtMoney(s.priced)}</td>
                        <td className="num">{fmtMoney(s.committed)}</td>
                        <td className="num">{s.priced > 0 ? fmtMoney(s.priced - s.committed) : <span className="muted">—</span>}</td>
                        <td>
                          <div className="bar"><div className={over ? "danger" : exact ? "ok" : ""} style={{ width: `${pct}%` }} /></div>
                          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{pct.toFixed(0)}%</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            )}

            {tab === "materials" && (
              <div className="card">
                <div className="card-hd">
                  <h2 style={{ flex: 1 }}>
                    Materials
                    <span className="muted" style={{ fontWeight: 400, marginLeft: 10, fontSize: 13, fontFamily: "var(--font-sans)" }}>
                      {showAll ? `${mats.length} in library` : `${pricedCount} priced for this job`}
                      {offBoqRows.length > 0 && ` · ${offBoqRows.length} added on POs`}
                    </span>
                  </h2>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)", marginBottom: 0, textTransform: "none", letterSpacing: 0 }}>
                    <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} style={{ minHeight: 0 }} />
                    Show full library
                  </label>
                  <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} />
                  <select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}>
                    <option value="">All suppliers</option>
                    {suppliers.map((s) => <option key={s} value={s}>{s === "—" ? "Unassigned" : s}</option>)}
                  </select>
                  <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                    <option value="">All types</option>
                    {types.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <select value={orderFilter} onChange={(e) => setOrderFilter(e.target.value as "" | "framework" | "calloff" | "omitted" | "offboq")} title="Filter by framework call-off status, or show only what was bought outside the bill">
                    <option value="">All orders</option>
                    <option value="framework">On a framework</option>
                    <option value="calloff">Called off to date</option>
                    {offBoqRows.length > 0 && <option value="offboq">Off-BOQ ({offBoqRows.length})</option>}
                    {omittedCount > 0 && <option value="omitted">Omitted ({omittedCount})</option>}
                  </select>
                  <select
                    value={sortKey ? `${sortKey}:${sortDir}` : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) { setSortKey(null); return; }
                      const [k, d] = v.split(":");
                      setSortKey(k as NonNullable<typeof sortKey>);
                      setSortDir(d as "asc" | "desc");
                    }}
                    title="Order the list — the column headings sort too, this just puts the useful orders in one place"
                  >
                    <option value="">Sort: default</option>
                    <option value="item:asc">Material A–Z</option>
                    <option value="added:desc">Date added — newest</option>
                    <option value="added:asc">Date added — oldest</option>
                    <option value="modified:desc">Date modified — newest</option>
                    <option value="rate:desc">Price £/unit — high to low</option>
                    <option value="rate:asc">Price £/unit — low to high</option>
                    <option value="supplier:asc">Supplier A–Z</option>
                  </select>
                  <select value={qtyMode} onChange={(e) => setQtyMode(e.target.value as "committed" | "calledoff")} title="Quantity column: committed (incl. framework reservation) or only what's been called off">
                    <option value="committed">Qty: Committed</option>
                    <option value="calledoff">Qty: Called off</option>
                  </select>
                  <button className="btn ghost tiny" onClick={exportMaterialsXlsx} title="Export the listed materials (respecting the filter above) to Excel">⤓ Excel</button>
                </div>
                {orderFilter && (
                  <div className="row" style={{ padding: "0 16px 12px", gap: 16, flexWrap: "wrap", fontSize: 12.5 }}>
                    <span className="muted">
                      {orderFilter === "calloff"
                        ? <><b style={{ color: "var(--ink)" }}>{fmtMoney(calledOffValue)}</b> called off to date across <b style={{ color: "var(--ink)" }}>{calledOffCount}</b> material{calledOffCount === 1 ? "" : "s"}</>
                        : <><b style={{ color: "var(--ink)" }}>{visible.length}</b> material{visible.length === 1 ? "" : "s"} on a framework · <b style={{ color: "var(--ink)" }}>{fmtMoney(calledOffValue)}</b> called off</>}
                    </span>
                    {reservedValue > 0.005 && <span className="muted">·&nbsp; <b style={{ color: "var(--warn)" }}>{fmtMoney(reservedValue)}</b> still reserved, awaiting call-off</span>}
                  </div>
                )}
                <table>
                  <thead>
                    <tr className="sortable-head">
                      <th className="center" onClick={() => toggleSort("type")} style={{ cursor: "pointer" }}>Type{sortArrow("type")}</th>
                      <th onClick={() => toggleSort("item")} style={{ cursor: "pointer" }}>Item{sortArrow("item")}</th>
                      <th className="center" onClick={() => toggleSort("supplier")} style={{ cursor: "pointer" }}>Supplier{sortArrow("supplier")}</th>
                      <th className="num" onClick={() => toggleSort("boq")} style={{ cursor: "pointer" }}>BOQ cost{sortArrow("boq")}</th>
                      <th className="num" onClick={() => toggleSort("live")} style={{ cursor: "pointer" }}>Live{sortArrow("live")}</th>
                      <th className="center">Unit</th>
                      <th className="num" onClick={() => toggleSort("priced")} style={{ cursor: "pointer" }}>Priced{sortArrow("priced")}</th>
                      <th className="num" onClick={() => toggleSort("committed")} style={{ cursor: "pointer" }}>{qtyMode === "calledoff" ? "Called off" : "Committed"}{sortArrow("committed")}</th>
                      <th className="num" onClick={() => toggleSort("remaining")} style={{ cursor: "pointer" }}>Remaining{sortArrow("remaining")}</th>
                      <th className="center" style={{ width: 140 }}>Usage</th>
                      {canUploadMaterials && <th style={{ width: 90 }}></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedVisible.map((m) => {
                      const omittedQty = m.omitted_qty ?? 0;
                      // Budget quantity net of a partial omission — every figure
                      // on the row (remaining, usage, exact) prices the net qty.
                      const priced = Math.max(0, (m.total_units ?? 0) - omittedQty);
                      const committed = m.committed_qty ?? 0;
                      const isOriginallyUnpriced = priced === 0;
                      const pct = priced > 0 ? Math.min(100, (committed / priced) * 100) : (committed > 0 ? 100 : 0);
                      const remaining = m.remaining_qty;
                      const over = remaining != null && remaining < 0;
                      const exact = priced > 0 && Math.abs(committed - priced) < 0.005;
                      // Framework-reserved (light) vs firm/called-off (solid). A
                      // framework reserves committed_qty; as call-offs are drawn,
                      // the solid fill (standard POs + called-off) grows across it.
                      const calledOff = m.called_off_qty ?? 0;
                      const fwReserved = m.framework_reserved_qty ?? 0;
                      const hasReservation = fwReserved > 0.0001;
                      const firm = Math.max(0, committed - fwReserved) + calledOff;
                      const firmPct = priced > 0 ? Math.min(100, (firm / priced) * 100) : (firm > 0 ? 100 : 0);
                      const unit = m.total_units_unit ?? m.pack_unit ?? "";
                      const live = m.live_unit_price ?? null;
                      const delta = live != null && m.cost != null ? live - m.cost : null;
                      const isSubbed = !!m.sub_id;
                      const isPartSub = isSubbed && m.sub_units != null && m.total_units != null && m.sub_units < m.total_units;
                      const subRemainder = isPartSub && m.total_units != null && m.sub_units != null ? m.total_units - m.sub_units : null;
                      return (
                        <tr key={m.id}>
                          <td className="center">{m.type}</td>
                          <td>
                            {m.off_boq ? (
                              <>
                                <div>{m.item}</div>
                                <div style={{ marginTop: 3 }}>
                                  <span className="pill warn" style={{ fontSize: 10 }}
                                    title="Added on a purchase order, not in the priced BOQ. Its cost sits under Unpriced spend until someone assigns the PO line to a budget item.">
                                    off-BOQ
                                  </span>
                                  {/* The row totals the quantity, so each order stays listed
                                      underneath with its date and its own qty — otherwise a
                                      repeat buy reads as one big order nobody can place. */}
                                  {m.off_boq.orders.slice(0, 3).map((o) => (
                                    <div key={o.line_id} style={{ fontSize: 11, marginTop: 2 }}>
                                      <Link to={`/pos/${o.po_id}`}>{o.po_number}</Link>
                                      <span className="muted" style={{ fontSize: 11 }}>
                                        {o.ordered_at ? ` · ${fmtDate(o.ordered_at)}` : ""} · {fmtQty(o.qty)} {m.total_units_unit ?? ""}
                                      </span>
                                    </div>
                                  ))}
                                  {m.off_boq.orders.length > 3 && (
                                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}
                                      title={m.off_boq.orders.slice(3).map((o) => `${o.po_number} · ${fmtDate(o.ordered_at)} · ${fmtQty(o.qty)} ${m.total_units_unit ?? ""}`).join("\n")}>
                                      +{m.off_boq.orders.length - 3} earlier order{m.off_boq.orders.length - 3 === 1 ? "" : "s"}
                                    </div>
                                  )}
                                </div>
                              </>
                            ) : isSubbed ? (
                              <>
                                <div style={{ fontWeight: 600 }}>{m.sub_item}</div>
                                <div className="muted" style={{ fontSize: 11, textDecoration: isPartSub ? "none" : "line-through", marginTop: 2 }}>
                                  {isPartSub ? <>+ {fmtQty(subRemainder)} {unit} stays on {m.item}</> : m.item}
                                </div>
                                <SubBadge kind={m.sub_kind} reason={m.sub_reason} by={m.sub_created_by} at={m.sub_created_at} part={isPartSub ? { qty: m.sub_units!, total: m.total_units!, unit } : undefined} />
                              </>
                            ) : m.item}
                            {m.pending_sub_id && (
                              <div style={{ marginTop: 4 }}>
                                <Link to="/approvals" className="pill warn" style={{ fontSize: 10, textDecoration: "none", whiteSpace: "nowrap" }} title={`Part-substitute to ${m.pending_sub_item ?? "a replacement"} — awaiting approval`}>
                                  ⏳ part-sub pending{m.pending_sub_units != null ? ` (${fmtQty(m.pending_sub_units)} ${unit})` : ""}
                                </Link>
                              </div>
                            )}
                          </td>
                          <td className="muted center">
                            {isSubbed
                              ? (m.sub_supplier ?? m.sub_manufacturer ?? <span className="muted">Unassigned</span>)
                              : (m.manufacturer ?? <span className="muted">Unassigned</span>)}
                          </td>
                          <td className="num">
                            {isSubbed && m.sub_cost != null ? (
                              <>
                                <div>{fmtMoney(m.sub_cost)}</div>
                                {m.cost != null && (
                                  <div className="muted" style={{ fontSize: 10, textDecoration: "line-through" }}>{fmtMoney(m.cost)}</div>
                                )}
                              </>
                            ) : m.cost != null ? fmtMoney(m.cost) : <span className="muted">—</span>}
                          </td>
                          <td className="num">
                            {live != null ? (
                              <>
                                <div>{fmtMoney(live)}</div>
                                {delta != null && Math.abs(delta) >= 0.005 && (
                                  <div className="muted" style={{ fontSize: 10, color: delta < 0 ? "var(--success)" : "var(--danger)" }}>
                                    {delta < 0 ? "↓" : "↑"} {fmtMoney(Math.abs(delta))}
                                  </div>
                                )}
                              </>
                            ) : (m.pending_price_count ?? 0) > 0 ? (
                              <div style={{ textAlign: "center" }}>
                                <Link to="/approvals" className="pill pending" style={{ fontSize: 10, textDecoration: "none", whiteSpace: "nowrap" }} title="Review & approve in the Approvals inbox">
                                  {m.pending_price_count} pending
                                </Link>
                              </div>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td className="center">{isSubbed ? (m.sub_unit ?? unit) : unit}</td>
                          <td className="num">
                            {priced ? fmtQty(priced)
                              : <span className="muted" title={m.off_boq ? "Bought outside the priced BOQ — there's no budgeted quantity to draw against" : undefined}>
                                  {m.off_boq ? "no budget" : "not priced"}
                                </span>}
                            {omittedQty > 0 && !m.omitted && (
                              <div className="muted" style={{ fontSize: 10 }} title={`BOQ ${fmtQty(m.total_units ?? 0)} less ${fmtQty(omittedQty)} omitted`}>
                                {fmtQty(omittedQty)} omitted
                              </div>
                            )}
                          </td>
                          <td className="num">
                            {qtyMode === "calledoff" ? (
                              <>
                                {fmtQty(calledOff)}
                                {committed > 0.0001 && <div className="muted" style={{ fontSize: 10 }}>{fmtQty(committed)} committed</div>}
                              </>
                            ) : (
                              <>
                                {fmtQty(committed)}
                                {calledOff > 0.0001
                                  ? <div className="muted" style={{ fontSize: 10 }}>{fmtQty(calledOff)} called off</div>
                                  : fwReserved > 0.0001 && <div className="muted" style={{ fontSize: 10 }}>{fmtQty(fwReserved)} reserved</div>}
                              </>
                            )}
                            {m.off_boq && (
                              <div style={{ fontSize: 10, color: "var(--danger)" }}
                                title="Ordered on POs outside the priced BOQ. This money is already counted in the project's Unpriced spend and forecast final cost.">
                                {fmtMoney(qtyMode === "calledoff" ? m.off_boq.called_off_value : m.off_boq.committed_value)} spent
                              </div>
                            )}
                          </td>
                          <td className="num">
                            {qtyMode === "calledoff"
                              ? (priced > 0 ? fmtQty(priced - calledOff) : <span className="muted">—</span>)
                              : (remaining == null ? <span className="muted">—</span> : fmtQty(remaining))}
                          </td>
                          <td className="center">
                            <div className={`bar${hasReservation ? " layered" : ""}`} title={hasReservation ? `${fmtQty(Math.max(0, fwReserved - calledOff))} reserved on framework, awaiting call-off` : undefined}>
                              {hasReservation && <div className="u-reserved" style={{ width: `${pct}%` }} />}
                              <div
                                className={over || (isOriginallyUnpriced && committed > 0) ? "danger" : exact ? "ok" : ""}
                                style={{ width: `${hasReservation ? firmPct : pct}%` }}
                              />
                            </div>
                          </td>
                          {canUploadMaterials && (
                            <td className="center" style={{ whiteSpace: "nowrap" }}>
                              {m.off_boq ? (
                                // Nothing to substitute or omit — there's no BOQ
                                // line behind this row. It's resolved by coding
                                // its PO line to a budget item, which is done on
                                // the PO (linked from the item above).
                                null
                              ) : m.omitted ? (
                                <button className="ghost tiny" title="Bring this material back into the job"
                                  onClick={async () => { if (id) { await api.restoreOmittedMaterial(id, m.item); load(); } }}>
                                  ↺ Restore
                                </button>
                              ) : (
                                <>
                                  <SubstituteAction material={m} onChanged={load} />{" "}
                                  <button className="ghost tiny" title="Not needed (or partly not needed) for this job — enter a quantity to omit only part of the line, or omit the whole line to remove it from the rollups"
                                    onClick={async () => {
                                      if (!id) return;
                                      const total = m.total_units ?? 0;
                                      const raw = prompt(
                                        `Omit how many ${m.total_units_unit ?? m.pack_unit ?? "units"} of “${m.item}”?\n\nBOQ quantity: ${total}. Leave blank to omit the WHOLE line.`,
                                        omittedQty > 0 ? String(omittedQty) : "",
                                      );
                                      if (raw == null) return; // cancelled
                                      const trimmed = raw.trim();
                                      let qty: number | undefined;
                                      if (trimmed) {
                                        qty = Number(trimmed);
                                        if (!Number.isFinite(qty) || qty <= 0) { alert("Enter a positive number, or leave blank to omit the whole line."); return; }
                                        if (total > 0 && qty >= total && !confirm(`${fmtQty(qty)} is the whole BOQ quantity — omit the whole line instead?`)) return;
                                        if (total > 0 && qty >= total) qty = undefined; // full omit
                                      }
                                      if (qty == null && (m.committed_qty ?? 0) > 0.01 && !confirm("This material has committed orders — omit it anyway? Its committed £ will leave the rollups.")) return;
                                      await api.omitMaterial(id, m.item, qty); load();
                                    }}>
                                    {omittedQty > 0 ? "Omit…" : "Omit"}
                                  </button>
                                  {omittedQty > 0 && (
                                    <>{" "}
                                      <button className="ghost tiny" title={`Clear the partial omission (${fmtQty(omittedQty)} omitted) — restores the full BOQ quantity`}
                                        onClick={async () => { if (id) { await api.restoreOmittedMaterial(id, m.item); load(); } }}>
                                        ↺
                                      </button>
                                    </>
                                  )}
                                </>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* Pricing snapshot footer — uploader sits here so the page reads
            "headline numbers → detail → file source" top-to-bottom. */}
        <div className="card">
          <div className="card-hd">
            <h3 style={{ flex: 1 }}>Pricing snapshot</h3>
            {canUploadMaterials && (
              <label className="btn secondary" style={{ cursor: "pointer", marginBottom: 0 }}>
                {busy ? "Uploading…" : info.active_snapshot ? "Replace .xlsx" : "Upload .xlsx"}
                <input ref={fileRef} type="file" accept=".xlsx,.xlsm" onChange={onUpload} hidden disabled={busy} />
              </label>
            )}
          </div>
          <div className="card-bd">
            {info.active_snapshot ? (
              <div className="muted">
                {info.active_snapshot.filename} · uploaded {fmtDate(info.active_snapshot.uploaded_at)} · {mats.length} materials
              </div>
            ) : (
              <div className="muted">No pricing workbook uploaded yet.</div>
            )}
          </div>
        </div>
        </>
        )}
      </main>
    </>
  );
}

/* ── Materials subtab nav (Materials list ‹›  Purchase orders) ─────────── */

/** Banner shown on the Materials tab when a pricing upload is awaiting superadmin approval. */
function PendingUploadBanner({ pending, isSuper, projectId, onChanged }: {
  pending: { snapshot_id: number; filename: string; uploaded_at: string; uploaded_by: string; rows?: number };
  isSuper: boolean;
  projectId: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function decide(action: "approve" | "reject") {
    if (action === "reject" && !confirm("Reject this pricing upload? The uploaded workbook is discarded and the current pricing kept.")) return;
    setBusy(true); setErr(null);
    try {
      if (action === "approve") await api.approvePendingUpload(projectId);
      else await api.rejectPendingUpload(projectId);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "failed"); setBusy(false); }
  }
  return (
    <div className="card" style={{ marginBottom: 16, borderLeft: "4px solid #b45309" }}>
      <div className="card-bd" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontWeight: 600 }}>Pricing upload awaiting approval</div>
          <div className="muted" style={{ fontSize: 13 }}>
            <b>{pending.filename}</b>{pending.rows != null ? ` · ${pending.rows} material rows` : ""} — uploaded by {pending.uploaded_by} on {fmtDate(pending.uploaded_at)}. The project keeps its current pricing live until a superadmin approves this.
          </div>
          {err && <div style={{ color: "#b91c1c", fontSize: 12, marginTop: 4 }}>{err}</div>}
        </div>
        {isSuper ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="ghost" disabled={busy} onClick={() => decide("reject")}>Reject</button>
            <button className="accent" disabled={busy} onClick={() => decide("approve")}>Approve &amp; make live</button>
          </div>
        ) : (
          <span className="pill pending" style={{ fontSize: 11 }}>awaiting superadmin</span>
        )}
      </div>
    </div>
  );
}

/** One question/answer block in a Help panel. */
function HelpItem({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 3 }}>{q}</div>
      <div className="muted" style={{ fontSize: 13, lineHeight: 1.55 }}>{children}</div>
    </div>
  );
}

/** Help & FAQ for the Commercials tab (applications, labour, variations, forecast). */
export function CommercialsHelpPanel() {
  return (
    <div className="card">
      <div className="card-hd"><h2 style={{ flex: 1 }}>Help &amp; FAQ <span className="muted" style={{ fontWeight: 400, fontSize: 13, fontFamily: "var(--font-sans)" }}>Commercials</span></h2></div>
      <div className="card-bd" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 18 }}>
        <HelpItem q="Forecast outturn (Overview)">Forecast Final Account = contract + variations. Forecast Final Cost = contract cost + variation cost − material &amp; labour savings. Forecast Profit = FFA − FFC.</HelpItem>
        <HelpItem q="Client applications (email)">Email a client application to <strong>clientapps@</strong>, or create one under Applications (Outgoing). It auto-counts as sent once received / reconciled — no director approval needed.</HelpItem>
        <HelpItem q="Client certificates (email)">Email the client's returned certificate to <strong>clientcerts@</strong>. It's matched to the newest submitted application and the certified figures lock in. Lines the client doesn't mention are reduced to zero.</HelpItem>
        <HelpItem q="Labour applications (email)">Subcontractors email their application to <strong>labourapps@</strong> (or a PowerGrid PM forwards it). Anything not addressed to <em>client…</em> is treated as an incoming labour application and lands as a draft under Applications → <strong>Incoming labour</strong> to review, match to the subbie &amp; period, then Submit → Certify.</HelpItem>
        <HelpItem q="Labour certificates (email)">A PowerGrid QS forwards the subcontractor's certified labour breakdown to <strong>labourcerts@</strong>. It's matched to that subbie's newest submitted incoming-labour application for the project and the certified figures lock in (submitted → certified, shown as <em>Expended</em>). You can also certify in-app — Applications → <strong>Incoming labour</strong> → set the certified % per line → <strong>Submit → Certify</strong>.</HelpItem>
        <HelpItem q="Create invoice">Once an application is certified, <strong>Create invoice</strong> pushes a live, project-tagged ACCREC sales invoice to Xero.</HelpItem>
        <HelpItem q="Expending labour">Applications → <strong>Incoming labour</strong> → New / Upload labour app → pick the subbie &amp; period → set % per line → <strong>Submit → Certify</strong>. Certified shows as <em>Expended</em>.</HelpItem>
        <HelpItem q="Over-budget labour">A labour application that exceeds the budgeted labour is held for a director to sign off before it can be certified.</HelpItem>
        <HelpItem q="Live labour rates">On the Labour subtab, upload a subcontractor rate schedule. Rates match the BOQ labour lines — <em>Savings from Labour</em> = contract − live.</HelpItem>
        <HelpItem q="Pending approval">A live labour rate <strong>above</strong> the contract rate is a budget increase, held for a director to approve before it counts.</HelpItem>
        <HelpItem q="Unmatched lines">Labour-schedule lines that don't auto-match show in an <strong>Unmatched</strong> card to allocate to a BOQ line by hand.</HelpItem>
        <HelpItem q="Variations">Each variation is a cost-centre — a sell value plus material &amp; labour budgets. A director approves it before its budget can be expended (PO or labour). Margin is tracked per variation.</HelpItem>
        <HelpItem q="Schedule">The Schedule subtab shows the valuation calendar; upload a valuation schedule to populate application / due / notice / final dates.</HelpItem>
      </div>
    </div>
  );
}

/** Help & FAQ for the Materials tab (workbook, quotes, savings, POs). */
function MaterialsHelpPanel() {
  return (
    <div className="card">
      <div className="card-hd"><h2 style={{ flex: 1 }}>Help &amp; FAQ <span className="muted" style={{ fontWeight: 400, fontSize: 13, fontFamily: "var(--font-sans)" }}>Materials</span></h2></div>
      <div className="card-bd" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 18 }}>
        <HelpItem q="Pricing workbook">Upload the project's pricing workbook to populate the materials list, the labour BOQ and the commercials. Re-uploading replaces the active snapshot.</HelpItem>
        <HelpItem q="Supplier quotes">Use <strong>↑ Upload quote</strong> (this line) to upload a supplier quote PDF. Claude detects the supplier and matches lines to the BOQ; review the deltas, then apply.</HelpItem>
        <HelpItem q="Quote savings">Applying a quote sets the <em>Live</em> price per material. <em>Quote savings</em> (Overview) = (BOQ cost − live price) × quantity.</HelpItem>
        <HelpItem q="Price approvals">A quoted price that pushes spend over budget is held for approval, banded by the overspend; genuine savings apply immediately.</HelpItem>
        <HelpItem q="Substitutions">Swap a specified product for an alternative — the substitute's cost / supplier flows through to PO line defaults.</HelpItem>
        <HelpItem q="Purchase orders">Raise POs against priced materials (or add unpriced items). Over-budget / unpriced POs route for approval by tier; approved POs can be pushed to Xero.</HelpItem>
        <HelpItem q="By supplier">The By-supplier panel rolls up priced vs committed per supplier, so you can see who's been ordered against and what's left.</HelpItem>
      </div>
    </div>
  );
}

function MaterialsSubnav({ active, onChange, right }: {
  active: MaterialsSubtab;
  onChange: (s: MaterialsSubtab) => void;
  right?: React.ReactNode;
}) {
  return (
    <nav className="tabs" role="tablist" style={{ marginBottom: 16, alignItems: "center" }}>
      <button
        type="button" role="tab" aria-selected={active === "list"}
        className={`tab-btn${active === "list" ? " active" : ""}`}
        onClick={() => onChange("list")}
      >
        Materials
      </button>
      <button
        type="button" role="tab" aria-selected={active === "help"}
        className={`tab-btn${active === "help" ? " active" : ""}`}
        onClick={() => onChange("help")}
      >
        Help
      </button>
      {right && <><span style={{ flex: 1 }} />{right}</>}
    </nav>
  );
}

/* ── Project POs panel ─────────────────────────────────────────────────── */

function ProjectPOsPanel({ rows }: { rows: ProjectPORow[] }) {
  if (rows.length === 0) {
    return (
      <div className="card">
        <div className="card-bd">
          <div className="empty">No purchase orders raised for this project yet.</div>
        </div>
      </div>
    );
  }

  // Quick KPIs across just this project's POs.
  const totals = rows.reduce(
    (acc, r) => {
      acc.all += r.total_value;
      if (r.status === "approved" || r.status === "issued" || r.status === "pending_approval") {
        acc.committed += r.total_value;
      }
      if (r.status === "pending_approval") acc.pending += 1;
      if (r.xero_sync_status === "synced") acc.inXero += 1;
      if (r.xero_sync_status === "failed") acc.xeroFailed += 1;
      return acc;
    },
    { all: 0, committed: 0, pending: 0, inXero: 0, xeroFailed: 0 },
  );

  return (
    <>
      <div className="kpis" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        <div className="kpi">
          <div className="kpi-label">POs raised</div>
          <div className="kpi-value">{rows.length}</div>
          <div className="kpi-sub">{totals.pending > 0 ? `${totals.pending} pending approval` : "all decided"}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Committed</div>
          <div className="kpi-value">{fmtMoney(totals.committed)}</div>
          <div className="kpi-sub">approved + issued + pending</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">In Xero</div>
          <div className="kpi-value">{totals.inXero}</div>
          <div className="kpi-sub">{totals.xeroFailed > 0 ? `${totals.xeroFailed} push failed` : "synced"}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Total value</div>
          <div className="kpi-value">{fmtMoney(totals.all)}</div>
          <div className="kpi-sub">across all statuses</div>
        </div>
      </div>

      <div className="card">
        <div className="card-hd">
          <h2 style={{ flex: 1 }}>Purchase orders on this project</h2>
          <span className="pill">{rows.length}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>PO</th>
              <th>Supplier</th>
              <th className="num">Value</th>
              <th className="center">Status</th>
              <th className="center">Xero</th>
              <th>Raised</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/pos/${r.id}`}>{r.po_number}</Link></td>
                <td>{r.supplier}</td>
                <td className="num">{fmtMoney(r.total_value)}</td>
                <td className="center"><span className={`pill ${r.status}`}>{r.status.replace("_", " ")}</span></td>
                <td className="center">
                  {r.xero_sync_status === "synced" ? (
                    <span className="pill approved" style={{ fontSize: 10 }} title={r.xero_po_number ?? ""}>✓ {r.xero_po_number ?? "synced"}</span>
                  ) : r.xero_sync_status === "failed" ? (
                    <span className="pill rejected" style={{ fontSize: 10 }} title={r.xero_sync_error ?? ""}>failed</span>
                  ) : (
                    <span className="muted" style={{ fontSize: 11 }}>—</span>
                  )}
                </td>
                <td className="muted">{fmtDate(r.created_at)}</td>
                <td className="muted">{r.created_by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── Project settings block — stage 1 expand wraps two collapsible sections ── */

export function ProjectSettingsBlock({ project, onSaved, canEdit }: { project: Project; onSaved: () => void; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <div className="card-hd" style={{ cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        <span style={{ marginRight: 10, color: "var(--ink)", fontSize: 22, lineHeight: 1, width: 20, display: "inline-block" }}>{open ? "▾" : "▸"}</span>
        <h3 style={{ flex: 1, fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 500 }}>Project Info</h3>
        {!open && <span className="muted" style={{ fontSize: 12, marginRight: 12 }}>Site details · Application terms</span>}
      </div>
      {open && (
        <div>
          <SiteDetailsSection project={project} onSaved={onSaved} canEdit={canEdit} />
          <ApplicationTermsSection project={project} onSaved={onSaved} canEdit={canEdit} />
        </div>
      )}
    </div>
  );
}

/* ── Site details section ──────────────────────────────────────────────── */

function SiteDetailsSection({ project, onSaved, canEdit }: { project: Project; onSaved: () => void; canEdit: boolean }) {
  const [collapsed, setCollapsed] = useState(true);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({
    delivery_address: project.delivery_address ?? "",
    site_contact_name: project.site_contact_name ?? "",
    site_contact_phone: project.site_contact_phone ?? "",
    delivery_instructions: project.delivery_instructions ?? "",
    site_manager_email: project.site_manager_email ?? "",
    project_manager_email: project.project_manager_email ?? "",
    payment_terms: project.payment_terms ?? "",
    application_cadence: project.application_cadence ?? "",
    commercial_manager_email: project.commercial_manager_email ?? "",
  });

  useEffect(() => {
    setForm({
      delivery_address: project.delivery_address ?? "",
      site_contact_name: project.site_contact_name ?? "",
      site_contact_phone: project.site_contact_phone ?? "",
      delivery_instructions: project.delivery_instructions ?? "",
      site_manager_email: project.site_manager_email ?? "",
      project_manager_email: project.project_manager_email ?? "",
      payment_terms: project.payment_terms ?? "",
      application_cadence: project.application_cadence ?? "",
      commercial_manager_email: project.commercial_manager_email ?? "",
    });
  }, [project.id, project.delivery_address, project.site_contact_name, project.site_contact_phone, project.delivery_instructions, project.site_manager_email, project.project_manager_email, project.commercial_manager_email, project.payment_terms, project.application_cadence]);

  async function save() {
    setBusy(true); setErr(null);
    try {
      // Only send site_manager_email when it actually changed, so a routine
      // site-details edit doesn't touch that column before its migration runs.
      const { site_manager_email, ...rest } = form;
      const payload: typeof form | Omit<typeof form, "site_manager_email"> =
        site_manager_email !== (project.site_manager_email ?? "") ? form : rest;
      await api.updateProject(project.id, payload);
      setEditing(false); onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : "save failed"); }
    finally { setBusy(false); }
  }

  const isEmpty =
    !project.delivery_address && !project.site_contact_name && !project.site_contact_phone
    && !project.delivery_instructions && !project.site_manager_email;
  const summary = isEmpty
    ? "Not set"
    : [project.delivery_address?.split("\n")[0], project.site_contact_name].filter(Boolean).join(" · ");

  return (
    <div style={{ borderTop: "1px solid var(--line)" }}>
      <div className="card-hd" style={{ cursor: "pointer", paddingLeft: 28 }} onClick={() => setCollapsed((c) => !c)}>
        <span style={{ marginRight: 10, color: "var(--ink)", fontSize: 16, lineHeight: 1, width: 16, display: "inline-block" }}>{collapsed ? "▸" : "▾"}</span>
        <h3 style={{ flex: 1, fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 500 }}>Site details</h3>
        {collapsed && <span className="muted" style={{ fontSize: 12, marginRight: 12 }}>{summary}</span>}
        {!collapsed && !editing && canEdit && (
          <>
            <span onClick={(e) => e.stopPropagation()}><ContractUpload project={project} onApplied={onSaved} /></span>{" "}
            <button className="ghost tiny" onClick={(e) => { e.stopPropagation(); setEditing(true); }}>Edit</button>
          </>
        )}
      </div>
      {!collapsed && (
      <div className="card-bd">
        {err && <div className="flash error">{err}</div>}
        {!editing ? (
          isEmpty ? (
            <div className="muted">No site details yet — these appear on every PO PDF for this project.</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24 }}>
              <SiteField label="Delivery address" value={project.delivery_address} multiline />
              <SiteField label="Site contact" value={[project.site_contact_name, project.site_contact_phone].filter(Boolean).join(" · ")} />
              <SiteField label="Delivery instructions" value={project.delivery_instructions} multiline />
              <SiteField label="Site manager email" value={project.site_manager_email} />
              <SiteField label="Project manager email" value={project.project_manager_email} />
              <SiteField label="Commercial manager email" value={project.commercial_manager_email} />
              <SiteField label="Client payment terms" value={project.payment_terms} />
              <SiteField label="Application cadence" value={
                project.application_cadence
                  ? (APPLICATION_CADENCES.find((c) => c.value === project.application_cadence)?.label ?? project.application_cadence)
                  : null
              } />
            </div>
          )
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
            <div>
              <label>Delivery address</label>
              <textarea
                rows={5}
                value={form.delivery_address}
                onChange={(e) => setForm({ ...form, delivery_address: e.target.value })}
                placeholder={"Site name\nStreet\nTown\nPostcode"}
                style={{ width: "100%" }}
              />
            </div>
            <div>
              <label>Site contact name</label>
              <input value={form.site_contact_name} onChange={(e) => setForm({ ...form, site_contact_name: e.target.value })} style={{ width: "100%" }} />
              <label style={{ marginTop: 12 }}>Telephone</label>
              <input value={form.site_contact_phone} onChange={(e) => setForm({ ...form, site_contact_phone: e.target.value })} style={{ width: "100%" }} />
              <label style={{ marginTop: 12 }}>Site manager email</label>
              <input type="email" value={form.site_manager_email} onChange={(e) => setForm({ ...form, site_manager_email: e.target.value })} placeholder="Gets site alerts (e.g. RAMS not signed)" style={{ width: "100%" }} />
              <label style={{ marginTop: 12 }}>Project manager email</label>
              <input type="email" value={form.project_manager_email} onChange={(e) => setForm({ ...form, project_manager_email: e.target.value })} placeholder="Plant off-hire reminders (falls back to site manager)" style={{ width: "100%" }} />
              <label style={{ marginTop: 12 }}>Commercial manager email</label>
              <input type="email" value={form.commercial_manager_email} onChange={(e) => setForm({ ...form, commercial_manager_email: e.target.value })} placeholder="Plant off-hire reminders" style={{ width: "100%" }} />
            </div>
            <div>
              <label>Delivery instructions</label>
              <textarea
                rows={5}
                value={form.delivery_instructions}
                onChange={(e) => setForm({ ...form, delivery_instructions: e.target.value })}
                placeholder="Access notes, opening hours, gate code, etc."
                style={{ width: "100%" }}
              />
              <label style={{ marginTop: 12 }}>Client payment terms</label>
              <select value={form.payment_terms} onChange={(e) => setForm({ ...form, payment_terms: e.target.value })} style={{ width: "100%" }}>
                <option value="">— Not set —</option>
                {/* Preserve any existing custom value (legacy free-text entries) */}
                {form.payment_terms && !PAYMENT_TERMS_OPTIONS.includes(form.payment_terms) && (
                  <option value={form.payment_terms}>{form.payment_terms} (custom)</option>
                )}
                {PAYMENT_TERMS_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <label style={{ marginTop: 12 }}>Application cadence</label>
              <select value={form.application_cadence} onChange={(e) => setForm({ ...form, application_cadence: e.target.value })} style={{ width: "100%" }}>
                <option value="">— Not set —</option>
                {APPLICATION_CADENCES.map((cad) => <option key={cad.value} value={cad.value}>{cad.label}</option>)}
              </select>
            </div>
            <div className="row" style={{ gridColumn: "1 / -1" }}>
              <button onClick={save} className="primary" disabled={busy}>Save</button>
              <button className="ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

/* ── Application terms card (per-direction VAT + retention) ─────────────── */

const VAT_OPTIONS = [
  { value: 20, label: "20% (standard)" },
  { value: 5, label: "5% (reduced)" },
  { value: 0, label: "0% / reverse charge (CIS)" },
];

function ApplicationTermsSection({ project, onSaved, canEdit }: { project: Project; onSaved: () => void; canEdit: boolean }) {
  const [collapsed, setCollapsed] = useState(true);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const initial = () => ({
    client_vat_pct: project.client_vat_pct ?? 20,
    client_retention_pct: project.client_retention_pct ?? project.retention_pct ?? 5,
    labour_vat_pct: project.labour_vat_pct ?? 20,
    labour_retention_pct: project.labour_retention_pct ?? project.retention_pct ?? 5,
  });
  const [form, setForm] = useState(initial);
  useEffect(() => { setForm(initial()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [
    project.id, project.client_vat_pct, project.client_retention_pct, project.labour_vat_pct, project.labour_retention_pct,
  ]);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.updateProject(project.id, {
        client_vat_pct: Number(form.client_vat_pct),
        client_retention_pct: Number(form.client_retention_pct),
        labour_vat_pct: Number(form.labour_vat_pct),
        labour_retention_pct: Number(form.labour_retention_pct),
      });
      setEditing(false); onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : "save failed"); }
    finally { setBusy(false); }
  }

  const clientVat = project.client_vat_pct ?? 20;
  const clientRet = project.client_retention_pct ?? project.retention_pct ?? 5;
  const labourVat = project.labour_vat_pct ?? 20;
  const labourRet = project.labour_retention_pct ?? project.retention_pct ?? 5;
  const vatLabel = (v: number) => VAT_OPTIONS.find((o) => o.value === v)?.label ?? `${v}%`;
  const summary = `Client VAT ${clientVat}% · ret ${clientRet}%  |  Labour VAT ${labourVat}% · ret ${labourRet}%`;

  return (
    <div style={{ borderTop: "1px solid var(--line)" }}>
      <div className="card-hd" style={{ cursor: "pointer", paddingLeft: 28 }} onClick={() => setCollapsed((c) => !c)}>
        <span style={{ marginRight: 10, color: "var(--ink)", fontSize: 16, lineHeight: 1, width: 16, display: "inline-block" }}>{collapsed ? "▸" : "▾"}</span>
        <h3 style={{ flex: 1, fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 500 }}>Application terms</h3>
        {collapsed && <span className="muted" style={{ fontSize: 12, marginRight: 12 }}>{summary}</span>}
        {!collapsed && !editing && canEdit && (
          <button className="ghost tiny" onClick={(e) => { e.stopPropagation(); setEditing(true); }}>Edit</button>
        )}
      </div>
      {!collapsed && (
      <div className="card-bd">
        {err && <div className="flash error">{err}</div>}
        {!editing ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            <div>
              <div className="eyebrow">Client applications (outgoing)</div>
              <div style={{ marginTop: 6, display: "flex", gap: 24 }}>
                <span>VAT <b>{vatLabel(clientVat)}</b></span>
                <span>Retention <b>{clientRet}%</b></span>
              </div>
            </div>
            <div>
              <div className="eyebrow">Labour applications (incoming)</div>
              <div style={{ marginTop: 6, display: "flex", gap: 24 }}>
                <span>VAT <b>{vatLabel(labourVat)}</b></span>
                <span>Retention <b>{labourRet}%</b></span>
              </div>
            </div>
            <div className="muted" style={{ gridColumn: "1 / -1", fontSize: 12 }}>
              Applied automatically when a draft AfP is created for each direction. Existing drafts aren't changed.
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Client applications (outgoing)</div>
              <label>VAT</label>
              <select value={form.client_vat_pct} onChange={(e) => setForm({ ...form, client_vat_pct: Number(e.target.value) })} style={{ width: "100%" }}>
                {VAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <label style={{ marginTop: 12 }}>Retention %</label>
              <input type="number" step="0.5" min="0" max="100" className="num" value={form.client_retention_pct}
                onChange={(e) => setForm({ ...form, client_retention_pct: Number(e.target.value) })} style={{ width: "100%" }} />
            </div>
            <div>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Labour applications (incoming)</div>
              <label>VAT</label>
              <select value={form.labour_vat_pct} onChange={(e) => setForm({ ...form, labour_vat_pct: Number(e.target.value) })} style={{ width: "100%" }}>
                {VAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <label style={{ marginTop: 12 }}>Retention %</label>
              <input type="number" step="0.5" min="0" max="100" className="num" value={form.labour_retention_pct}
                onChange={(e) => setForm({ ...form, labour_retention_pct: Number(e.target.value) })} style={{ width: "100%" }} />
            </div>
            <div className="row" style={{ gridColumn: "1 / -1" }}>
              <button onClick={save} className="primary" disabled={busy}>Save</button>
              <button className="ghost" onClick={() => { setForm(initial()); setEditing(false); }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function SiteField({ label, value, multiline }: { label: string; value: string | null | undefined; multiline?: boolean }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div style={{ marginTop: 6, whiteSpace: multiline ? "pre-line" : undefined }}>
        {value ? value : <span className="muted">—</span>}
      </div>
    </div>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "default" | "success" | "warn" | "danger" }) {
  return (
    <div className={`kpi${tone && tone !== "default" ? ` tone-${tone}` : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

// `Summary`/`Forecast` types, `matSupplier`, `summariseMaterials` and
// `contractTotals` now live in ../lib/commercials (the single source of truth
// shared with the combined group page) and are imported at the top of the file.

/* ── Commercials — split between Overview (headline KPIs) and tab (table) ── */

/** Four headline KPIs shown at the top of the Overview tab. */

function CommercialsHeadlineKpis({ rows }: { rows: ProjectCommercial[] }) {
  const total = rows.find((r) => r.is_total === 1);
  if (!total) return null;
  // Contract value/cost net any post-total adjustments; GP derived from
  // Value − Cost for internal consistency.
  const ct = contractTotals(rows);
  const value = ct?.value ?? (total.value ?? 0);
  const cost = ct?.cost ?? (total.cost ?? 0);
  const gp = value - cost;
  const gpPct = value > 0 ? gp / value : null;
  return (
    <div className="kpis">
      <Kpi label="Contract value" value={fmtMoney(value)} />
      <Kpi label="Cost" value={fmtMoney(cost)} />
      <Kpi
        label="Gross profit"
        value={fmtMoney(gp)}
        tone={gp > 0.005 ? "success" : gp < -0.005 ? "danger" : "default"}
      />
      <Kpi
        label="GP margin"
        value={gpPct != null ? `${(gpPct * 100).toFixed(1)}%` : "—"}
        tone={(gpPct ?? 0) >= 0.1 ? "success" : (gpPct ?? 0) < 0 ? "danger" : "warn"}
      />
    </div>
  );
}

export const moneyTone = (n: number): "success" | "danger" | "default" => (n > 0.005 ? "success" : n < -0.005 ? "danger" : "default");

/**
 * Commercial dashboard shown under the headline KPIs on the Overview tab:
 * the forecast outturn, the profit levers (material/labour savings + variation
 * profit), and what's been applied for / certified by the client.
 */
type ForecastSection = "forecast" | "levers" | "applied";
export type ForecastDrill = "materials" | "labour" | "variations" | "unexpected" | "applied" | "certified";
export function ForecastDashboard({ f, sections = ["forecast", "levers", "applied"], onDrill }: { f: Forecast; sections?: ForecastSection[]; onDrill?: (m: ForecastDrill) => void }) {
  // With a drill handler the lever/applied figures become clickable and open the
  // slide-over listing exactly what made them up. Same tile otherwise.
  const D = ({ metric, ...p }: { metric: ForecastDrill; label: string; value: string; sub?: string; tone?: "default" | "success" | "danger" | "warn" }) =>
    onDrill ? <DrillKpi {...p} onOpen={() => onDrill(metric)} /> : <Kpi {...p} />;
  return (
    <>
      {sections.includes("forecast") && (
        <>
          <div className="eyebrow" style={{ marginTop: 4 }}>Forecast outturn</div>
          <div className="kpis">
            <Kpi label="Forecast Final Account" value={fmtMoney(f.ffa)} />
            <Kpi label="Forecast Final Cost" value={fmtMoney(f.ffc)} sub={(() => {
              const p: string[] = [];
              if (f.contingency > 0) p.push(`incl. ${fmtMoney(f.contingency)} contingency`);
              if (f.unexpectedSpend > 0.005) p.push(`incl. ${fmtMoney(f.unexpectedSpend)} unexpected`);
              if (f.omittedValue > 0.005) p.push(`less ${fmtMoney(f.omittedValue)} omitted`);
              return p.length ? p.join(" · ") : undefined;
            })()} />
            <Kpi label="Forecast Profit" value={fmtMoney(f.forecastProfit)} tone={moneyTone(f.forecastProfit)} />
            <Kpi
              label="Forecast Profit GP%"
              value={f.forecastGpPct != null ? `${(f.forecastGpPct * 100).toFixed(1)}%` : "—"}
              tone={(f.forecastGpPct ?? 0) >= 0.1 ? "success" : (f.forecastGpPct ?? 0) < 0 ? "danger" : "warn"}
            />
          </div>
        </>
      )}

      {sections.includes("levers") && (
        <>
          <div className="eyebrow" style={{ marginTop: 4 }}>Profit levers</div>
          <div className="kpis">
            <D metric="materials" label="Profit/Loss from Materials" value={fmtMoney(f.materialSavings)} sub="quotes vs BOQ" tone={moneyTone(f.materialSavings)} />
            <D metric="labour" label="Profit/Loss from Labour" value={fmtMoney(f.labourSavings)} sub={Math.abs(f.labourSavings) < 0.005 ? "upload labour rates" : "live vs BOQ"} tone={moneyTone(f.labourSavings)} />
            <D metric="variations" label="Profit/Loss from Variations" value={fmtMoney(f.varProfit)} tone={moneyTone(f.varProfit)} />
            <D metric="unexpected" label="Unexpected spend" value={fmtMoney(-f.unexpectedSpend)}
              sub={`${fmtMoney(f.unpricedSpend)} off-BOQ (the Materials tab figure) + ${fmtMoney(f.materialOverspend)} over-budget POs`}
              tone={f.unexpectedSpend > 0.005 ? "danger" : "default"} />
            {f.omittedValue > 0.005 && (
              <Kpi label="Omitted from scope" value={fmtMoney(f.omittedValue)} sub="BOQ items no longer being bought" tone="success" />
            )}
            <Kpi label="Total Change in Profit/Loss" value={fmtMoney(f.materialSavings + f.labourSavings + f.varProfit + f.omittedValue - f.unexpectedSpend)} sub="vs base contract" tone={moneyTone(f.materialSavings + f.labourSavings + f.varProfit + f.omittedValue - f.unexpectedSpend)} />
          </div>
        </>
      )}

      {sections.includes("applied") && (
        <>
          <div className="eyebrow" style={{ marginTop: 4 }}>Applied &amp; certified (gross)</div>
          <div className="kpis">
            <D metric="applied" label="Applied Value" value={fmtMoney(f.appliedValue)} />
            <D metric="certified" label="Certified Value" value={fmtMoney(f.certifiedValue)} />
            <Kpi label="Variation Applied Value" value={fmtMoney(f.varApplied)} />
            <Kpi label="Variations Certified Value" value={fmtMoney(f.varCertified)} />
          </div>
        </>
      )}
    </>
  );
}

/** Project "at a glance" — forecast outturn split bar (cost vs profit, delta vs
 *  contract), needs-attention flags and quick links. Uses already-loaded data. */
/** Operational overview for delivery roles (PM / site) who don't see commercials:
 *  live ops KPIs — on site, plant, programme progress and quality — plus the
 *  on-site card and recent purchase orders. */
function OperationalOverview({ projectId, projectPOs, onJump }: { projectId: string; projectPOs: ProjectPORow[]; onJump: (t: Tab) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [attendance, setAttendance] = useState<Awaited<ReturnType<typeof api.opsAttendance>>>([]);
  const [plant, setPlant] = useState<Awaited<ReturnType<typeof api.opsPlant>>>([]);
  const [programme, setProgramme] = useState<import("../../shared/types").ProgrammeActivity[]>([]);
  const [qitp, setQitp] = useState<import("../../shared/types").QitpDashboard | null>(null);
  useEffect(() => {
    api.opsAttendance(projectId, today).then(setAttendance).catch(() => setAttendance([]));
    api.opsPlant(projectId).then(setPlant).catch(() => setPlant([]));
    api.listProgramme(projectId).then(setProgramme).catch(() => setProgramme([]));
    api.qitpDashboard(projectId).then(setQitp).catch(() => setQitp(null));
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSiteNow = attendance.filter((a) => !a.signed_out_at).length;
  const plantOnHire = plant.filter((p) => !p.off_hire_to).length;
  // Programme % — duration-weighted mean of leaf (non-summary, non-milestone) activities.
  const leaves = programme.filter((a) => !a.is_summary && !a.is_milestone);
  const progDen = leaves.reduce((s, a) => s + (a.duration_days ?? 1), 0);
  const progPct = progDen > 0 ? leaves.reduce((s, a) => s + (a.pct_complete ?? 0) * (a.duration_days ?? 1), 0) / progDen : null;
  const msDone = programme.filter((a) => a.is_milestone === 1 && (a.actual_finish || (a.pct_complete ?? 0) >= 1)).length;
  const msTotal = programme.filter((a) => a.is_milestone === 1).length;
  // Quality — QITP cabins signed off (only when the project has cabins).
  const cabins = qitp?.cabins ?? [];
  const cabinsDone = cabins.filter((c) => c.status === "complete").length;
  const qualityPct = cabins.length > 0 ? cabinsDone / cabins.length : null;

  const recentPOs = [...projectPOs].filter((p) => p.created_at).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")).slice(0, 6);
  const fmtAct = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

  return (
    <>
      <div className="kpis" style={{ marginTop: 4 }}>
        <Kpi label="On site now" value={String(onSiteNow)} sub={`${attendance.length} signed in today`} tone={onSiteNow > 0 ? "success" : "default"} />
        <Kpi label="Plant on hire" value={String(plantOnHire)} sub="on site" />
        <Kpi label="Programme" value={progPct != null ? `${Math.round(progPct * 100)}%` : "—"} sub={msTotal > 0 ? `${msDone}/${msTotal} milestones` : "% complete"} />
        {qualityPct != null && (
          <Kpi label="Quality" value={`${Math.round(qualityPct * 100)}%`} sub={`${cabinsDone}/${cabins.length} signed off`} tone={qualityPct >= 1 ? "success" : "default"} />
        )}
      </div>
      <div className="dash-grid" style={{ marginTop: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card card-padded">
            <div className="card-hd" style={{ padding: 0, marginBottom: 10, alignItems: "baseline" }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>On site today</h3>
              <button onClick={() => onJump("operations")} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, padding: 0, minHeight: 0, width: "auto" }}>Operations →</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <Glance label="On site now" value={String(onSiteNow)} tone={onSiteNow > 0 ? "success" : "default"} />
              <Glance label="Signed in today" value={String(attendance.length)} />
              <Glance label="Plant on hire" value={String(plantOnHire)} />
              <Glance label="Programme" value={progPct != null ? `${Math.round(progPct * 100)}%` : "—"} />
            </div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card card-padded">
            <div className="card-hd" style={{ padding: 0, marginBottom: 8, alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Recent purchase orders</h3>
              <button onClick={() => onJump("materials")} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, padding: 0, minHeight: 0, width: "auto" }}>Materials →</button>
            </div>
            {recentPOs.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>No purchase orders yet.</div> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {recentPOs.map((po) => (
                  <div key={po.id} className="row" style={{ justifyContent: "space-between", fontSize: 13 }}>
                    <span>PO {po.po_number} <span className="muted">{po.status.replace(/_/g, " ")}</span></span>
                    <span className="muted">{po.created_at ? fmtAct(po.created_at) : ""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function OverviewAtAGlance({ projectId, forecast: f, commercials, afps, variations, projectPOs, canViewCommercial, overdrawnFrameworkCount, onJump }: {
  projectId: string;
  forecast: Forecast;
  commercials: ProjectCommercial[];
  afps: ApplicationForPayment[];
  variations: import("../../shared/types").Variation[];
  projectPOs: ProjectPORow[];
  canViewCommercial: boolean;
  overdrawnFrameworkCount: number;
  onJump: (t: Tab) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [attendance, setAttendance] = useState<Awaited<ReturnType<typeof api.opsAttendance>>>([]);
  const [plant, setPlant] = useState<Awaited<ReturnType<typeof api.opsPlant>>>([]);
  const [valuations, setValuations] = useState<Awaited<ReturnType<typeof api.listValuationEntries>>>([]);
  useEffect(() => {
    api.opsAttendance(projectId, today).then(setAttendance).catch(() => setAttendance([]));
    api.opsPlant(projectId).then(setPlant).catch(() => setPlant([]));
    api.listValuationEntries(projectId).then(setValuations).catch(() => setValuations([]));
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Forecast outturn ──────────────────────────────────────────────────
  const total = commercials.find((r) => r.is_total === 1);
  const contractValue = total?.value ?? 0;
  const contractProfit = contractValue - (total?.cost ?? 0);
  const contractGp = contractValue > 0 ? contractProfit / contractValue : null;
  const costPct = f.ffa > 0 ? Math.min(100, (f.ffc / f.ffa) * 100) : 0;
  const profitPct = f.ffa > 0 ? Math.max(0, (f.forecastProfit / f.ffa) * 100) : 0;
  const profitDelta = f.forecastProfit - contractProfit;
  const profitDeltaPct = contractProfit > 0 ? (profitDelta / contractProfit) * 100 : null;
  const marginDeltaPts = f.forecastGpPct != null && contractGp != null ? (f.forecastGpPct - contractGp) * 100 : null;
  const up = profitDelta >= 0;

  // ── On site today ─────────────────────────────────────────────────────
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

  // ── Key dates (next future entry per type) ────────────────────────────
  const nextOf = (type: string) => valuations.filter((v) => v.entry_type === type && v.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
  const nextApp = nextOf("application");
  const nextDue = nextOf("due");
  const finalDate = nextOf("final_payment");
  const fmtShort = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const hasDates = !!(nextApp || nextDue || finalDate);

  // ── Needs attention ───────────────────────────────────────────────────
  // Commercial flags (applications/variations) only surface for commercial roles.
  const flags: Array<{ text: string; tab: Tab; tone: string }> = [];
  if (canViewCommercial) {
    for (const a of afps.filter((x) => x.direction === "outgoing" && x.status === "submitted")) {
      flags.push({ text: `AfP #${a.app_number} awaiting certification`, tab: "commercials", tone: "var(--warn)" });
    }
    const openVars = variations.filter((v) => v.status === "open").length;
    if (openVars > 0) flags.push({ text: `${openVars} open variation${openVars === 1 ? "" : "s"}`, tab: "commercials", tone: "var(--warn)" });
  }
  if (overdrawnFrameworkCount > 0) {
    flags.push({
      text: `${overdrawnFrameworkCount} framework line${overdrawnFrameworkCount === 1 ? "" : "s"} overdrawn — call-offs exceed the agreed qty or cost`,
      tab: "pos", tone: "var(--danger)",
    });
  }

  // ── Recent activity (synthesised from loaded data) ────────────────────
  // Application / variation activity is commercial; POs show for everyone.
  const acts: Array<{ date: string; text: string; sub: string }> = [];
  if (canViewCommercial) {
    for (const v of variations) if (v.created_at) acts.push({ date: v.created_at, text: `VO${v.variation_no} raised`, sub: (v.description ?? "").slice(0, 44) });
    for (const a of afps) { const d = a.submitted_at ?? a.created_at; if (d) acts.push({ date: d, text: `AfP #${a.app_number} ${a.status.replace(/_/g, " ")}`, sub: a.cumulative_value != null ? fmtMoney(a.cumulative_value) : "" }); }
  }
  for (const po of projectPOs) if (po.created_at) acts.push({ date: po.created_at, text: `PO ${po.po_number} ${po.status.replace(/_/g, " ")}`, sub: po.total_value != null ? fmtMoney(po.total_value) : "" });
  acts.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const recent = acts.slice(0, 5);
  const fmtAct = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

  return (
    <div className="dash-grid" style={{ marginTop: 16 }}>
      {/* LEFT */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="card card-padded">
          <div className="card-hd" style={{ padding: 0, marginBottom: 10, alignItems: "baseline" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Forecast outturn</h3>
            {marginDeltaPts != null && (
              <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, color: up ? "var(--success)" : "var(--danger)" }}>
                {up ? "▲" : "▼"} {up ? "+" : ""}{fmtMoney(profitDelta)}{profitDeltaPct != null ? ` · ${up ? "+" : ""}${profitDeltaPct.toFixed(1)}%` : ""} vs contract
              </span>
            )}
          </div>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>Forecast cost vs final account</span>
            <span className="num" style={{ fontSize: 12.5, fontWeight: 600 }}>{Math.round(costPct)}% cost · {Math.round(profitPct)}% profit</span>
          </div>
          <div style={{ display: "flex", height: 12, borderRadius: 999, overflow: "hidden", background: "var(--line)" }}>
            <div style={{ width: `${costPct}%`, background: "var(--navy)" }} />
            <div style={{ width: `${profitPct}%`, background: "var(--success)" }} />
          </div>
          <div className="row" style={{ gap: 18, marginTop: 14, flexWrap: "wrap" }}>
            <Glance label="Final account" value={fmtMoney(f.ffa)} />
            <Glance label="Final cost" value={fmtMoney(f.ffc)} />
            <Glance
              label={`Profit · ${f.forecastGpPct != null ? `${(f.forecastGpPct * 100).toFixed(1)}%` : "—"}`}
              value={fmtMoney(f.forecastProfit)}
              tone={moneyTone(f.forecastProfit)}
              sub={marginDeltaPts != null ? `${marginDeltaPts >= 0 ? "+" : ""}${marginDeltaPts.toFixed(1)} pts margin` : undefined}
            />
          </div>
        </div>

        <div className="card card-padded">
          <div className="card-hd" style={{ padding: 0, marginBottom: 10, alignItems: "baseline" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Key dates</h3>
            <button onClick={() => onJump("commercials")} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, padding: 0, minHeight: 0, width: "auto" }}>Schedule →</button>
          </div>
          {!hasDates ? <div className="muted" style={{ fontSize: 13 }}>No upcoming dates — upload a valuation schedule on Commercials → Schedule.</div> : (
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
            <button onClick={() => onJump("operations")} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, padding: 0, minHeight: 0, width: "auto" }}>Operations →</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Glance label="On site now" value={String(onSiteNow)} tone={onSiteNow > 0 ? "success" : "default"} />
            <Glance label="Signed in today" value={String(attendance.length)} />
            <Glance label="Plant on hire" value={String(plantOnHire)} />
            <Glance label="Plant accrued" value={fmtMoney(plantAccrued)} />
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
          {flags.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>All clear — nothing outstanding.</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {flags.map((fl, i) => (
                <div key={i} className="row" style={{ alignItems: "center", gap: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: fl.tone, flex: "0 0 auto" }} />
                  <span style={{ flex: 1, fontSize: 13 }}>{fl.text}</span>
                  <button onClick={() => onJump(fl.tab)} style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 13, padding: 0, minHeight: 0, width: "auto" }}>View</button>
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
          {(([["commercials", "Commercials · Applications"], ["pos", "Purchase orders · Raise PO"], ["operations", "Operations · Attendance"]] as Array<[Tab, string]>)).map(([t, label]) => (
            <button key={t} onClick={() => onJump(t)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "none", border: "none", borderBottom: "1px solid var(--line)", padding: "10px 0", cursor: "pointer", width: "100%", font: "inherit", color: "var(--ink)", minHeight: 0 }}>
              <span style={{ fontSize: 13 }}>{label}</span>
              <span className="muted">›</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
export function DateCard({ label, date, sub, navy }: { label: string; date: string; sub?: string; navy?: boolean }) {
  return (
    <div style={{ borderLeft: `3px solid ${navy ? "var(--navy)" : "var(--line-strong)"}`, paddingLeft: 10 }}>
      <div className="eyebrow" style={{ margin: 0, fontSize: 10 }}>{label}</div>
      <div className="num serif" style={{ fontSize: 17, marginTop: 2, color: navy ? "var(--navy)" : "var(--ink)" }}>{date}</div>
      {sub && <div className="muted" style={{ fontSize: 11.5, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}
export function Glance({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "success" | "danger" | "warn" | "default" }) {
  const color = tone === "success" ? "var(--success)" : tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : "var(--ink)";
  return (
    <div>
      <div className="eyebrow" style={{ margin: 0, fontSize: 10 }}>{label}</div>
      <div className="num serif" style={{ fontSize: 18, marginTop: 3, color }}>{value}</div>
      {sub && <div className="num" style={{ fontSize: 11.5, fontWeight: 600, color, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/** Full per-category breakdown on the Commercials tab. */
function CommercialsBreakdown({
  rows, projectId, canEdit, canRaisePO, canApprove, afps, onAfpsRefresh, labour, contractItems,
  forecast, onForecastDrill, contingency, onSetContingency,
}: {
  rows: ProjectCommercial[];
  projectId: string;
  canEdit: boolean;
  canRaisePO: boolean;
  canApprove: boolean;
  afps: ApplicationForPayment[];
  onAfpsRefresh: () => void;
  labour: LabourByCostCode[];
  contractItems: import("../../shared/types").ContractItem[];
  forecast: Forecast;
  onForecastDrill?: (m: ForecastDrill) => void;
  contingency: number;
  onSetContingency: (amount: number) => void;
}) {
  const [subtab, setSubtab] = useState<CommercialsSubtab>("breakdown");
  // Live labour rates live here so the upload button can sit in the subtab bar.
  const [liveRates, setLiveRates] = useState<import("../../shared/types").LabourLiveRate[]>([]);
  function refreshLive() { api.listLabourRates(projectId).then(setLiveRates).catch(() => setLiveRates([])); }
  useEffect(refreshLive, [projectId]);
  // Notification count = applications still needing attention — certified/paid
  // ones are done and drop off.
  const openAfpCount = afps.filter((a) => a.status !== "certified" && a.status !== "paid").length;
  return (
    <>
      <nav className="tabs" role="tablist" style={{ marginBottom: 16, alignItems: "center" }}>
        <button
          type="button" role="tab" aria-selected={subtab === "breakdown"}
          className={`tab-btn${subtab === "breakdown" ? " active" : ""}`}
          onClick={() => setSubtab("breakdown")}
        >
          Overview
        </button>
        <button
          type="button" role="tab" aria-selected={subtab === "prelims"}
          className={`tab-btn${subtab === "prelims" ? " active" : ""}`}
          onClick={() => setSubtab("prelims")}
        >
          Prelims
        </button>
        <button
          type="button" role="tab" aria-selected={subtab === "schedule"}
          className={`tab-btn${subtab === "schedule" ? " active" : ""}`}
          onClick={() => setSubtab("schedule")}
        >
          Schedule
        </button>
        <button
          type="button" role="tab" aria-selected={subtab === "applications"}
          className={`tab-btn${subtab === "applications" ? " active" : ""}`}
          onClick={() => setSubtab("applications")}
        >
          Applications
          {openAfpCount > 0 && <span className="count">{openAfpCount}</span>}
        </button>
        <button
          type="button" role="tab" aria-selected={subtab === "labour"}
          className={`tab-btn${subtab === "labour" ? " active" : ""}`}
          onClick={() => setSubtab("labour")}
        >
          Labour
        </button>
        <button
          type="button" role="tab" aria-selected={subtab === "variations"}
          className={`tab-btn${subtab === "variations" ? " active" : ""}`}
          onClick={() => setSubtab("variations")}
        >
          Variations
        </button>
        <button
          type="button" role="tab" aria-selected={subtab === "contract"}
          className={`tab-btn${subtab === "contract" ? " active" : ""}`}
          onClick={() => setSubtab("contract")}
        >
          Contract
        </button>
        <button
          type="button" role="tab" aria-selected={subtab === "help"}
          className={`tab-btn${subtab === "help" ? " active" : ""}`}
          onClick={() => setSubtab("help")}
        >
          Help
        </button>
        {subtab === "labour" && (
          <>
            <span style={{ flex: 1 }} />
            <LabourRatesPanel projectId={projectId} canEdit={canEdit} count={liveRates.length} onChanged={() => { refreshLive(); onAfpsRefresh(); }} />
          </>
        )}
      </nav>

      {subtab === "breakdown" && (
        <>
          <CommercialsHeadlineKpis rows={rows} />
          <ForecastDashboard f={forecast} onDrill={onForecastDrill} />
          <CommercialsBreakdownInner rows={rows} contingency={contingency} canEdit={canEdit} onSetContingency={onSetContingency} />
        </>
      )}
      {subtab === "prelims" && (
        <PrelimsTab projectId={projectId} canRaisePO={canRaisePO} />
      )}
      {subtab === "schedule" && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 16 }}>
          <PortfolioCalendarPanel projectId={projectId} />
          <ValuationScheduleUpload projectId={projectId} canEdit={canEdit} />
        </div>
      )}
      {subtab === "applications" && (
        <AfpListPanel projectId={projectId} afps={afps} canCreate={canEdit} onRefresh={onAfpsRefresh} />
      )}
      {subtab === "labour" && (
        <LabourBreakdown rows={labour} contractItems={contractItems} canRaiseApp={canEdit} canApprove={canApprove} projectId={projectId} onRefresh={onAfpsRefresh} liveRates={liveRates} refreshLive={refreshLive} />
      )}
      {subtab === "variations" && (
        <VariationsView projectId={projectId} canEdit={canEdit} canApprove={canApprove} contractValue={rows.find((r) => r.is_total === 1)?.value ?? 0} />
      )}
      {subtab === "contract" && (
        <ContractPanel projectId={projectId} canEdit={canEdit} />
      )}
      {subtab === "help" && <CommercialsHelpPanel />}
    </>
  );
}

/** Manual contingency buffer (inline, sits on the Commercials heading line). */
function ContingencyInline({ value, canEdit, onSave }: { value: number; canEdit: boolean; onSave: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value || 0));
  useEffect(() => { setDraft(String(value || 0)); }, [value]);
  const parsed = Number(draft);
  const dirty = Number.isFinite(parsed) && Math.abs(parsed - value) > 0.005;
  if (!canEdit) {
    return <span className="muted" style={{ fontSize: 12 }}>Contingency {fmtMoney(value)}</span>;
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className="muted" style={{ fontSize: 12 }}>Contingency £</span>
      <input type="number" step="any" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ width: 110, textAlign: "right" }} />
      <button className="accent tiny" disabled={!dirty} onClick={() => onSave(Math.round(parsed * 100) / 100)}>Save</button>
    </span>
  );
}

/** Preliminaries expenditure tab: budget vs committed (prelim-tagged POs) plus
 *  plant-tracker accrual, the list of prelim POs, and a one-click way to expend
 *  the budget. Prelims aren't tied to a single supplier, so "Raise prelim
 *  expenditure" opens the PO form pre-set to the prelims category and lets the
 *  user pick any supplier (or an ad-hoc one) at that point. */
export function PrelimsTab({ projectId, canRaisePO }: { projectId: string; canRaisePO: boolean }) {
  const [d, setD] = useState<Awaited<ReturnType<typeof api.prelimsSummary>> | null>(null);
  const [pos, setPos] = useState<Awaited<ReturnType<typeof api.listPOs>>>([]);
  useEffect(() => {
    api.prelimsSummary(projectId).then(setD).catch(() => setD(null));
    api.listPOs({ project_id: projectId }).then(setPos).catch(() => setPos([]));
  }, [projectId]);

  const prelimPos = pos.filter((p) => p.category === "prelims");
  const budget = d?.budget ?? 0;
  const committed = d?.po_committed ?? 0;
  const remaining = budget - committed;
  const over = remaining < 0;
  const pct = budget > 0 ? Math.min(100, (committed / budget) * 100) : (committed > 0 ? 100 : 0);
  const statusPill = (s: string) =>
    s === "approved" ? "approved" : s === "issued" ? "ok" : s === "pending_approval" ? "pending"
      : s === "rejected" ? "rejected" : "draft";

  const raiseBtn = canRaisePO && (
    <Link className="btn accent" to={`/projects/${projectId}/new-po?category=prelims`}>
      + Raise prelim expenditure
    </Link>
  );

  return (
    <>
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div className="card-hd" style={{ padding: 0, marginBottom: 12, alignItems: "center" }}>
          <h3 style={{ margin: 0, flex: 1 }}>Preliminaries
            <span className="muted" style={{ fontSize: 12, marginLeft: 10, fontWeight: 400 }}>budget vs committed spend</span>
          </h3>
          {raiseBtn}
        </div>
        <div className="kpis" style={{ marginBottom: 12 }}>
          <div className="kpi"><div className="kpi-label">Prelims budget</div><div className="kpi-value">{fmtMoney(budget)}</div></div>
          <div className="kpi"><div className="kpi-label">Committed</div><div className="kpi-value">{fmtMoney(committed)}</div><div className="kpi-sub">{d?.po_count ?? 0} prelim PO{(d?.po_count ?? 0) === 1 ? "" : "s"}</div></div>
          <div className={`kpi${over ? " tone-danger" : ""}`}><div className="kpi-label">Available to spend</div><div className="kpi-value">{fmtMoney(remaining)}</div>{over && <div className="kpi-sub">over budget</div>}</div>
          <div className="kpi"><div className="kpi-label">Plant on site (accrued)</div><div className="kpi-value">{fmtMoney(d?.plant_accrued ?? 0)}</div><div className="kpi-sub">{d?.plant_count ?? 0} item{(d?.plant_count ?? 0) === 1 ? "" : "s"} · from tracker</div></div>
        </div>
        <div className="bar" style={{ height: 8 }}><div className={over ? "danger" : ""} style={{ width: `${pct}%` }} /></div>
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Prelims (welfare, plant hire, scaffold, site management) aren't tied to a single supplier — use
          {" "}<b>Raise prelim expenditure</b> to raise a PO against this budget and choose the supplier then.
          Plant on site is accrued from the Operations plant tracker (day-rate × days) as a cross-check.
        </p>
      </div>

      {(d?.headings?.length ?? 0) > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-hd"><h3 style={{ flex: 1 }}>Prelim items</h3><span className="muted" style={{ fontSize: 12 }}>budget vs committed, per heading</span></div>
          <table>
            <thead><tr><th>Prelim item</th><th className="num">Budget</th><th className="num">Committed</th><th className="num">Remaining</th><th className="center">POs</th></tr></thead>
            <tbody>
              {(d?.headings ?? []).map((h) => {
                const over = h.remaining < 0;
                return (
                  <tr key={h.name}>
                    <td>{h.name}</td>
                    <td className="num">{h.budget > 0 ? fmtMoney(h.budget) : <span className="muted">—</span>}</td>
                    <td className="num">{fmtMoney(h.committed)}</td>
                    <td className="num" style={{ color: over ? "var(--danger)" : undefined }}>
                      {fmtMoney(h.remaining)}{over ? " ⚠" : ""}
                    </td>
                    <td className="center">{h.po_count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="card-hd"><h3 style={{ flex: 1 }}>Prelim purchase orders</h3><span className="pill">{prelimPos.length}</span>{canRaisePO && <Link className="btn accent tiny" to={`/projects/${projectId}/new-po?category=prelims`} style={{ marginLeft: 10 }}>+ Raise prelim expenditure</Link>}</div>
        {prelimPos.length === 0 ? (
          <div className="empty in-card">
            <div className="ic"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16v13H4z" /><path d="M4 7l2-3h12l2 3M9 12h6" /></svg></div>
            <h3 className="serif" style={{ fontSize: 18 }}>No prelim POs yet</h3>
            <p className="muted" style={{ maxWidth: 420, margin: "0 auto" }}>Raise expenditure against the {fmtMoney(budget)} prelims budget — welfare, plant hire, scaffold or site management — and choose the supplier at that point.</p>
            {canRaisePO && <div style={{ marginTop: 18 }}><Link className="btn accent" to={`/projects/${projectId}/new-po?category=prelims`}>+ Raise prelim expenditure</Link></div>}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>PO</th>
                <th>Supplier</th>
                <th className="center">Status</th>
                <th className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {prelimPos.map((p) => (
                <tr key={p.id}>
                  <td><Link to={`/pos/${p.id}`}>{p.po_number}</Link></td>
                  <td>{p.supplier}</td>
                  <td className="center">
                    <span className={`pill ${statusPill(p.status)}`}>{p.status.replace(/_/g, " ")}</span>
                    {p.paid_at && <span className="pill ok" style={{ marginLeft: 6 }}>paid</span>}
                  </td>
                  <td className="num">{fmtMoney(p.total_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function CommercialsBreakdownInner({ rows, contingency, canEdit, onSetContingency }: {
  rows: ProjectCommercial[];
  contingency: number;
  canEdit: boolean;
  onSetContingency: (amount: number) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="card">
        <div className="card-bd">
          <div className="empty">
            No commercials yet — upload (or re-upload) a pricing workbook that includes the "Summary Cost Sheet" tab.
          </div>
        </div>
      </div>
    );
  }
  const breakdown = rows.filter((r) => r.is_total === 0);
  // Mark the section-parent rows ("Preliminaries", "Measured Works") as
  // subheadings. The child "Measured works" differs only by case, so take the
  // first occurrence of each known name.
  const SUBHEADINGS = new Set(["preliminaries", "prelims", "measured works"]);
  const subheadingIds = new Set<number>();
  {
    const seen = new Set<string>();
    for (const r of breakdown) {
      const k = (r.category ?? "").toLowerCase().trim();
      if (SUBHEADINGS.has(k) && !seen.has(k)) { seen.add(k); subheadingIds.add(r.id); }
    }
  }
  // Preliminaries now live on the Prelims tab, so drop that whole section
  // (the heading + its child rows) from this breakdown.
  const PRELIM_HEADS = new Set(["preliminaries", "prelims"]);
  const visibleBreakdown: typeof breakdown = [];
  {
    let inPrelims = false;
    for (const r of breakdown) {
      const k = (r.category ?? "").toLowerCase().trim();
      if (subheadingIds.has(r.id)) inPrelims = PRELIM_HEADS.has(k);
      if (!inPrelims) visibleBreakdown.push(r);
    }
  }
  return (
    <div className="card">
      <div className="card-hd" style={{ alignItems: "center", gap: 12 }}>
        <h2 style={{ flex: 1 }}>Commercials <span className="muted" style={{ fontWeight: 400, fontSize: 12, fontFamily: "var(--font-sans)" }}>from Summary Cost Sheet</span></h2>
        <ContingencyInline value={contingency} canEdit={canEdit} onSave={onSetContingency} />
      </div>
      <table>
        <thead>
          <tr>
            <th>Category</th>
            <th className="num">Value</th>
            <th className="num">Cost</th>
            <th className="num">GP £</th>
            <th className="num">GP %</th>
          </tr>
        </thead>
        <tbody>
          {visibleBreakdown.map((r) => {
            // Derive GP from this row's own Value − Cost so every line is
            // internally consistent. The sheet sometimes carries a section's GP
            // on its child row, and leaves value-only adjustments (e.g.
            // "Directors Adjustment", −£8,000 at £0 cost) showing GP £0 — both
            // of which the raw GP column gets wrong.
            const gp = r.value != null && r.cost != null ? r.value - r.cost : r.gross_profit;
            const gpPct = r.value != null && r.value > 0 && gp != null ? gp / r.value : null;
            const gpTone = gp == null ? "" : gp > 0.005 ? "var(--success)" : gp < -0.005 ? "var(--danger)" : "var(--muted)";
            const isSub = subheadingIds.has(r.id);
            return (
              <tr key={r.id} style={isSub ? { background: "var(--card-2)", fontWeight: 700 } : undefined}>
                <td style={isSub ? { textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 12 } : { paddingLeft: 22 }}>{r.category}</td>
                <td className="num">{r.value != null ? fmtMoney(r.value) : <span className="muted">—</span>}</td>
                <td className="num">{r.cost != null ? fmtMoney(r.cost) : <span className="muted">—</span>}</td>
                <td className="num" style={{ color: gpTone || undefined }}>
                  {gp != null ? fmtMoney(gp) : <span className="muted">—</span>}
                </td>
                <td className="num" style={{ color: gpTone || undefined }}>
                  {gpPct != null ? `${(gpPct * 100).toFixed(1)}%` : <span className="muted">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Applications for Payment panel ───────────────────────────────────────── */

function AfpListPanel({
  projectId, afps, canCreate, onRefresh,
}: {
  projectId: string;
  afps: ApplicationForPayment[];
  canCreate: boolean;
  onRefresh: () => void;
}) {
  const navigate = useNavigate();
  const [direction, setDirection] = useState<"outgoing" | "incoming_labour">("outgoing");
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [periodEnd, setPeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [suppliers, setSuppliers] = useState<Awaited<ReturnType<typeof api.listSuppliers>>>([]);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [combined, setCombined] = useState(false);
  const [periodMode, setPeriodMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (direction === "incoming_labour" && suppliers.length === 0) {
      api.listSuppliers().then(setSuppliers).catch(() => setSuppliers([]));
    }
  }, [direction, suppliers.length]);

  async function uploadLabourApp() {
    if (!uploadFile) { setErr("Pick a file to upload"); return; }
    // Outgoing = OUR combined application up to the client — one workbook with
    // a tab per block, landing as a single AfP on the group's base project.
    if (direction === "outgoing") {
      setBusy(true); setErr(null);
      try {
        const r = await api.uploadCombinedClientApp(uploadFile, { period_end: periodEnd, notes: notes || undefined });
        onRefresh();
        navigate(`/applications/${r.id}`);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "upload failed");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!supplierId) { setErr("Pick the subcontractor this application is from"); return; }
    setBusy(true); setErr(null);
    try {
      if (combined) {
        const r = await api.uploadCombinedLabourApp(uploadFile, {
          counterparty_supplier_id: supplierId, period_end: periodEnd, notes: notes || undefined, period_mode: periodMode,
        });
        onRefresh();
        if (r.created.length === 0) {
          setErr(`No applications created — ${r.skipped.map((s) => `${s.code}: ${s.reason}`).join("; ") || "no matching project tabs found"}`);
        } else if (r.skipped.length) {
          setUploading(false); setUploadFile(null);
          setErr(`Created ${r.created.map((cc) => `${cc.code} #${cc.app_number}`).join(", ")}. Skipped ${r.skipped.map((s) => `${s.code} (${s.reason})`).join(", ")}.`);
        } else {
          navigate(`/applications/${r.created[0].afp_id}`);
        }
        return;
      }
      const r = await api.uploadLabourApp(projectId, uploadFile, {
        counterparty_supplier_id: supplierId,
        period_end: periodEnd,
        notes: notes || undefined,
        period_mode: periodMode,
      });
      onRefresh();
      navigate(`/applications/${r.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function createAfp() {
    if (direction === "incoming_labour" && !supplierId) {
      setErr("Pick the subcontractor this application is from");
      return;
    }
    setBusy(true); setErr(null);
    try {
      const r = await api.createAfp(projectId, {
        period_end: periodEnd,
        notes: notes || undefined,
        direction,
        counterparty_supplier_id: direction === "incoming_labour" ? supplierId : undefined,
      });
      onRefresh();
      navigate(`/applications/${r.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  // Filter AfPs to the selected direction
  const filtered = afps.filter((a) => a.direction === direction);
  const totals = filtered.reduce(
    (acc, a) => {
      acc.invoiced += a.total_invoice ?? 0;
      if (a.status === "certified" || a.status === "paid") acc.certified += a.certified_amount ?? a.amount_due ?? 0;
      if (a.status === "paid") acc.paid += a.certified_amount ?? a.amount_due ?? 0;
      return acc;
    },
    { invoiced: 0, certified: 0, paid: 0 },
  );

  const dirLabel = direction === "outgoing" ? "Outgoing (to client)" : "Incoming labour (from subcontractor)";
  return (
    <>
      <div className="kpis">
        <Kpi label="Apps to date" value={String(filtered.length)} sub={filtered.length > 0 ? `Latest #${filtered[0].app_number}` : "None yet"} />
        <Kpi label={direction === "outgoing" ? "Total invoiced" : "Total claimed"} value={fmtMoney(totals.invoiced)} sub="incl VAT" />
        <Kpi label="Certified" value={fmtMoney(totals.certified)} tone={totals.certified > 0 ? "success" : "default"} />
        <Kpi label="Paid" value={fmtMoney(totals.paid)} tone={totals.paid > 0 ? "success" : "default"} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-hd">
          <h2 style={{ flex: 1 }}>Applications for payment</h2>
          <div style={{ display: "flex", gap: 6, marginRight: 12 }}>
            <button
              type="button"
              className={direction === "outgoing" ? "primary tiny" : "ghost tiny"}
              onClick={() => setDirection("outgoing")}
            >Outgoing</button>
            <button
              type="button"
              className={direction === "incoming_labour" ? "primary tiny" : "ghost tiny"}
              onClick={() => setDirection("incoming_labour")}
            >Incoming labour</button>
          </div>
          {canCreate && !creating && !uploading && (
            <>
              <button className="ghost" onClick={() => { setUploading(true); setErr(null); }} style={{ marginRight: 6 }}>
                {direction === "outgoing" ? "↑ Upload combined application" : "↑ Upload labour app"}
              </button>
              <button className="accent" onClick={() => setCreating(true)}>+ New {direction === "outgoing" ? "AfP" : "labour app"}</button>
            </>
          )}
        </div>
        {err && <div className="flash error" style={{ margin: "12px 20px 0" }}>{err}</div>}
        {uploading && (
          <div className="card-bd" style={{ background: "var(--accent-soft)", borderBottom: "1px solid var(--line)" }}>
            <div className="row" style={{ alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
              <div>
                <label>Period ending</label>
                <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
              </div>
              {direction === "incoming_labour" && (() => {
                const labourSuppliers = suppliers.filter((s) => s.is_labour_supplier);
                return (
                  <div>
                    <label>Subcontractor</label>
                    <select value={supplierId ?? ""} onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : null)} style={{ minWidth: 220 }}>
                      <option value="">— select —</option>
                      {labourSuppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                );
              })()}
              <div>
                <label>{direction === "outgoing" ? "Our application workbook (.xlsx, one tab per block)" : "Subbie's application (PDF, Word or XLSX)"}</label>
                <input
                  type="file"
                  accept={direction === "outgoing"
                    ? ".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    : "application/pdf,.pdf,.xlsx,.xls,.docx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
                  onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                />
              </div>
              {direction === "incoming_labour" && (
                <div>
                  <label style={{ display: "block", visibility: "hidden" }}>x</label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, whiteSpace: "nowrap", height: 34 }} title="An .xlsx with one tab per block (named by project code) — creates one draft app per block">
                    <input type="checkbox" checked={combined} onChange={(e) => setCombined(e.target.checked)} />
                    Combined workbook (tab per block)
                  </label>
                </div>
              )}
              {direction === "incoming_labour" && (
                <div>
                  <label style={{ display: "block", visibility: "hidden" }}>x</label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, whiteSpace: "nowrap", height: 34 }} title="The applied figures are for THIS period only — added on top of what's already been certified, rather than being the cumulative to-date total">
                    <input type="checkbox" checked={periodMode} onChange={(e) => setPeriodMode(e.target.checked)} />
                    Figures are this period (add to previous)
                  </label>
                </div>
              )}
              <div className="grow">
                <label>Notes (optional)</label>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={direction === "outgoing" ? "e.g. July combined application to MCR" : "e.g. May application — subbie's running total"} />
              </div>
              <button className="primary" onClick={uploadLabourApp} disabled={busy || !uploadFile || !periodEnd || (direction === "incoming_labour" && !supplierId)}>
                {busy ? "Extracting…" : direction === "outgoing" ? "Upload + build combined draft" : combined ? "Upload + split into blocks" : "Upload + create draft"}
              </button>
              <button className="ghost" onClick={() => { setUploading(false); setUploadFile(null); setErr(null); }}>Cancel</button>
            </div>
            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              {direction === "outgoing"
                ? "One tab per block (named by project code, e.g. \"26001 Block B\") plus shared Fall Arrest/Variations tabs with code-prefixed rows. Every block's BOQ seeds a single draft application on the group's base project, with each tab's applied figures matched to that block's own lines."
                : "We'll extract the priced lines (Claude reads PDFs & Word docs, XLSX is parsed directly), match each to a BOQ contract item, and create a draft labour app with the % complete pre-populated. Unmatched lines surface as a banner on the draft for manual review."}
            </div>
            {direction === "incoming_labour" && combined && <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>Combined mode (.xlsx only): each tab named by its project code — e.g. "26001 Block B" — becomes its own draft application; shared tabs (Fall Arrest, Variations) are split to each block by the code on the line.</div>}
          </div>
        )}
        {creating && (
          <div className="card-bd" style={{ background: "var(--accent-soft)", borderBottom: "1px solid var(--line)" }}>
            <div className="row" style={{ alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
              <div>
                <label>Period ending</label>
                <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
              </div>
              {direction === "incoming_labour" && (() => {
                const labourSuppliers = suppliers.filter((s) => s.is_labour_supplier);
                return (
                  <div>
                    <label>Subcontractor</label>
                    <select value={supplierId ?? ""} onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : null)} style={{ minWidth: 220 }}>
                      <option value="">— select —</option>
                      {labourSuppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    {suppliers.length > 0 && labourSuppliers.length === 0 && (
                      <div className="muted" style={{ fontSize: 12, marginTop: 4, maxWidth: 220 }}>
                        No labour suppliers yet — tick "Labour supplier" on a supplier in <Link to="/suppliers">Approved Suppliers</Link>.
                      </div>
                    )}
                  </div>
                );
              })()}
              <div className="grow">
                <label>Notes (optional)</label>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={direction === "outgoing" ? "e.g. Valuation #3 — works to 30 Apr 2026" : "e.g. May application from labour subcontractor"} />
              </div>
              <button className="primary" onClick={createAfp} disabled={busy || !periodEnd || (direction === "incoming_labour" && !supplierId)}>{busy ? "Creating…" : "Create draft"}</button>
              <button className="ghost" onClick={() => setCreating(false)}>Cancel</button>
            </div>
            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              Draft seeded from the BOQ at 0% complete using {direction === "outgoing" ? "sell rates" : "labour cost rates"}. Edit per-line % and add variations on the detail screen, then submit.
            </div>
          </div>
        )}
        {filtered.length === 0 ? (
          <div className="card-bd"><div className="empty">No {dirLabel.toLowerCase()} applications yet.</div></div>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="center">#</th>
                <th>Period ending</th>
                <th className="center">Status</th>
                <th className="num">Cumulative</th>
                <th className="num">This period</th>
                <th className="num">{direction === "outgoing" ? "Total invoice" : "Total claimed"}</th>
                <th className="num">Certified</th>
                <th>Raised</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id}>
                  <td className="center"><Link to={`/applications/${a.id}`}>#{a.app_number}</Link></td>
                  <td>{fmtDate(a.period_end)}</td>
                  <td className="center">
                    <span className={`pill ${afpStatusPill(a.status)}`} style={{ fontSize: 10 }}>{a.status}</span>
                  </td>
                  <td className="num">{fmtMoney(a.cumulative_value ?? 0)}</td>
                  <td className="num">{fmtMoney(a.this_period_net ?? 0)}</td>
                  <td className="num">{fmtMoney(a.total_invoice ?? 0)}</td>
                  <td className="num">
                    {a.certified_amount != null
                      ? fmtMoney(a.certified_amount)
                      : <span className="muted">—</span>}
                  </td>
                  <td className="muted">{fmtDate(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function afpStatusPill(s: ApplicationForPayment["status"]): string {
  switch (s) {
    case "draft": return "draft";
    case "pending_approval": return "pending";
    case "submitted": return "issued";
    case "certified": return "approved";
    case "paid": return "approved";
  }
}

/* ── Labour breakdown by cost code ───────────────────────────────────────── */

/**
 * Live labour rates (Savings from Labour). Upload a subcontractor labour-rate
 * schedule (XLSX); we extract the priced items, match to the BOQ labour lines,
 * store the agreed rate per line, and show the resulting savings. Drives the
 * Savings from Labour tile on the Overview.
 */
function LabourRatesPanel({ projectId, canEdit, count, onChanged }: { projectId: string; canEdit: boolean; count: number; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.uploadLabourRates>> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await api.uploadLabourRates(projectId, f);
      setResult(r); onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "upload failed"); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }
  async function clear() {
    if (!confirm("Clear all live labour rates for this project?")) return;
    try { await api.clearLabourRates(projectId); setResult(null); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "clear failed"); }
  }

  if (!canEdit) return null;
  return (
    <div className="row" style={{ alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={onFile} style={{ display: "none" }} />
      <button className="ghost" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? "Reading…" : "↑ Upload labour schedule"}</button>
      {count > 0 && <button className="ghost" onClick={clear} disabled={busy}>Clear rates</button>}
      {err
        ? <span style={{ color: "#b91c1c", fontSize: 12 }}>{err}</span>
        : result && (
          <span className="muted" style={{ fontSize: 12 }}>
            {result.applied} applied{result.pending > 0 && <> · <b style={{ color: "#b45309" }}>{result.pending} pending</b></>}{result.unmatched > 0 && <> · {result.unmatched} unmatched</>} · saved{" "}
            <b style={{ color: result.savings >= 0 ? "var(--accent-2)" : "#b91c1c" }}>{fmtMoney(result.savings)}</b>
          </span>
        )}
    </div>
  );
}

/** One unmatched schedule line: pick a BOQ labour line to allocate it to, or dismiss. */
function AllocateRow({ projectId, row, options, canEdit, onChanged }: {
  projectId: string;
  row: import("../../shared/types").LabourLiveRate;
  options: { id: number; label: string }[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [sel, setSel] = useState<string>("");
  const [busy, setBusy] = useState(false);
  async function allocate() {
    if (!sel) return;
    setBusy(true);
    try { await api.allocateLabourRate(projectId, row.id, Number(sel)); onChanged(); }
    finally { setBusy(false); }
  }
  async function dismiss() {
    setBusy(true);
    try { await api.deleteLabourRate(projectId, row.id); onChanged(); }
    finally { setBusy(false); }
  }
  return (
    <tr>
      <td>{row.description}</td>
      <td className="num">{fmtMoney(row.live_rate)}</td>
      <td>
        {canEdit ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ flex: 1, minWidth: 200 }}>
              <option value="">— pick BOQ line —</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            <button className="accent tiny" disabled={!sel || busy} onClick={allocate}>Allocate</button>
          </div>
        ) : <span className="muted">—</span>}
      </td>
      {canEdit && <td><button className="ghost tiny" disabled={busy} onClick={dismiss} title="Dismiss this line">×</button></td>}
    </tr>
  );
}

/** Worklist of labour-schedule lines that didn't auto-match a BOQ line. */
function UnmatchedLabourCard({ projectId, canEdit, unmatched, options, onChanged }: {
  projectId: string;
  canEdit: boolean;
  unmatched: import("../../shared/types").LabourLiveRate[];
  options: { id: number; label: string }[];
  onChanged: () => void;
}) {
  return (
    <div className="card" style={{ borderLeft: "4px solid #b45309" }}>
      <div className="card-hd">
        <h2 style={{ flex: 1 }}>Unmatched labour rates <span className="muted" style={{ fontWeight: 400, fontSize: 13, fontFamily: "var(--font-sans)" }}>{unmatched.length} to allocate</span></h2>
      </div>
      <table>
        <thead>
          <tr>
            <th>Schedule line</th>
            <th className="num">Live rate £</th>
            <th>Allocate to BOQ line</th>
            {canEdit && <th style={{ width: 40 }}></th>}
          </tr>
        </thead>
        <tbody>
          {unmatched.map((u) => (
            <AllocateRow key={u.id} projectId={projectId} row={u} options={options} canEdit={canEdit} onChanged={onChanged} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LabourBreakdown({
  rows, contractItems, canRaiseApp, canApprove, projectId, onRefresh, liveRates, refreshLive,
}: {
  rows: LabourByCostCode[];
  contractItems: import("../../shared/types").ContractItem[];
  canRaiseApp: boolean;
  canApprove: boolean;
  projectId: string;
  onRefresh: () => void;
  liveRates: import("../../shared/types").LabourLiveRate[];
  refreshLive: () => void;
}) {
  const [costOpen, setCostOpen] = useState(true);
  const liveMap = useMemo(() => new Map(liveRates.map((r) => [r.contract_item_id, r])), [liveRates]);
  async function approveRate(id: number) {
    try { await api.approveLabourRate(projectId, id); refreshLive(); onRefresh(); }
    catch { /* surfaced elsewhere */ }
  }
  if (rows.length === 0) {
    return (
      <div className="card">
        <div className="card-bd">
          <div className="empty">
            No labour data — either the BOQ has no labour entered, or it was uploaded before labour parsing was added (re-upload the workbook to populate).
          </div>
        </div>
      </div>
    );
  }
  const totalLabour = rows.reduce((s, r) => s + r.labour_total, 0);
  const totalExpended = rows.reduce((s, r) => s + (r.expended ?? 0), 0);

  // BOQ items that carry a labour rate (section headers have no rate)
  const labourItems = contractItems.filter(
    (ci) => ci.labour_rate != null && ci.labour_rate > 0
  );
  const boqTotal = labourItems.reduce((s, ci) => s + (ci.labour_total ?? 0), 0);

  // Group BOQ items by section for display
  const sections: { name: string; items: typeof labourItems }[] = [];
  for (const ci of labourItems) {
    const sectionName = ci.section ?? "General";
    const last = sections[sections.length - 1];
    if (last && last.name === sectionName) {
      last.items.push(ci);
    } else {
      sections.push({ name: sectionName, items: [ci] });
    }
  }

  // Unmatched schedule lines + the BOQ lines still available to allocate to.
  const unmatchedRates = liveRates.filter((r) => r.status === "unmatched");
  const matchedIds = new Set(liveRates.filter((r) => r.status !== "unmatched").map((r) => r.contract_item_id));
  const allocOptions = labourItems
    .filter((ci) => !matchedIds.has(ci.id))
    .map((ci) => ({ id: ci.id, label: `${ci.description} — ${fmtMoney(ci.labour_rate ?? 0)}${ci.unit ? `/${ci.unit}` : ""}` }));

  return (
    <>
    <div className="kpis" style={{ marginBottom: 16 }}>
      <Kpi label="Total labour" value={fmtMoney(totalLabour)} sub="from BOQ" />
      <Kpi label="Amount expended" value={fmtMoney(totalExpended)} sub="certified so far" />
      <Kpi
        label="% expended"
        value={totalLabour > 0 ? `${((totalExpended / totalLabour) * 100).toFixed(1)}%` : "—"}
        sub="of total labour"
      />
    </div>

    {unmatchedRates.length > 0 && (
      <UnmatchedLabourCard
        projectId={projectId}
        canEdit={canRaiseApp}
        unmatched={unmatchedRates}
        options={allocOptions}
        onChanged={() => { refreshLive(); onRefresh(); }}
      />
    )}

    {/* Labour by section — collapsible, with real expenditure bars */}
    <div className="card">
      <div className="card-hd" style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }} onClick={() => setCostOpen((o) => !o)}>
        <span style={{ fontSize: 24, lineHeight: 1, color: "var(--muted)" }}>{costOpen ? "▾" : "▸"}</span>
        <h2 style={{ flex: 1 }}>Labour by section</h2>
        <span className="muted" style={{ fontSize: 12 }}>budget vs certified</span>
      </div>
      {costOpen && (
      <table>
        <thead>
          <tr>
            <th>Section</th>
            <th className="num">Lines</th>
            <th className="num">Labour £</th>
            <th className="num">Expended £</th>
            <th className="center" style={{ width: 180 }}>Expenditure</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const expended = r.expended ?? 0;
            const pct = r.labour_total > 0 ? (expended / r.labour_total) * 100 : 0;
            const over = expended > r.labour_total && r.labour_total > 0;
            const exact = r.labour_total > 0 && Math.abs(expended - r.labour_total) < 0.005;
            const isZero = expended < 0.005;
            return (
              <tr key={r.section}>
                <td style={{ fontWeight: 600 }}>{r.section}</td>
                <td className="num">{r.line_count}</td>
                <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(r.labour_total)}</td>
                <td className="num">
                  {isZero ? <span className="muted">{fmtMoney(0)}</span> : fmtMoney(expended)}
                </td>
                <td>
                  <div className="bar"><div className={over ? "danger" : exact ? "ok" : ""} style={{ width: `${Math.min(100, pct)}%` }} /></div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{pct.toFixed(0)}%</div>
                </td>
              </tr>
            );
          })}
          <tr style={{ background: "var(--card-2)" }}>
            <td style={{ fontWeight: 600, textAlign: "right" }}>Total</td>
            <td></td>
            <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(totalLabour)}</td>
            <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(totalExpended)}</td>
            <td className="num" style={{ fontWeight: 600 }}>
              {totalLabour > 0 ? `${((totalExpended / totalLabour) * 100).toFixed(0)}%` : "—"}
            </td>
          </tr>
        </tbody>
      </table>
      )}
    </div>

    {/* Labour BOQ */}
    <div className="card">
      <div className="card-hd">
        <h2 style={{ flex: 1 }}>Labour BOQ</h2>
        <span className="muted" style={{ fontSize: 12 }}>from pricing workbook · {fmtMoney(boqTotal)} total</span>
      </div>
      {labourItems.length === 0 ? (
        <div className="card-bd">
          <div className="empty">
            No labour-rated items found in the BOQ. Re-upload the pricing workbook if labour rates have been entered since the last upload.
          </div>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Section / Description</th>
              <th className="num">Qty</th>
              <th className="center">Unit</th>
              <th className="num">Contract rate £</th>
              <th className="num">Contract value £</th>
              <th className="num">Live rate £</th>
              <th className="num">Live value £</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((sec) => (
              <Fragment key={`sec-${sec.name}`}>
                {sections.length > 1 && (
                  <tr style={{ background: "var(--card-2)" }}>
                    <td
                      colSpan={7}
                      style={{ fontWeight: 600, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-2)" }}
                    >
                      {sec.name}
                    </td>
                  </tr>
                )}
                {sec.items.map((ci) => {
                  const lr = liveMap.get(ci.id);
                  const pending = lr?.status === "pending_approval";
                  const liveRate = lr ? lr.live_rate : null;
                  const liveValue = liveRate != null ? liveRate * ci.qty : null;
                  const contractValue = ci.labour_total ?? 0;
                  const saving = liveValue != null ? contractValue - liveValue : null; // +ve = saving
                  return (
                    <tr key={ci.id}>
                      <td style={{ paddingLeft: sections.length > 1 ? 28 : undefined }}>{ci.description}</td>
                      <td className="num">{fmtQty(ci.qty)}</td>
                      <td className="center">{ci.unit ?? "—"}</td>
                      <td className="num">{fmtMoney(ci.labour_rate!)}</td>
                      <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(contractValue)}</td>
                      <td className="num">
                        {liveRate != null ? (
                          <>
                            {fmtMoney(liveRate)}
                            {/* A confirmed rate is tagged QUOTED on the rate itself. */}
                            {!pending && <span className="quoted">QUOTED</span>}
                            {pending && <div style={{ fontSize: 10, color: "var(--warn)", fontWeight: 600 }}>pending</div>}
                          </>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td className="num">
                        {liveValue != null ? (
                          <>
                            {/* Live value is neutral ink; the saving/overspend delta below is the
                                coloured signal (green ▼ saving / red ▲ over), not the value. */}
                            <span style={{ fontWeight: 600, color: pending ? "var(--warn)" : "var(--ink)" }}>{fmtMoney(liveValue)}</span>
                            {!pending && saving != null && Math.abs(saving) > 0.005 && (
                              <div style={{ fontSize: 11, fontWeight: 600, color: saving >= 0 ? "var(--success)" : "var(--danger)" }}>
                                {saving >= 0 ? `▼ ${fmtMoney(Math.abs(saving))} saved` : `▲ ${fmtMoney(Math.abs(saving))} over`}
                              </div>
                            )}
                            {pending && (
                              canApprove
                                ? <div><button className="accent tiny" style={{ marginTop: 2 }} onClick={() => approveRate(lr!.id)} title="Approve this budget increase">Approve</button></div>
                                : <div style={{ fontSize: 10, color: "var(--warn)" }}>awaiting sign-off</div>
                            )}
                          </>
                        ) : (
                          <>
                            <span className="muted">{fmtMoney(contractValue)}</span>
                            <div className="muted" style={{ fontSize: 11 }}>awaiting quote</div>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
            <tr style={{ background: "var(--card-2)" }}>
              <td colSpan={4} style={{ fontWeight: 600, textAlign: "right" }}>Total</td>
              <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(boqTotal)}</td>
              <td></td>
              <td className="num" style={{ fontWeight: 600 }}>
                {fmtMoney(labourItems.reduce((s, ci) => {
                  const lr = liveMap.get(ci.id);
                  if (!lr || lr.status === "pending_approval") return s; // effective (approved) only
                  return s + lr.live_rate * ci.qty;
                }, 0))}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
    </>
  );
}

/* ── Project-scoped quote upload button (Overview + Materials tab) ─────── */

function ProjectQuoteUpload({ projectId, disabled }: { projectId: string; disabled?: boolean }) {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!f) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.uploadQuote(f, { projectId });
      navigate(`/quotes/${r.quote_id}`);
    } catch (e) {
      // 422 (supplier_unmatched) flows up here too — the supplier picker UX
      // lives on the suppliers page; here we just surface the message and tell
      // the user to add the supplier to the register first.
      setErr(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input ref={fileRef} type="file" accept="application/pdf" style={{ display: "none" }} onChange={onPick} />
      <button
        className="ghost"
        onClick={() => fileRef.current?.click()}
        disabled={busy || disabled}
        title={disabled
          ? "Upload a pricing workbook first so quotes can be matched to BOQ lines"
          : "Upload a supplier quote PDF for this project — Claude auto-detects the supplier and matches lines against the BOQ"}
        style={{ marginLeft: "auto" }}
      >
        {busy ? "Reading PDF…" : "↑ Upload quote"}
      </button>
      {err && <span style={{ color: "var(--danger)", fontSize: 11, marginLeft: 8 }}>{err}</span>}
    </>
  );
}

/* ── Portfolio valuation calendar (month grid, navigable) ────────────── */

export function PortfolioCalendarPanel({ projectId }: { projectId: string }) {
  type Item = Awaited<ReturnType<typeof api.portfolioCalendar>>[number];
  const [items, setItems] = useState<Item[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [cursor, setCursor] = useState<Date>(() => {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d;
  });

  useEffect(() => {
    // Fetch a window slightly wider than the visible 6-week grid so events at
    // the month boundary don't pop on/off.
    const from = new Date(cursor); from.setDate(1); from.setDate(from.getDate() - 7);
    const to = new Date(cursor); to.setMonth(to.getMonth() + 1); to.setDate(to.getDate() + 7);
    api.portfolioCalendar({ from: localIso(from), to: localIso(to) })
      // This is the project's own Schedule tab — only show this project's dates.
      .then((all) => setItems(all.filter((it) => it.project_id === projectId)))
      .catch((e) => setErr(e.message));
  }, [cursor, projectId]);

  const weeks = useMemo(() => buildMonthGrid(cursor), [cursor]);
  const byDate = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of items) {
      const key = it.date.slice(0, 10);
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(it);
    }
    return m;
  }, [items]);

  const today = localIso(new Date());
  const monthLabel = cursor.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  function shift(delta: number) {
    const next = new Date(cursor);
    next.setMonth(next.getMonth() + delta);
    setCursor(next);
  }
  function jumpToday() {
    const d = new Date(); d.setDate(1);
    setCursor(d);
  }

  return (
    <div className="card">
      <div className="card-hd">
        <h3 style={{ flex: 1 }}>Valuation calendar</h3>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <button className="ghost tiny" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
          <button className="ghost tiny" onClick={jumpToday}>Today</button>
          <button className="ghost tiny" onClick={() => shift(1)} aria-label="Next month">›</button>
        </div>
      </div>
      <div style={{ padding: 10 }}>
        {err && <div className="muted" style={{ color: "var(--danger)", marginBottom: 8 }}>{err}</div>}
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{monthLabel}</div>

        {/* Weekday header */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 3, marginBottom: 3 }}>
          {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => (
            <div key={d} className="muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", padding: "2px 4px" }}>{d}</div>
          ))}
        </div>

        {weeks.map((week, wi) => (
          <div key={wi} style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 3, marginBottom: 3 }}>
            {week.map((day) => {
              const key = localIso(day);
              const evs = byDate.get(key) ?? [];
              const ours = evs.filter((e) => e.project_id === projectId);
              const others = evs.filter((e) => e.project_id !== projectId);
              const inMonth = day.getMonth() === cursor.getMonth();
              const isToday = key === today;
              return (
                <div key={key} style={{
                  minHeight: 70,
                  padding: 3,
                  border: `1px solid ${isToday ? "var(--accent)" : "var(--line)"}`,
                  borderRadius: 4,
                  background: inMonth ? "var(--card)" : "var(--card-2)",
                  opacity: inMonth ? 1 : 0.55,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  overflow: "hidden",
                }}>
                  <div style={{
                    fontSize: 10, fontWeight: 600,
                    color: isToday ? "var(--accent)" : "var(--ink-2)",
                  }}>
                    {day.getDate()}
                  </div>
                  {/* Our project's events first (prominent), others muted */}
                  {ours.slice(0, 3).map((it, i) => <MiniChip key={`o-${i}`} it={it} prominent />)}
                  {others.slice(0, Math.max(0, 3 - ours.length)).map((it, i) => <MiniChip key={`x-${i}`} it={it} prominent={false} />)}
                  {evs.length > 3 && (
                    <div className="muted" style={{ fontSize: 9 }}>+{evs.length - 3} more</div>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 10, fontSize: 10 }}>
          {[
            { kind: "scheduled-application", label: "Application" },
            { kind: "scheduled-due", label: "Due" },
            { kind: "scheduled-notice", label: "Notice" },
            { kind: "scheduled-final_payment", label: "Final pmt" },
            { kind: "afp-period-end", label: "AfP period" },
          ].map((k) => (
            <span key={k.kind} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 6, height: 6, background: colorForKind(k.kind), borderRadius: 999 }} />
              <span className="muted">{k.label}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function MiniChip({ it, prominent }: { it: Awaited<ReturnType<typeof api.portfolioCalendar>>[number]; prominent: boolean }) {
  const color = colorForKind(it.kind);
  const text = prominent
    ? it.label.split("(")[0].trim()
    : it.project_code;
  return (
    <div
      title={`${it.project_code} — ${it.label}`}
      style={{
        fontSize: 9,
        padding: "1px 4px",
        background: `color-mix(in srgb, ${color} ${prominent ? 18 : 8}%, transparent)`,
        borderLeft: `2px solid ${color}`,
        borderRadius: 2,
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        fontWeight: prominent ? 600 : 400,
        color: prominent ? "var(--ink)" : "var(--muted)",
      }}
    >
      {text}
    </div>
  );
}

function colorForKind(kind: string): string {
  switch (kind) {
    case "scheduled-application": return "#16a34a";
    case "scheduled-due": return "#d97706";
    case "scheduled-notice": return "#ee5d2b";
    case "scheduled-final_payment": return "var(--navy)";   // navy, not purple
    case "afp-period-end": return "#0f1130";
    // Legacy kinds — keep similar tones.
    case "scheduled-cutoff": return "#d97706";
    case "scheduled-submission": return "#16a34a";
    case "scheduled-certification": return "#ee5d2b";
    case "scheduled-payment": return "var(--navy)";
    default: return "#6b7280";
  }
}

function valuationLabel(t: string): string {
  switch (t) {
    case "application": return "Application date";
    case "due": return "Due date";
    case "notice": return "Notice date";
    case "final_payment": return "Final date for payment";
    default: return t;
  }
}

/** Local-time ISO yyyy-mm-dd (avoid Date.toISOString which uses UTC). */
function localIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 6-row, Monday-anchored grid of dates covering the displayed month. */
function buildMonthGrid(monthCursor: Date): Date[][] {
  const first = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - startOffset);
  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d++) {
      const cell = new Date(start);
      cell.setDate(start.getDate() + w * 7 + d);
      row.push(cell);
    }
    weeks.push(row);
  }
  return weeks;
}

/* ── Valuation schedule upload + add-entry form ──────────────────────── */

export function ValuationScheduleUpload({ projectId, canEdit, mirrorProjectIds = [] }: { projectId: string; canEdit: boolean; mirrorProjectIds?: string[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof api.listValuationEntries>>>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<{ entry_type: "application" | "due" | "notice" | "final_payment"; date: string; app_number: string; notes: string }>({ entry_type: "application", date: "", app_number: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [project, setProject] = useState<Awaited<ReturnType<typeof api.getProject>>["project"] | null>(null);

  function refresh() {
    api.listValuationEntries(projectId).then(setEntries).catch(() => setEntries([]));
    api.getProject(projectId).then((r) => setProject(r.project)).catch(() => setProject(null));
  }
  useEffect(refresh, [projectId]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!f) return;
    setBusy(true); setErr(null); setInfo(null);
    try {
      const r = await api.uploadValuationSchedule(projectId, f);
      // Grouped blocks share one payment schedule — replay the upload so every
      // block's calendar carries the same dates.
      await Promise.all(mirrorProjectIds.map((mid) => api.uploadValuationSchedule(mid, f).catch(() => {})));
      if (r.parsed && r.entries_created > 0) {
        setInfo(`Imported ${r.entries_created} schedule date${r.entries_created === 1 ? "" : "s"} from ${r.filename}.`);
      } else if (r.parsed) {
        setInfo(
          `Read ${r.filename} but couldn't recognise the layout. The parser looks for date columns labelled "Application date", "Due date", "Notice date" or "Final date for payment" — either as columns (one row per valuation) or as rows (transposed, with the entry-type names in column A). Add entries manually below, or send the file headers so I can extend the matcher.`,
        );
      } else {
        setInfo(`Recorded ${r.filename}. PDF previews aren't auto-parsed — add the dates manually below.`);
      }
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "upload failed");
    } finally { setBusy(false); }
  }

  async function saveEntry() {
    if (!form.date) { setErr("Date required"); return; }
    setBusy(true); setErr(null);
    try {
      const entry = {
        entry_type: form.entry_type,
        date: form.date,
        app_number: form.app_number ? Number(form.app_number) : null,
        notes: form.notes || undefined,
      };
      await api.addValuationEntry(projectId, entry);
      await Promise.all(mirrorProjectIds.map((mid) => api.addValuationEntry(mid, entry).catch(() => {})));
      setForm({ entry_type: "application", date: "", app_number: "", notes: "" });
      setAdding(false);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally { setBusy(false); }
  }

  async function deleteEntry(id: number) {
    // Mirror the delete by matching the same-dated entry on each sibling block
    // (ids differ per project; type + date + app number identify the entry).
    const target = entries.find((e) => e.id === id);
    await api.deleteValuationEntry(id);
    if (target && mirrorProjectIds.length) {
      await Promise.all(mirrorProjectIds.map(async (mid) => {
        try {
          const rows = await api.listValuationEntries(mid);
          const twin = rows.find((r) => r.entry_type === target.entry_type && r.date === target.date
            && (r.app_number ?? null) === (target.app_number ?? null));
          if (twin) await api.deleteValuationEntry(twin.id);
        } catch { /* best-effort */ }
      }));
    }
    refresh();
  }

  return (
    <div className="card">
      <div className="card-hd">
        <h3 style={{ flex: 1 }}>Project schedule</h3>
        {canEdit && (
          <>
            <input ref={fileRef} type="file" style={{ display: "none" }} accept=".pdf,.xlsx,.xls" onChange={onFile} />
            <button className="ghost tiny" onClick={() => fileRef.current?.click()} disabled={busy}>↑ Upload</button>
            {entries.length > 0 && (
              <button className="ghost tiny danger" disabled={busy}
                title="Delete every schedule date on this project — e.g. to wipe a wrong upload and start again"
                onClick={async () => {
                  const scopeNote = mirrorProjectIds.length ? " (and its sibling blocks)" : "";
                  if (!window.confirm(`Delete all ${entries.length} schedule date${entries.length === 1 ? "" : "s"} for this project${scopeNote}?`)) return;
                  setBusy(true); setErr(null); setInfo(null);
                  try {
                    const r = await api.clearValuationSchedule(projectId);
                    await Promise.all(mirrorProjectIds.map((mid) => api.clearValuationSchedule(mid).catch(() => {})));
                    setInfo(`Cleared ${r.deleted} schedule date${r.deleted === 1 ? "" : "s"}.`);
                    refresh();
                  } catch (e) { setErr(e instanceof Error ? e.message : "couldn't clear the schedule"); }
                  finally { setBusy(false); }
                }}>Clear all</button>
            )}
          </>
        )}
      </div>
      <div className="card-bd">
        {err && <div className="flash error" style={{ marginBottom: 8 }}>{err}</div>}
        {info && <div className="flash success" style={{ marginBottom: 8 }}>{info}</div>}
        {project?.valuation_schedule_filename && (
          <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
            Last uploaded: <b>{project.valuation_schedule_filename}</b>
            {project.valuation_schedule_uploaded_at && <> · {fmtDate(project.valuation_schedule_uploaded_at)}</>}
          </div>
        )}
        {canEdit && !adding && (
          <button className="ghost tiny" onClick={() => setAdding(true)} style={{ marginBottom: 8 }}>+ Add date</button>
        )}
        {canEdit && adding && (
          <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
            <select value={form.entry_type} onChange={(e) => setForm({ ...form, entry_type: e.target.value as typeof form.entry_type })}>
              <option value="application">Application date</option>
              <option value="due">Due date</option>
              <option value="notice">Notice date</option>
              <option value="final_payment">Final date for payment</option>
            </select>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            <input type="number" placeholder="App # (optional)" value={form.app_number} onChange={(e) => setForm({ ...form, app_number: e.target.value })} />
            <input placeholder="Notes (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            <div style={{ display: "flex", gap: 6 }}>
              <button className="primary tiny" onClick={saveEntry} disabled={busy}>Save</button>
              <button className="ghost tiny" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        )}
        {entries.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>No schedule entries yet.</div>
        ) : (
          <ScheduleEntryGroups entries={entries} canEdit={canEdit} onDelete={deleteEntry} />
        )}
      </div>
    </div>
  );
}

/* ── Schedule list, grouped by valuation and date-sorted ──────────────── */

function ScheduleEntryGroups({
  entries, canEdit, onDelete,
}: {
  entries: Awaited<ReturnType<typeof api.listValuationEntries>>;
  canEdit: boolean;
  onDelete: (id: number) => void;
}) {
  type Entry = (typeof entries)[number];
  // Stable order for the four entry types within a valuation block.
  const TYPE_ORDER: Record<string, number> = {
    application: 1, due: 2, notice: 3, final_payment: 4,
  };

  // ISO yyyy-mm-dd for today's local date — used to hide past entries.
  const todayIso = useMemo(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }, []);

  const groups = useMemo(() => {
    const m = new Map<string, Entry[]>();
    // Filter out entries whose date is strictly before today.
    for (const e of entries) {
      if (e.date < todayIso) continue;
      const key = e.app_number == null ? "none" : `app-${e.app_number}`;
      const arr = m.get(key) ?? [];
      arr.push(e);
      m.set(key, arr);
    }
    const result = [...m.values()].map((list) => {
      const sorted = [...list].sort((a, b) => {
        const dateCmp = a.date.localeCompare(b.date);
        if (dateCmp !== 0) return dateCmp;
        return (TYPE_ORDER[a.entry_type] ?? 99) - (TYPE_ORDER[b.entry_type] ?? 99);
      });
      return {
        app_number: sorted[0].app_number,
        earliest: sorted[0].date,
        latest: sorted[sorted.length - 1].date,
        entries: sorted,
      };
    });
    // Sort valuations by their earliest upcoming date so the next cycle is on top.
    result.sort((a, b) => a.earliest.localeCompare(b.earliest));
    return result;
  }, [entries, todayIso]);

  const hiddenCount = entries.filter((e) => e.date < todayIso).length;

  return (
    <>
      {groups.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          All scheduled dates are in the past.
          {hiddenCount > 0 && <> ({hiddenCount} hidden.)</>}
        </div>
      ) : (
        <div style={{ maxHeight: 360, overflowY: "auto", display: "grid", gap: 8 }}>
          {groups.map((g, gi) => (
            <div key={gi} style={{ border: "1px solid var(--line)", borderRadius: 4, padding: "6px 8px" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>
                  {g.app_number != null ? `Val #${g.app_number}` : "Unnumbered"}
                </span>
                <span className="muted" style={{ fontSize: 10 }}>
                  {fmtDate(g.earliest)} → {fmtDate(g.latest)}
                </span>
                <span style={{ flex: 1 }} />
                <span className="muted" style={{ fontSize: 10 }}>{g.entries.length} dates</span>
              </div>
              <div style={{ display: "grid", gap: 2 }}>
                {g.entries.map((e) => (
                  <div key={e.id} style={{
                    display: "flex", alignItems: "baseline", gap: 6,
                    fontSize: 11, padding: "2px 0",
                  }}>
                    <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums", width: 56 }}>
                      {fmtDate(e.date).slice(0, 6)}
                    </span>
                    <span style={{ flex: 1 }}>{valuationLabel(e.entry_type)}</span>
                    {canEdit && (
                      <button className="ghost tiny" onClick={() => onDelete(e.id)} title="Delete this date">×</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {hiddenCount > 0 && groups.length > 0 && (
        <div className="muted" style={{ fontSize: 10, marginTop: 6, textAlign: "right" }}>
          {hiddenCount} past date{hiddenCount === 1 ? "" : "s"} hidden
        </div>
      )}
    </>
  );
}
