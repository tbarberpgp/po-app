import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Topbar } from "./Shell";
import { api, fmtDate } from "../lib/api";

type Row = Awaited<ReturnType<typeof api.programmePortfolio>>[number];

export function ProgrammePortfolio() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    api.programmePortfolio().then(setRows).catch(() => setRows([])).finally(() => setLoaded(true));
  }, []);

  // Rows can be individual blocks of a combined programme, so count distinct
  // programmes (projects) for the headline, but flag risk at block granularity.
  const liveProgrammes = new Set(rows.map((r) => r.project_id)).size;
  const atRisk = rows.filter((r) => (r.slip_days ?? 0) > 0).length;
  const activeWk = rows.reduce((s, r) => s + r.active_this_week, 0);
  const overdue = rows.reduce((s, r) => s + r.overdue, 0);

  return (
    <>
      <Topbar crumbs="Workspace" title="Programme" />
      <main>
        <div className="kpis">
          <div className="kpi"><div className="kpi-label">Live programmes</div><div className="kpi-value">{liveProgrammes}</div></div>
          <div className={`kpi${atRisk ? " tone-danger" : ""}`}><div className="kpi-label">Behind baseline</div><div className="kpi-value">{atRisk}</div></div>
          <div className="kpi"><div className="kpi-label">Active this week</div><div className="kpi-value">{activeWk}</div></div>
          <div className={`kpi${overdue ? " tone-danger" : ""}`}><div className="kpi-label">Overdue activities</div><div className="kpi-value">{overdue}</div></div>
        </div>

        <div className="card">
          <div className="card-hd"><h2>Programmes by site</h2></div>
          {loaded && rows.length === 0 ? (
            <div className="empty in-card">
              <p>No programmes imported yet.</p>
              <p className="muted">Open a project's <strong>Programme</strong> tab and import a works programme from Excel — it'll appear here.</p>
            </div>
          ) : (
            <table className="prog-table">
              <thead>
                <tr>
                  <th>Site / contract</th>
                  <th className="num">Activities</th>
                  <th>Progress</th>
                  <th>Planned finish</th>
                  <th className="num">Slippage</th>
                  <th className="num">This week</th>
                  <th className="num">Overdue</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pct = Math.round(r.pct_complete * 100);
                  return (
                    <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => nav(`/projects/${r.project_id}`)}>
                      <td>
                        <strong>{r.title}</strong>
                        {r.subtitle && <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{r.subtitle}</div>}
                      </td>
                      <td className="num">{r.activities}</td>
                      <td>
                        <div className="mini-bar"><div className="mini-fill" style={{ width: pct + "%" }} /></div>
                        <span className="muted" style={{ fontSize: 11 }}>{pct}%</span>
                      </td>
                      <td>{r.planned_finish ? fmtDate(r.planned_finish) : "—"}</td>
                      <td className="num" style={{ color: r.slip_days == null ? "var(--muted)" : r.slip_days > 0 ? "var(--danger)" : r.slip_days < 0 ? "var(--success)" : "var(--muted)", fontWeight: 600 }}>
                        {r.slip_days == null ? "—" : r.slip_days === 0 ? "On time" : `${r.slip_days > 0 ? "+" : ""}${r.slip_days}d`}
                      </td>
                      <td className="num">{r.active_this_week || "—"}</td>
                      <td className="num" style={{ color: r.overdue ? "var(--danger)" : "var(--muted)" }}>{r.overdue || "—"}</td>
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
