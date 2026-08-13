import { useEffect, useState } from "react";
import { api, fmtDate } from "../lib/api";
import { Topbar } from "./Shell";
import { can } from "../../shared/permissions";
import type { CurrentUser, OwnedPlant as OwnedPlantItem } from "../../shared/types";

type ProjectOpt = { id: string; code: string; name: string };
const TEST_TYPES = ["LOLER", "PUWER / service", "PAT", "Insurance", "Calibration", "Other"];

const statusPill = (s?: string) => (s === "expired" ? "danger" : s === "expiring" ? "warn" : s === "valid" ? "ok" : "neutral");
const statusLabel = (s?: string) => (s === "expired" ? "Test expired" : s === "expiring" ? "Retest due soon" : s === "valid" ? "In test" : "No test");

export function OwnedPlantPage({ me }: { me: CurrentUser | null }) {
  const canEdit = can(me?.role, "delivery.edit");
  const [rows, setRows] = useState<OwnedPlantItem[]>([]);
  const [projects, setProjects] = useState<ProjectOpt[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  function refresh() { api.ownedPlant().then(setRows).catch((e) => setErr(e.message)); }
  useEffect(refresh, []);
  useEffect(() => { api.listProjects().then((rs) => setProjects(rs.filter((r) => !r.completed_at).map((r) => ({ id: r.id, code: r.code, name: r.name })))).catch(() => {}); }, []);

  const shown = q.trim()
    ? rows.filter((r) => `${r.name} ${r.asset_no ?? ""} ${r.category ?? ""} ${r.supplier ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))
    : rows;
  const sel = rows.find((r) => r.id === selected) ?? null;
  const onSite = rows.filter((r) => r.assigned_project_id).length;
  const testsAttn = rows.filter((r) => r.test_status === "expired" || r.test_status === "expiring").length;

  return (
    <>
      <Topbar crumbs="Master data" title="Plant register"
        actions={canEdit ? <button className="accent" onClick={() => setShowNew(true)}>+ Add plant</button> : null} />
      <main>
        {err && <div className="flash error">{err}</div>}

        {rows.length > 0 && (
          <div className="kpis">
            <Kpi label="Owned items" value={String(rows.length)} />
            <Kpi label="On site" value={String(onSite)} sub={`${rows.length - onSite} in the yard`} />
            <Kpi label="In the yard" value={String(rows.length - onSite)} sub="available to transfer" />
            <Kpi label="Tests due / expired" value={String(testsAttn)} tone={rows.some((r) => r.test_status === "expired") ? "danger" : testsAttn > 0 ? "warn" : "success"} sub={testsAttn > 0 ? "needs attention" : "all in test"} />
          </div>
        )}

        {showNew && <NewOwnedPlant projects={projects} onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); refresh(); }} />}

        <div className="card" style={{ marginTop: rows.length > 0 ? 16 : 0 }}>
          <div className="card-hd" style={{ flexWrap: "wrap", gap: 10 }}>
            <h2 style={{ fontSize: 17 }}>Register</h2><span className="pill">{rows.length}</span>
            <span className="grow" />
            {rows.length > 0 && <input className="input" placeholder="Search name, asset no, category" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240, maxWidth: "50%" }} />}
          </div>
          {rows.length === 0 ? (
            <div className="empty in-card">
              <div className="ic"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 14h7V8h4l4 4v2h-2M3 14v3h2M19 14v3h-2M7 19a1.6 1.6 0 100-3.2A1.6 1.6 0 007 19zM15 19a1.6 1.6 0 100-3.2A1.6 1.6 0 0015 19z" /></svg></div>
              <h3 className="serif" style={{ fontSize: 19 }}>No owned plant yet</h3>
              <p className="muted" style={{ maxWidth: 460, margin: "0 auto" }}>Add company-owned plant — scissor lifts, telehandlers, welfare units — then transfer it between sites and track LOLER / service / insurance dates.</p>
              {canEdit && <div style={{ marginTop: 20 }}><button className="accent" onClick={() => setShowNew(true)}>+ Add plant</button></div>}
            </div>
          ) : (
            <table className="ops-table">
              <thead><tr><th>Item</th><th>Category</th><th>Supplier</th><th className="center">Location</th><th className="center">Tests</th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} style={{ cursor: "pointer", background: selected === r.id ? "var(--accent-soft)" : undefined }} onClick={() => setSelected(selected === r.id ? null : r.id)}>
                    <td data-label="Item"><b>{r.name}</b>{r.asset_no && <div className="muted" style={{ fontSize: 12 }}>#{r.asset_no}</div>}</td>
                    <td className="muted" data-label="Category">{r.category ?? "—"}</td>
                    <td className="muted" data-label="Supplier">{r.supplier ?? "—"}</td>
                    <td className="center" data-label="Location">{r.assigned_project_code ? <span className="pill navy">{r.assigned_project_code}</span> : <span className="muted">Yard</span>}</td>
                    <td className="center" data-label="Tests"><span className={`pill ${statusPill(r.test_status)} dot`}>{statusLabel(r.test_status)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {sel && <OwnedPlantDetail item={sel} projects={projects} canEdit={canEdit} onChanged={refresh} onClose={() => setSelected(null)} />}
      </main>
    </>
  );
}

function OwnedPlantDetail({ item, projects, canEdit, onChanged, onClose }: { item: OwnedPlantItem; projects: ProjectOpt[]; canEdit: boolean; onChanged: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [tType, setTType] = useState(TEST_TYPES[0]);
  const [testedOn, setTestedOn] = useState("");
  const [expiry, setExpiry] = useState("");

  async function transfer(projectId: string) {
    setBusy(true); setErr(null);
    try { await api.assignOwnedPlant(item.id, projectId || null); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(false); }
  }
  async function addTest() {
    if (!tType) return;
    setBusy(true); setErr(null);
    try {
      await api.addOwnedPlantTest(item.id, { test_type: tType, tested_on: testedOn || undefined, expiry_date: expiry || undefined });
      setAdding(false); setTType(TEST_TYPES[0]); setTestedOn(""); setExpiry(""); onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(false); }
  }
  async function delTest(testId: string) {
    await api.deleteOwnedPlantTest(testId); onChanged();
  }
  async function archive() {
    if (!confirm(`Remove ${item.name} from the plant register?`)) return;
    setBusy(true);
    try { await api.deleteOwnedPlant(item.id); onClose(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "failed"); setBusy(false); }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-hd" style={{ alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 className="serif" style={{ margin: 0, fontSize: 18 }}>{item.name}</h3>
          <div className="muted" style={{ fontSize: 12 }}>{[item.asset_no ? `#${item.asset_no}` : null, item.category, item.supplier].filter(Boolean).join(" · ") || "—"}</div>
        </div>
        <span className={`pill ${statusPill(item.test_status)} dot`}>{statusLabel(item.test_status)}</span>
        {canEdit && <button className="ghost tiny danger" onClick={archive} disabled={busy}>Remove</button>}
      </div>
      <div className="card-bd">
        {err && <div className="flash error">{err}</div>}
        <div className="dash-grid">
          {/* Transfer / location */}
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Location</div>
            {canEdit ? (
              <label className="field"><span>On site</span>
                <select className="input" value={item.assigned_project_id ?? ""} onChange={(e) => transfer(e.target.value)} disabled={busy}>
                  <option value="">— Yard (not on site) —</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
                </select>
              </label>
            ) : (
              <div>{item.assigned_project_code ? <span className="pill navy">{item.assigned_project_code}</span> : <span className="muted">In the yard</span>}</div>
            )}
            {item.assigned_at && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Transferred {fmtDate(item.assigned_at)}{item.assigned_by ? ` · ${item.assigned_by}` : ""}</div>}
          </div>

          {/* Tests */}
          <div>
            <div className="row" style={{ marginBottom: 8, alignItems: "baseline" }}>
              <div className="eyebrow" style={{ margin: 0, flex: 1 }}>Statutory tests</div>
              {canEdit && !adding && <button className="ghost tiny" onClick={() => setAdding(true)}>+ Add test</button>}
            </div>
            {(item.tests ?? []).length === 0 && !adding && <div className="muted" style={{ fontSize: 13 }}>No tests recorded.</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {(item.tests ?? []).map((t) => (
                <div key={t.id} className="row" style={{ alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
                  <span className={`pill ${statusPill(t.status)} dot`} style={{ flexShrink: 0 }}>{t.test_type}</span>
                  <span className="muted" style={{ fontSize: 12, flex: 1 }}>
                    {t.tested_on ? `tested ${fmtDate(t.tested_on)}` : ""}{t.expiry_date ? `${t.tested_on ? " · " : ""}due ${fmtDate(t.expiry_date)}` : (t.tested_on ? "" : "no dates")}
                  </span>
                  {canEdit && <button className="link-danger" onClick={() => delTest(t.id)} title="Delete">✕</button>}
                </div>
              ))}
            </div>
            {adding && (
              <div className="card" style={{ marginTop: 8, padding: 12 }}>
                <div className="ops-form-grid">
                  <label className="field"><span>Test</span>
                    <select className="input" value={tType} onChange={(e) => setTType(e.target.value)}>{TEST_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
                  </label>
                  <label className="field"><span>Tested on</span><input className="input" type="date" value={testedOn} onChange={(e) => setTestedOn(e.target.value)} /></label>
                  <label className="field"><span>Retest due</span><input className="input" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></label>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button className="primary" onClick={addTest} disabled={busy}>Add test</button>
                  <button className="ghost" onClick={() => setAdding(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function NewOwnedPlant({ projects, onClose, onSaved }: { projects: ProjectOpt[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [assetNo, setAssetNo] = useState("");
  const [category, setCategory] = useState("");
  const [supplier, setSupplier] = useState("");
  const [project, setProject] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) { setErr("Name the plant item."); return; }
    setBusy(true); setErr(null);
    try {
      await api.addOwnedPlant({ name: name.trim(), asset_no: assetNo.trim() || undefined, category: category.trim() || undefined, supplier: supplier.trim() || undefined, notes: notes.trim() || undefined, assigned_project_id: project || undefined });
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(false); }
  }
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-hd"><h3 style={{ flex: 1 }}>Add owned plant</h3></div>
      <div className="card-bd">
        {err && <div className="flash error">{err}</div>}
        <div className="ops-form-grid">
          <label className="field" style={{ gridColumn: "1 / -1" }}><span>Item *</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Genie GS-1932 scissor lift" /></label>
          <label className="field"><span>Asset no.</span><input className="input" value={assetNo} onChange={(e) => setAssetNo(e.target.value)} /></label>
          <label className="field"><span>Category</span><input className="input" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="MEWP, welfare, telehandler…" /></label>
          <label className="field"><span>Supplier / make</span><input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} /></label>
          <label className="field"><span>On site</span>
            <select className="input" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">— Yard (not on site) —</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
            </select>
          </label>
          <label className="field" style={{ gridColumn: "1 / -1" }}><span>Notes</span><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="primary" onClick={save} disabled={busy || !name.trim()}>{busy ? "Saving…" : "Add to register"}</button>
          <button className="ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "default" | "warn" | "danger" | "success" }) {
  return (
    <div className={`kpi${tone && tone !== "default" ? ` tone-${tone}` : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
