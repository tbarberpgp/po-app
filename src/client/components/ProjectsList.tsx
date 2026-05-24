import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

type Row = { id: string; code: string; name: string; client: string | null; active_snapshot_id: number | null };

export function ProjectsList() {
  const [rows, setRows] = useState<Row[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    api.listProjects().then(setRows).catch((e) => setError(e.message));
  }
  useEffect(refresh, []);

  return (
    <>
      <div className="row" style={{ marginBottom: 24 }}>
        <h2 className="grow">Projects</h2>
        <button onClick={() => setShowNew(true)}>+ New project</button>
      </div>
      {error && <div className="flash error">{error}</div>}
      {showNew && <NewProjectForm onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); refresh(); }} />}
      {rows.length === 0 ? (
        <div className="empty">No projects yet — click <i>New project</i> to start.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Client</th>
              <th>Materials</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/projects/${r.id}`}>{r.code}</Link></td>
                <td>{r.name}</td>
                <td>{r.client ?? ""}</td>
                <td>{r.active_snapshot_id ? <span className="badge approved">Loaded</span> : <span className="badge draft">None</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
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
      <h3 style={{ marginTop: 0 }}>New project</h3>
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
        <button type="submit" disabled={busy}>Create</button>
        <button type="button" className="secondary" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
