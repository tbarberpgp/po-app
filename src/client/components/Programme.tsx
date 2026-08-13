import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDate, fmtQty } from "../lib/api";
import type { ProgrammeActivity } from "../../shared/types";

type ActivityItem = Awaited<ReturnType<typeof api.listActivityItems>>[number];
type StockRow = Awaited<ReturnType<typeof api.programmeStockDemand>>[number];
type BillItem = Awaited<ReturnType<typeof api.listContractItems>>[number];

const DAY = 86400000;
const NAME_W = 264;
const ZOOM = [2, 3, 5, 8, 12, 18, 28, 44]; // px per day
const toDate = (s: string | null | undefined): Date | null => (s ? new Date(s + "T00:00:00") : null);
const diffDays = (from: string | null, to: string | null): number | null => {
  const a = toDate(from), b = toDate(to);
  return a && b ? Math.round((+b - +a) / DAY) : null;
};
const todayISO = () => new Date().toISOString().slice(0, 10);

/** Per-project (or per-site-group) works programme: import from Excel, a
 *  scrollable + zoomable Gantt, baseline/variance and progress capture. */
export function ProjectProgramme({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [acts, setActs] = useState<ProgrammeActivity[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<"gantt" | "table" | "stock">("gantt");
  const [stockFilter, setStockFilter] = useState<"all" | "toorder" | "notordered" | "partordered" | "onsite" | "installed">("all");
  const [stockSort, setStockSort] = useState<"urgent" | "name" | "toorder" | "required">("urgent");
  const [zi, setZi] = useState(3);
  const fitDone = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const progressRef = useRef<HTMLInputElement>(null);
  const pxPerDay = ZOOM[zi];
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [items, setItems] = useState<Record<number, ActivityItem[]>>({});
  const [bill, setBill] = useState<BillItem[]>([]);
  const [stock, setStock] = useState<StockRow[]>([]);
  const [stockErr, setStockErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function load() {
    api.listProgramme(projectId).then((r) => { setActs(r); setLoaded(true); }).catch(() => { setActs([]); setLoaded(true); });
    api.programmeStockDemand(projectId).then((r) => { setStock(r); setStockErr(null); }).catch((e) => { setStock([]); setStockErr(e instanceof Error ? e.message : "Couldn't load materials & stock"); });
  }
  useEffect(load, [projectId]);

  async function toggleExpand(id: number) {
    setExpanded((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
    if (!items[id]) {
      try { const r = await api.listActivityItems(projectId, id); setItems((p) => ({ ...p, [id]: r })); } catch { /* */ }
    }
    if (bill.length === 0) api.listContractItems(projectId).then(setBill).catch(() => { /* */ });
  }
  async function refreshItems(activityId: number) {
    try { const r = await api.listActivityItems(projectId, activityId); setItems((p) => ({ ...p, [activityId]: r })); } catch { /* */ }
    api.programmeStockDemand(projectId).then(setStock).catch(() => { /* */ });
  }
  async function addItem(activityId: number, contractItemId: number) {
    await api.addActivityItem(projectId, activityId, { contract_item_id: contractItemId });
    refreshItems(activityId);
  }
  async function removeItem(activityId: number, itemId: number) {
    await api.deleteActivityItem(projectId, itemId);
    refreshItems(activityId);
  }

  async function onImport(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true); setErr(null); setNotice(null);
    try {
      const res = await api.importProgramme(projectId, f);
      if (!res.activities) setErr("No activities found in that file — check it has a task table with Name, Start and Finish columns.");
      else if (res.tagged && res.components) setNotice(`Imported ${res.activities} activities and auto-tagged ${res.tagged} to bill lines from the cost sheet — the Materials & stock tab is populated below.`);
      else if (res.pendingBill) setNotice(`Imported ${res.activities} activities. The cost sheet is awaiting superadmin approval — once approved, the Materials & stock tab fills in automatically.`);
      else if (!res.billItems) setNotice(`Imported ${res.activities} activities. To populate the Materials & stock tab, upload the pricing workbook (cost sheet) in the Materials tab — it'll link to the programme automatically.`);
      else if (res.tagged && !res.components) setNotice(`Imported ${res.activities} activities and linked ${res.tagged} to bill lines, but this project's cost sheet has no material breakdown stored — re-upload this project's pricing workbook in its Materials tab to populate the Materials & stock tab.`);
      else setNotice(`Imported ${res.activities} activities. The bill has ${res.billItems} lines but none auto-matched — use “Auto-tag from bill” or link via the ▸ on each activity.`);
      fitDone.current = false; load();
    } catch (e) { setErr(e instanceof Error ? e.message : "import failed"); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  async function onProgress(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true); setErr(null); setNotice(null);
    try {
      const res = await api.updateProgrammeProgress(projectId, f);
      if (!res.updated && res.skipped) {
        setErr(`Couldn't match any of the ${res.total} rows to this programme — the sheet's tasks/order differ. Use “Re-import programme” instead if the programme has been re-sequenced.`);
      } else {
        setNotice(`Progress updated on ${res.updated} activit${res.updated === 1 ? "y" : "ies"}${res.skipped ? ` · ${res.skipped} row${res.skipped === 1 ? "" : "s"} skipped (no match)` : ""}. Baseline and bill-line tags are unchanged.`);
      }
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : "progress update failed"); }
    finally { setBusy(false); if (progressRef.current) progressRef.current.value = ""; }
  }

  async function autoTag() {
    setBusy(true); setErr(null); setNotice(null);
    try {
      const r = await api.autoTagProgramme(projectId);
      if (r.pendingBill) setErr("This project's cost sheet is uploaded but still awaiting superadmin approval. Once it's approved, the programme links to it automatically and this tab populates.");
      else if (!r.billItems) setErr("No priced bill is loaded for this project yet. Upload the pricing workbook (cost sheet) in the Materials tab — the programme then links to it automatically.");
      else if (!r.tagged) setNotice(`The bill has ${r.billItems} line${r.billItems === 1 ? "" : "s"} but none auto-matched the activity names. Link them via the ▸ on each activity in the Table subtab.`);
      else if (!r.components) setErr(`Linked ${r.tagged} activities, but this project's cost sheet has no material breakdown stored — it was uploaded before that was captured. Re-upload this project's pricing workbook in its Materials tab and this tab fills in automatically.`);
      else setNotice(`Auto-tagged ${r.tagged} activities to bill lines — the Materials & stock tab is populated below.`);
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : "auto-tag failed"); }
    finally { setBusy(false); }
  }

  async function setBaseline() {
    if (!confirm("Set the current programme as the agreed baseline? Variance will be measured against this from now on.")) return;
    setBusy(true);
    try { await api.setProgrammeBaseline(projectId); load(); }
    finally { setBusy(false); }
  }

  async function patch(id: number, p: Parameters<typeof api.updateProgrammeActivity>[2]) {
    setActs((prev) => prev.map((a) => (a.id === id ? { ...a, ...p } as ProgrammeActivity : a)));
    try { await api.updateProgrammeActivity(projectId, id, p); } catch { load(); }
  }

  // ── Date range + headline metrics ────────────────────────────────────────
  const range = useMemo(() => {
    const ds: number[] = [];
    for (const a of acts) {
      for (const s of [a.baseline_start, a.planned_start, a.actual_start, a.baseline_finish, a.planned_finish, a.actual_finish]) {
        const d = toDate(s); if (d) ds.push(+d);
      }
    }
    if (ds.length < 2) return null;
    const min = Math.min(...ds), max = Math.max(...ds);
    return { min, max, days: Math.max(Math.round((max - min) / DAY) + 1, 1) };
  }, [acts]);

  // Default zoom so the whole programme roughly fits ~900px, once per load.
  useEffect(() => {
    if (!range || fitDone.current) return;
    fitDone.current = true;
    const target = 900 / range.days;
    let best = 0; for (let i = 0; i < ZOOM.length; i++) if (Math.abs(ZOOM[i] - target) < Math.abs(ZOOM[best] - target)) best = i;
    setZi(best);
  }, [range]);

  const metrics = useMemo(() => {
    const leaves = acts.filter((a) => !a.is_summary && a.level > 0 || (!acts.some((x) => x.level > 0) && !a.is_summary));
    const base = leaves.length ? leaves : acts.filter((a) => !a.is_summary);
    let wsum = 0, w = 0;
    for (const a of base) { const d = a.duration_days ?? 1; wsum += (a.pct_complete || 0) * d; w += d; }
    const pct = w > 0 ? wsum / w : 0;
    const plannedFinish = acts.reduce<string | null>((m, a) => (a.planned_finish && (!m || a.planned_finish > m) ? a.planned_finish : m), null);
    const baselineFinish = acts.reduce<string | null>((m, a) => (a.baseline_finish && (!m || a.baseline_finish > m) ? a.baseline_finish : m), null);
    const slip = diffDays(baselineFinish, plannedFinish);
    return { pct, plannedFinish, baselineFinish, slip, count: acts.length };
  }, [acts]);

  const dayX = (s: string | null) => { const d = toDate(s); return d && range ? ((+d - range.min) / DAY) * pxPerDay : null; };
  const tlW = range ? range.days * pxPerDay : 0;

  const months = useMemo(() => {
    if (!range) return [];
    const segs: { label: string; left: number; width: number }[] = [];
    let cur = new Date(range.min); cur = new Date(cur.getFullYear(), cur.getMonth(), 1);
    while (+cur <= range.max) {
      const next = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      const segStart = Math.max(+cur, range.min), segEnd = Math.min(+next, range.max + DAY);
      segs.push({
        label: cur.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }),
        left: ((segStart - range.min) / DAY) * pxPerDay,
        width: ((segEnd - segStart) / DAY) * pxPerDay,
      });
      cur = next;
    }
    return segs;
  }, [range, pxPerDay]);

  const weeks = useMemo(() => {
    if (!range || pxPerDay * 7 < 26) return [];
    const out: number[] = [];
    const start = new Date(range.min);
    // first Monday on/after min
    const dow = (start.getDay() + 6) % 7;
    let d = +start + (dow === 0 ? 0 : (7 - dow) * DAY);
    for (; d <= range.max; d += 7 * DAY) out.push(((d - range.min) / DAY) * pxPerDay);
    return out;
  }, [range, pxPerDay]);

  const todayX = dayX(todayISO());

  const importBtn = canEdit && (
    <>
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.xlsm,.pdf" hidden onChange={onImport} disabled={busy} />
      <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
        {acts.length ? "↑ Re-import programme" : "↑ Import programme (Excel / PDF)"}
      </button>
    </>
  );
  const progressBtn = canEdit && acts.length > 0 && (
    <>
      <input ref={progressRef} type="file" accept=".xlsx,.xls,.xlsm,.pdf" hidden onChange={onProgress} disabled={busy} />
      <button className="btn ghost" disabled={busy} onClick={() => progressRef.current?.click()}
        title="Upload an updated programme export to refresh % complete and forecast dates on the existing activities — keeps the baseline and bill-line tags.">
        ↑ Update progress
      </button>
    </>
  );

  if (loaded && acts.length === 0) {
    return (
      <div className="card">
        <div className="card-hd"><h2>Programme</h2><div className="actions">{importBtn}</div></div>
        {err && <div className="flash error">{err}</div>}
        <div className="empty in-card">
          <p>No programme imported yet.</p>
          <p className="muted" style={{ maxWidth: 540, margin: "0 auto", textAlign: "center" }}>
            Import your works programme from Excel (Asta, MS Project or a spreadsheet). It needs a task
            table with at least <strong>Name/Activity</strong>, <strong>Start</strong> and <strong>Finish</strong>{" "}
            columns — <strong>Duration</strong>, <strong>% Complete</strong>, predecessors and indented sub-tasks
            are picked up too. The first import becomes your baseline. Grouped sites share one programme.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {err && <div className="flash error">{err}</div>}
      {notice && <div className="flash info">{notice}</div>}
      <div className="kpis">
        <Kpi label="Activities" value={String(metrics.count)} />
        <Kpi label="Overall progress" value={`${Math.round(metrics.pct * 100)}%`} />
        <Kpi label="Planned completion" value={metrics.plannedFinish ? fmtDate(metrics.plannedFinish) : "—"} />
        <Kpi
          label="Slippage vs baseline"
          value={metrics.slip == null ? "—" : metrics.slip === 0 ? "On programme" : `${metrics.slip > 0 ? "+" : ""}${metrics.slip} days`}
          tone={metrics.slip != null && metrics.slip > 0 ? "danger" : metrics.slip != null && metrics.slip < 0 ? "success" : "default"}
        />
      </div>

      <div className="card">
        <div className="card-hd">
          <h2>Works programme</h2>
          <div className="actions" style={{ gap: 8, flexWrap: "wrap" }}>
            <div className="seg" role="group" aria-label="View">
              <button className={`seg-btn${view === "gantt" ? " active" : ""}`} onClick={() => setView("gantt")}>Gantt</button>
              <button className={`seg-btn${view === "table" ? " active" : ""}`} onClick={() => setView("table")}>Table</button>
              <button className={`seg-btn${view === "stock" ? " active" : ""}`} onClick={() => setView("stock")}>Materials &amp; stock</button>
            </div>
            {view === "gantt" && range && (
              <div className="seg" role="group" aria-label="Zoom">
                <button className="seg-btn" disabled={zi === 0} onClick={() => setZi((z) => Math.max(0, z - 1))} title="Zoom out">−</button>
                <button className="seg-btn" onClick={() => { fitDone.current = true; const t = 900 / range.days; let b = 0; for (let i = 0; i < ZOOM.length; i++) if (Math.abs(ZOOM[i] - t) < Math.abs(ZOOM[b] - t)) b = i; setZi(b); }} title="Fit to width">Fit</button>
                <button className="seg-btn" disabled={zi === ZOOM.length - 1} onClick={() => setZi((z) => Math.min(ZOOM.length - 1, z + 1))} title="Zoom in">+</button>
              </div>
            )}
            {canEdit && acts.length > 0 && <button className="btn ghost" disabled={busy} onClick={autoTag} title="Match activities to bill lines from the cost sheet">Auto-tag from bill</button>}
            {canEdit && acts.length > 0 && <button className="btn ghost" disabled={busy} onClick={setBaseline}>Set baseline</button>}
            {progressBtn}
            {importBtn}
          </div>
        </div>

        {view === "gantt" && range && (
          <>
            <div className="gantt-scroll">
              <div className="gantt2" style={{ width: NAME_W + tlW }}>
                <div className="g2-row g2-head">
                  <div className="g2-name g2-corner" />
                  <div className="g2-time" style={{ width: tlW }}>
                    {months.map((m, i) => (
                      <div key={i} className="g2-month" style={{ left: m.left, width: m.width }}>{m.width > 42 ? m.label : ""}</div>
                    ))}
                  </div>
                </div>
                {acts.map((a) => {
                  const left = dayX(a.planned_start);
                  const end = dayX(a.planned_finish);
                  const w = left != null && end != null ? Math.max(end - left + pxPerDay, 5) : null;
                  const bl = dayX(a.baseline_start), bf = dayX(a.baseline_finish);
                  const baseShift = a.baseline_finish && a.planned_finish && a.baseline_finish !== a.planned_finish;
                  const pct = Math.round((a.pct_complete || 0) * 100);
                  return (
                    <div key={a.id} className={`g2-row${a.is_summary ? (a.level === 0 ? " g2-block" : " g2-section") : ""}`}>
                      <div className="g2-name" style={{ paddingLeft: 10 + a.level * 14 }} title={a.name}>
                        {!!a.is_summary && a.level > 0 && <span className="g2-caret">▸ </span>}{a.name}
                      </div>
                      <div className="g2-time" style={{ width: tlW }}>
                        {weeks.map((x, i) => <div key={i} className="g2-week" style={{ left: x }} />)}
                        {todayX != null && todayX >= 0 && todayX <= tlW && <div className="g2-today" style={{ left: todayX }} />}
                        {baseShift && bl != null && bf != null && (
                          <div className="g2-base" style={{ left: bl, width: Math.max(bf - bl + pxPerDay, 4) }} title={`Baseline: ${fmtDate(a.baseline_start)} → ${fmtDate(a.baseline_finish)}`} />
                        )}
                        {a.is_milestone && left != null ? (
                          <div className="g2-ms" style={{ left }} title={`◆ ${a.name} · ${fmtDate(a.planned_start)}`} />
                        ) : left != null && w != null ? (
                          <>
                            <div
                              className={`g2-bar${a.level === 0 ? " summary" : ""}`}
                              style={{ left, width: w }}
                              title={`${a.name}\n${fmtDate(a.planned_start)} → ${fmtDate(a.planned_finish)}${a.duration_days ? ` · ${a.duration_days}d` : ""} · ${pct}% complete`}
                            >
                              <div className="g2-fill" style={{ width: pct + "%" }} />
                            </div>
                            {pct > 0 && <div className="g2-pct" style={{ left: left + w + 6 }}>{pct}%</div>}
                          </>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="gantt-legend muted">
              <span><i className="lg-bar" /> Planned</span>
              <span><i className="lg-fill" /> Complete</span>
              <span><i className="lg-base" /> Baseline (moved)</span>
              <span><i className="lg-ms" /> Milestone</span>
              <span><i className="lg-today" /> Today</span>
              <span style={{ marginLeft: "auto" }}>Drag to scroll · use −/Fit/+ to zoom</span>
            </div>
          </>
        )}

        {view === "table" && (
          <div style={{ overflowX: "auto" }}>
            <table className="prog-table">
              <thead>
                <tr>
                  <th>Activity</th><th>Start</th><th>Finish</th><th className="num">Dur</th>
                  <th className="num">%</th><th className="num">Variance</th>
                  {canEdit && <th>Actual start</th>}{canEdit && <th>Actual finish</th>}
                </tr>
              </thead>
              <tbody>
                {acts.map((a) => {
                  const variance = diffDays(a.baseline_finish, a.actual_finish ?? a.planned_finish);
                  const isOpen = expanded.has(a.id);
                  const colCount = 6 + (canEdit ? 2 : 0);
                  const linked = items[a.id] ?? [];
                  return (
                    <Fragment key={a.id}>
                      {a.is_summary ? (
                        <tr className={a.level === 0 ? "prog-block" : "prog-section"}>
                          <td colSpan={colCount} style={{ paddingLeft: 10 + a.level * 16 }}>{a.name}</td>
                        </tr>
                      ) : (
                      <>
                      <tr>
                        <td style={{ paddingLeft: 10 + a.level * 16 }}>
                          <button className="prog-expand" onClick={() => toggleExpand(a.id)} title="Materials for this activity">{isOpen ? "▾" : "▸"}</button>
                          {!!a.is_milestone && <span title="Milestone">◆ </span>}{a.name}
                        </td>
                        <td>{fmtDate(a.planned_start)}</td>
                        <td>{fmtDate(a.planned_finish)}</td>
                        <td className="num">{a.duration_days ?? "—"}</td>
                        <td className="num">
                          {canEdit ? (
                            <input className="prog-pct" type="number" min={0} max={100} value={Math.round((a.pct_complete || 0) * 100)}
                              onChange={(e) => patch(a.id, { pct_complete: Math.max(0, Math.min(100, Number(e.target.value))) / 100 })} />
                          ) : `${Math.round((a.pct_complete || 0) * 100)}%`}
                        </td>
                        <td className="num" style={{ color: variance == null ? "var(--muted)" : variance > 0 ? "var(--danger)" : variance < 0 ? "var(--success)" : "var(--muted)" }}>
                          {variance == null ? "—" : variance === 0 ? "0" : `${variance > 0 ? "+" : ""}${variance}d`}
                        </td>
                        {canEdit && <td><input type="date" className="prog-date" value={a.actual_start ?? ""} onChange={(e) => patch(a.id, { actual_start: e.target.value || null })} /></td>}
                        {canEdit && <td><input type="date" className="prog-date" value={a.actual_finish ?? ""} onChange={(e) => patch(a.id, { actual_finish: e.target.value || null })} /></td>}
                      </tr>
                      {isOpen && (
                        <tr className="prog-items">
                          <td colSpan={colCount}>
                            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
                              Bill lines this installs{a.planned_start ? ` — needed by ${fmtDate(a.planned_start)}` : ""}
                            </div>
                            {linked.map((it) => (
                              <div className="pi-row" key={it.id}>
                                <span>{it.bill_name || it.description || "—"}</span>
                                <span className="muted">
                                  {it.bill_qty != null ? `${it.bill_qty}${it.bill_unit ? ` ${it.bill_unit}` : ""}` : ""}
                                  {it.component_count ? ` · ${it.component_count} materials` : ""}
                                </span>
                                {canEdit && <button className="pi-del" onClick={() => removeItem(a.id, it.id)}>Remove</button>}
                              </div>
                            ))}
                            {linked.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No bill lines linked yet — its materials won't appear in the Materials &amp; stock tab.</div>}
                            {canEdit && <AddItemRow bill={bill} onAdd={(cid) => addItem(a.id, cid)} />}
                          </td>
                        </tr>
                      )}
                      </>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {view === "stock" && (
          stock.length === 0 ? (
            <div className="empty in-card">
              {stockErr
                ? <p style={{ color: "var(--danger, #c0392b)" }}>Couldn't load Materials &amp; stock: {stockErr}</p>
                : <p>No materials in the pipeline yet.</p>}
              <p className="muted" style={{ maxWidth: 620, margin: "0 auto", textAlign: "center" }}>
                This is driven by the priced bill: upload the pricing workbook (cost sheet) in the <strong>Materials</strong> tab,
                then activities link to their bill lines automatically (or use <strong>Auto-tag from bill</strong> / the ▸ on
                each activity in the Table subtab). It then tracks every material's full flow — required, ordered on POs,
                delivered, installed and what's still to order — grouped by block across the whole site, each shortfall
                orderable in one click.
              </p>
            </div>
          ) : (() => {
            const rnd = (n: number) => Math.round(n * 100) / 100; // comma-free, for the Raise-PO qty param
            const q = (n: number) => (n ? fmtQty(n) : "—"); // blank zeros, thousands separators
            // Non-stock cost-sheet components (torch gas, labour, prelims, plant
            // hire, logistics, allowances) get pulled in as bill lines but aren't
            // orderable materials — keep them out of the stock list. Word-boundary
            // matched so real materials (e.g. "rainwater outlet") aren't caught.
            const NON_MATERIAL = /\b(gas|fuel|consumables?|labour|labor|daywork|prelim(?:s|inaries)?|p\s*&\s*g|welfare|supervision|management|overheads?|transport|carriage|haulage|freight|skips?|disposal|scaffold(?:ing)?|plant\s*hire|allowances?|sundr(?:y|ies)|wastage)\b/i;
            type Row = StockRow & {
              req: number; ord: number; del: number; inst: number; toOrder: number; remaining: number;
              ordSt: "ok" | "none" | "short"; ordLabel: string; siteLabel: string; showInst: boolean;
            };
            const allRows: Row[] = stock.map((s) => {
              const req = s.required_qty || 0, ord = s.on_order || 0, del = s.delivered || 0, inst = s.installed || 0;
              const toOrder = Math.max(req - ord, 0), remaining = Math.max(req - inst, 0);
              // Order traffic-light: green covered · amber part · red nothing ordered (most urgent).
              const ordSt: Row["ordSt"] = ord >= req && req > 0 ? "ok" : ord > 0 ? "none" : "short";
              const ordLabel = ordSt === "ok" ? "Fully ordered" : ordSt === "none" ? "Part ordered" : "Not ordered";
              // "Installed" is derived from the activity's % complete, so a barely-
              // started activity bleeds a misleading 1%-of-area figure in with
              // nothing on site. Only surface it once it's corroborated (something
              // delivered) or the activity is meaningfully under way (≥5%).
              const showInst = del > 0 || (req > 0 && inst / req >= 0.05);
              const siteLabel = req > 0 && inst >= req ? "Installed" : del > 0 ? "On site" : showInst ? "Installing" : "";
              return { ...s, req, ord, del, inst, toOrder, remaining, ordSt, ordLabel, siteLabel, showInst };
            });
            const nonMaterialCount = allRows.filter((r) => NON_MATERIAL.test(r.item)).length;
            const rows = allRows.filter((r) => !NON_MATERIAL.test(r.item));
            const filtered = rows.filter((r) => {
              switch (stockFilter) {
                case "toorder": return r.toOrder > 0;
                case "notordered": return r.ordSt === "short";
                case "partordered": return r.ordSt === "none";
                case "onsite": return r.del > 0 || r.inst > 0;
                case "installed": return r.req > 0 && r.inst >= r.req;
                default: return true;
              }
            });
            const cmp = (a: Row, b: Row) => {
              switch (stockSort) {
                case "name": return a.item.localeCompare(b.item);
                case "toorder": return b.toOrder - a.toOrder;
                case "required": return b.req - a.req;
                default: { const an = a.needed_by ?? "9999", bn = b.needed_by ?? "9999"; return an < bn ? -1 : an > bn ? 1 : b.toOrder - a.toOrder; }
              }
            };
            // Group by block (each block is its own project in the site group).
            const byBlock = new Map<string, { block: string; block_id: string; rows: Row[] }>();
            for (const r of filtered) {
              const key = r.block_id || "_";
              let g = byBlock.get(key);
              if (!g) { g = { block: r.block || "Unassigned", block_id: r.block_id, rows: [] }; byBlock.set(key, g); }
              g.rows.push(r);
            }
            const groups = [...byBlock.values()].sort((a, b) => a.block.localeCompare(b.block));
            for (const g of groups) g.rows.sort(cmp);
            const multiBlock = groups.length > 1;
            const colSpan = canEdit ? 10 : 9;
            return (
              <div style={{ overflowX: "auto" }}>
                <div className="stock-toolbar">
                  <div className="muted" style={{ fontSize: 12, maxWidth: 560 }}>
                    Required → ordered → delivered → installed, grouped by block. Installed is derived from each
                    activity's % complete (shown once under way); delivered is matched from site check-ins (approximate).
                    {nonMaterialCount > 0 && <> {nonMaterialCount} non-material line{nonMaterialCount === 1 ? "" : "s"} (gas, labour, prelims…) hidden.</>}
                  </div>
                  <div className="stock-controls">
                    <label>Show
                      <select value={stockFilter} onChange={(e) => setStockFilter(e.target.value as typeof stockFilter)}>
                        <option value="all">All materials</option>
                        <option value="toorder">Still to order</option>
                        <option value="notordered">Not ordered</option>
                        <option value="partordered">Part ordered</option>
                        <option value="onsite">On site / installing</option>
                        <option value="installed">Installed</option>
                      </select>
                    </label>
                    <label>Sort
                      <select value={stockSort} onChange={(e) => setStockSort(e.target.value as typeof stockSort)}>
                        <option value="urgent">Most urgent</option>
                        <option value="name">Material A–Z</option>
                        <option value="toorder">To order (high→low)</option>
                        <option value="required">Required (high→low)</option>
                      </select>
                    </label>
                  </div>
                </div>
                {filtered.length === 0 ? (
                  <div className="muted" style={{ fontSize: 13, padding: "12px 2px" }}>No materials match this filter.</div>
                ) : (
                  <table className="prog-table">
                    <thead><tr>
                      <th>Material</th><th>Needed by</th>
                      <th className="num">Required</th><th className="num">Ordered</th><th className="num">Delivered</th>
                      <th className="num">Installed</th><th className="num">Remaining</th><th className="num">To order</th>
                      <th>Status</th>{canEdit && <th />}
                    </tr></thead>
                    <tbody>
                      {groups.map((g) => (
                        <Fragment key={g.block_id || g.block}>
                          {multiBlock && (
                            <tr className="prog-block"><td colSpan={colSpan}>{g.block} · {g.rows.length} material{g.rows.length === 1 ? "" : "s"}</td></tr>
                          )}
                          {g.rows.map((r) => (
                            <tr key={g.block_id + r.item}>
                              <td>{r.item}{r.substituted_from ? <span className="muted" style={{ fontSize: 11, display: "block" }}>↔ substituted (was {r.substituted_from})</span> : null}</td>
                              <td>{r.needed_by ? fmtDate(r.needed_by) : "—"}</td>
                              <td className="num nowrap">{fmtQty(r.req)}{r.unit ? <span className="unit"> {r.unit}</span> : ""}</td>
                              <td className="num">{q(r.ord)}</td>
                              <td className="num">{q(r.del)}</td>
                              <td className="num">{r.showInst ? q(r.inst) : "—"}</td>
                              <td className="num">{q(r.showInst ? r.remaining : r.req)}</td>
                              <td className="num">{q(r.toOrder)}</td>
                              <td>
                                <span className={`stock-status ${r.ordSt}`}>{r.ordLabel}</span>
                                {r.siteLabel && <span className="stock-phase">{r.siteLabel}</span>}
                              </td>
                              {canEdit && <td>{r.toOrder > 0 && (
                                <Link className="btn ghost sm" to={`/projects/${r.block_id}/new-po?item=${encodeURIComponent(r.item)}&qty=${rnd(r.toOrder)}${r.unit ? `&unit=${encodeURIComponent(r.unit)}` : ""}`}>Raise PO</Link>
                              )}</td>}
                            </tr>
                          ))}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })()
        )}
      </div>
    </>
  );
}

function AddItemRow({ bill, onAdd }: { bill: BillItem[]; onAdd: (contractItemId: number) => void }) {
  const [cid, setCid] = useState("");
  // Bill lines that carry materials (measured + ancil); prelims have none.
  const pickable = bill.filter((b) => b.category !== "prelims");
  return (
    <div className="pi-add">
      <select value={cid} onChange={(e) => setCid(e.target.value)} style={{ maxWidth: 460 }}>
        <option value="">+ Add bill line…</option>
        {pickable.map((b) => (
          <option key={b.id} value={b.id}>{b.section ? `${b.section} · ` : ""}{b.description}{b.qty != null ? ` (${b.qty} ${b.unit ?? ""})` : ""}</option>
        ))}
      </select>
      <button className="btn" disabled={!cid} onClick={() => { onAdd(Number(cid)); setCid(""); }}>Add</button>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "default" | "success" | "danger" }) {
  return (
    <div className={`kpi${tone && tone !== "default" ? ` tone-${tone}` : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
    </div>
  );
}
