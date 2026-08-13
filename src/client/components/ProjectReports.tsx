import { useEffect, useMemo, useState } from "react";
import { api, fmtDate } from "../lib/api";
import { ReportDrawer } from "./ReportDrawer";
import { GroupedReports } from "./ReportsList";

type ReportRow = Awaited<ReturnType<typeof api.listSiteReports>>[number];
type UpdateRow = Awaited<ReturnType<typeof api.listProjectUpdates>>[number];

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysAgoISO = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Per-project site reports — the daily/weekly reports for this project. Mirrors
 *  the workspace Reports page (period filter, multi-select, bulk email/CSV,
 *  slide-over viewing) scoped to one project, plus an on-demand generate and a
 *  manual "log update" box.
 *
 *  For a site group, pass `members` (the blocks in scope): the listing then
 *  merges every block's reports into one list — each row is labelled with its
 *  block code — and the Generate / Log-update boxes gain a block picker (reports
 *  are stored per block, so both need a target project). */
export function ProjectReports({ projectId, canEdit, members }: {
  projectId: string;
  canEdit: boolean;
  members?: { id: string; code: string; name: string }[];
}) {
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [viewId, setViewId] = useState<number | null>(null);
  const [updates, setUpdates] = useState<UpdateRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [genPeriod, setGenPeriod] = useState<"daily" | "weekly">("daily");
  const [genDate, setGenDate] = useState(todayISO());
  const [draft, setDraft] = useState("");
  const [period, setPeriod] = useState<"all" | "daily" | "weekly">("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [updatesOpen, setUpdatesOpen] = useState(false); // "Recent updates" collapsed by default

  // The blocks whose reports this tab lists. For a single project that's just
  // it; for a group it's every block in scope.
  const memberList = members && members.length ? members : null;
  const scopeIds = useMemo(() => (memberList ? memberList.map((m) => m.id) : [projectId]), [memberList, projectId]);
  const scopeKey = scopeIds.join(",");
  const showBlockPicker = !!memberList && memberList.length > 1;
  // Generate / log-update need a single target block. Default to the first
  // block in scope; a picker lets you switch when the group has several.
  const [genProject, setGenProject] = useState(scopeIds[0]);
  useEffect(() => { setGenProject(scopeIds[0]); }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const blockLabel = (id: string) => memberList?.find((m) => m.id === id)?.code ?? id;

  function refresh() {
    api.listSiteReports({ project: scopeKey }).then(setRows).catch(() => setRows([]));
    api.listProjectUpdates(genProject, daysAgoISO(7), todayISO()).then(setUpdates).catch(() => setUpdates([]));
  }
  useEffect(refresh, [scopeKey, genProject]);
  useEffect(() => { setSelected(new Set()); }, [period]);

  const shown = useMemo(() => (period === "all" ? rows : rows.filter((r) => r.period_type === period)), [rows, period]);
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleGroup = (ids: number[]) => setSelected((s) => { const n = new Set(s); const all = ids.every((id) => n.has(id)); for (const id of ids) all ? n.delete(id) : n.add(id); return n; });

  async function generate() {
    setBusy(true); setErr(null); setNotice(null);
    try {
      const r = await api.generateSiteReport({ project_id: genProject, period_type: genPeriod, date: genDate });
      setViewId(r.id);
      setNotice(`Generated the ${genPeriod} report${showBlockPicker ? ` for ${blockLabel(genProject)}` : ""}.`);
      refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : "generation failed"); }
    finally { setBusy(false); }
  }
  async function logUpdate() {
    if (!draft.trim()) return;
    setBusy(true); setErr(null); setNotice(null);
    try {
      await api.addProjectUpdate(genProject, { body: draft.trim() });
      setDraft("");
      // Rebuild the current period's report so the new update shows up straight
      // away — logging an update on its own only adds it to the feed; the report
      // is a point-in-time summary that has to be regenerated to include it.
      try {
        const r = await api.generateSiteReport({ project_id: genProject, period_type: genPeriod, date: genDate });
        setViewId(r.id);
        setNotice(`Update logged and the ${genPeriod} report${showBlockPicker ? ` for ${blockLabel(genProject)}` : ""} rebuilt — opening it now.`);
      } catch {
        setNotice("Update logged. Click Generate to rebuild the report with it.");
      }
      refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't log update"); }
    finally { setBusy(false); }
  }
  async function bulkEmail() {
    setBusy(true); setErr(null); setNotice(null);
    let sent = 0, failed = 0;
    for (const id of selected) { try { await api.sendSiteReport(id); sent++; } catch { failed++; } }
    setBusy(false); setSelected(new Set()); refresh();
    setNotice(`Emailed ${sent} report${sent === 1 ? "" : "s"}${failed ? `, ${failed} failed (check the project's manager emails)` : ""}.`);
  }
  function bulkCsv() {
    const sel2 = shown.filter((r) => selected.has(r.id));
    if (sel2.length === 0) return;
    const header = ["Period", "Start", "End", "Updates", "Status", "Generated"];
    const data = sel2.map((r) => [r.period_type, r.period_start, r.period_end, String(r.update_count), r.status, r.generated_at]);
    const csv = [header, ...data].map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = `reports-${projectId}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <ReportDrawer reportId={viewId} onClose={() => setViewId(null)} onEmailed={refresh} />
      {err && <div className="flash error">{err}</div>}
      {notice && <div className="flash info">{notice}</div>}

      <div className="card">
        <div className="card-hd"><h2>Generate a report</h2></div>
        <div className="card-bd" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          {showBlockPicker && (
            <label className="field"><span>Block</span>
              <select value={genProject} onChange={(e) => setGenProject(e.target.value)}>
                {memberList!.map((m) => <option key={m.id} value={m.id}>{m.code} · {m.name}</option>)}
              </select>
            </label>
          )}
          <label className="field"><span>Period</span>
            <select value={genPeriod} onChange={(e) => setGenPeriod(e.target.value as "daily" | "weekly")}>
              <option value="daily">Daily</option><option value="weekly">Weekly</option>
            </select>
          </label>
          <label className="field"><span>Date in period</span>
            <input type="date" value={genDate} onChange={(e) => setGenDate(e.target.value)} />
          </label>
          <button className="btn" disabled={busy} onClick={generate} style={{ minHeight: 37 }}>{busy ? "Working…" : "Generate"}</button>
          <span className="muted" style={{ fontSize: 12, maxWidth: 380 }}>
            {showBlockPicker
              ? "Reports are per block — pick the block, then generate. Each block's daily auto-runs at 07:00; weekly on Mondays."
              : "Summarises this project's field updates (WhatsApp + manual) for the day/week. Daily auto-runs at 07:00; weekly on Mondays."}
          </span>
        </div>
      </div>

      {canEdit && (
        <div className="card">
          <div className="card-hd"><h2>Log a site update</h2></div>
          <div className="card-bd">
            {showBlockPicker && (
              <label className="field" style={{ marginBottom: 8, maxWidth: 320 }}><span>Log against block</span>
                <select value={genProject} onChange={(e) => setGenProject(e.target.value)}>
                  {memberList!.map((m) => <option key={m.id} value={m.id}>{m.code} · {m.name}</option>)}
                </select>
              </label>
            )}
            <textarea
              value={draft} onChange={(e) => setDraft(e.target.value)} rows={2}
              placeholder="e.g. 2 gangs on Block C felt; Alumasc insulation delivered (22 boards); RFI raised on parapet detail."
              style={{ width: "100%", boxSizing: "border-box" }}
            />
            <div style={{ marginTop: 6 }}>
              <button className="btn ghost" disabled={busy || !draft.trim()} onClick={logUpdate}>Add update{showBlockPicker ? ` to ${blockLabel(genProject)}` : ""}</button>
            </div>
            {updates.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <button type="button" onClick={() => setUpdatesOpen((o) => !o)}
                  style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--ink)" }}>
                  <span className="rep-group-chev">{updatesOpen ? "▾" : "▸"}</span>
                  <span className="eyebrow" style={{ margin: 0 }}>Recent updates{showBlockPicker ? ` · ${blockLabel(genProject)}` : ""} (last 7 days)</span>
                  <span className="pill">{updates.length}</span>
                </button>
                {updatesOpen && (
                  <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                    {updates.slice(-12).reverse().map((u) => (
                      <li key={u.id} style={{ fontSize: 13, marginBottom: 3 }}>
                        <span className="muted">{fmtDate(u.occurred_at)} · {u.source}{u.sender ? ` · ${u.sender}` : ""}:</span>{" "}
                        {u.body || (u.media_url ? "[photo]" : "")}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-hd">
          <h2 style={{ flex: 1 }}>Reports</h2>
          <div className="seg">
            <button className={`seg-btn${period === "all" ? " active" : ""}`} onClick={() => setPeriod("all")}>All</button>
            <button className={`seg-btn${period === "daily" ? " active" : ""}`} onClick={() => setPeriod("daily")}>Daily</button>
            <button className={`seg-btn${period === "weekly" ? " active" : ""}`} onClick={() => setPeriod("weekly")}>Weekly</button>
          </div>
          <span className="pill" style={{ marginLeft: 8 }}>{shown.length}</span>
        </div>

        {selected.size > 0 && (
          <div className="bulkbar">
            <span><b>{selected.size}</b> selected</span>
            <button className="btn ghost tiny" disabled={busy} onClick={bulkEmail}>✉ Email</button>
            <button className="btn ghost tiny" onClick={bulkCsv}>⤓ CSV</button>
            <button className="btn ghost tiny" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}

        {shown.length === 0 ? (
          <div className="empty in-card">
            <p>No reports {period === "all" ? "yet" : `for the ${period} filter`}{showBlockPicker ? " across this site's blocks" : ""}.</p>
            <p className="muted" style={{ maxWidth: 520 }}>
              Generate one above, or once {showBlockPicker ? "a block's" : "this project's"} WhatsApp group is linked the daily/weekly reports build themselves.
            </p>
          </div>
        ) : (
          <GroupedReports rows={shown} selected={selected} onToggleOne={toggle} onToggleGroup={toggleGroup} onOpen={setViewId} resetKey={period} />
        )}
      </div>
    </>
  );
}
