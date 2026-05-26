import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Topbar } from "./Shell";
import { can, outranks, ROLE_LABELS, ROLES, type Role } from "../../shared/permissions";
import type { AppUser, CurrentUser, Settings } from "../../shared/types";

type ApproverItem = { id: number; project_id: string | null; tier: string; email: string; name: string | null };

export function Admin({ me }: { me: CurrentUser | null }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [approvers, setApprovers] = useState<Awaited<ReturnType<typeof api.listApprovers>>>([]);
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof api.listProjects>>>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [approverForm, setApproverForm] = useState({ project_id: "", tier: "line_manager", email: "", name: "" });

  const canManageUsers = can(me?.role, "users.write");
  const canManageApprovers = can(me?.role, "approvers.manage");

  function refresh() {
    api.settings().then(setSettings).catch((e) => setErr(e.message));
    api.listApprovers().then(setApprovers).catch((e) => setErr(e.message));
    api.listProjects().then(setProjects).catch((e) => setErr(e.message));
    if (canManageUsers) api.listUsers().then(setUsers).catch((e) => setErr(e.message));
  }
  useEffect(refresh, [canManageUsers]);

  async function addApprover(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api.addApprover({
        project_id: approverForm.project_id || null,
        tier: approverForm.tier,
        email: approverForm.email.trim(),
        name: approverForm.name.trim() || undefined,
      });
      setApproverForm({ project_id: "", tier: "line_manager", email: "", name: "" });
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

        {canManageApprovers && <XeroSection />}

        {canManageUsers && (
          <UsersSection users={users} me={me} onChanged={refresh} />
        )}

        <div className="card card-padded">
          <h3 style={{ marginTop: 0 }}>Approval thresholds</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            PO total value determines the tier when approval is required. Edit the values in
            the <code>settings</code> table to adjust.
          </p>
          {settings && (
            <ul style={{ marginBottom: 0 }}>
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
            People listed here receive approval emails and can approve/reject POs in the
            Approvals tab. Edit any row in place.
          </p>
          {canManageApprovers && (
            <form onSubmit={addApprover} className="row" style={{ marginBottom: 16 }}>
              <div>
                <label>Project</label>
                <select value={approverForm.project_id} onChange={(e) => setApproverForm({ ...approverForm, project_id: e.target.value })}>
                  <option value="">All projects (default)</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
                </select>
              </div>
              <div>
                <label>Tier</label>
                <select value={approverForm.tier} onChange={(e) => setApproverForm({ ...approverForm, tier: e.target.value })}>
                  <option value="line_manager">Line Manager</option>
                  <option value="commercial_manager">Commercial Manager</option>
                  <option value="director">Director</option>
                </select>
              </div>
              <div className="grow">
                <label>Email</label>
                <input type="email" required value={approverForm.email} onChange={(e) => setApproverForm({ ...approverForm, email: e.target.value })} placeholder="approver@powergridprojects.net" />
              </div>
              <div>
                <label>Name</label>
                <input value={approverForm.name} onChange={(e) => setApproverForm({ ...approverForm, name: e.target.value })} />
              </div>
              <button type="submit" className="primary" style={{ alignSelf: "flex-end" }}>Add</button>
            </form>
          )}
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
                  <th style={{ width: 110 }}></th>
                </tr>
              </thead>
              <tbody>
                {approvers.map((a) => (
                  <ApproverRow
                    key={a.id}
                    approver={a}
                    projectCode={a.project_id ? projects.find((p) => p.id === a.project_id)?.code ?? a.project_id : null}
                    onSaved={refresh}
                    canManage={canManageApprovers}
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

/* ── Xero integration ───────────────────────────────────────────────────── */

function XeroSection() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.xeroStatus>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function refresh() {
    api.xeroStatus().then(setStatus).catch((e) => setErr(e.message));
  }
  useEffect(() => {
    refresh();
    // If we came back from the OAuth callback, the URL has ?xero=connected or
    // ?xero_error=… — peel those off and show a notification.
    const url = new URL(window.location.href);
    if (url.searchParams.get("xero") === "connected") {
      url.searchParams.delete("xero");
      window.history.replaceState(null, "", url.toString());
    }
    const xeroErr = url.searchParams.get("xero_error");
    if (xeroErr) {
      setErr(`Xero connect failed: ${xeroErr}`);
      url.searchParams.delete("xero_error");
      window.history.replaceState(null, "", url.toString());
    }
  }, []);

  if (!status) return null;

  async function disconnect() {
    if (!confirm("Disconnect from Xero? You'll need to re-authorise to sync again.")) return;
    setBusy(true); setErr(null);
    try { await api.xeroDisconnect(); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "disconnect failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="card card-padded">
      <h3 style={{ marginTop: 0 }}>Xero integration</h3>
      {err && <div className="flash error">{err}</div>}

      {!status.configured && (
        <div className="muted">
          Xero isn't configured on this environment. An admin needs to:
          <ol style={{ marginTop: 4 }}>
            <li>Register an app at <a href="https://developer.xero.com/myapps" target="_blank" rel="noreferrer">developer.xero.com/myapps</a></li>
            <li>Set the redirect URI to <code style={{ background: "var(--card-2)", padding: "1px 4px", borderRadius: 4 }}>{window.location.origin}/api/xero/callback</code></li>
            <li>From the terminal: <code style={{ background: "var(--card-2)", padding: "1px 4px", borderRadius: 4 }}>npx wrangler secret put XERO_CLIENT_ID</code> and <code style={{ background: "var(--card-2)", padding: "1px 4px", borderRadius: 4 }}>npx wrangler secret put XERO_CLIENT_SECRET</code> using the values from the Xero app</li>
          </ol>
        </div>
      )}

      {status.configured && !status.connected && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Not connected. Click below to authorise the app with one of your Xero organisations.
            You'll be redirected to Xero to choose a tenant and approve the requested scopes.
          </p>
          <a href={api.xeroConnectUrl()} className="btn accent">Connect to Xero</a>
        </>
      )}

      {status.configured && status.connected && status.connection && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 12 }}>
            <div>
              <div className="eyebrow">Organisation</div>
              <div style={{ fontWeight: 500 }}>{status.connection.tenant_name ?? status.connection.tenant_id}</div>
              <div className="muted" style={{ fontSize: 12 }}>{status.connection.tenant_type}</div>
            </div>
            <div>
              <div className="eyebrow">Connected by</div>
              <div style={{ fontSize: 13 }}>{status.connection.connected_by}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {new Date(status.connection.connected_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
              </div>
            </div>
            <div>
              <div className="eyebrow">Token expires</div>
              <div style={{ fontSize: 13 }}>{new Date(status.connection.expires_at).toLocaleString("en-GB")}</div>
              <div className="muted" style={{ fontSize: 12 }}>auto-refreshes</div>
            </div>
          </div>
          <div className="row">
            <a href={api.xeroConnectUrl()} className="btn ghost">Re-authorise / switch organisation</a>
            <button className="danger" onClick={disconnect} disabled={busy}>Disconnect</button>
          </div>
          <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
            Approved POs are automatically pushed into Xero as draft Purchase Orders for AP to match against incoming invoices.
            Supplier contacts can be synced from the Approved Suppliers page.
          </p>
        </>
      )}
    </div>
  );
}

/* ── Users section ──────────────────────────────────────────────────────── */

function UsersSection({
  users,
  me,
  onChanged,
}: {
  users: AppUser[];
  me: CurrentUser | null;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<{ email: string; name: string; role: Role }>({
    email: "", name: "", role: "viewer",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.addUser({
        email: form.email.trim(),
        name: form.name.trim() || undefined,
        role: form.role,
      });
      setForm({ email: "", name: "", role: "viewer" });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  const canPromoteSuper = can(me?.role, "users.promote_superadmin");

  return (
    <div className="card card-padded">
      <h3 style={{ marginTop: 0 }}>Users & permissions</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Anyone past Cloudflare Access lands here as <b>Viewer</b> by default. Promote them to
        Procurement to raise POs, Admin to manage users and projects, or Superadmin for full
        control (incl. deleting POs).
      </p>
      {err && <div className="flash error">{err}</div>}

      <form onSubmit={add} className="row" style={{ marginBottom: 16 }}>
        <div className="grow">
          <label>Email</label>
          <input
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="person@powergridprojects.net"
          />
        </div>
        <div className="grow">
          <label>Name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div style={{ minWidth: 160 }}>
          <label>Role</label>
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.filter((r) => r !== "superadmin" || canPromoteSuper).map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r]}</option>
            ))}
          </select>
        </div>
        <button type="submit" className="primary" style={{ alignSelf: "flex-end" }} disabled={busy}>Add</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th style={{ width: 130 }}></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <UserRow key={u.email} user={u} me={me} onChanged={onChanged} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserRow({
  user,
  me,
  onChanged,
}: {
  user: AppUser;
  me: CurrentUser | null;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name ?? "");
  const [role, setRole] = useState<Role>(user.role);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // What this current user is allowed to do to this row.
  const isSelf = me?.email === user.email;
  const isProtected = me ? outranks(user.role, me.role) : true;
  const canEdit = !isProtected;
  const canPromoteSuper = can(me?.role, "users.promote_superadmin");
  const allowedRoles = ROLES.filter((r) => r !== "superadmin" || canPromoteSuper || user.role === "superadmin");

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.updateUser(user.email, { name: name.trim() || undefined, role });
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    if (!confirm(`${user.active ? "Deactivate" : "Reactivate"} ${user.email}?`)) return;
    await api.updateUser(user.email, { active: !user.active });
    onChanged();
  }

  async function remove() {
    if (!confirm(`Permanently remove ${user.email}? They'll be re-created as a Viewer if they visit again.`)) return;
    await api.removeUser(user.email);
    onChanged();
  }

  if (editing) {
    return (
      <tr style={{ background: "var(--accent-soft)" }}>
        <td><input value={name} onChange={(e) => setName(e.target.value)} /></td>
        <td className="muted">{user.email}{isSelf && " (you)"}</td>
        <td>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={isSelf}>
            {allowedRoles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
          {err && <div className="muted" style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>{err}</div>}
        </td>
        <td><span className={`pill ${user.active ? "approved" : "draft"}`}>{user.active ? "active" : "deactivated"}</span></td>
        <td>
          <button className="primary tiny" onClick={save} disabled={busy}>Save</button>{" "}
          <button className="ghost tiny" onClick={() => { setEditing(false); setName(user.name ?? ""); setRole(user.role); }}>Cancel</button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>{user.name ?? <span className="muted">—</span>}</td>
      <td className="muted">{user.email}{isSelf && " (you)"}</td>
      <td><span className="pill">{ROLE_LABELS[user.role]}</span></td>
      <td><span className={`pill ${user.active ? "approved" : "draft"}`}>{user.active ? "active" : "deactivated"}</span></td>
      <td>
        {canEdit && <button className="ghost tiny" onClick={() => setEditing(true)}>Edit</button>}{" "}
        {canEdit && !isSelf && (
          <button className="ghost tiny" onClick={toggleActive}>
            {user.active ? "Deactivate" : "Reactivate"}
          </button>
        )}{" "}
        {canEdit && !isSelf && (
          <button className="ghost tiny" onClick={remove}>×</button>
        )}
      </td>
    </tr>
  );
}

/* ── Approver row (unchanged in behaviour, now takes canManage) ────────── */

function ApproverRow({
  approver,
  projectCode,
  onSaved,
  canManage,
}: {
  approver: ApproverItem;
  projectCode: string | null;
  onSaved: () => void;
  canManage: boolean;
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
      <tr onDoubleClick={() => canManage && setEditing(true)} style={canManage ? { cursor: "pointer" } : undefined}>
        <td>{projectCode ?? "All"}</td>
        <td>{approver.tier.replace("_", " ")}</td>
        <td>{approver.name ?? <span className="muted">—</span>}</td>
        <td>{approver.email}</td>
        <td>
          {canManage && <button className="ghost tiny" onClick={() => setEditing(true)}>Edit</button>}{" "}
          {canManage && (
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
          )}
        </td>
      </tr>
    );
  }

  return (
    <tr style={{ background: "var(--accent-soft)" }}>
      <td>{projectCode ?? "All"}</td>
      <td>
        <select value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="line_manager">Line Manager</option>
          <option value="commercial_manager">Commercial Manager</option>
          <option value="director">Director</option>
        </select>
      </td>
      <td><input value={name} onChange={(e) => setName(e.target.value)} /></td>
      <td><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></td>
      <td>
        <button className="primary tiny" disabled={busy} onClick={save}>Save</button>{" "}
        <button className="ghost tiny" onClick={() => { setEditing(false); setEmail(approver.email); setName(approver.name ?? ""); setTier(approver.tier); }}>Cancel</button>
      </td>
    </tr>
  );
}
