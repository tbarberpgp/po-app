import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Topbar } from "./Shell";
import type { Settings } from "../../shared/types";

type ApproverItem = { id: number; project_id: string | null; tier: string; email: string; name: string | null };

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
      <Topbar crumbs="Master data" title="Admin" />
      <main>
      {err && <div className="flash error">{err}</div>}

      <div className="card card-padded">
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

      <div className="card card-padded">
        <h3 style={{ marginTop: 0 }}>Approvers</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          People listed here receive approval emails and can approve/reject POs in the Approvals tab.
          Click any name or email to edit in place.
        </p>
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
            <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="approver@powergridprojects.net" />
          </div>
          <div>
            <label>Name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <button type="submit" className="primary" style={{ alignSelf: "flex-end" }}>Add</button>
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
                <th style={{ width: 90 }}></th>
              </tr>
            </thead>
            <tbody>
              {approvers.map((a) => (
                <ApproverRow
                  key={a.id}
                  approver={a}
                  projectCode={a.project_id ? projects.find((p) => p.id === a.project_id)?.code ?? a.project_id : null}
                  onSaved={refresh}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
      </main>
    </>
  );
}

function ApproverRow({
  approver,
  projectCode,
  onSaved,
}: {
  approver: ApproverItem;
  projectCode: string | null;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(approver.email);
  const [name, setName] = useState(approver.name ?? "");
  const [tier, setTier] = useState(approver.tier);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.updateApprover(approver.id, { email: email.trim(), name: name.trim() || null, tier });
      setEditing(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <tr onDoubleClick={() => setEditing(true)} style={{ cursor: "pointer" }}>
        <td>{projectCode ?? "All"}</td>
        <td>{approver.tier.replace("_", " ")}</td>
        <td onClick={() => setEditing(true)}>{approver.name ?? <span className="muted">—</span>}</td>
        <td onClick={() => setEditing(true)}>{approver.email}</td>
        <td>
          <button className="ghost tiny" onClick={() => setEditing(true)}>Edit</button>{" "}
          <button
            className="ghost tiny"
            onClick={async () => {
              if (!confirm(`Remove ${approver.email}?`)) return;
              await api.removeApprover(approver.id);
              onSaved();
            }}
          >
            ×
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr style={{ background: "var(--row-hover)" }}>
      <td>{projectCode ?? "All"}</td>
      <td>
        <select value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="line_manager">Line Manager</option>
          <option value="commercial_manager">Commercial Manager</option>
          <option value="director">Director</option>
        </select>
      </td>
      <td><input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} /></td>
      <td><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: "100%" }} /></td>
      <td>
        <button className="primary" disabled={busy} onClick={save}>Save</button>{" "}
        <button className="ghost" onClick={() => { setEditing(false); setEmail(approver.email); setName(approver.name ?? ""); setTier(approver.tier); }}>Cancel</button>
      </td>
    </tr>
  );
}
