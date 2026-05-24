import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Settings } from "../../shared/types";

export function Admin() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [approvers, setApprovers] = useState<Awaited<ReturnType<typeof api.listApprovers>>>([]);
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof api.listProjects>>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ project_id: "", tier: "line_manager", email: "", name: "" });

  function refresh() {
    api.settings().then(setSettings).catch((e) => setErr(e.message));
    api.listApprovers().then(setApprovers).catch((e) => setErr(e.message));
    api.listProjects().then(setProjects).catch((e) => setErr(e.message));
  }
  useEffect(refresh, []);

  async function addApprover(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api.addApprover({
        project_id: form.project_id || null,
        tier: form.tier,
        email: form.email.trim(),
        name: form.name.trim() || undefined,
      });
      setForm({ project_id: "", tier: "line_manager", email: "", name: "" });
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    }
  }

  return (
    <>
      <h2>Admin</h2>
      {err && <div className="flash error">{err}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Approval thresholds</h3>
        <p className="muted">Configured in <code>wrangler.toml</code> / <code>settings</code> table. PO total value determines tier.</p>
        {settings && (
          <ul>
            <li>Up to <b>£{settings.tier_threshold_line_manager.toLocaleString()}</b> → Line Manager</li>
            <li>Up to <b>£{settings.tier_threshold_commercial_manager.toLocaleString()}</b> → Commercial Manager</li>
            <li>Above <b>£{settings.tier_threshold_commercial_manager.toLocaleString()}</b> → Director</li>
            <li>Any <b>unpriced material</b> escalates at least to Commercial Manager.</li>
          </ul>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Approvers</h3>
        <form onSubmit={addApprover} className="row" style={{ marginBottom: 16 }}>
          <div>
            <label>Project</label>
            <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}>
              <option value="">All projects (default)</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
            </select>
          </div>
          <div>
            <label>Tier</label>
            <select value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })}>
              <option value="line_manager">Line Manager</option>
              <option value="commercial_manager">Commercial Manager</option>
              <option value="director">Director</option>
            </select>
          </div>
          <div className="grow">
            <label>Email</label>
            <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="approver@powergridprojects.co.uk" />
          </div>
          <div>
            <label>Name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <button type="submit" style={{ alignSelf: "flex-end" }}>Add</button>
        </form>
        {approvers.length === 0 ? (
          <div className="muted">No approvers configured yet — POs needing approval will route nowhere.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Scope</th>
                <th>Tier</th>
                <th>Name</th>
                <th>Email</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {approvers.map((a) => (
                <tr key={a.id}>
                  <td>{a.project_id ? projects.find((p) => p.id === a.project_id)?.code ?? a.project_id : "All"}</td>
                  <td>{a.tier.replace("_", " ")}</td>
                  <td>{a.name ?? ""}</td>
                  <td>{a.email}</td>
                  <td>
                    <button
                      className="secondary"
                      onClick={async () => {
                        await api.removeApprover(a.id);
                        refresh();
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
