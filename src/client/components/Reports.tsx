import { useEffect, useRef, useState } from "react";
import { Topbar } from "./Shell";
import { api, fmtDate } from "../lib/api";
import { SiteReportDoc } from "./SiteReportDoc";
import { ReportDrawer } from "./ReportDrawer";
import { GroupedReports } from "./ReportsList";

type ReportRow = Awaited<ReturnType<typeof api.listSiteReports>>[number];
type FullReport = Awaited<ReturnType<typeof api.getSiteReport>>;
type Proj = Awaited<ReturnType<typeof api.listProjects>>[number];

const todayISO = () => new Date().toISOString().slice(0, 10);

/** A distribution-rule being created/edited in the modal. `content` picks what
 *  the rule sends: a site report, or the site's full H&S pack (weekly/monthly,
 *  with a weekday). One table, one toggle, one editor for both. */
type RuleDraft = {
  id?: number;
  project_id: string | null;
  content: "report" | "hs_pack";
  frequency: "daily" | "weekly" | "both" | "monthly";
  format: "pdf" | "link" | "pdf_link";
  recipients: string[];
  send_time: string;
  weekday: number;
  only_if: "always" | "skip_quiet";
  enabled: boolean;
  include_managers: boolean;
};

const safeEmails = (json: string): string[] => { try { const v = JSON.parse(json); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };

/** Compact relative time, e.g. "2h ago", "3d ago", "just now". */
function ago(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (isNaN(t)) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  return `${Math.round(d / 7)}w ago`;
}

/** Daily / weekly site reports built from field updates (WhatsApp, email, or
 *  manual). Generate on demand, view, export to PDF, email to managers. */
export function Reports() {
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [period, setPeriod] = useState<"all" | "daily" | "weekly">("all");
  const [projects, setProjects] = useState<Proj[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [genProject, setGenProject] = useState("");
  const [genPeriod, setGenPeriod] = useState<"daily" | "weekly">("daily");
  const [genDate, setGenDate] = useState(todayISO());
  const [waStatus, setWaStatus] = useState<Awaited<ReturnType<typeof api.whatsappStatus>>>([]);
  const [waOpen, setWaOpen] = useState(false);
  const [ueOpen, setUeOpen] = useState(false); // "Unfiled emails" collapsed by default
  // Connect-a-group: "all" = opened from the header; {code,name} = a row.
  const [connect, setConnect] = useState<null | "all" | { code: string; name: string }>(null);
  const [grp, setGrp] = useState<Awaited<ReturnType<typeof api.whatsappGroups>> | null>(null);
  const [grpLoading, setGrpLoading] = useState(false);
  const [linkBusy, setLinkBusy] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [viewId, setViewId] = useState<number | null>(null);

  // Auto-distribute rules + reports-list search / grouping / windowing state.
  const [rules, setRules] = useState<Awaited<ReturnType<typeof api.listDistributionRules>>>([]);
  const [adOpen, setAdOpen] = useState(false);
  const [editRule, setEditRule] = useState<RuleDraft | null>(null); // null = modal closed
  const [ruleBusy, setRuleBusy] = useState(false);
  const [emailDraft, setEmailDraft] = useState("");
  const [search, setSearch] = useState("");

  // Fetch the live WhatsApp group list whenever the Connect modal opens.
  useEffect(() => {
    if (connect === null) return;
    setGrp(null); setGrpLoading(true); setPick({});
    api.whatsappGroups()
      .then(setGrp)
      .catch(() => setGrp({ configured: false, connected: false, error: "request failed", groups: [] }))
      .finally(() => setGrpLoading(false));
  }, [connect]);

  async function linkGroup(g: NonNullable<typeof grp>["groups"][number]) {
    const projectId = g.suggested?.project_id || pick[g.chat_id];
    if (!projectId) return;
    setLinkBusy(g.chat_id);
    try {
      await api.linkWhatsappGroup({ chat_id: g.chat_id, group_name: g.name, project_id: projectId });
      setGrp((cur) => (cur ? { ...cur, groups: cur.groups.filter((x) => x.chat_id !== g.chat_id) } : cur));
      api.whatsappStatus().then(setWaStatus).catch(() => { /* keep stale on failure */ });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "couldn't link the group");
    } finally { setLinkBusy(null); }
  }

  // Unfiled project emails (no recognised project code) awaiting allocation.
  const [corr, setCorr] = useState<Awaited<ReturnType<typeof api.pendingCorrespondence>>>([]);
  const [corrPick, setCorrPick] = useState<Record<number, string>>({});
  const [corrBusy, setCorrBusy] = useState<number | null>(null);
  useEffect(() => { api.pendingCorrespondence().then(setCorr).catch(() => setCorr([])); }, []);
  async function allocateCorr(id: number) {
    const pid = corrPick[id]; if (!pid) return;
    setCorrBusy(id);
    try { await api.allocateCorrespondence(id, pid); setCorr((c) => c.filter((x) => x.id !== id)); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't file the email"); }
    finally { setCorrBusy(null); }
  }
  async function dismissCorr(id: number) {
    setCorrBusy(id);
    try { await api.dismissCorrespondence(id); setCorr((c) => c.filter((x) => x.id !== id)); }
    catch { /* ignore */ } finally { setCorrBusy(null); }
  }

  function refresh() {
    api.listSiteReports(period === "all" ? {} : { period }).then(setRows).catch(() => setRows([])).finally(() => setLoaded(true));
  }
  useEffect(refresh, [period]);
  useEffect(() => { api.listProjects().then(setProjects).catch(() => setProjects([])); }, []);
  useEffect(() => { api.whatsappStatus().then(setWaStatus).catch(() => setWaStatus([])); }, []);

  const waConnected = waStatus.filter((w) => w.connected).length;
  const genWa = genProject && genProject !== "__portfolio__" ? waStatus.find((w) => w.project_id === genProject) : undefined;

  async function generate() {
    if (!genProject) { setErr("Pick a project to generate a report for."); return; }
    setBusy(true); setErr(null); setNotice(null);
    try {
      const r = await api.generateSiteReport({ project_id: genProject, period_type: genPeriod, date: genDate });
      setViewId(r.id);
    } catch (e) { setErr(e instanceof Error ? e.message : "generation failed"); }
    finally { setBusy(false); }
  }
  function open(id: number) { setViewId(id); }

  // ── Auto-distribute rules ──────────────────────────────────────────────────
  function reloadRules() { api.listDistributionRules().then(setRules).catch(() => setRules([])); }
  useEffect(reloadRules, []);
  function newRule() { setEmailDraft(""); setEditRule({ project_id: null, content: "report", frequency: "daily", format: "pdf_link", recipients: [], send_time: "07:30", weekday: 1, only_if: "always", enabled: true, include_managers: false }); }
  function openRule(r: (typeof rules)[number]) {
    setEmailDraft("");
    setEditRule({ id: r.id, project_id: r.project_id, content: r.content ?? "report", frequency: r.frequency, format: r.format, recipients: safeEmails(r.recipients), send_time: r.send_time ?? "07:30", weekday: r.weekday ?? 1, only_if: r.only_if, enabled: r.enabled === 1, include_managers: r.include_managers === 1 });
  }
  /** Flip the draft between kinds, coercing fields the other kind can't hold. */
  function setDraftContent(content: RuleDraft["content"]) {
    setEditRule((d) => d && ({
      ...d, content,
      frequency: content === "hs_pack"
        ? (d.frequency === "monthly" ? "monthly" : "weekly")
        : (d.frequency === "monthly" ? "weekly" : d.frequency),
      send_time: content === "hs_pack" ? "07:00" : d.send_time,
    }));
  }
  function addEmail() {
    if (!editRule) return;
    const e = emailDraft.trim().replace(/[,;]+$/, "");
    if (!e || !e.includes("@")) { setEmailDraft(""); return; }
    if (!editRule.recipients.includes(e)) setEditRule({ ...editRule, recipients: [...editRule.recipients, e] });
    setEmailDraft("");
  }
  async function saveRule() {
    if (!editRule) return;
    const recipients = editRule.recipients.slice();
    const draftEmail = emailDraft.trim().replace(/[,;]+$/, "");
    if (draftEmail.includes("@") && !recipients.includes(draftEmail)) recipients.push(draftEmail);
    if (recipients.length === 0 && !editRule.include_managers) { setErr("Add at least one recipient email, or tick “send to this project's managers”."); return; }
    if (editRule.content === "hs_pack" && !editRule.project_id) { setErr("An H&S pack rule needs a project — packs are per-site."); return; }
    setRuleBusy(true); setErr(null);
    const isNew = !editRule.id;
    try {
      await api.saveDistributionRule({ id: editRule.id, project_id: editRule.project_id, content: editRule.content, frequency: editRule.frequency, format: editRule.format, recipients, send_time: editRule.send_time, weekday: editRule.weekday, only_if: editRule.only_if, enabled: editRule.enabled, include_managers: editRule.include_managers });
      setEditRule(null); setEmailDraft(""); reloadRules();
      setNotice(isNew
        ? (editRule.content === "hs_pack" ? "H&S pack release scheduled." : "Distribution rule created — matching reports will auto-send when generated.")
        : "Distribution rule updated.");
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't save the rule"); }
    finally { setRuleBusy(false); }
  }
  async function removeRule() {
    if (!editRule?.id) { setEditRule(null); return; }
    setRuleBusy(true);
    try { await api.deleteDistributionRule(editRule.id); setEditRule(null); reloadRules(); setNotice("Distribution rule deleted."); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't delete the rule"); }
    finally { setRuleBusy(false); }
  }
  async function toggleRule(r: (typeof rules)[number]) {
    // content + weekday must round-trip: the PUT rewrites every column, so
    // omitting them would quietly turn an H&S pack rule back into a report rule.
    try { await api.saveDistributionRule({ id: r.id, project_id: r.project_id, content: r.content ?? "report", frequency: r.frequency, format: r.format, recipients: safeEmails(r.recipients), send_time: r.send_time ?? "07:30", weekday: r.weekday ?? 1, only_if: r.only_if, enabled: r.enabled !== 1, include_managers: r.include_managers === 1 }); reloadRules(); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't update the rule"); }
  }

  // Row selection → accent bulk bar (export / share).
  const [selected, setSelected] = useState<Set<number>>(new Set());
  useEffect(() => { setSelected(new Set()); }, [period]);
  function toggleOne(id: number) { setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  const onToggleGroup = (ids: number[]) => setSelected((s) => { const n = new Set(s); const all = ids.every((id) => n.has(id)); for (const id of ids) all ? n.delete(id) : n.add(id); return n; });
  // Condensed download filename, e.g. "26002 Daily report 21 Jun 2026".
  const reportFileName = (r: { period_type: string; project_id: string | null; project_code: string | null; period_start: string }) =>
    `${r.project_id ? (r.project_code ?? "Project") : "Portfolio"} ${r.period_type === "daily" ? "Daily" : "Weekly"} report ${fmtDate(r.period_start)}`;
  // Bulk "Export PDF" = print-to-PDF of the SAME report document(s) shown on
  // screen, so every export matches the live report exactly (rounded cards, PGP
  // palette, Cambria/Inter). Selecting several prints them as one combined PDF,
  // each report starting on a new page — browsers can't save N separately-named
  // files from one print, and a combined PDF reads better than N attachments.
  const [printReports, setPrintReports] = useState<FullReport[] | null>(null);
  const printRootRef = useRef<HTMLDivElement>(null);
  const prevTitle = useRef("");
  async function bulkPdf() {
    setBusy(true); setErr(null);
    try {
      const ids = rows.filter((r) => selected.has(r.id)).map((r) => r.id); // keep table order
      const reports = await Promise.all(ids.map((id) => api.getSiteReport(id)));
      setPrintReports(reports);
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't load reports for export"); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!printReports) return;
    let cancelled = false;
    (async () => {
      // Wait for report photos to load so they aren't blank in the PDF (cap 3s).
      const imgs = Array.from(printRootRef.current?.querySelectorAll("img") ?? []);
      await Promise.race([
        Promise.all(imgs.map((im) => im.complete ? null : new Promise<void>((res) => { im.onload = im.onerror = () => res(); }))),
        new Promise<void>((res) => setTimeout(res, 3000)),
      ]);
      if (cancelled) return;
      prevTitle.current = document.title;
      document.title = printReports.length === 1
        ? reportFileName(printReports[0]).replace(/[^\w.\- ·]+/g, "")
        : `Site reports (${printReports.length})`;
      document.body.classList.add("rd-bulk-printing");
      window.print();
      setTimeout(() => { document.body.classList.remove("rd-bulk-printing"); document.title = prevTitle.current; setPrintReports(null); }, 500);
    })();
    return () => { cancelled = true; };
  }, [printReports]);
  function bulkCsv() {
    const sel2 = rows.filter((r) => selected.has(r.id));
    const esc = (s: string) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const head = ["Period", "Project code", "Project", "Start", "End", "Updates", "Status", "Generated"];
    const body = sel2.map((r) => [r.period_type, r.project_code ?? "", r.project_name ?? "Portfolio", r.period_start, r.period_end, String(r.update_count), r.update_count === 0 ? "No updates" : "Generated", r.generated_at].map(esc).join(","));
    const url = URL.createObjectURL(new Blob([[head.map(esc).join(","), ...body].join("\n")], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = "site-reports.csv"; a.click(); URL.revokeObjectURL(url);
  }
  async function bulkShare() {
    setBusy(true); setErr(null); setNotice(null);
    let sent = 0, failed = 0;
    for (const id of selected) { try { await api.sendSiteReport(id); sent++; } catch { failed++; } }
    setBusy(false); setSelected(new Set()); refresh();
    setNotice(`Emailed ${sent} report${sent === 1 ? "" : "s"}${failed ? ` · ${failed} couldn't send (check manager emails)` : ""}.`);
  }

  // Project search → the grouped list (collapse + windowing) lives in <GroupedReports>.
  const filtered = search.trim()
    ? rows.filter((r) => {
        const q = search.trim().toLowerCase();
        return (r.project_code ?? "").toLowerCase().includes(q)
          || (r.project_name ?? "").toLowerCase().includes(q)
          || (!r.project_id && "portfolio roll-up".includes(q));
      })
    : rows;

  return (
    <>
      <Topbar crumbs="Workspace" title="Reports" />
      <ReportDrawer reportId={viewId} onClose={() => setViewId(null)} onEmailed={() => api.listSiteReports(period === "all" ? {} : { period }).then(setRows).catch(() => {})} />
      <main>
        {err && <div className="flash error">{err}</div>}
        {notice && <div className="flash info">{notice}</div>}

        <div className="card">
          <div className="card-hd"><h2>Generate a report</h2></div>
          <div className="card-bd" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="field"><span>Project</span>
              <select value={genProject} onChange={(e) => setGenProject(e.target.value)}>
                <option value="">Select…</option>
                <option value="__portfolio__">Portfolio rollup — all sites</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Period</span>
              <select value={genPeriod} onChange={(e) => setGenPeriod(e.target.value as "daily" | "weekly")}>
                <option value="daily">Daily</option><option value="weekly">Weekly</option>
              </select>
            </label>
            <label className="field"><span>Date in period</span>
              <input type="date" value={genDate} onChange={(e) => setGenDate(e.target.value)} />
            </label>
            <div className="field" style={{ flexGrow: 0, marginBottom: 6 }}>
              <span aria-hidden="true">&nbsp;</span>
              <button className="btn" disabled={busy} onClick={generate} style={{ minHeight: 37 }}>{busy ? "Working…" : "Generate"}</button>
            </div>
          </div>
          {genWa && (
            <div style={{ padding: "0 16px 4px", fontSize: 12.5 }}>
              {genWa.connected
                ? <span style={{ color: "var(--success, #1a7f4b)" }}>● WhatsApp chat connected{genWa.group_name ? ` — “${genWa.group_name}”` : ""}{genWa.last_at ? ` · last message ${ago(genWa.last_at)}` : ""}.</span>
                : <span className="muted">○ No WhatsApp chat found for this project yet — messages auto-match when the chat name contains the project code. Log updates manually until then.</span>}
            </div>
          )}
          <div style={{ margin: "4px 16px 0", padding: "10px 12px", background: "var(--accent-soft)", border: "1px solid var(--line)", borderRadius: 10, fontSize: 13 }}>
            ✉️ <strong>Forward (or CC) any project email to <a href="mailto:projects@pgpprojects.com" style={{ color: "var(--accent-2)" }}>projects@pgpprojects.com</a></strong> — it's filed to the project automatically (matched by the project code in the subject or body) and folded into that project's daily &amp; weekly reports. <span className="muted">Keep it under 25&nbsp;MB including attachments — bigger emails bounce before they reach us, so trim heavy photo sets or send a link instead.</span>
          </div>
          <div className="muted" style={{ fontSize: 12, padding: "8px 16px 14px" }}>
            Reports summarise the field updates logged for the project that day/week. Pick <strong>Portfolio rollup</strong> to
            combine every active site into one report. Daily reports run automatically each
            morning and weekly reports on Mondays; this button regenerates on demand. WhatsApp chatter and forwarded
            emails flow in by themselves — until then you can log updates manually on a project.
          </div>
        </div>

        {corr.length > 0 && (
          <div className="card">
            <div className="card-hd">
              <button className="linklike rep-collapse" onClick={() => setUeOpen((o) => !o)} title={ueOpen ? "Collapse" : "Expand"} aria-label={ueOpen ? "Collapse" : "Expand"}>{ueOpen ? "▾" : "▸"}</button>
              <h2>Unfiled emails</h2>
              <span className="pill warn dot">{corr.length}</span>
            </div>
            {ueOpen && (
              <>
                <p className="muted" style={{ margin: 0, padding: "12px 20px 0", fontSize: 12.5, lineHeight: 1.5 }}>
                  Project emails to <strong>projects@pgpprojects.com</strong> that didn't carry a recognised project code. Pick the project to file each into its reports, or dismiss.
                </p>
                <div style={{ overflowX: "auto", padding: "8px 0 4px" }}>
                  <table className="rep-table">
                    <thead><tr><th>From</th><th>Subject</th><th>Received</th><th>Project</th><th></th></tr></thead>
                    <tbody>
                      {corr.map((m) => (
                        <tr key={m.id}>
                          <td className="muted" style={{ whiteSpace: "nowrap" }}>{m.sender}</td>
                          <td>{m.subject}</td>
                          <td className="muted" style={{ whiteSpace: "nowrap" }}>{ago(m.received_at)}</td>
                          <td>
                            <select value={corrPick[m.id] ?? ""} onChange={(e) => setCorrPick((p) => ({ ...p, [m.id]: e.target.value }))} style={{ maxWidth: 180 }}>
                              <option value="">Choose…</option>
                              {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
                            </select>
                          </td>
                          <td className="num" style={{ whiteSpace: "nowrap" }}>
                            <button className="btn" disabled={corrBusy === m.id || !corrPick[m.id]} onClick={() => allocateCorr(m.id)}>{corrBusy === m.id ? "…" : "File"}</button>{" "}
                            <button className="linklike" onClick={() => dismissCorr(m.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontWeight: 600, fontSize: 12.5, padding: 0 }}>Dismiss</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {waStatus.length > 0 && (
          <div className="card">
            <div className="card-hd">
              <button className="linklike" onClick={() => setWaOpen((o) => !o)} title={waOpen ? "Collapse" : "Expand"} aria-label={waOpen ? "Collapse" : "Expand"} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-2)", fontSize: 22, lineHeight: 1, padding: "0 4px 0 0", marginRight: 2 }}>{waOpen ? "▾" : "▸"}</button>
              <h2>WhatsApp feeds</h2>
              <span className={`pill dot ${waConnected > 0 ? "ok" : "neutral"}`}>{waConnected} of {waStatus.length} connected</span>
              <span className="grow" />
              <button className="linklike" onClick={() => setConnect("all")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontWeight: 600, fontSize: 13, padding: 0 }}>+ Connect a group</button>
            </div>
            {waOpen && (
              <>
                <p className="muted" style={{ margin: 0, padding: "12px 20px 0", fontSize: 12.5, lineHeight: 1.5 }}>
                  Updates flow in by <strong>WhatsApp</strong> and <strong>email</strong>. Email always works; a project's <strong>WhatsApp group</strong> needs connecting once.
                </p>
                <div style={{ overflowX: "auto", padding: "8px 0 4px" }}>
                  <table className="rep-table">
                    <thead><tr>
                      <th>Project</th><th>WhatsApp</th><th>Group</th>
                      <th className="num">WhatsApp</th><th className="num">Email</th>
                      <th>Last message</th><th className="num">Updates</th><th></th>
                    </tr></thead>
                    <tbody>
                      {waStatus.map((w) => (
                        <tr key={w.project_id}>
                          <td><strong>{w.code}</strong> <span className="muted">{w.name}</span></td>
                          <td>{w.connected ? <span className="stock-status ok">Connected</span> : <span className="stock-status none">Not connected</span>}</td>
                          <td className="muted">{w.group_name || "—"}</td>
                          <td className="num">{w.connected ? w.wa_count : <span className="muted">—</span>}</td>
                          <td className="num">{w.email_count > 0 ? w.email_count : <span className="muted">0</span>}</td>
                          <td className="muted">{ago(w.last_at)}</td>
                          <td className="num"><strong>{w.updates}</strong></td>
                          <td className="num">{!w.connected && (
                            <button className="linklike" onClick={() => setConnect({ code: w.code, name: w.name })} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontWeight: 600, fontSize: 12.5, padding: 0 }}>Connect</button>
                          )}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        <div className="card">
          <div className="card-hd">
            <button className="linklike rep-collapse" onClick={() => setAdOpen((o) => !o)} title={adOpen ? "Collapse" : "Expand"} aria-label={adOpen ? "Collapse" : "Expand"}>{adOpen ? "▾" : "▸"}</button>
            <h2>Auto-distribute</h2>
            <span className={`pill dot ${rules.some((r) => r.enabled === 1) ? "ok" : "neutral"}`}>{rules.filter((r) => r.enabled === 1).length} active</span>
            <span className="grow" />
            <button className="linklike rep-add" onClick={newRule} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontWeight: 600, fontSize: 13, padding: 0 }}>+ New rule</button>
          </div>
          {adOpen && (
            <>
              <p className="muted" style={{ margin: 0, padding: "12px 20px 0", fontSize: 12.5, lineHeight: 1.5 }}>
                Email each report to clients or the wider team the moment it's generated. Rules ride along with the
                automatic <strong>daily</strong> &amp; <strong>weekly</strong> jobs — no manual send needed.
              </p>
              {rules.length === 0 ? (
                <div className="empty in-card"><p className="muted" style={{ maxWidth: 460, margin: "0 auto" }}>No distribution rules yet. Add one to auto-email a project's (or the portfolio's) reports to a fixed set of recipients.</p></div>
              ) : (
                <div style={{ overflowX: "auto", padding: "8px 0 4px" }}>
                  <table className="rep-table">
                    <thead><tr><th>Report</th><th>When</th><th>Recipients</th><th>Active</th><th></th></tr></thead>
                    <tbody>
                      {rules.map((r) => {
                        const emails = safeEmails(r.recipients);
                        const isHs = r.content === "hs_pack";
                        const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
                        return (
                          <tr key={r.id} className="rep-row">
                            <td onClick={() => openRule(r)}>
                              {isHs && <span className="stock-status warn" style={{ marginRight: 6 }}>H&amp;S pack</span>}
                              {r.project_id ? <><strong>{r.project_code}</strong> <span className="muted">{r.project_name}</span></> : <em>Portfolio roll-up</em>}
                            </td>
                            <td onClick={() => openRule(r)}>
                              {isHs ? (
                                <>
                                  <span className={`per ${r.frequency === "monthly" ? "weekly" : "daily"}`}>{r.frequency === "monthly" ? "monthly (1st)" : "weekly"}</span>
                                  <span className="muted" style={{ marginLeft: 6, fontSize: 11.5 }}>
                                    {r.frequency === "weekly" && `· ${days[(r.weekday ?? 1) - 1]} `}· {(r.send_time ?? "07:00").slice(0, 5)}
                                  </span>
                                  {r.last_sent_at && <span className="muted" style={{ marginLeft: 6, fontSize: 11.5 }}>· sent {ago(r.last_sent_at)}</span>}
                                </>
                              ) : (
                                <>
                                  <span className={`per ${r.frequency === "weekly" ? "weekly" : "daily"}`}>{r.frequency === "both" ? "daily + weekly" : r.frequency}</span>
                                  {r.send_time && <span className="muted" style={{ marginLeft: 6, fontSize: 11.5 }}>· {r.send_time}</span>}
                                  {r.only_if === "skip_quiet" && <span className="muted" style={{ marginLeft: 6, fontSize: 11.5 }}>· skips quiet days</span>}
                                </>
                              )}
                            </td>
                            <td onClick={() => openRule(r)} className="muted">
                              {r.include_managers === 1 && <span className="stock-status ok" style={{ marginRight: 6 }}>Managers</span>}
                              {emails.length === 0 ? (r.include_managers === 1 ? "" : "—") : emails.length === 1 ? emails[0] : `${emails[0]} +${emails.length - 1}`}
                            </td>
                            <td><button className={`mini-toggle${r.enabled === 1 ? " on" : ""}`} onClick={() => toggleRule(r)} aria-label={r.enabled === 1 ? "Disable rule" : "Enable rule"}><span /></button></td>
                            <td className="num"><button className="linklike" onClick={() => openRule(r)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontWeight: 600, fontSize: 12.5, padding: 0 }}>Edit</button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        <div className="card">
          <div className="card-hd">
            <h2>Reports</h2>
            <span className="pill">{filtered.length}</span>
            <span className="grow" />
            <input className="rep-search" type="search" placeholder="Search project…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search reports by project" />
            <div className="seg2" role="group" aria-label="Period">
              <button className={period === "all" ? "on" : ""} onClick={() => setPeriod("all")}>All</button>
              <button className={period === "daily" ? "on" : ""} onClick={() => setPeriod("daily")}>Daily</button>
              <button className={period === "weekly" ? "on" : ""} onClick={() => setPeriod("weekly")}>Weekly</button>
            </div>
          </div>
          {selected.size > 0 && (
            <div style={{ padding: "12px 20px 0" }}>
              <div className="bulkbar">
                <span><span className="n">{selected.size}</span> selected</span>
                <span className="grow" />
                <button className="bbtn" disabled={busy} onClick={bulkPdf}>↓ Export PDF</button>
                <button className="bbtn" onClick={bulkCsv}>⤓ Export CSV</button>
                <button className="bbtn accent" disabled={busy} onClick={bulkShare}>⤢ Share</button>
                <span className="bulk-x" onClick={() => setSelected(new Set())}>✕ Clear</span>
              </div>
            </div>
          )}
          {loaded && rows.length === 0 ? (
            <div className="empty in-card">
              <p>No reports yet.</p>
              <p className="muted" style={{ maxWidth: 560 }}>
                Generate one above, or connect WhatsApp so each project group's daily chatter flows in and the
                daily/weekly reports build themselves.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty in-card"><p className="muted">No reports match “{search}”.</p></div>
          ) : (
            <GroupedReports rows={filtered} selected={selected} onToggleOne={toggleOne} onToggleGroup={onToggleGroup} onOpen={open} newestOpen resetKey={`${period}|${search}`} />
          )}
        </div>
      </main>

      {connect !== null && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,17,48,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={() => setConnect(null)}>
          <div className="card" style={{ maxWidth: 600, width: "calc(100% - 32px)", maxHeight: "calc(100vh - 64px)", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div className="card-hd">
              <h3 style={{ flex: 1 }}>Connect a WhatsApp group</h3>
              {grp && (grp.configured
                ? <span className={`pill dot ${grp.connected ? "ok" : "warn"}`}>{grp.connected ? "Whapi connected" : "Whapi error"}</span>
                : <span className="pill neutral">Whapi not connected</span>)}
              <button onClick={() => setConnect(null)} title="Close" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 18, padding: 0 }}>✕</button>
            </div>
            <div className="card-bd">
              <p className="muted" style={{ marginTop: 0, fontSize: 13, lineHeight: 1.5 }}>
                New groups are detected automatically when the chat name starts with a project code. Confirm the match to start feeding that project's reports.
              </p>
              {connect !== "all" && (
                <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Connecting a group for <strong>{connect.code} {connect.name}</strong>.</div>
              )}

              {grpLoading && <div className="muted" style={{ fontSize: 13, padding: "8px 0" }}>Loading groups…</div>}

              {grp && !grpLoading && !grp.configured && (
                <div className="flash info" style={{ fontSize: 13 }}>
                  Live group detection isn't switched on yet. For now, name the WhatsApp group so it <strong>starts with the project code</strong> (e.g. <em>“{connect !== "all" ? connect.code : "26001"} …”</em>) — it connects automatically on the first message.
                </div>
              )}
              {grp && !grpLoading && grp.configured && grp.error && (
                <div className="flash error" style={{ fontSize: 13 }}>Couldn't reach WhatsApp: {grp.error}</div>
              )}
              {grp && !grpLoading && grp.configured && !grp.error && grp.groups.length === 0 && (
                <div className="flash success" style={{ fontSize: 13 }}>No new groups to connect — every group is already linked.</div>
              )}

              {grp && !grpLoading && grp.groups.map((g) => (
                <div key={g.chat_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderTop: "1px solid var(--line)" }}>
                  <span aria-hidden style={{ fontSize: 16 }}>💬</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name || "(unnamed group)"}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{g.members != null ? `${g.members} members` : "group"}{g.last_at ? ` · last message ${ago(g.last_at)}` : ""}</div>
                  </div>
                  {g.suggested
                    ? <span className="pill ok" style={{ whiteSpace: "nowrap" }}>→ {g.suggested.code} {g.suggested.name}</span>
                    : <select value={pick[g.chat_id] ?? ""} onChange={(e) => setPick((p) => ({ ...p, [g.chat_id]: e.target.value }))} style={{ maxWidth: 170 }}>
                        <option value="">Choose project…</option>
                        {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
                      </select>}
                  <button className="btn" disabled={linkBusy === g.chat_id || (!g.suggested && !pick[g.chat_id])} onClick={() => linkGroup(g)}>{linkBusy === g.chat_id ? "Linking…" : "Link"}</button>
                </div>
              ))}

              <p className="muted" style={{ fontSize: 12, margin: "12px 0 0" }}>
                A group whose code matches an existing project links to it. Don't recognise one? Check the project code at the start of the chat name.
              </p>
            </div>
            <div className="card-bd" style={{ borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
              <span className="muted" style={{ fontSize: 12, flex: 1 }}>{grp && grp.configured && !grp.error ? `${grp.groups.length} new group${grp.groups.length === 1 ? "" : "s"} detected` : ""}</span>
              <button className="ghost" onClick={() => setConnect(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {editRule && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,17,48,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={() => setEditRule(null)}>
          <div className="card" style={{ maxWidth: 540, width: "calc(100% - 32px)", maxHeight: "calc(100vh - 64px)", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div className="card-hd">
              <h3 style={{ flex: 1 }}>{editRule.id ? (editRule.content === "hs_pack" ? "Edit H&S pack release" : "Edit distribution rule") : "New distribution rule"}</h3>
              <button onClick={() => setEditRule(null)} title="Close" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 18, padding: 0 }}>✕</button>
            </div>
            <div className="card-bd" style={{ display: "grid", gap: 12 }}>
              {!editRule.id && (
                <div className="field"><span>What to send</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    {([["report", "Site report"], ["hs_pack", "H&S pack"]] as const).map(([val, label]) => (
                      <button key={val} type="button" className={editRule.content === val ? "btn" : "btn ghost"} style={{ flex: 1 }} onClick={() => setDraftContent(val)}>{label}</button>
                    ))}
                  </div>
                  {editRule.content === "hs_pack" && <span className="muted" style={{ fontSize: 11.5, marginTop: 4, display: "block" }}>Signed-attendance H&amp;S pack for one site — RAMS &amp; toolbox talk registers, signatures, sign-in records.</span>}
                </div>
              )}
              <label className="field"><span>Project</span>
                <select value={editRule.project_id ?? "__portfolio__"} onChange={(e) => setEditRule({ ...editRule, project_id: e.target.value === "__portfolio__" ? null : e.target.value })}>
                  {editRule.content !== "hs_pack" && <option value="__portfolio__">Portfolio roll-up — all sites</option>}
                  {editRule.content === "hs_pack" && !editRule.project_id && <option value="__portfolio__">Choose a site…</option>}
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
                </select>
              </label>
              {editRule.content === "hs_pack" ? (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <label className="field" style={{ flex: 1, minWidth: 140 }}><span>Release</span>
                    <select value={editRule.frequency === "monthly" ? "monthly" : "weekly"} onChange={(e) => setEditRule({ ...editRule, frequency: e.target.value as RuleDraft["frequency"] })}>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly (1st, previous month)</option>
                    </select>
                  </label>
                  {editRule.frequency !== "monthly" && (
                    <label className="field" style={{ flex: 1, minWidth: 130 }}><span>On</span>
                      <select value={editRule.weekday} onChange={(e) => setEditRule({ ...editRule, weekday: Number(e.target.value) })}>
                        {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
                      </select>
                    </label>
                  )}
                </div>
              ) : (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <label className="field" style={{ flex: 1, minWidth: 150 }}><span>Report type</span>
                    <select value={editRule.frequency} onChange={(e) => setEditRule({ ...editRule, frequency: e.target.value as RuleDraft["frequency"] })}>
                      <option value="daily">Daily report</option>
                      <option value="weekly">Weekly report</option>
                      <option value="both">Daily &amp; weekly</option>
                    </select>
                  </label>
                  <label className="field" style={{ flex: 1, minWidth: 150 }}><span>Only if</span>
                    <select value={editRule.only_if} onChange={(e) => setEditRule({ ...editRule, only_if: e.target.value as RuleDraft["only_if"] })}>
                      <option value="always">Always send</option>
                      <option value="skip_quiet">Skip “no updates” days</option>
                    </select>
                  </label>
                </div>
              )}
              <div className="field">
                <span>Send to{editRule.recipients.length > 0 && <span className="muted" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}> · {editRule.recipients.length} recipient{editRule.recipients.length === 1 ? "" : "s"}</span>}</span>
                <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
                  <div className="chip-input" style={{ flex: 1 }} onClick={() => document.getElementById("rule-email-input")?.focus()}>
                    {editRule.recipients.map((e) => (
                      <span key={e} className="chip">{e}<button onClick={(ev) => { ev.stopPropagation(); setEditRule({ ...editRule, recipients: editRule.recipients.filter((x) => x !== e) }); }} aria-label={`Remove ${e}`}>×</button></span>
                    ))}
                    <input id="rule-email-input" type="email" value={emailDraft} placeholder={editRule.recipients.length ? "Add another…" : "name@client.com"}
                      onChange={(e) => setEmailDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === "," || e.key === ";") { e.preventDefault(); addEmail(); } else if (e.key === "Backspace" && !emailDraft && editRule.recipients.length) { setEditRule({ ...editRule, recipients: editRule.recipients.slice(0, -1) }); } }} />
                  </div>
                  <button type="button" className="btn ghost" onClick={addEmail} disabled={!emailDraft.includes("@")} style={{ whiteSpace: "nowrap" }}>+ Add</button>
                </div>
                <span className="muted" style={{ fontSize: 11.5, marginTop: 4, display: "block" }}>Add as many as you like — press Enter, comma, or “Add” after each.</span>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, cursor: editRule.project_id ? "pointer" : "default", opacity: editRule.project_id ? 1 : 0.55 }}>
                <input type="checkbox" checked={editRule.include_managers} disabled={!editRule.project_id} onChange={(e) => setEditRule({ ...editRule, include_managers: e.target.checked })} />
                Also send to this project's managers (PM, site &amp; commercial){!editRule.project_id && <span className="muted" style={{ fontSize: 11.5 }}> · pick a project first</span>}
              </label>
              <div style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
                <label className="field" style={{ minWidth: 130 }}><span>Send time</span>
                  <input type="time" value={editRule.send_time} onChange={(e) => setEditRule({ ...editRule, send_time: e.target.value })} />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, cursor: "pointer", paddingBottom: 8 }}>
                  <input type="checkbox" checked={editRule.enabled} onChange={(e) => setEditRule({ ...editRule, enabled: e.target.checked })} />
                  Rule active
                </label>
              </div>
            </div>
            <div className="card-bd" style={{ borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
              {editRule.id ? <button className="linklike" onClick={removeRule} disabled={ruleBusy} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--danger, #c0392b)", fontWeight: 600, fontSize: 13, padding: 0 }}>Delete rule</button> : <span />}
              <span className="grow" />
              <button className="ghost" onClick={() => setEditRule(null)} disabled={ruleBusy}>Cancel</button>
              <button className="btn" onClick={saveRule} disabled={ruleBusy}>{ruleBusy ? "Saving…" : editRule.id ? "Save changes" : "Create rule"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Off-screen render of the selected report document(s) for print-to-PDF.
          Hidden on screen; revealed only while body.rd-bulk-printing is set. */}
      {printReports && (
        <div className="rd-printroot" ref={printRootRef} aria-hidden>
          {printReports.map((r) => <SiteReportDoc key={r.id} report={r} onEmail={() => {}} onClose={() => {}} />)}
        </div>
      )}
    </>
  );
}
