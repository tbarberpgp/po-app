import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Topbar } from "./Shell";
import { GlobalDeliveryCheckIn } from "./Operations";
import { can } from "../../shared/permissions";
import { combineSiteCodes } from "../../shared/site-code";
import type { CurrentUser, OpsSite } from "../../shared/types";

type Row = { id: string; code: string; name: string; client: string | null; active_snapshot_id: number | null; completed_at?: string | null; is_sandbox?: number; site_group_id?: string | null; site_group_name?: string | null; site_group_base?: string | null };

export function ProjectsList({ me }: { me: CurrentUser | null }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [showCheckIn, setShowCheckIn] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<Awaited<ReturnType<typeof api.listPOs>>>([]);
  const [sites, setSites] = useState<OpsSite[]>([]);
  const canCreate = can(me?.role, "projects.create");
  const canCheckin = can(me?.role, "delivery.edit");

  function refresh() {
    api.listProjects().then(setRows).catch((e) => setError(e.message));
    api.listPOs().then(setPos).catch(() => {});
    // Site activity (requires the Operations tables); ignore if unavailable.
    api.opsSites().then(setSites).catch(() => setSites([]));
  }
  useEffect(refresh, []);

  const pendingCount = pos.filter((p) => p.status === "pending_approval").length;
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const totalOnSite = sites.reduce((n, s) => n + (s.on_site_now || 0), 0);
  const totalSignedToday = sites.reduce((n, s) => n + (s.signins_today || 0), 0);
  const totalPlant = sites.reduce((n, s) => n + (s.plant_on_site || 0), 0);

  const active = rows.filter((r) => !r.completed_at);
  const completed = rows.filter((r) => r.completed_at);

  function projectRow(r: Row, indented = false) {
    const s = siteById.get(r.id);
    const onSite = s?.on_site_now ?? 0;
    const signed = s?.signins_today ?? 0;
    const plant = s?.plant_on_site ?? 0;
    return (
      <tr key={r.id} className={r.completed_at ? "row-muted" : undefined}>
        <td style={indented ? { paddingLeft: 30 } : undefined}><Link to={`/projects/${r.id}`}>{r.code}</Link></td>
        <td>{r.name}{r.is_sandbox ? <span className="pill" style={{ marginLeft: 8, fontSize: 10, background: "var(--accent-soft, #fbe6dd)", color: "var(--accent)" }}>SANDBOX</span> : null}{r.completed_at && <span className="pill approved" style={{ marginLeft: 8, fontSize: 10 }}>✓ Complete</span>}</td>
        <td className="muted center">{r.client ?? ""}</td>
        <td className="center">
          {r.active_snapshot_id
            ? <span className="pill approved" style={{ minWidth: 64, justifyContent: "center" }}>Loaded</span>
            : <span className="pill draft" style={{ minWidth: 64, justifyContent: "center" }}>None</span>}
        </td>
        <td className="center">
          {onSite > 0
            ? <span className="pill ok" title={`${signed} signed in today`}>{onSite} on site</span>
            : <span className="muted">{signed > 0 ? `${signed} today` : "—"}</span>}
        </td>
        <td className="center">{plant > 0 ? <span className="pill neutral">{plant}</span> : <span className="muted">—</span>}</td>
        <td style={{ textAlign: "right" }}>
          <Link to={`/projects/${r.id}`} className="btn ghost tiny">Open ›</Link>
        </td>
      </tr>
    );
  }

  // A grouped site (Blocks B/C/D of one job) shows as ONE row — combined code
  // "26001/2/3" linking to the group page (filterable to each block inside) —
  // with its blocks' on-site/plant rolled up. Standalone projects stay inline.
  function renderGrouped(list: Row[]): JSX.Element[] {
    const seen = new Set<string>();
    const out: JSX.Element[] = [];
    for (const r of list) {
      const gid = r.site_group_id;
      if (!gid) { out.push(projectRow(r)); continue; }
      if (seen.has(gid)) continue;
      seen.add(gid);
      const members = list.filter((x) => x.site_group_id === gid);
      if (members.length < 2) { out.push(projectRow(r)); continue; } // group of one → inline
      const onSite = members.reduce((n, m) => n + (siteById.get(m.id)?.on_site_now ?? 0), 0);
      const plant = members.reduce((n, m) => n + (siteById.get(m.id)?.plant_on_site ?? 0), 0);
      const loaded = members.filter((m) => m.active_snapshot_id).length;
      const code = combineSiteCodes(members.map((m) => m.code));
      out.push(
        <tr key={`g-${gid}`}>
          <td><Link to={`/groups/${gid}`}>{code}</Link></td>
          <td><Link to={`/groups/${gid}`} style={{ color: "inherit" }}>{r.site_group_name || "Site"}</Link> <span className="pill" style={{ marginLeft: 6, fontSize: 10 }}>{members.length} blocks</span></td>
          <td className="muted center">{members[0]?.client ?? ""}</td>
          <td className="center muted">{loaded}/{members.length}</td>
          <td className="center">{onSite > 0 ? <span className="pill ok">{onSite} on site</span> : <span className="muted">—</span>}</td>
          <td className="center">{plant > 0 ? <span className="pill neutral">{plant}</span> : <span className="muted">—</span>}</td>
          <td style={{ textAlign: "right" }}><Link to={`/groups/${gid}`} className="btn ghost tiny">Open ›</Link></td>
        </tr>,
      );
    }
    return out;
  }

  return (
    <>
      <Topbar
        crumbs="Workspace"
        title="Projects"
        actions={
          <>
            {canCreate && <button className="accent hide-on-mobile" onClick={() => setShowNew(true)}>+ New project</button>}
            {canCheckin && <button className="accent show-on-mobile" style={{ marginLeft: "auto" }} onClick={() => setShowCheckIn(true)}>Check in a delivery</button>}
          </>
        }
      />
      <main>
        {error && <div className="flash error">{error}</div>}

        <div className="kpis">
          <Kpi label="Active projects" value={String(active.length)} sub={`${active.filter((r) => r.active_snapshot_id).length} with priced BOQ`} />
          <Kpi label="On site now" value={String(totalOnSite)} sub={`${totalSignedToday} signed in today`} tone={totalOnSite > 0 ? "success" : "default"} />
          <Kpi label="Plant on site" value={String(totalPlant)} sub="across all sites" />
          <Kpi label="Pending approvals" value={String(pendingCount)} sub={pendingCount > 0 ? "Action needed" : "All clear"} tone={pendingCount > 0 ? "warn" : "default"} />
        </div>

        {showNew && <NewProjectForm onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); refresh(); }} />}
        {showCheckIn && <GlobalDeliveryCheckIn onClose={() => setShowCheckIn(false)} onDone={refresh} />}

        <div className="card">
          <div className="card-hd">
            <h2>Active projects</h2>
            <span className="pill">{active.length}</span>
          </div>
          {active.length === 0 ? (
            <div style={{ padding: 32 }}>
              <div className="empty">
                {rows.length === 0
                  ? <>No projects yet — click <i>New project</i> to start.</>
                  : "No active projects — all are marked complete."}
              </div>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th className="center">Client</th>
                  <th className="center">Materials</th>
                  <th className="center">On site</th>
                  <th className="center">Plant</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>{renderGrouped(active)}</tbody>
            </table>
          )}
        </div>

        {completed.length > 0 && (
          <div className="card">
            <button
              className="card-hd"
              onClick={() => setShowCompleted((v) => !v)}
              style={{ width: "100%", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
            >
              <h2 style={{ flex: 1 }}>Completed projects</h2>
              <span className="pill approved">{completed.length}</span>
              <span className="muted" style={{ marginLeft: 8 }}>{showCompleted ? "▾" : "▸"}</span>
            </button>
            {showCompleted && (
              <table>
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th className="center">Client</th>
                    <th className="center">Materials</th>
                    <th className="center">On site</th>
                    <th className="center">Plant</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>{renderGrouped(completed)}</tbody>
              </table>
            )}
          </div>
        )}
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
