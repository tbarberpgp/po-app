// Portfolio-wide Applications workspace — every Application for Payment across
// all projects in one place. Filter by direction / project / subcontractor /
// status, spot unassigned
// labour apps (typically arrived via forwarded email) and assign the
// subcontractor inline without opening each one.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import { useStickyCard } from "../lib/sticky";
import { can } from "../../shared/permissions";
import type { AfpDetail, AfpStatus, ApplicationListItem, CurrentUser, InboundApplication, Supplier } from "../../shared/types";
import type { AfpHistoryEntry } from "../lib/api";

type ProjectOption = { id: string; code: string; name: string; active_snapshot_id: number | null };

const STATUS_PILL: Record<AfpStatus, string> = {
  draft: "draft",
  pending_approval: "pending",
  submitted: "warn",      // awaiting certification → amber (orange is for CTAs only)
  certified: "approved",
  paid: "approved",
};
const STATUS_LABEL: Record<AfpStatus, string> = {
  draft: "Draft",
  pending_approval: "Pending approval",
  submitted: "Submitted",
  certified: "Certified",
  paid: "Paid",
};

type Space = "labour" | "client";
type StatusFilter = "all" | AfpStatus;

export function ApplicationsWorkspace({ me }: { me: CurrentUser | null }) {
  const canEdit = can(me, "commercial.edit");
  const [rows, setRows] = useState<ApplicationListItem[]>([]);
  const cardRef = useStickyCard();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [inbound, setInbound] = useState<InboundApplication[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [space, setSpace] = useState<Space>("labour");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [projectFilter, setProjectFilter] = useState("");   // project id, "" = all
  const [supplierFilter, setSupplierFilter] = useState(""); // supplier id, "" = all
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The application open in the side panel — clicking a row previews it in place.
  const [openId, setOpenId] = useState<number | null>(null);

  function refresh() {
    setLoading(true);
    api.listAllApplications()
      .then(setRows)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
    api.listInboundApplications().then(setInbound).catch(() => setInbound([]));
  }
  useEffect(() => {
    refresh();
    api.listSuppliers().then(setSuppliers).catch(() => setSuppliers([]));
    api.listProjects().then(setProjects).catch(() => setProjects([]));
  }, []);

  const labourSuppliers = useMemo(() => suppliers.filter((s) => s.is_labour_supplier), [suppliers]);

  const direction = space === "labour" ? "incoming_labour" : "outgoing";
  const isLabour = space === "labour";

  // Rows + inbound scoped to the active space
  const spaceRows = rows.filter((r) => r.direction === direction);
  const spaceInbound = inbound.filter((i) => i.direction === direction);

  // Filter choices come from the applications themselves, so every option
  // matches at least one row in this space.
  const projectOptions = useMemo(() => {
    const m = new Map<string, { id: string; code: string; name: string }>();
    for (const r of spaceRows) m.set(r.project_id, { id: r.project_id, code: r.project_code, name: r.project_name });
    return [...m.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [spaceRows]);
  const supplierOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of spaceRows) if (r.counterparty_supplier_id != null) m.set(r.counterparty_supplier_id, r.supplier_name ?? `Supplier ${r.counterparty_supplier_id}`);
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [spaceRows]);

  const visible = spaceRows
    .filter((r) => !projectFilter || r.project_id === projectFilter)
    .filter((r) => !isLabour || !supplierFilter || String(r.counterparty_supplier_id) === supplierFilter)
    .filter((r) => status === "all" || r.status === status)
    .filter((r) => !unassignedOnly || (isLabour && r.counterparty_supplier_id == null));

  // KPI counts within the active space
  const counts = useMemo(() => ({
    total: spaceRows.length,
    needsProject: spaceInbound.length,
    unassigned: isLabour ? spaceRows.filter((r) => r.counterparty_supplier_id == null).length : 0,
    needsReview: spaceRows.filter((r) => r.has_unmatched === 1).length,
    certified: spaceRows.filter((r) => r.status === "certified" || r.status === "paid").length,
  }), [spaceRows, spaceInbound, isLabour]);

  // Tab badge counts (across both directions) for at-a-glance attention
  const filtered = projectFilter !== "" || (isLabour && supplierFilter !== "") || status !== "all" || unassignedOnly;
  function switchSpace(next: Space) {
    setSpace(next); setStatus("all"); setProjectFilter(""); setSupplierFilter(""); setUnassignedOnly(false); setOpenId(null);
  }

  const labourCount = rows.filter((r) => r.direction === "incoming_labour").length
    + inbound.filter((i) => i.direction === "incoming_labour").length;
  const clientCount = rows.filter((r) => r.direction === "outgoing").length
    + inbound.filter((i) => i.direction === "outgoing").length;

  async function assign(afpId: number, supplierId: number) {
    setErr(null);
    try {
      await api.updateAfp(afpId, { counterparty_supplier_id: supplierId });
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "assign failed");
    }
  }

  return (
    <>
      <Topbar crumbs="Workspace" title="Applications" />
      <main>
        {err && <div className="flash error">{err}</div>}

        {/* Two distinct spaces */}
        <div className="tabs" style={{ marginBottom: 16 }}>
          <button
            type="button"
            className={`tab-btn${space === "labour" ? " active" : ""}`}
            onClick={() => switchSpace("labour")}
          >
            Labour applications <span className="count">{labourCount}</span>
          </button>
          <button
            type="button"
            className={`tab-btn${space === "client" ? " active" : ""}`}
            onClick={() => switchSpace("client")}
          >
            Client applications <span className="count">{clientCount}</span>
          </button>
        </div>

        {/* KPI strip scoped to the active space */}
        <div className="kpis" style={{ marginBottom: 16 }}>
          <Kpi label={isLabour ? "Labour applications" : "Client applications"} value={String(counts.total)} />
          <Kpi label="Needs a project" value={String(counts.needsProject)} tone={counts.needsProject > 0 ? "warn" : "default"} />
          {isLabour && (
            <Kpi label="Unassigned subbie" value={String(counts.unassigned)} tone={counts.unassigned > 0 ? "warn" : "default"} />
          )}
          <Kpi label="Lines need review" value={String(counts.needsReview)} tone={counts.needsReview > 0 ? "warn" : "default"} />
          <Kpi label="Certified / paid" value={String(counts.certified)} tone={counts.certified > 0 ? "success" : "default"} />
        </div>

        {/* Inbound tray — emails in this space received without a resolvable project */}
        {spaceInbound.length > 0 && (
          <InboundTray
            items={spaceInbound}
            projects={projects}
            labourSuppliers={labourSuppliers}
            canEdit={canEdit}
            onChange={refresh}
            onErr={setErr}
          />
        )}

        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div className="card" ref={cardRef} style={{ flex: 1, minWidth: 0 }}>
          <div className="card-hd sticky-bar" style={{ gap: 12, flexWrap: "wrap" }}>
            <h2 style={{ flex: 1 }}>{isLabour ? "Labour applications" : "Client applications"}</h2>
            <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} style={{ width: "auto", minWidth: 180 }} aria-label="Filter by project">
              <option value="">All projects</option>
              {projectOptions.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
            </select>
            {isLabour && (
              <select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)} style={{ width: "auto", minWidth: 180 }} aria-label="Filter by subcontractor">
                <option value="">All subcontractors</option>
                {supplierOptions.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
              </select>
            )}
            <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} style={{ width: "auto", minWidth: 150 }} aria-label="Filter by status">
              <option value="all">All statuses</option>
              <option value="draft">Draft</option>
              <option value="pending_approval">Pending approval</option>
              <option value="submitted">Submitted</option>
              <option value="certified">Certified</option>
              <option value="paid">Paid</option>
            </select>
            {isLabour && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, textTransform: "none", letterSpacing: 0, color: "var(--ink)", cursor: "pointer", margin: 0 }}>
                <input type="checkbox" checked={unassignedOnly} onChange={(e) => setUnassignedOnly(e.target.checked)} style={{ minHeight: 0 }} />
                Unassigned only
              </label>
            )}
          </div>

          {loading ? (
            <div className="card-bd"><div className="muted">Loading…</div></div>
          ) : visible.length === 0 ? (
            <div className="card-bd"><div className="empty">No {isLabour ? "labour" : "client"} applications{filtered ? " match the current filter" : " yet"}.</div></div>
          ) : (
            <ApplicationsTable
              rows={visible}
              isLabour={isLabour}
              canEdit={canEdit}
              labourSuppliers={labourSuppliers}
              onAssign={assign}
              openId={openId}
              onOpen={(id) => setOpenId((cur) => (cur === id ? null : id))}
            />
          )}
        </div>
        {openId != null && (
          <AfpPeek
            id={openId}
            row={rows.find((r) => r.id === openId) ?? null}
            onClose={() => setOpenId(null)}
          />
        )}
        </div>
      </main>
    </>
  );
}

