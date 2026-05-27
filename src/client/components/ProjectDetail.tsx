import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import { can } from "../../shared/permissions";
import type { ApplicationForPayment, CurrentUser, LabourByCostCode, MaterialWithCommitment, Project, ProjectCommercial, PurchaseOrder } from "../../shared/types";

type Tab = "overview" | "materials" | "commercials" | "labour" | "pos";
type CommercialsSubtab = "breakdown" | "schedule" | "applications";

type ProjectPORow = PurchaseOrder & { project_code: string; project_name: string };

export function ProjectDetail({ me }: { me: CurrentUser | null }) {
  const nav = useNavigate();
  const canRaisePO = can(me?.role, "pos.create");
  const canUploadMaterials = can(me?.role, "materials.upload");
  const canEditProject = can(me?.role, "projects.edit");
  const canDeleteProject = can(me?.role, "projects.delete");
  const [showDelete, setShowDelete] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleting, setDeleting] = useState(false);
  const { id } = useParams<{ id: string }>();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.getProject>> | null>(null);
  const [poSummary, setPoSummary] = useState<Awaited<ReturnType<typeof api.getProjectSummary>> | null>(null);
  const [mats, setMats] = useState<MaterialWithCommitment[]>([]);
  const [commercials, setCommercials] = useState<ProjectCommercial[]>([]);
  const [labour, setLabour] = useState<LabourByCostCode[]>([]);
  const [afps, setAfps] = useState<ApplicationForPayment[]>([]);
  const [projectPOs, setProjectPOs] = useState<ProjectPORow[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [filter, setFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function load() {
    if (!id) return;
    api.getProject(id).then(setInfo).catch((e) => setErr(e.message));
    api.listMaterials(id).then(setMats).catch((e) => setErr(e.message));
    api.listProjectCommercials(id).then(setCommercials).catch(() => setCommercials([]));
    api.listLabourByCostCode(id).then(setLabour).catch(() => setLabour([]));
    api.listAfps(id).then(setAfps).catch(() => setAfps([]));
    api.getProjectSummary(id).then(setPoSummary).catch((e) => setErr(e.message));
    api.listPOs({ project_id: id })
      .then((rs) => setProjectPOs(rs as ProjectPORow[]))
      .catch(() => setProjectPOs([]));
  }
  useEffect(load, [id]);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f || !id) return;
    setBusy(true); setErr(null);
    try {
      await api.uploadMaterials(id, f);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const summary = useMemo(() => summarise(mats, poSummary?.unpriced_spend ?? 0), [mats, poSummary]);

  const pricedCount = mats.filter((m) => (m.total_units ?? 0) > 0).length;
  const baseList = showAll ? mats : mats.filter((m) => (m.total_units ?? 0) > 0);
  const types = [...new Set(baseList.map((m) => m.type))].sort();
  const suppliers = [...new Set(baseList.map((m) => m.manufacturer ?? "—"))].sort();
  const visible = baseList
    .filter((m) => !typeFilter || m.type === typeFilter)
    .filter((m) => !supplierFilter || (m.manufacturer ?? "—") === supplierFilter)
    .filter((m) => !filter || (m.item + (m.manufacturer ?? "")).toLowerCase().includes(filter.toLowerCase()));

  if (!info) return <main className="muted">Loading…</main>;

  return (
    <>
      <Topbar
        crumbs={<><Link to="/">Projects</Link> / {info.project.code}</>}
        title={info.project.name}
        actions={
          <>
            {canDeleteProject && (
              <button className="danger" onClick={() => setShowDelete(true)}>Delete project</button>
            )}
            {canRaisePO && <Link className="btn accent" to={`/projects/${id}/new-po`}>+ Raise PO</Link>}
          </>
        }
      />
      <main>
        {err && <div className="flash error">{err}</div>}
        {info.project.client && <p className="muted" style={{ marginTop: 0 }}>Client · {info.project.client}</p>}

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

        <SiteDetailsCard project={info.project} onSaved={load} canEdit={canEditProject} />

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
          {commercials.length > 0 && (
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
            <span className="count">{mats.length}</span>
          </button>
          {labour.length > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "labour"}
              className={`tab-btn${tab === "labour" ? " active" : ""}`}
              onClick={() => setTab("labour")}
            >
              Labour
              <span className="count">{labour.length}</span>
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={tab === "pos"}
            className={`tab-btn${tab === "pos" ? " active" : ""}`}
            onClick={() => setTab("pos")}
          >
            Purchase orders
            <span className="count">{projectPOs.length}</span>
          </button>
          <div style={{ flex: 1 }} />
          {canUploadMaterials && id && (
            <ProjectQuoteUpload projectId={id} disabled={mats.length === 0} />
          )}
        </nav>

        {tab === "pos" ? (
          <ProjectPOsPanel rows={projectPOs} />
        ) : tab === "commercials" ? (
          <CommercialsBreakdown
            rows={commercials}
            projectId={id ?? ""}
            canEdit={canEditProject}
            afps={afps}
            onAfpsRefresh={load}
          />
        ) : tab === "labour" ? (
          <LabourBreakdown rows={labour} />
        ) : (
        <>
        {mats.length > 0 && (
          <>
            {tab === "overview" && commercials.length > 0 && (
              <CommercialsHeadlineKpis rows={commercials} />
            )}

            <div className="kpis">
              <Kpi label="Priced material budget" value={fmtMoney(summary.priced_total)} />
              <Kpi label="Committed" value={fmtMoney(summary.committed_total)} sub={`${summary.committed_pct.toFixed(0)}% of budget`} tone={summary.committed_total > summary.priced_total ? "danger" : "default"} />
              <Kpi label="Remaining" value={fmtMoney(summary.remaining_total)} sub={summary.remaining_total < 0 ? `Over by ${fmtMoney(Math.abs(summary.remaining_total))}` : undefined} tone={summary.remaining_total < 0 ? "danger" : summary.remaining_total === 0 ? "success" : "default"} />
              <Kpi label="Unpriced spend" value={fmtMoney(summary.unpriced_spend)} sub={summary.unpriced_spend > 0 ? "Outside the BOQ" : "None"} tone={summary.unpriced_spend > 0 ? "danger" : "default"} />
            </div>

            {tab === "overview" && (
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
                    </span>
                  </h2>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)", marginBottom: 0, textTransform: "none", letterSpacing: 0 }}>
                    <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} style={{ minHeight: 0 }} />
                    Show full library
                  </label>
                  <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} />
                  <select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}>
                    <option value="">All suppliers</option>
                    {suppliers.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                    <option value="">All types</option>
                    {types.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th className="center">Type</th>
                      <th>Item</th>
                      <th className="center">Supplier</th>
                      <th className="num">BOQ cost</th>
                      <th className="num">Live</th>
                      <th className="center">Unit</th>
                      <th className="num">Priced</th>
                      <th className="num">Committed</th>
                      <th className="num">Remaining</th>
                      <th className="center" style={{ width: 140 }}>Usage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((m) => {
                      const priced = m.total_units ?? 0;
                      const committed = m.committed_qty ?? 0;
                      const isOriginallyUnpriced = priced === 0;
                      const pct = priced > 0 ? Math.min(100, (committed / priced) * 100) : (committed > 0 ? 100 : 0);
                      const remaining = m.remaining_qty;
                      const over = remaining != null && remaining < 0;
                      const exact = priced > 0 && Math.abs(committed - priced) < 0.005;
                      const unit = m.total_units_unit ?? m.pack_unit ?? "";
                      const live = m.live_unit_price ?? null;
                      const delta = live != null && m.cost != null ? live - m.cost : null;
                      return (
                        <tr key={m.id}>
                          <td className="center">{m.type}</td>
                          <td>{m.item}</td>
                          <td className="muted center">{m.manufacturer ?? "—"}</td>
                          <td className="num">{m.cost != null ? fmtMoney(m.cost) : <span className="muted">—</span>}</td>
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
                              <span className="pill pending" style={{ fontSize: 10 }}>{m.pending_price_count} pending</span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td className="center">{unit}</td>
                          <td className="num">{priced ? `${priced.toLocaleString()}` : <span className="muted">not priced</span>}</td>
                          <td className="num">{committed.toLocaleString()}</td>
                          <td className="num">
                            {remaining == null ? <span className="muted">—</span> : remaining.toLocaleString()}
                          </td>
                          <td className="center">
                            <div className="bar">
                              <div
                                className={over || (isOriginallyUnpriced && committed > 0) ? "danger" : exact ? "ok" : ""}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </td>
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

/* ── Site details card ─────────────────────────────────────────────────── */

function SiteDetailsCard({ project, onSaved, canEdit }: { project: Project; onSaved: () => void; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({
    delivery_address: project.delivery_address ?? "",
    site_contact_name: project.site_contact_name ?? "",
    site_contact_phone: project.site_contact_phone ?? "",
    delivery_instructions: project.delivery_instructions ?? "",
  });

  useEffect(() => {
    setForm({
      delivery_address: project.delivery_address ?? "",
      site_contact_name: project.site_contact_name ?? "",
      site_contact_phone: project.site_contact_phone ?? "",
      delivery_instructions: project.delivery_instructions ?? "",
    });
  }, [project.id, project.delivery_address, project.site_contact_name, project.site_contact_phone, project.delivery_instructions]);

  async function save() {
    setBusy(true); setErr(null);
    try { await api.updateProject(project.id, form); setEditing(false); onSaved(); }
    catch (e) { setErr(e instanceof Error ? e.message : "save failed"); }
    finally { setBusy(false); }
  }

  const isEmpty =
    !project.delivery_address && !project.site_contact_name && !project.site_contact_phone && !project.delivery_instructions;

  return (
    <div className="card">
      <div className="card-hd">
        <h3 style={{ flex: 1 }}>Site details</h3>
        {!editing && canEdit && <button className="ghost tiny" onClick={() => setEditing(true)}>Edit</button>}
      </div>
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
            </div>
            <div className="row" style={{ gridColumn: "1 / -1" }}>
              <button onClick={save} className="primary" disabled={busy}>Save</button>
              <button className="ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
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

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "default" | "success" | "warn" | "danger" }) {
  return (
    <div className={`kpi${tone && tone !== "default" ? ` tone-${tone}` : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

type Summary = {
  priced_total: number;
  committed_total: number;
  remaining_total: number;
  committed_pct: number;
  unpriced_spend: number;
  by_supplier: Array<{ supplier: string; items: number; priced: number; committed: number }>;
};

function summarise(mats: MaterialWithCommitment[], unpricedSpend: number): Summary {
  let priced = 0, committed = 0;
  const bySup = new Map<string, { items: number; priced: number; committed: number }>();
  for (const m of mats) {
    const cost = m.cost ?? 0;
    const matPriced = (m.total_units ?? 0) * cost;
    const matCommitted = (m.committed_qty ?? 0) * cost;
    priced += matPriced;
    committed += matCommitted;
    const sup = m.manufacturer?.trim() || "—";
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
    by_supplier: [...bySup.entries()]
      .map(([supplier, v]) => ({ supplier, ...v }))
      .filter((s) => s.priced > 0)
      .sort((a, b) => b.priced - a.priced),
  };
}

/* ── Commercials — split between Overview (headline KPIs) and tab (table) ── */

/** Four headline KPIs shown at the top of the Overview tab. */
function CommercialsHeadlineKpis({ rows }: { rows: ProjectCommercial[] }) {
  const total = rows.find((r) => r.is_total === 1);
  if (!total) return null;
  return (
    <div className="kpis">
      <Kpi label="Project value" value={fmtMoney(total.value ?? 0)} />
      <Kpi label="Cost" value={fmtMoney(total.cost ?? 0)} />
      <Kpi
        label="Gross profit"
        value={fmtMoney(total.gross_profit ?? 0)}
        tone={(total.gross_profit ?? 0) > 0 ? "success" : (total.gross_profit ?? 0) < 0 ? "danger" : "default"}
      />
      <Kpi
        label="GP margin"
        value={total.gross_profit_pct != null ? `${(total.gross_profit_pct * 100).toFixed(1)}%` : "—"}
        tone={(total.gross_profit_pct ?? 0) >= 0.1 ? "success" : (total.gross_profit_pct ?? 0) < 0 ? "danger" : "warn"}
      />
    </div>
  );
}

/** Full per-category breakdown on the Commercials tab. */
function CommercialsBreakdown({
  rows, projectId, canEdit, afps, onAfpsRefresh,
}: {
  rows: ProjectCommercial[];
  projectId: string;
  canEdit: boolean;
  afps: ApplicationForPayment[];
  onAfpsRefresh: () => void;
}) {
  const [subtab, setSubtab] = useState<CommercialsSubtab>("breakdown");
  return (
    <>
      <nav className="tabs" role="tablist" style={{ marginBottom: 16 }}>
        <button
          type="button" role="tab" aria-selected={subtab === "breakdown"}
          className={`tab-btn${subtab === "breakdown" ? " active" : ""}`}
          onClick={() => setSubtab("breakdown")}
        >
          Breakdown
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
          {afps.length > 0 && <span className="count">{afps.length}</span>}
        </button>
      </nav>

      {subtab === "breakdown" && <CommercialsBreakdownInner rows={rows} />}
      {subtab === "schedule" && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 16 }}>
          <PortfolioCalendarPanel projectId={projectId} />
          <ValuationScheduleUpload projectId={projectId} canEdit={canEdit} />
        </div>
      )}
      {subtab === "applications" && (
        <AfpListPanel projectId={projectId} afps={afps} canCreate={canEdit} onRefresh={onAfpsRefresh} />
      )}
    </>
  );
}

function CommercialsBreakdownInner({ rows }: { rows: ProjectCommercial[] }) {
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
  const total = rows.find((r) => r.is_total === 1);
  const breakdown = rows.filter((r) => r.is_total === 0);
  return (
    <div className="card">
      <div className="card-hd">
        <h2 style={{ flex: 1 }}>Commercials</h2>
        <span className="muted" style={{ fontSize: 12 }}>from Summary Cost Sheet</span>
      </div>
      {total && (
        <div
          className="kpis"
          style={{
            gridTemplateColumns: "repeat(4, 1fr)",
            padding: "16px 20px",
            background: "var(--card-2)",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <Kpi label="Project value" value={fmtMoney(total.value ?? 0)} />
          <Kpi label="Cost" value={fmtMoney(total.cost ?? 0)} />
          <Kpi
            label="Gross profit"
            value={fmtMoney(total.gross_profit ?? 0)}
            tone={(total.gross_profit ?? 0) > 0 ? "success" : (total.gross_profit ?? 0) < 0 ? "danger" : "default"}
          />
          <Kpi
            label="GP margin"
            value={total.gross_profit_pct != null ? `${(total.gross_profit_pct * 100).toFixed(1)}%` : "—"}
            tone={(total.gross_profit_pct ?? 0) >= 0.1 ? "success" : (total.gross_profit_pct ?? 0) < 0 ? "danger" : "warn"}
          />
        </div>
      )}
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
          {breakdown.map((r) => {
            const gp = r.gross_profit;
            const gpPctTone = gp == null ? "" : gp > 0 ? "var(--success)" : gp < 0 ? "var(--danger)" : "var(--muted)";
            return (
              <tr key={r.id}>
                <td>{r.category}</td>
                <td className="num">{r.value != null ? fmtMoney(r.value) : <span className="muted">—</span>}</td>
                <td className="num">{r.cost != null ? fmtMoney(r.cost) : <span className="muted">—</span>}</td>
                <td className="num" style={{ color: gpPctTone || undefined }}>
                  {gp != null ? fmtMoney(gp) : <span className="muted">—</span>}
                </td>
                <td className="num" style={{ color: gpPctTone || undefined }}>
                  {r.gross_profit_pct != null ? `${(r.gross_profit_pct * 100).toFixed(1)}%` : <span className="muted">—</span>}
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
  const [periodEnd, setPeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [suppliers, setSuppliers] = useState<Awaited<ReturnType<typeof api.listSuppliers>>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (direction === "incoming_labour" && suppliers.length === 0) {
      api.listSuppliers().then(setSuppliers).catch(() => setSuppliers([]));
    }
  }, [direction, suppliers.length]);

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
          {canCreate && !creating && (
            <button className="accent" onClick={() => setCreating(true)}>+ New {direction === "outgoing" ? "AfP" : "labour app"}</button>
          )}
        </div>
        {err && <div className="flash error" style={{ margin: "12px 20px 0" }}>{err}</div>}
        {creating && (
          <div className="card-bd" style={{ background: "var(--accent-soft)", borderBottom: "1px solid var(--line)" }}>
            <div className="row" style={{ alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
              <div>
                <label>Period ending</label>
                <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
              </div>
              {direction === "incoming_labour" && (
                <div>
                  <label>Subcontractor</label>
                  <select value={supplierId ?? ""} onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : null)} style={{ minWidth: 220 }}>
                    <option value="">— select —</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              )}
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

function LabourBreakdown({ rows }: { rows: LabourByCostCode[] }) {
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
  return (
    <div className="card">
      <div className="card-hd">
        <h2 style={{ flex: 1 }}>Labour by cost code</h2>
        <span className="muted" style={{ fontSize: 12 }}>resource code <code>.L</code></span>
      </div>
      <div
        className="kpis"
        style={{
          gridTemplateColumns: "repeat(3, 1fr)",
          padding: "16px 20px",
          background: "var(--card-2)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <Kpi label="Total labour" value={fmtMoney(totalLabour)} sub="from BOQ" />
        <Kpi label="Amount expended" value={fmtMoney(totalExpended)} sub="certified so far" />
        <Kpi
          label="% expended"
          value={totalLabour > 0 ? `${((totalExpended / totalLabour) * 100).toFixed(1)}%` : "—"}
          sub="of total labour"
        />
      </div>
      <table>
        <thead>
          <tr>
            <th className="center">Cost code</th>
            <th>Element</th>
            <th className="num">Lines</th>
            <th className="num">Labour £</th>
            <th className="num">Expended £</th>
            <th className="num">% expended</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const expended = r.expended ?? 0;
            const pct = r.labour_total > 0 ? expended / r.labour_total : 0;
            const isZero = expended < 0.005;
            return (
              <tr key={r.cost_code}>
                <td className="center">
                  <span className="badge" style={{ fontFamily: "ui-monospace, monospace" }}>{r.cost_code}</span>
                </td>
                <td>
                  {r.element_name ?? <span className="muted">Element {r.element_code}</span>}
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>code {r.element_code}</div>
                </td>
                <td className="num">{r.line_count}</td>
                <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(r.labour_total)}</td>
                <td className="num">
                  {isZero ? <span className="muted">{fmtMoney(0)}</span> : fmtMoney(expended)}
                </td>
                <td className="num">
                  {isZero ? <span className="muted">0.0%</span> : `${(pct * 100).toFixed(1)}%`}
                </td>
              </tr>
            );
          })}
          <tr style={{ background: "var(--card-2)" }}>
            <td colSpan={3} style={{ fontWeight: 600, textAlign: "right" }}>Total</td>
            <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(totalLabour)}</td>
            <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(totalExpended)}</td>
            <td className="num" style={{ fontWeight: 600 }}>
              {totalLabour > 0 ? `${((totalExpended / totalLabour) * 100).toFixed(1)}%` : "—"}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
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

/* ── Portfolio valuation calendar (combined across projects) ─────────── */

function PortfolioCalendarPanel({ projectId }: { projectId: string }) {
  type Item = Awaited<ReturnType<typeof api.portfolioCalendar>>[number];
  const [items, setItems] = useState<Item[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.portfolioCalendar().then(setItems).catch((e) => setErr(e.message));
  }, []);

  // Group items by ISO month for display
  const byMonth = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of items) {
      const key = it.date.slice(0, 7);
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(it);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [items]);

  return (
    <div className="card">
      <div className="card-hd"><h3 style={{ flex: 1 }}>Valuation calendar</h3></div>
      <div className="card-bd" style={{ maxHeight: 560, overflowY: "auto" }}>
        {err && <div className="muted" style={{ color: "var(--danger)" }}>{err}</div>}
        {byMonth.length === 0 ? (
          <div className="empty" style={{ fontSize: 12 }}>No upcoming valuation dates across the portfolio. Add a schedule entry below to get started.</div>
        ) : (
          byMonth.map(([month, list]) => (
            <div key={month} style={{ marginBottom: 14 }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>{formatMonth(month)}</div>
              {list.map((it, i) => (
                <CalendarRow key={`${it.kind}-${it.afp_id ?? "s"}-${i}`} it={it} isThisProject={it.project_id === projectId} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function CalendarRow({ it, isThisProject }: { it: Awaited<ReturnType<typeof api.portfolioCalendar>>[number]; isThisProject: boolean }) {
  const color =
    it.kind === "afp-period-end" ? "var(--accent-2)"
    : it.kind === "scheduled-submission" ? "var(--success)"
    : it.kind === "scheduled-cutoff" ? "var(--warn)"
    : it.kind === "scheduled-payment" ? "var(--accent)"
    : "var(--muted)";
  return (
    <div style={{
      display: "flex", alignItems: "baseline", gap: 8,
      padding: "5px 0", borderBottom: "1px solid var(--line)",
      fontSize: 12,
      fontWeight: isThisProject ? 600 : 400,
    }}>
      <span style={{ width: 42, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{it.date.slice(8, 10)}</span>
      <span style={{ width: 6, height: 6, background: color, borderRadius: 999, flexShrink: 0 }} />
      <span style={{ flex: 1, color: isThisProject ? "var(--ink)" : "var(--muted)" }}>
        <Link to={`/projects/${it.project_id}`} style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{it.project_code}</Link>{" — "}
        {it.afp_id ? <Link to={`/applications/${it.afp_id}`}>{it.label}</Link> : it.label}
      </span>
    </div>
  );
}

function formatMonth(yyyymm: string): string {
  const [y, m] = yyyymm.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

/* ── Valuation schedule upload + add-entry form ──────────────────────── */

function ValuationScheduleUpload({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof api.listValuationEntries>>>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ entry_type: "submission" as const, date: "", app_number: "", notes: "" });
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
      if (r.parsed && r.entries_created > 0) {
        setInfo(`Imported ${r.entries_created} schedule date${r.entries_created === 1 ? "" : "s"} from ${r.filename}.`);
      } else if (r.parsed) {
        setInfo(`Read ${r.filename} but found no recognisable schedule rows. The parser looks for an "App #" column plus cut-off / submission / certification / payment date columns. Add entries manually below.`);
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
      await api.addValuationEntry(projectId, {
        entry_type: form.entry_type,
        date: form.date,
        app_number: form.app_number ? Number(form.app_number) : null,
        notes: form.notes || undefined,
      });
      setForm({ entry_type: "submission", date: "", app_number: "", notes: "" });
      setAdding(false);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally { setBusy(false); }
  }

  async function deleteEntry(id: number) {
    await api.deleteValuationEntry(id);
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
              <option value="cutoff">Cut-off</option>
              <option value="submission">Submission</option>
              <option value="certification">Certification</option>
              <option value="payment">Payment</option>
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
          <div style={{ display: "grid", gap: 4 }}>
            {entries.map((e) => (
              <div key={e.id} style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 12, padding: "3px 0", borderBottom: "1px solid var(--line)" }}>
                <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums", width: 64 }}>{fmtDate(e.date).slice(0, 6)}</span>
                <span style={{ flex: 1 }}>
                  {e.entry_type.replace(/^./, (c) => c.toUpperCase())}{e.app_number ? ` #${e.app_number}` : ""}
                </span>
                {canEdit && <button className="ghost tiny" onClick={() => deleteEntry(e.id)} title="Delete">×</button>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
