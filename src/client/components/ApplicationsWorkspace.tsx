// Portfolio-wide Applications workspace — every Application for Payment across
// all projects in one place. Filter by direction / status, spot unassigned
// labour apps (typically arrived via forwarded email) and assign the
// subcontractor inline without opening each one.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import { can } from "../../shared/permissions";
import type { AfpStatus, ApplicationListItem, CurrentUser, InboundApplication, Supplier } from "../../shared/types";

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
  const canEdit = can(me?.role, "commercial.edit");
  const navigate = useNavigate();
  const [rows, setRows] = useState<ApplicationListItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [inbound, setInbound] = useState<InboundApplication[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [space, setSpace] = useState<Space>("labour");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  const visible = spaceRows
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
            onClick={() => { setSpace("labour"); setStatus("all"); setUnassignedOnly(false); }}
          >
            Labour applications <span className="count">{labourCount}</span>
          </button>
          <button
            type="button"
            className={`tab-btn${space === "client" ? " active" : ""}`}
            onClick={() => { setSpace("client"); setStatus("all"); setUnassignedOnly(false); }}
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

        <div className="card">
          <div className="card-hd" style={{ gap: 12, flexWrap: "wrap" }}>
            <h2 style={{ flex: 1 }}>{isLabour ? "Labour applications" : "Client applications"}</h2>
            <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
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
            <div className="card-bd"><div className="empty">No {isLabour ? "labour" : "client"} applications{status !== "all" ? " match the current filter" : " yet"}.</div></div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="center">#</th>
                  <th>Project</th>
                  <th>{isLabour ? "Subcontractor" : "Client"}</th>
                  <th>Period</th>
                  <th className="center">Status</th>
                  <th className="num">Value</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const isUnassigned = isLabour && r.counterparty_supplier_id == null;
                  const value = r.status === "certified" || r.status === "paid"
                    ? (r.certified_amount ?? r.amount_due ?? 0)
                    : (r.total_invoice ?? 0);
                  return (
                    // The whole row opens the application — hunting for the
                    // small "#n" link is needless precision. Inner links and the
                    // assign dropdown stop the bubble so they still do their own job.
                    <tr key={r.id} className="rep-row" style={{ cursor: "pointer" }}
                      onClick={(e) => { if (!(e.target as HTMLElement).closest("a,select,button,input,label")) navigate(`/applications/${r.id}`); }}>
                      <td className="center">
                        <Link to={`/applications/${r.id}`} onClick={(e) => e.stopPropagation()}>#{r.app_number}</Link>
                      </td>
                      <td>
                        <Link to={`/projects/${r.project_id}`} style={{ fontWeight: 500 }} onClick={(e) => e.stopPropagation()}>{r.project_code}</Link>
                        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{r.project_name}</div>
                      </td>
                      <td>
                        {!isLabour ? (
                          <span className="muted">Client (per project)</span>
                        ) : isUnassigned ? (
                          canEdit ? (
                            <select
                              defaultValue=""
                              onChange={(e) => { const id = Number(e.target.value); if (id > 0) assign(r.id, id); }}
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
                      </td>
                      <td className="num">{fmtMoney(value)}</td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {fmtDate(r.created_at)}
                        <div style={{ fontSize: 11 }}>{formatActor(r.created_by)}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
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