/**
 * The applications table — shared by the portfolio workspace and a project's
 * Labour tab (which drops the Project column). A row opens its application —
 * or, given `onOpen`, previews it beside the list; an unassigned labour row
 * offers the subcontractor picker inline.
 */
export function ApplicationsTable({
  rows, isLabour, canEdit, labourSuppliers, onAssign, showProject = true, openId = null, onOpen,
}: {
  rows: ApplicationListItem[];
  isLabour: boolean;
  canEdit: boolean;
  labourSuppliers: Supplier[];
  onAssign: (afpId: number, supplierId: number) => void;
  showProject?: boolean;
  /** The row previewed in the side panel, highlighted. */
  openId?: number | null;
  /** Row click previews instead of navigating; who/when moves to the panel. */
  onOpen?: (afpId: number) => void;
}) {
  const navigate = useNavigate();
  // With the panel open the table loses ~440px, so Created (who/when) gives
  // way — the panel's audit trail carries it.
  const showCreated = openId == null;
  return (
    <table className="sticky-head">
      <thead>
        <tr>
          <th className="center">#</th>
          {showProject && <th>Project</th>}
          <th>{isLabour ? "Subcontractor" : "Client"}</th>
          <th>Period</th>
          <th className="center">Status</th>
          <th className="num">Value</th>
          {showCreated && <th>Created</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const isUnassigned = isLabour && r.counterparty_supplier_id == null;
          const value = r.status === "certified" || r.status === "paid"
            ? (r.certified_amount ?? r.amount_due ?? 0)
            : (r.total_invoice ?? 0);
          return (
            // The whole row opens the application — hunting for the
            // small "#n" link is needless precision. Inner links and the
            // assign dropdown stop the bubble so they still do their own job.
            <tr key={r.id} className="rep-row"
              style={{ cursor: "pointer", ...(openId === r.id ? { background: "var(--accent-soft)", boxShadow: "inset 3px 0 0 var(--accent)" } : {}) }}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("a,select,button,input,label")) return;
                if (onOpen) onOpen(r.id); else navigate(`/applications/${r.id}`);
              }}>
              <td className="center">
                <Link to={`/applications/${r.id}`} onClick={(e) => e.stopPropagation()}>#{r.app_number}</Link>
              </td>
              {showProject && (
                <td>
                  <Link to={`/projects/${r.project_id}`} style={{ fontWeight: 500 }} onClick={(e) => e.stopPropagation()}>{r.project_code}</Link>
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{r.project_name}</div>
                </td>
              )}
              <td>
                {!isLabour ? (
                  <span className="muted">Client (per project)</span>
                ) : isUnassigned ? (
                  canEdit ? (
                    <select
                      defaultValue=""
                      onChange={(e) => { const id = Number(e.target.value); if (id > 0) onAssign(r.id, id); }}
                      style={{ minWidth: 200, borderColor: "var(--warn, #ea580c)" }}
                      title="No subcontractor assigned — pick one"
                    >
                      <option value="">⚠ assign subcontractor…</option>
                      {labourSuppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  ) : (
                    <span className="pill rejected" title="No subcontractor assigned">Unassigned</span>
                  )
                ) : (
                  r.supplier_name ?? <span className="muted">—</span>
                )}
              </td>
              <td>{fmtDate(r.period_end)}</td>
              <td className="center">
                <span className={`pill ${STATUS_PILL[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                {r.has_unmatched === 1 && (
                  <span className="pill pending" style={{ marginLeft: 6, fontSize: 10 }} title="Some uploaded lines still need review">review</span>
                )}
                {r.attention_note?.trim() && (
                  <span className="pill danger" style={{ marginLeft: 6, fontSize: 10, cursor: "help" }} title={`Needs attention: ${r.attention_note}`}>⚑ attention</span>
                )}
              </td>
              <td className="num">{fmtMoney(value)}</td>
              {showCreated && (
                <td className="muted" style={{ fontSize: 12 }}>
                  {fmtDate(r.created_at)}
                  <div style={{ fontSize: 11 }}>{formatActor(r.created_by)}</div>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * One project's labour applications, as the workspace shows them: the same
 * status filter and table, scoped to the project and without the Project
 * column. Sits on the project's Commercials → Labour tab, folded to a single
 * header line (with the counts) until opened — the list runs long. `reloadKey`
 * changes whenever the project's applications do, so the list follows.
 */
export function ProjectLabourApplications({
  projectId, canEdit, reloadKey, onChanged,
}: {
  projectId: string;
  canEdit: boolean;
  reloadKey?: unknown;
  /** Called after an inline change (a subcontractor assigned) so the page refetches. */
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<ApplicationListItem[] | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const cardRef = useStickyCard();

  useEffect(() => {
    let live = true;
    api.listAllApplications({ direction: "incoming_labour", projectId })
      .then((r) => { if (live) { setRows(r); setErr(null); } })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : "failed to load applications"); });
    return () => { live = false; };
  }, [projectId, reloadKey, tick]);
  useEffect(() => {
    if (canEdit) api.listSuppliers().then(setSuppliers).catch(() => setSuppliers([]));
  }, [canEdit]);

  const labourSuppliers = useMemo(() => suppliers.filter((s) => s.is_labour_supplier), [suppliers]);
  const all = rows ?? [];
  const visible = all
    .filter((r) => status === "all" || r.status === status)
    .filter((r) => !unassignedOnly || r.counterparty_supplier_id == null);
  const unassigned = all.filter((r) => r.counterparty_supplier_id == null).length;
  const needsReview = all.filter((r) => r.has_unmatched === 1).length;
  const certified = all.filter((r) => r.status === "certified" || r.status === "paid").length;

  async function assign(afpId: number, supplierId: number) {
    setErr(null);
    try {
      await api.updateAfp(afpId, { counterparty_supplier_id: supplierId });
      setTick((t) => t + 1);
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "assign failed");
    }
  }

  const warn = { color: "var(--warn)", fontWeight: 600 } as const;
  return (
    <div className="card" ref={cardRef}>
      <div className="card-hd sticky-bar" style={{ gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 10, background: "none", border: 0, padding: 0, minHeight: 0, cursor: "pointer", textAlign: "left", color: "inherit" }}
        >
          <span className="muted" style={{ width: 12 }}>{open ? "▾" : "▸"}</span>
          <h2 style={{ margin: 0 }}>Labour applications</h2>
          {rows != null && (
            <span className="muted" style={{ fontSize: 12 }}>
              {all.length} · {certified} certified / paid
              {unassigned > 0 && <> · <span style={warn}>{unassigned} unassigned</span></>}
              {needsReview > 0 && <> · <span style={warn}>{needsReview} need review</span></>}
            </span>
          )}
        </button>
        {open && (
          <>
            <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="all">All statuses</option>
              <option value="draft">Draft</option>
              <option value="pending_approval">Pending approval</option>
              <option value="submitted">Submitted</option>
              <option value="certified">Certified</option>
              <option value="paid">Paid</option>
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, textTransform: "none", letterSpacing: 0, color: "var(--ink)", cursor: "pointer", margin: 0 }}>
              <input type="checkbox" checked={unassignedOnly} onChange={(e) => setUnassignedOnly(e.target.checked)} style={{ minHeight: 0 }} />
              Unassigned only
            </label>
          </>
        )}
      </div>
      {err && <div className="card-bd"><div className="flash error">{err}</div></div>}
      {open && (rows == null ? (
        !err && <div className="card-bd"><div className="muted">Loading…</div></div>
      ) : visible.length === 0 ? (
        <div className="card-bd"><div className="empty">No labour applications{status !== "all" || unassignedOnly ? " match the current filter" : " on this project yet"}.</div></div>
      ) : (
        <ApplicationsTable
          rows={visible}
          isLabour
          canEdit={canEdit}
          labourSuppliers={labourSuppliers}
          onAssign={assign}
          showProject={false}
        />
      ))}
    </div>
  );
}

/**
 * One application previewed beside the list: who it's from, what it claims
 * line by line, how the money adds up, and its history — enough to read it
 * without opening it. Certifying and editing stay on the full page.
 */
function AfpPeek({ id, row, onClose }: { id: number; row: ApplicationListItem | null; onClose: () => void }) {
  const [detail, setDetail] = useState<AfpDetail | null>(null);
  const [history, setHistory] = useState<AfpHistoryEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setDetail(null); setErr(null); setHistory([]);
    api.getAfp(id)
      .then((d) => { if (live) setDetail(d); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : "failed to load"); });
    api.getAfpHistory(id).then((h) => { if (live) setHistory(h); }).catch(() => {});
    return () => { live = false; };
  }, [id]);
  // Esc closes the panel, as ✕ does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const afp = detail?.afp;
  const isLabour = afp ? afp.direction === "incoming_labour" : row?.direction === "incoming_labour";
  const fact = (label: string, value: React.ReactNode) => (
    <><span className="muted">{label}</span><span>{value}</span></>
  );
  // Only the lines with something claimed — a labour app carries the whole
  // BOQ, most of it at nil.
  const claimed = (detail?.lines ?? []).filter((l) => (l.cumulative_value ?? 0) !== 0);
  const unmatched = (() => {
    try { return afp?.unmatched_lines_json ? (JSON.parse(afp.unmatched_lines_json) as unknown[]).length : 0; }
    catch { return 0; }
  })();
  const money: Array<[string, number | null | undefined, boolean?]> = afp ? [
    ["Gross to date", afp.cumulative_value],
    ["Less previously certified", afp.previous_certified != null ? -afp.previous_certified : null],
    ["Expenses", afp.expenses_amount || null],
    ["Dayworks", afp.dayworks_amount || null],
    ["This period (net)", afp.this_period_net],
    ["Retention", afp.retention_amount ? -afp.retention_amount : null],
    ["Amount due", afp.amount_due],
    ["VAT", afp.vat_amount || null],
  ] : [];
  const total = afp ? (afp.status === "certified" || afp.status === "paid" ? (afp.certified_amount ?? afp.total_invoice) : afp.total_invoice) : null;
  const cta = afp?.status === "submitted" ? "Review & certify →"
    : afp?.status === "pending_approval" ? "Review & approve →"
    : afp?.status === "draft" ? "Open draft →"
    : "Open full application →";

  return (
    <aside className="card" style={{ width: 420, flex: "0 0 420px", position: "sticky", top: 16, maxHeight: "calc(100vh - 32px)", overflow: "auto" }}>
      <div className="card-hd" style={{ alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em" }}>
            {isLabour ? "Labour application" : "Client application"}
          </div>
          <h2 style={{ margin: "2px 0 6px" }}>#{afp?.app_number ?? row?.app_number}</h2>
          {afp && <span className={`pill ${STATUS_PILL[afp.status]}`}>{STATUS_LABEL[afp.status]}</span>}
          {unmatched > 0 && <span className="pill pending" style={{ marginLeft: 4 }}>{unmatched} line{unmatched === 1 ? "" : "s"} to review</span>}
          {afp?.attention_note?.trim() && <span className="pill danger" style={{ marginLeft: 4 }} title={afp.attention_note}>⚑ attention</span>}
        </div>
        <button className="ghost tiny" onClick={onClose} title="Close (Esc)">✕</button>
      </div>
      {err ? <div className="card-bd"><div className="flash error">{err}</div></div>
        : !afp ? <div className="card-bd muted">Loading…</div> : (
        <>
          <div className="card-bd" style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: "6px 12px", fontSize: 13 }}>
            {isLabour && fact("Subcontractor", row?.supplier_name ?? <span style={{ color: "var(--warn)" }}>Unassigned</span>)}
            {row && fact("Project", `${row.project_code} · ${row.project_name}`)}
            {fact("Period", fmtDate(afp.period_end))}
            {afp.claim_basis && fact("Basis", afp.claim_basis === "period" ? "This period only" : "Cumulative to date")}
            {afp.invoiced_days != null && fact("Days", `${afp.invoiced_days} invoiced${afp.signin_days != null ? ` · ${afp.signin_days} signed in` : ""}`)}
            {afp.source_file_key && fact("Source", (
              <a href={`/api/applications/${afp.id}/source-file`} target="_blank" rel="noreferrer">{afp.source_file_name ?? "document"} ↗</a>
            ))}
            {afp.attention_note?.trim() && fact("Attention", <span style={{ color: "var(--danger)" }}>{afp.attention_note}</span>)}
          </div>

          <div className="card-bd" style={{ borderTop: "1px solid var(--line)" }}>
            {claimed.length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>No lines claimed{unmatched > 0 ? " yet — the uploaded lines still need matching" : ""}.</div>
            ) : claimed.map((l) => {
              const prev = l.previously_certified ?? 0;
              const thisPeriod = afp.claim_basis === "period" ? l.cumulative_value : l.cumulative_value - prev;
              return (
                <div key={l.id} style={{ display: "flex", gap: 12, fontSize: 13, padding: "4px 0" }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {l.description}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {l.is_adhoc ? "Ad hoc" : l.section ?? ""}
                      {l.qty != null && l.unit ? `${l.is_adhoc || l.section ? " · " : ""}${l.qty} ${l.unit} × ${fmtMoney(l.rate)}` : ""}
                      {afp.claim_basis !== "period" && prev !== 0 ? ` · ${fmtMoney(thisPeriod)} this period` : ""}
                    </div>
                  </span>
                  <span className="num">{fmtMoney(l.cumulative_value)}</span>
                </div>
              );
            })}
          </div>

          <div className="card-bd" style={{ borderTop: "1px solid var(--line)", fontSize: 13 }}>
            {money.filter(([, v]) => v != null).map(([label, v]) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                <span className="muted">{label}</span><span className="num">{fmtMoney(v as number)}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1.5px solid var(--ink)", marginTop: 8, paddingTop: 8, fontWeight: 700, fontSize: 14 }}>
              <span>{afp.status === "certified" || afp.status === "paid" ? "Certified" : "Total"}</span><span>{fmtMoney(total ?? 0)}</span>
            </div>
          </div>

          <div className="card-bd" style={{ borderTop: "1px solid var(--line)" }}>
            <Link className="btn accent" to={`/applications/${afp.id}`} style={{ display: "block", textAlign: "center" }}>{cta}</Link>
          </div>

          <div className="card-hd" style={{ borderTop: "1px solid var(--line)" }}><h3>Audit trail</h3></div>
          <div className="card-bd">
            {(history.length > 0 ? history : [{ at: afp.created_at, what: "Created", by: afp.created_by }]).map((h, i) => (
              <div key={i} style={{ display: "flex", gap: 8, fontSize: 13, padding: "5px 0" }}>
                <span style={{ flex: 1 }}>
                  <span className="muted">{h.what}</span>{h.by && <> <b>{formatActor(h.by)}</b></>}
                  {h.detail && <div className="muted" style={{ fontSize: 12 }}>{h.detail}</div>}
                </span>
                <span className="muted" style={{ whiteSpace: "nowrap" }}>{fmtDate(h.at)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

/** Inbound tray — emails parked without a project. Pick a project (+ subbie) to create the draft. */
function InboundTray({
  items, projects, labourSuppliers, canEdit, onChange, onErr,
}: {
  items: InboundApplication[];
  projects: ProjectOption[];
  labourSuppliers: Supplier[];
  canEdit: boolean;
  onChange: () => void;
  onErr: (msg: string | null) => void;
}) {
  const navigate = useNavigate();
  const [picks, setPicks] = useState<Record<number, { projectId: string; supplierId: number | null; periodMode?: boolean }>>({});
  const [busyId, setBusyId] = useState<number | null>(null);

  function setPick(id: number, patch: Partial<{ projectId: string; supplierId: number | null; periodMode: boolean }>) {
    setPicks((prev) => {
      const base = prev[id] ?? { projectId: "", supplierId: null, periodMode: false };
      return { ...prev, [id]: { ...base, ...patch } };
    });
  }

  async function resolve(item: InboundApplication) {
    const pick = picks[item.id];
    if (!pick?.projectId) { onErr("Pick a project first"); return; }
    setBusyId(item.id); onErr(null);
    try {
      const r = await api.resolveInboundApplication(item.id, {
        project_id: pick.projectId,
        counterparty_supplier_id: pick.supplierId ?? item.counterparty_supplier_id ?? undefined,
        period_mode: pick.periodMode || undefined,
      });
      onChange();
      navigate(`/applications/${r.id}`);
    } catch (e) {
      onErr(e instanceof Error ? e.message : "couldn't create draft");
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(item: InboundApplication) {
    if (!confirm(`Dismiss the application from ${item.sender_email}? This can't be undone.`)) return;
    setBusyId(item.id); onErr(null);
    try { await api.dismissInboundApplication(item.id); onChange(); }
    catch (e) { onErr(e instanceof Error ? e.message : "dismiss failed"); }
    finally { setBusyId(null); }
  }

  return (
    <div className="card" style={{ marginBottom: 16, background: "var(--warn-soft, #fff7ed)", borderLeft: "4px solid var(--warn, #ea580c)" }}>
      <div className="card-hd">
        <h2 style={{ flex: 1 }}>⚠ Needs assignment ({items.length})</h2>
        <span className="muted" style={{ fontSize: 12 }}>received by email — pick a project to create the draft</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>From</th>
            <th className="center">Type</th>
            <th>Subject / file</th>
            <th className="num">Lines</th>
            <th>Project</th>
            <th>Subcontractor</th>
            {canEdit && <th></th>}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const pick = picks[item.id] ?? { projectId: "", supplierId: null };
            const isOutgoing = item.direction === "outgoing";
            return (
              <tr key={item.id}>
                <td>
                  <div>{item.sender_email}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{fmtDate(item.received_at)}</div>
                </td>
                <td className="center">
                  {isOutgoing ? <span className="badge draft">Client</span> : <span className="badge">Labour</span>}
                </td>
                <td>
                  <div>{item.subject || <span className="muted">(no subject)</span>}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{item.filename ?? "—"}</div>
                </td>
                <td className="num">{item.line_count}</td>
                <td>
                  {canEdit ? (
                    <select
                      value={pick.projectId}
                      onChange={(e) => setPick(item.id, { projectId: e.target.value })}
                      style={{ minWidth: 200, borderColor: "var(--warn, #ea580c)" }}
                    >
                      <option value="">⚠ pick project…</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id} disabled={p.active_snapshot_id == null}>
                          {p.code} — {p.name}{p.active_snapshot_id == null ? " (no pricing)" : ""}
                        </option>
                      ))}
                    </select>
                  ) : <span className="muted">—</span>}
                </td>
                <td>
                  {isOutgoing ? (
                    <span className="muted">Client (per project)</span>
                  ) : item.counterparty_supplier_id && item.supplier_name ? (
                    item.supplier_name
                  ) : canEdit ? (
                    <select
                      value={pick.supplierId ?? ""}
                      onChange={(e) => setPick(item.id, { supplierId: e.target.value ? Number(e.target.value) : null })}
                      style={{ minWidth: 180 }}
                    >
                      <option value="">— optional —</option>
                      {labourSuppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  ) : <span className="muted">—</span>}
                </td>
                {canEdit && (
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, whiteSpace: "nowrap" }}
                        title="The application's figures are for THIS period only — every line starts at its previously-certified position and the claimed values add on top">
                        <input type="checkbox" checked={!!pick.periodMode} onChange={(e) => setPick(item.id, { periodMode: e.target.checked })} />
                        Figures are this period
                      </label>
                      <button className="primary tiny" onClick={() => resolve(item)} disabled={busyId === item.id || !pick.projectId}>
                        {busyId === item.id ? "…" : "Create draft"}
                      </button>
                      <button className="ghost tiny" onClick={() => dismiss(item)} disabled={busyId === item.id}>Dismiss</button>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Kpi({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "success" | "warn" }) {
  // Labels stay muted; colour is reserved for the value, and only when it's
  // semantic — amber for attention metrics above zero, green for certified/paid.
  // At zero everything is neutral ink so a clean board reads calm.
  const valueColor = tone === "success" ? "var(--success)" : tone === "warn" ? "var(--warn)" : undefined;
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={valueColor ? { color: valueColor } : undefined}>{value}</div>
    </div>
  );
}

/** "email:dave@subbie.co.uk" → "via email · dave@subbie.co.uk"; otherwise the raw actor. */
function formatActor(actor: string): string {
  if (actor.startsWith("email:")) return `via email · ${actor.slice(6)}`;
  return actor;
}
