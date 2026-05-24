import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";

type Row = { id: string; code: string; name: string; client: string | null; active_snapshot_id: number | null };

export function ProjectsList() {
  const [rows, setRows] = useState<Row[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<Awaited<ReturnType<typeof api.listPOs>>>([]);

  function refresh() {
    api.listProjects().then(setRows).catch((e) => setError(e.message));
    api.listPOs().then(setPos).catch(() => {});
  }
  useEffect(refresh, []);

  const totalCommitted = pos
    .filter((p) => p.status === "approved" || p.status === "issued" || p.status === "pending_approval")
    .reduce((s, p) => s + p.total_value, 0);
  const pendingCount = pos.filter((p) => p.status === "pending_approval").length;
  const issuedCount = pos.filter((p) => p.status === "issued").length;

  return (
    <>
      <Topbar
        crumbs="Workspace"
        title="Projects"
        actions={<button className="accent" onClick={() => setShowNew(true)}>+ New project</button>}
      />
      <main>
        {error && <div className="flash error">{error}</div>}

        <div className="kpis">
          <Kpi label="Active projects" value={String(rows.length)} sub={`${rows.filter((r) => r.active_snapshot_id).length} with priced BOQ`} />
          <Kpi label="Committed (all POs)" value={fmtMoney(totalCommitted)} sub="Approved + issued + pending" />
          <Kpi label="Pending approvals" value={String(pendingCount)} sub={pendingCount > 0 ? "Action needed" : "All clear"} tone={pendingCount > 0 ? "warn" : "default"} />
          <Kpi label="Issued POs" value={String(issuedCount)} sub="Sent to suppliers" />
        </div>

        {showNew && <NewProjectForm onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); refresh(); }} />}

        <div className="card">
          <div className="card-hd">
            <h2>Active projects</h2>
            <span className="pill">{rows.length}</span>
          </div>
          {rows.length === 0 ? (
            <div style={{ padding: 32 }}>
              <div className="empty">No projects yet — click <i>New project</i> to start.</div>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Client</th>
                  <th>Materials</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><Link to={`/projects/${r.id}`}>{r.code}</Link></td>
                    <td>{r.name}</td>
                    <td className="muted">{r.client ?? ""}</td>
                    <td>
                      {r.active_snapshot_id
                        ? <span className="pill approved">Loaded</span>
                        : <span className="pill draft">None</span>}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link to={`/projects/${r.id}`} className="btn ghost tiny">Open ›</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
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

function NewProjectForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createProject({ code, name, client: client || undefined });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card" onSubmit={submit}>
      <div className="card-hd"><h3>New project</h3></div>
      <div className="card-bd">
        {err && <div className="flash error">{err}</div>}
        <div className="row">
          <div>
            <label>Code</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="BNC001" required />
          </div>
          <div className="grow">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Hobsons Building, St Catherine's College" required />
          </div>
          <div className="grow">
            <label>Client</label>
            <input value={client} onChange={(e) => setClient(e.target.value)} placeholder="Barnes Construction" />
          </div>
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          <button type="submit" className="accent" disabled={busy}>Create</button>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </form>
  );
}
