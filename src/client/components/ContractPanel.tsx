// Commercials → Contract: the contract particulars at a glance, the risk
// register (likelihood × impact, mitigation, £ exposure) and the key contract
// items (obligations / notices / dates) with due-date tracking.

import { useEffect, useState } from "react";
import { api, fmtDate, fmtMoney } from "../lib/api";
import type { Project, ProjectKeyItem, ProjectRisk } from "../../shared/types";

const RISK_CATEGORIES = ["commercial", "programme", "design", "site", "client", "other"] as const;

function scoreTone(score: number): string {
  return score >= 15 ? "danger" : score >= 8 ? "warn" : "ok";
}

const SCALE_1_5 = [1, 2, 3, 4, 5];

export function ContractPanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [project, setProject] = useState<Project | null>(null);
  const [risks, setRisks] = useState<ProjectRisk[]>([]);
  const [items, setItems] = useState<ProjectKeyItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  function load() {
    api.contractRegister(projectId)
      .then((r) => { setRisks(r.risks); setItems(r.key_items); setLoaded(true); })
      .catch((e) => setErr(e instanceof Error ? e.message : "failed to load"));
  }
  useEffect(() => {
    load();
    api.getProject(projectId).then((r) => setProject(r.project)).catch(() => setProject(null));
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const openRisks = risks.filter((r) => r.status === "open");
  const exposure = openRisks.reduce((s, r) => s + (r.cost_exposure ?? 0), 0);
  const today = new Date().toISOString().slice(0, 10);
  const overdue = items.filter((i) => i.status === "open" && i.due_date && i.due_date < today).length;

  return (
    <>
      {err && <div className="flash error">{err}</div>}

      {/* Contract particulars — maintained on Overview → Site details; shown
          here so the commercial picture sits in one place. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-hd">
          <h3 style={{ flex: 1 }}>Contract particulars</h3>
          <span className="muted" style={{ fontSize: 12.5 }}>Edit these under Overview → Site details / Application terms (or upload the contract there to read them off it).</span>
        </div>
        <div className="card-bd" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14 }}>
          {[
            ["Client", project?.client],
            ["Client contact", project?.client_contact_name],
            ["Client email", project?.client_email],
            ["Payment terms", project?.payment_terms],
            ["Application cadence", project?.application_cadence],
            ["Client retention", project?.client_retention_pct != null ? `${project.client_retention_pct}%` : null],
            ["Site address", project?.delivery_address],
          ].map(([label, value]) => (
            <div key={label as string}>
              <div className="muted" style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
              <div style={{ fontSize: 13.5, marginTop: 2 }}>{value || <span className="muted">—</span>}</div>
            </div>
          ))}
        </div>
      </div>

      <RiskRegister projectId={projectId} risks={risks} canEdit={canEdit} onChanged={load}
        openCount={openRisks.length} exposure={exposure} loaded={loaded} />
      <KeyItems projectId={projectId} items={items} canEdit={canEdit} onChanged={load} overdue={overdue} loaded={loaded} />
    </>
  );
}

/* ── Risk register ─────────────────────────────────────────────────────── */

function RiskRegister({ projectId, risks, canEdit, onChanged, openCount, exposure, loaded }: {
  projectId: string; risks: ProjectRisk[]; canEdit: boolean; onChanged: () => void;
  openCount: number; exposure: number; loaded: boolean;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ProjectRisk | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>("commercial");
  const [likelihood, setLikelihood] = useState(3);
  const [impact, setImpact] = useState(3);
  const [mitigation, setMitigation] = useState("");
  const [owner, setOwner] = useState("");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  function openNew() {
    setEditing(null); setTitle(""); setCategory("commercial"); setLikelihood(3); setImpact(3);
    setMitigation(""); setOwner(""); setCost(""); setErr(null); setShowForm(true);
  }
  function openEdit(r: ProjectRisk) {
    setEditing(r); setTitle(r.title); setCategory(r.category ?? "other"); setLikelihood(r.likelihood);
    setImpact(r.impact); setMitigation(r.mitigation ?? ""); setOwner(r.owner ?? "");
    setCost(r.cost_exposure != null ? String(r.cost_exposure) : ""); setErr(null); setShowForm(true);
  }
  async function save() {
    if (!title.trim()) return;
    setBusy(true); setErr(null);
    const body = {
      title: title.trim(), category, likelihood, impact,
      mitigation: mitigation.trim() || undefined, owner: owner.trim() || undefined,
      cost_exposure: cost.trim() ? Number(cost) : null,
    };
    try {
      if (editing) await api.updateRisk(editing.id, body);
      else await api.addRisk(projectId, body);
      setShowForm(false); onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "failed to save"); }
    finally { setBusy(false); }
  }
  async function setStatus(r: ProjectRisk, status: "open" | "closed") {
    await api.updateRisk(r.id, { status }); onChanged();
  }
  async function remove(r: ProjectRisk) {
    if (!confirm(`Delete risk “${r.title}”?`)) return;
    await api.deleteRisk(r.id); onChanged();
  }

  const visible = risks.filter((r) => showClosed || r.status === "open");
  const closedCount = risks.length - risks.filter((r) => r.status === "open").length;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-hd">
        <h3>Risk register</h3>
        {openCount > 0 && <span className="pill warn">{openCount} open</span>}
        {exposure > 0 && <span className="muted" style={{ fontSize: 12.5 }}>potential exposure {fmtMoney(exposure)}</span>}
        <span className="grow" />
        {closedCount > 0 && (
          <button className="ghost tiny" onClick={() => setShowClosed(!showClosed)}>
            {showClosed ? "Hide closed" : `Show closed (${closedCount})`}
          </button>
        )}
        {canEdit && !showForm && <button className="accent tiny" onClick={openNew}>+ Add risk</button>}
      </div>

      {showForm && (
        <div className="card-bd" style={{ borderBottom: "1px solid var(--line)" }}>
          {err && <div className="flash error" style={{ marginBottom: 10 }}>{err}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              <span>Risk</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Scaffold handover late from main contractor" />
            </label>
            <label className="field">
              <span>Category</span>
              <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                {RISK_CATEGORIES.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Likelihood (1–5)</span>
              <select className="input" value={likelihood} onChange={(e) => setLikelihood(Number(e.target.value))}>
                {SCALE_1_5.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Impact (1–5)</span>
              <select className="input" value={impact} onChange={(e) => setImpact(Number(e.target.value))}>
                {SCALE_1_5.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="field">
              <span>£ exposure (optional)</span>
              <input className="input" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="e.g. 12000" />
            </label>
            <label className="field">
              <span>Owner</span>
              <input className="input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="who's managing it" />
            </label>
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              <span>Mitigation</span>
              <textarea className="input" rows={2} value={mitigation} onChange={(e) => setMitigation(e.target.value)} placeholder="what we're doing about it" />
            </label>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={() => void save()} disabled={busy || !title.trim()}>{busy ? "Saving…" : editing ? "Save changes" : "Add risk"}</button>
            <button className="ghost" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="card-bd">
          <div className="empty" style={{ padding: "6px 0" }}>
            {loaded ? <p className="muted" style={{ margin: 0 }}>No {showClosed ? "" : "open "}risks recorded. Capture anything that could hit cost or programme — scaffold access, design freezes, client decisions, weather-exposed activities.</p> : <p className="muted">Loading…</p>}
          </div>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Risk</th>
              <th className="center">Category</th>
              <th className="center">L</th>
              <th className="center">I</th>
              <th className="center">Score</th>
              <th>Mitigation</th>
              <th className="center">Owner</th>
              <th className="num">Exposure</th>
              {canEdit && <th style={{ width: 150 }}></th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const score = r.likelihood * r.impact;
              return (
                <tr key={r.id} style={r.status === "closed" ? { opacity: 0.55 } : undefined}>
                  <td style={{ fontWeight: 500 }}>
                    {r.title}
                    {r.status === "closed" && <span className="pill neutral" style={{ marginLeft: 6, fontSize: 10 }}>Closed</span>}
                  </td>
                  <td className="center muted">{r.category ?? "—"}</td>
                  <td className="center num">{r.likelihood}</td>
                  <td className="center num">{r.impact}</td>
                  <td className="center"><span className={`pill ${scoreTone(score)}`}>{score}</span></td>
                  <td className="muted" style={{ fontSize: 12.5, maxWidth: 260 }}>{r.mitigation ?? "—"}</td>
                  <td className="center muted">{r.owner ?? "—"}</td>
                  <td className="num">{r.cost_exposure != null ? fmtMoney(r.cost_exposure) : <span className="muted">—</span>}</td>
                  {canEdit && (
                    <td className="center" style={{ whiteSpace: "nowrap" }}>
                      <button className="ghost tiny" onClick={() => openEdit(r)}>Edit</button>{" "}
                      {r.status === "open"
                        ? <button className="ghost tiny" onClick={() => void setStatus(r, "closed")} title="Risk no longer live — keeps it on record">Close</button>
                        : <button className="ghost tiny" onClick={() => void setStatus(r, "open")}>Reopen</button>}{" "}
                      <button className="ghost tiny danger" onClick={() => void remove(r)}>✕</button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ── Key contract items ────────────────────────────────────────────────── */

function KeyItems({ projectId, items, canEdit, onChanged, overdue, loaded }: {
  projectId: string; items: ProjectKeyItem[]; canEdit: boolean; onChanged: () => void; overdue: number; loaded: boolean;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ProjectKeyItem | null>(null);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  function openNew() { setEditing(null); setTitle(""); setDetail(""); setDue(""); setErr(null); setShowForm(true); }
  function openEdit(i: ProjectKeyItem) {
    setEditing(i); setTitle(i.title); setDetail(i.detail ?? ""); setDue(i.due_date ?? ""); setErr(null); setShowForm(true);
  }
  async function save() {
    if (!title.trim()) return;
    setBusy(true); setErr(null);
    try {
      if (editing) await api.updateKeyItem(editing.id, { title: title.trim(), detail: detail.trim() || null, due_date: due || null });
      else await api.addKeyItem(projectId, { title: title.trim(), detail: detail.trim() || undefined, due_date: due || undefined });
      setShowForm(false); onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "failed to save"); }
    finally { setBusy(false); }
  }
  async function toggle(i: ProjectKeyItem) {
    await api.updateKeyItem(i.id, { status: i.status === "done" ? "open" : "done" }); onChanged();
  }
  async function remove(i: ProjectKeyItem) {
    if (!confirm(`Delete “${i.title}”?`)) return;
    await api.deleteKeyItem(i.id); onChanged();
  }

  return (
    <div className="card">
      <div className="card-hd">
        <h3>Key contract items</h3>
        {overdue > 0 && <span className="pill danger dot">{overdue} overdue</span>}
        <span className="muted" style={{ fontSize: 12.5 }}>Obligations, notice periods, insurances, LADs, warranties — the clauses to keep in front of you.</span>
        <span className="grow" />
        {canEdit && !showForm && <button className="accent tiny" onClick={openNew}>+ Add item</button>}
      </div>

      {showForm && (
        <div className="card-bd" style={{ borderBottom: "1px solid var(--line)" }}>
          {err && <div className="flash error" style={{ marginBottom: 10 }}>{err}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
            <label className="field">
              <span>Item</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Notify delay events within 7 days (cl. 61.3)" />
            </label>
            <label className="field">
              <span>Due date (optional)</span>
              <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              <span>Detail</span>
              <textarea className="input" rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="clause reference, who to notify, consequences…" />
            </label>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={() => void save()} disabled={busy || !title.trim()}>{busy ? "Saving…" : editing ? "Save changes" : "Add item"}</button>
            <button className="ghost" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div className="card-bd">
          <div className="empty" style={{ padding: "6px 0" }}>
            {loaded ? <p className="muted" style={{ margin: 0 }}>Nothing recorded yet. Add the contract's key obligations — payment notice deadlines, insurance renewals, warranty submissions, LAD triggers.</p> : <p className="muted">Loading…</p>}
          </div>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: 30 }}></th>
              <th>Item</th>
              <th>Detail</th>
              <th className="center">Due</th>
              {canEdit && <th style={{ width: 110 }}></th>}
            </tr>
          </thead>
          <tbody>
            {items.map((i) => {
              const isOverdue = i.status === "open" && i.due_date != null && i.due_date < today;
              return (
                <tr key={i.id} style={i.status === "done" ? { opacity: 0.55 } : undefined}>
                  <td className="center">
                    <input type="checkbox" style={{ minHeight: 0 }} checked={i.status === "done"} disabled={!canEdit}
                      onChange={() => void toggle(i)} title={i.status === "done" ? "Mark as open" : "Mark as done"} />
                  </td>
                  <td style={{ fontWeight: 500, textDecoration: i.status === "done" ? "line-through" : "none" }}>{i.title}</td>
                  <td className="muted" style={{ fontSize: 12.5, maxWidth: 340 }}>{i.detail ?? "—"}</td>
                  <td className="center">
                    {i.due_date
                      ? <span className={isOverdue ? "pill danger" : undefined}>{fmtDate(i.due_date)}</span>
                      : <span className="muted">—</span>}
                  </td>
                  {canEdit && (
                    <td className="center" style={{ whiteSpace: "nowrap" }}>
                      <button className="ghost tiny" onClick={() => openEdit(i)}>Edit</button>{" "}
                      <button className="ghost tiny danger" onClick={() => void remove(i)}>✕</button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
