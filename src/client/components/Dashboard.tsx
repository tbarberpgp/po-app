import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bar as RBar, ComposedChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer, Cell, Legend, CartesianGrid } from "recharts";
import { api, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import { DrillPanel, type DrillData } from "./DrillPanel";
import type { CurrentUser } from "../../shared/types";

type Report = Awaited<ReturnType<typeof api.reportDashboard>>;
type ProjectOpt = Awaited<ReturnType<typeof api.listProjects>>[number];
const MONTH_OPTIONS = [3, 6, 12, 24];

const money = (n: number) => fmtMoney(n);
/** Compact money for dense table cells: £229k / £1.2M. */
const moneyK = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `£${(n / 1_000_000).toFixed(2).replace(/\.00$/, "")}M`;
  if (a >= 1_000) return `£${Math.round(n / 1000)}k`;
  return money(n);
};
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const gp = (frac: number | null) => (frac == null ? "—" : `${(frac * 100).toFixed(1)}%`);

export function Dashboard(_props: { me: CurrentUser | null }) {
  const [d, setD] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectOpt[]>([]);
  const [projectId, setProjectId] = useState("");   // "" = all projects
  const [months, setMonths] = useState(6);
  const [loading, setLoading] = useState(false);

  useEffect(() => { api.listProjects().then(setProjects).catch(() => {}); }, []);

  useEffect(() => {
    setLoading(true);
    api.reportDashboard({ project_id: projectId || undefined, months })
      .then((r) => { setD(r); setErr(null); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [projectId, months]);

  const selectedProject = projects.find((p) => p.id === projectId) ?? null;
  const scopeLabel = selectedProject ? `${selectedProject.code} — ${selectedProject.name}` : "All projects";

  return (
    <>
      <Topbar
        crumbs="Reporting"
        title="Dashboard"
        actions={
          <div className="row no-print" style={{ gap: 8 }}>
            <button className="ghost" onClick={() => d && downloadCsv(d, scopeLabel, months)} disabled={!d}>Export CSV</button>
            <button className="ghost" onClick={() => window.print()} disabled={!d}>Print / PDF</button>
          </div>
        }
      />
      <main>
        <div className="dash-filters no-print">
          <label className="dash-filter">
            <span>Project</span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">All active projects</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
            </select>
          </label>
          <label className="dash-filter">
            <span>Period</span>
            <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
              {MONTH_OPTIONS.map((m) => <option key={m} value={m}>Last {m} months</option>)}
            </select>
          </label>
          {projectId && (
            <button className="ghost tiny" onClick={() => setProjectId("")}>Clear filter</button>
          )}
          {loading && <span className="muted" style={{ fontSize: 12 }}>Updating…</span>}
        </div>

        {/* Print-only scope header (hidden on screen). */}
        <div className="print-only print-head">
          <strong>PGP Dashboard</strong> — {scopeLabel} · last {months} months · {new Date().toLocaleDateString("en-GB")}
        </div>

        {err && <div className="flash error">{err}</div>}
        {!d ? (
          <div className="empty" style={{ padding: 40 }}>Loading dashboard…</div>
        ) : (
          <DashboardBody d={d} onPickProject={setProjectId} scopeLabel={scopeLabel} />
        )}
      </main>
    </>
  );
}

/** Inline add-a-manual-adjustment form shown at the foot of a projected
 *  month's drawer. Positive £ adds to the series; negative reduces it. */
function AdjustmentForm({ month, projectId, onSaved }: {
  month: string;
  projectId: string | null;
  onSaved: () => Promise<void> | void;
}) {
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [amount, setAmount] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    const n = Number(amount);
    if (!Number.isFinite(n) || n === 0 || !label.trim()) {
      setErr("Enter a non-zero amount and a short reason.");
      return;
    }
    setBusy(true); setErr(null);
    try {
      await api.addCashAdjustment({ project_id: projectId, month, direction, amount: n, label: label.trim() });
      setAmount(""); setLabel("");
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to save");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
      <div className="eyebrow" style={{ marginBottom: 6 }}>Adjust this month's projection</div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <select value={direction} onChange={(e) => setDirection(e.target.value as "in" | "out")} style={{ width: 80 }}>
          <option value="in">In</option>
          <option value="out">Out</option>
        </select>
        <input
          type="number" step="500" className="num" placeholder="£ (− reduces)"
          value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 130 }}
        />
        <input
          placeholder="Reason — e.g. client agreed £150k application"
          value={label} onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
          style={{ flex: 1, minWidth: 180 }}
        />
        <button className="accent" onClick={() => void save()} disabled={busy}>{busy ? "Adding…" : "Add"}</button>
      </div>
      {err && <div className="flash error" style={{ marginTop: 8 }}>{err}</div>}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
        Layers on top of the derived projection{projectId ? " for this project" : " (portfolio level — shows in the unfiltered view)"}.
        It flows into the bars, the dashed cumulative line and this drawer; remove it any time with the ✕ next to its line.
      </div>
    </div>
  );
}

function DashboardBody({ d, onPickProject, scopeLabel }: { d: Report; onPickProject: (id: string) => void; scopeLabel: string }) {
  // Click a month on either cash chart → slide-over listing the exact
  // applications, POs and supplier invoices behind that month's bars.
  const [drill, setDrill] = useState<DrillData | null>(null);
  // Derived future projection for the outlook chart (re-fetched with the filter).
  const [outlook, setOutlook] = useState<Awaited<ReturnType<typeof api.reportCashOutlook>> | null>(null);
  useEffect(() => {
    api.reportCashOutlook(d.filter.project_id ?? undefined).then(setOutlook).catch(() => setOutlook(null));
  }, [d.filter.project_id]);
  // After adding/removing a manual adjustment: re-derive the outlook and
  // rebuild the open drawer so the rows, subtotals and bars all agree.
  async function refreshAfterAdjustment(month: string, gpFrac: number | null) {
    const o = await api.reportCashOutlook(d.filter.project_id ?? undefined);
    setOutlook(o);
    await openCashDetail(month, "cash", gpFrac, o.basis);
  }
  async function openCashDetail(month: string, chart: "cash" | "revenue", gpFrac: number | null, projected?: Array<{ month: string; kind: string; detail: string; date: string | null; amount: number; adj_id?: number }>) {
    try {
      const res: { rows: Array<{ kind: string; detail: string; date: string | null; amount: number; adj_id?: number }> } =
        await api.reportCashDetail(month, d.filter.project_id ?? undefined);
      if (projected) res.rows.push(...projected.filter((r) => r.month === month));
      const monthLabel = new Date(month + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
      // One section per chart series, in the legend's order and colour, each
      // with its own subtotal — so the drawer reconciles to the bars at a glance.
      const GROUPS: Array<{ kind: string; color: string }> = chart === "cash"
        ? [
            { kind: "Cash in", color: "var(--success)" },
            { kind: "Expected in", color: "#8fd0a8" },
            { kind: "Cash out", color: "#9aa0e0" },
            { kind: "Invoices due", color: "var(--warn)" },
            { kind: "Labour due", color: "#b0621f" },
            { kind: "Labour applied", color: "#e5bd7a" },
            { kind: "Projected in", color: "#cfe8da" },
            { kind: "Projected out", color: "#f0dcb4" },
          ]
        : [{ kind: "Revenue", color: "#cdd0ee" }];
      const rows: Array<Record<string, unknown>> = [];
      let revTotal = 0;
      for (const g of GROUPS) {
        // Date order tells the cash story: dated rows chronologically, undated
        // (spread-over-the-month) rows after, biggest first.
        const members = res.rows.filter((r) => r.kind === g.kind).sort((a, b) =>
          a.date && b.date ? (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount)
            : a.date ? -1 : b.date ? 1 : b.amount - a.amount);
        if (members.length === 0) continue;
        const subtotal = members.reduce((s, r) => s + r.amount, 0);
        if (g.kind === "Revenue") revTotal = subtotal;
        rows.push({ __header: g.kind, __total: fmtMoney(subtotal), __color: g.color });
        for (const r of members) rows.push({ detail: r.detail, date: r.date, amount: r.amount, __adj_id: r.adj_id ?? null });
      }
      const dayFmt = (v: unknown) => (
        <span style={{ whiteSpace: "nowrap" }}>
          {typeof v === "string" && v
            ? new Date(v.slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
            : "—"}
        </span>
      );
      // Manual adjustments carry an id: render a remove ✕ on their rows, and
      // offer the add form for any month the outlook still projects.
      const canAdjust = chart === "cash" && projected != null && outlook != null && month >= outlook.from;
      setDrill({
        title: chart === "cash" ? `${monthLabel} — cash flow detail` : `${monthLabel} — recognised revenue`,
        columns: [
          {
            key: "detail", label: "Detail",
            fmt: (v, row) => row.__adj_id
              ? (
                <span>
                  {String(v ?? "")}{" "}
                  <button
                    className="ghost tiny"
                    title="Remove this manual adjustment"
                    style={{ color: "var(--danger)", padding: "0 5px" }}
                    onClick={() => { void api.deleteCashAdjustment(Number(row.__adj_id)).then(() => refreshAfterAdjustment(month, gpFrac)); }}
                  >✕</button>
                </span>
              )
              : <>{(v as string) ?? "—"}</>,
          },
          { key: "date", label: "Date", align: "center", fmt: dayFmt },
          { key: "amount", label: "Amount", align: "right", fmt: (v) => fmtMoney(Number(v)) },
        ],
        rows,
        footer: canAdjust
          ? <AdjustmentForm month={month} projectId={d.filter.project_id ?? null} onSaved={() => refreshAfterAdjustment(month, gpFrac)} />
          : undefined,
        ...(chart === "revenue"
          ? {
              total: fmtMoney(revTotal),
              note: `Profit for the month is an ESTIMATE: recognised revenue × the portfolio's blended forecast GP% ` +
                `(currently ${gp(gpFrac)}) ≈ ${fmtMoney(Math.max(0, revTotal * (gpFrac ?? 0)))}. Monthly costs aren't measured directly — ` +
                `the margin comes from the forecast final accounts vs forecast final costs across the projects in view.`,
            }
          : { note: "Cash in / Cash out are actual receipts and payments. Expected in = certified applications at their contractual payment date. Invoices due = supplier invoices at account-terms due dates (the printed due date only when no account terms are set). Labour due = certified subcontractor applications awaiting payment. Labour applied = claims not yet certified, at this-period net value — shown for visibility but excluded from the cumulative line until certified. Purchase orders not yet invoiced are not projected." }),
      });
    } catch { /* keep the drawer closed if the detail fetch fails */ }
  }

  // "Applied & certified vs FFA" card — each figure opens the per-project rows
  // behind it (the by_project breakdown the dashboard already holds).
  const shortDate = (v: unknown) => (typeof v === "string" && v
    ? new Date(v.slice(0, 10) + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
    : "—");
  const moneyCol = (key: string, label: string) => ({ key, label, align: "right" as const, fmt: (v: unknown) => fmtMoney(Number(v)) });
  function openIncomeDrill(mode: "applied" | "certified" | "awaiting" | "retention") {
    const projLabel = (p: { code: string; name: string }) => `${p.code} — ${p.name}`;
    if (mode === "retention") {
      const rows = d.by_project
        .map((p) => ({ project: projLabel(p), certified: p.certified, ret_pct: p.client_retention_pct ?? 0, held: p.certified * ((p.client_retention_pct ?? 0) / 100) }))
        .filter((r) => r.held > 0.005)
        .sort((a, b) => b.held - a.held);
      setDrill({
        title: "Retention held by clients", value: fmtMoney(retention),
        columns: [
          { key: "project", label: "Project", align: "left" },
          moneyCol("certified", "Certified"),
          { key: "ret_pct", label: "Ret. %", align: "center", fmt: (v) => `${v}%` },
          moneyCol("held", "Held"),
        ],
        rows: rows as unknown as Array<Record<string, unknown>>,
        total: fmtMoney(retention),
        note: "Certified works value × each project's client retention % — money earned but held back until contractual release. Projects with no retention (e.g. Blyth/Durata) don't appear.",
      });
      return;
    }
    if (mode === "awaiting") {
      const rows = d.by_project
        .map((p) => ({ project: projLabel(p), applied: p.applied, certified: p.certified, awaiting: p.applied - p.certified }))
        .filter((r) => r.awaiting > 0.005)
        .sort((a, b) => b.awaiting - a.awaiting);
      setDrill({
        title: "Applied, not yet certified", value: fmtMoney(awaitingCert),
        columns: [
          { key: "project", label: "Project", align: "left" },
          moneyCol("applied", "Applied"), moneyCol("certified", "Certified"), moneyCol("awaiting", "Awaiting"),
        ],
        rows: rows as unknown as Array<Record<string, unknown>>,
        total: fmtMoney(awaitingCert),
        note: "Gross works value applied for that the client hasn't certified yet — claims still with the client, or values they knocked down. Retention they hold on certified work shows under Retention, not here.",
      });
      return;
    }
    const key = mode; // "applied" | "certified"
    const rows = d.by_project
      .map((p) => ({ project: projLabel(p), amount: p[key] }))
      .filter((r) => r.amount > 0.005)
      .sort((a, b) => b.amount - a.amount);
    setDrill({
      title: mode === "applied" ? "Applied to date" : "Certified to date",
      value: fmtMoney(mode === "applied" ? applied : certified),
      columns: [{ key: "project", label: "Project", align: "left" }, moneyCol("amount", mode === "applied" ? "Applied" : "Certified")],
      rows: rows as unknown as Array<Record<string, unknown>>,
      total: fmtMoney(mode === "applied" ? applied : certified),
      note: mode === "applied"
        ? "The latest application's cumulative works value per project, gross of retention."
        : "Gross certified works value per project. Retention the client holds against it shows under Retention; the cash actually due is certified minus that retention.",
    });
  }

  // Labour card — a project row opens its incoming labour applications.
  async function openLabourDrill(p: { id: string; code: string; name: string; labour_budget: number; labour_expended: number }) {
    try {
      const afps = await api.listAfps(p.id, "incoming_labour");
      const rows = [...afps]
        .sort((a, b) => a.app_number - b.app_number)
        .map((a) => ({
          app: `App #${a.app_number}`,
          period_end: a.period_end,
          status: a.status,
          claim: a.cumulative_value ?? 0,
          certified: (a.status === "certified" || a.status === "paid") ? (a.certified_amount ?? 0) : null,
        }));
      setDrill({
        title: `${p.code} — labour applications`,
        value: fmtMoney(p.labour_expended),
        subtitle: `certified labour vs ${fmtMoney(p.labour_budget)} BOQ budget`,
        columns: [
          { key: "app", label: "Application", align: "left" },
          { key: "period_end", label: "Period end", align: "center", fmt: shortDate },
          { key: "status", label: "Status", align: "center" },
          moneyCol("claim", "Claimed"),
          { key: "certified", label: "Certified", align: "right", fmt: (v) => (v == null ? "—" : fmtMoney(Number(v))) },
        ],
        rows: rows as unknown as Array<Record<string, unknown>>,
        note: "Only certified applications expend the labour budget — drafts and submitted claims are listed for context.",
      });
    } catch { /* leave closed on fetch failure */ }
  }
  const inductedPct = pct(d.compliance.inducted, d.compliance.operatives);
  const ramsTotal = d.compliance.rams.signed + d.compliance.rams.awaiting;
  const ramsPct = pct(d.compliance.rams.signed, ramsTotal);
  const cardsAttn = d.compliance.cards.expiring + d.compliance.cards.expired;
  // 14-day average sign-ins (from the daily series).
  const avgDay = d.operations.daily.length
    ? Math.round((d.operations.daily.reduce((s, x) => s + x.signins, 0) / d.operations.daily.length) * 10) / 10
    : 0;

  // Portfolio commercial rollups from the per-project breakdown.
  const totApplied = d.by_project.reduce((s, p) => s + p.applied, 0);
  const totCertified = d.by_project.reduce((s, p) => s + p.certified, 0);

  // Applied vs certified (client income) for the bar card — both GROSS works
  // values so like compares with like: "certified" answers "how much of the
  // claim did the client certify", and money they certified but hold back
  // shows separately under Retention. (Mixing net-of-retention certified with
  // gross applied made held retention look like work awaiting certification.)
  const applied = d.applications.client.applied;
  const certified = d.by_project.reduce((s, p) => s + p.certified, 0);
  const certOfApplied = pct(certified, applied);
  const awaitingCert = d.by_project.reduce((s, p) => s + Math.max(0, p.applied - p.certified), 0);
  // Retention held = each project's certified × its client retention %.
  const retention = d.by_project.reduce((s, p) => s + p.certified * ((p.client_retention_pct ?? 0) / 100), 0);

  // Portfolio commercial rollups (all projects, from the per-project forecast).
  const port = d.by_project.reduce(
    (a, p) => ({
      ffa: a.ffa + p.ffa, ffc: a.ffc + p.ffc, cv: a.cv + p.contract_value, cc: a.cc + p.contract_cost,
      committed: a.committed + p.committed, labExp: a.labExp + p.labour_expended, labBudget: a.labBudget + p.labour_budget,
    }),
    { ffa: 0, ffc: 0, cv: 0, cc: 0, committed: 0, labExp: 0, labBudget: 0 },
  );
  const portLabPct = port.labBudget > 0 ? pct(port.labExp, port.labBudget) : 0;
  const portContractGp = port.cv > 0 ? (port.cv - port.cc) / port.cv : null;
  const portForecastGp = port.ffa > 0 ? (port.ffa - port.ffc) / port.ffa : null;
  const portGpDeltaPts = portForecastGp != null && portContractGp != null ? (portForecastGp - portContractGp) * 100 : null;
  const committedPct = port.ffc > 0 ? pct(port.committed, port.ffc) : 0;
  const certOfFfa = port.ffa > 0 ? pct(totCertified, port.ffa) : 0;
  // Applied/certified bars scale against the forecast final account (fall back to
  // applied if no priced contract exists, so the bars aren't empty).
  const ffaDenom = port.ffa > 0 ? port.ffa : applied;
  const labourRows = d.by_project.filter((p) => p.labour_budget > 0 || p.labour_expended > 0);

  // Lightweight "needs attention" from signals we already aggregate. (Variations
  // / AfP-certification flags arrive with the commercials pass.)
  const flags: Array<{ tone: "warn" | "danger"; text: string; to: string; action: string }> = [];
  if (d.signals.variations_pending > 0) flags.push({ tone: "warn", text: `${d.signals.variations_pending} variation${d.signals.variations_pending === 1 ? "" : "s"} pending director approval`, to: "/", action: "Review" });
  if (d.signals.afp_awaiting_cert > 0) flags.push({ tone: "warn", text: `${d.signals.afp_awaiting_cert} application${d.signals.afp_awaiting_cert === 1 ? "" : "s"} submitted, awaiting certification`, to: "/applications", action: "View" });
  if (d.signals.framework_overdrawn > 0) flags.push({ tone: "danger", text: `${d.signals.framework_overdrawn} framework line${d.signals.framework_overdrawn === 1 ? "" : "s"} overdrawn — call-offs exceed the agreed qty or cost`, to: "/pos", action: "View" });
  if (d.pos.pending_approval > 0) flags.push({ tone: "warn", text: `${d.pos.pending_approval} purchase order${d.pos.pending_approval === 1 ? "" : "s"} awaiting approval`, to: "/approvals", action: "Review" });
  if (d.compliance.cards.expired > 0) flags.push({ tone: "danger", text: `${d.compliance.cards.expired} qualification card${d.compliance.cards.expired === 1 ? "" : "s"} expired`, to: "/operatives", action: "View" });
  if (d.compliance.rams.awaiting > 0) flags.push({ tone: "warn", text: `${d.compliance.rams.awaiting} RAMS awaiting signature`, to: "/operatives", action: "View" });
  if (d.compliance.cards.expiring > 0) flags.push({ tone: "warn", text: `${d.compliance.cards.expiring} card${d.compliance.cards.expiring === 1 ? "" : "s"} expiring soon`, to: "/operatives", action: "View" });
  if (d.compliance.plant_tests.expired > 0) flags.push({ tone: "danger", text: `${d.compliance.plant_tests.expired} plant test${d.compliance.plant_tests.expired === 1 ? "" : "s"} expired`, to: "/plant", action: "View" });
  else if (d.compliance.plant_tests.expiring > 0) flags.push({ tone: "warn", text: `${d.compliance.plant_tests.expiring} plant test${d.compliance.plant_tests.expiring === 1 ? "" : "s"} due for retest`, to: "/plant", action: "View" });
  if (d.compliance.cards.pending > 0) flags.push({ tone: "warn", text: `${d.compliance.cards.pending} self-uploaded card${d.compliance.cards.pending === 1 ? "" : "s"} to verify`, to: "/operatives", action: "Verify" });
  if (d.xero.pos_failed > 0) flags.push({ tone: "danger", text: `${d.xero.pos_failed} Xero sync failure${d.xero.pos_failed === 1 ? "" : "s"}`, to: "/admin", action: "Open" });
  else if (d.xero.pos_unsynced > 0) flags.push({ tone: "warn", text: `${d.xero.pos_unsynced} approved PO${d.xero.pos_unsynced === 1 ? "" : "s"} awaiting Xero push`, to: "/admin", action: "Open" });
  // Budget watch — projects committed ≥ 60% of forecast cost (and not yet over).
  for (const p of d.by_project) {
    if (p.ffc > 0 && p.committed / p.ffc >= 0.6 && p.committed < p.ffc) {
      flags.push({ tone: "warn", text: `${p.code} — ${pct(p.committed, p.ffc)}% committed, watch budget`, to: `/projects/${p.id}`, action: "Open" });
    }
  }

  return (
    <>
      {/* ── Portfolio ────────────────────────────────────────────────────── */}
      <SectionHeader title={d.filter.project_id ? `Portfolio — ${scopeLabel}` : "Portfolio — all active projects"} />
      <div className="kpis">
        <Kpi label="Active projects" value={String(d.projects.active)} sub={`${d.projects.with_boq} priced · ${Math.max(0, d.projects.active - d.projects.with_boq)} mobilising`} />
        <Kpi label="Forecast final account" value={moneyK(port.ffa)} sub={port.ffa - port.cv > 0.5 ? `incl. ${moneyK(port.ffa - port.cv)} variations` : "contract value"} />
        <Kpi label="Forecast GP%" value={gp(portForecastGp)} tone={portGpDeltaPts != null && portGpDeltaPts < 0 ? "warn" : portForecastGp != null ? "success" : "default"}
          sub={<>Contract {gp(portContractGp)} · <Delta pts={portGpDeltaPts} /></>} />
        <Kpi label="Committed" value={`${committedPct}%`} sub={`${moneyK(port.committed)} of cost budget`} />
        <Kpi label="Certified of FFA" value={`${certOfFfa}%`} tone={certOfFfa > 0 ? "success" : "default"} sub={`${moneyK(totCertified)} certified to date`} />
      </div>

      {/* ── Cash position ────────────────────────────────────────────────── */}
      {(() => {
        const clientPaid = d.applications.client.paid;       // cash in
        const posPaid = d.pos.paid_value;                    // materials/plant POs paid
        const labourPaid = d.applications.labour.paid;       // subbie labour certs paid (Xero bills, not local POs)
        const cashOut = posPaid + labourPaid;                // total cash out
        const net = clientPaid - cashOut;
        const awaitingClient = Math.max(0, d.applications.client.certified - clientPaid);
        const cashDenom = Math.max(clientPaid, cashOut, 1);
        return (
          <>
            <SectionHeader title="Cash position" hint="paid in vs paid out · from Xero" />
            <div className="kpis">
              <Kpi label="Paid by client" value={moneyK(clientPaid)} tone={clientPaid > 0 ? "success" : "default"} sub="cash in (invoices paid)" />
              <Kpi label="Paid out" value={moneyK(cashOut)} sub={`${moneyK(posPaid)} POs · ${moneyK(labourPaid)} labour`} />
              <Kpi label="Net cash position" value={moneyK(net)} tone={net >= 0 ? "success" : "danger"} sub={net >= 0 ? "in ahead of out" : "out ahead of in"} />
              <Kpi label="Awaiting from client" value={moneyK(awaitingClient)} tone={awaitingClient > 0 ? "warn" : "default"} sub="certified, not yet paid" />
              <Kpi label="Outstanding to suppliers" value={moneyK(d.pos.outstanding_value)} sub="committed, not yet paid" />
            </div>
            <div className="card card-padded" style={{ marginTop: 12 }}>
              <BarRow label="Cash in — client invoices paid" amount={clientPaid} pctWidth={(clientPaid / cashDenom) * 100} color="var(--success)" />
              <BarRow label="Cash out — purchase orders paid" amount={posPaid} pctWidth={(posPaid / cashDenom) * 100} color="var(--blue)" />
              <BarRow label="Cash out — labour certs paid" amount={labourPaid} pctWidth={(labourPaid / cashDenom) * 100} color="var(--accent)" />
              <div style={{ borderTop: "1px solid var(--line)", marginTop: 6, paddingTop: 10 }} className="row">
                <span className="muted" style={{ fontSize: 13, flex: 1 }}>Net cash position</span>
                <span className="num" style={{ fontSize: 15, fontWeight: 700, color: net >= 0 ? "var(--success)" : "var(--danger)" }}>{money(net)}</span>
              </div>
            </div>
          </>
        );
      })()}

      {/* ── Commercial performance by project ────────────────────────────── */}
      <SectionHeader title="Commercial performance — by project" hint="at a glance" link={{ to: "/", label: "Open projects →" }} />
      <div className="card" style={{ overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th className="num">Forecast final acct</th>
                <th style={{ minWidth: 140 }}>Committed</th>
                <th style={{ minWidth: 130 }}>Labour expended</th>
                <th className="num">Contract GP%</th>
                <th className="num">Forecast GP%</th>
                <th className="num">Applied</th>
                <th className="num">Certified</th>
                <th className="num no-print"></th>
              </tr>
            </thead>
            <tbody>
              {d.by_project.length === 0 ? (
                <tr><td colSpan={9}><div className="muted" style={{ padding: 16 }}>No projects.</div></td></tr>
              ) : d.by_project.map((p) => {
                const cPct = p.ffc > 0 ? pct(p.committed, p.ffc) : (p.committed > 0 ? 100 : 0);
                const dPts = p.forecast_gp_pct != null && p.contract_gp_pct != null ? (p.forecast_gp_pct - p.contract_gp_pct) * 100 : null;
                return (
                  <tr key={p.id} style={p.id === d.filter.project_id ? { background: "var(--accent-soft)" } : undefined}>
                    <td>
                      <Link to={`/projects/${p.id}`} style={{ fontWeight: 600 }}>{p.code}</Link>
                      <div className="muted" style={{ fontSize: 12 }}>{p.name}</div>
                    </td>
                    <td className="num">{p.ffa > 0 ? moneyK(p.ffa) : <span className="muted">—</span>}</td>
                    <td>
                      <Bar pctWidth={cPct} color={cPct >= 90 ? "var(--warn)" : undefined} />
                      <div className="muted num" style={{ fontSize: 12, marginTop: 3 }}>{p.ffc > 0 ? `${cPct}% · ` : ""}{moneyK(p.committed)}</div>
                    </td>
                    <td>
                      {p.labour_budget > 0 || p.labour_expended > 0 ? (
                        <>
                          <Bar pctWidth={p.labour_budget > 0 ? pct(p.labour_expended, p.labour_budget) : 100} color="var(--success)" />
                          <div className="muted num" style={{ fontSize: 12, marginTop: 3 }}>{p.labour_budget > 0 ? `${pct(p.labour_expended, p.labour_budget)}% · ` : ""}{moneyK(p.labour_expended)}</div>
                        </>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td className="num muted">{gp(p.contract_gp_pct)}</td>
                    <td className="num">
                      {gp(p.forecast_gp_pct)} {dPts != null && <Delta pts={dPts} />}
                      {p.ffa > 0 && <div className="muted num" style={{ fontSize: 12, marginTop: 3 }}>{moneyK(p.ffa - p.ffc)}</div>}
                    </td>
                    <td className="num">{p.applied > 0 ? moneyK(p.applied) : <span className="muted">—</span>}</td>
                    <td className="num">{p.certified > 0 ? moneyK(p.certified) : <span className="muted">—</span>}</td>
                    <td className="num no-print">
                      {p.id === d.filter.project_id
                        ? <button className="ghost tiny" onClick={() => onPickProject("")}>Clear</button>
                        : <button className="ghost tiny" onClick={() => onPickProject(p.id)}>Filter</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {d.by_project.length > 1 && (
              <tfoot>
                <tr style={{ borderTop: "2px solid var(--line-strong)" }}>
                  <td style={{ fontWeight: 600 }}>Portfolio</td>
                  <td className="num" style={{ fontWeight: 600 }}>{moneyK(port.ffa)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{committedPct}% · {moneyK(port.committed)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{port.labBudget > 0 ? `${portLabPct}% · ` : ""}{moneyK(port.labExp)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{gp(portContractGp)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>
                    {gp(portForecastGp)} {portGpDeltaPts != null && <Delta pts={portGpDeltaPts} />}
                    {port.ffa > 0 && <div className="muted num" style={{ fontSize: 12, marginTop: 3, fontWeight: 600 }}>{moneyK(port.ffa - port.ffc)}</div>}
                  </td>
                  <td className="num" style={{ fontWeight: 600 }}>{moneyK(totApplied)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{moneyK(totCertified)}</td>
                  <td className="no-print"></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* ── Applied & certified vs FFA · Labour by project ──────────────── */}
      <div className="dash-grid" style={{ marginTop: 18 }}>
        <div className="card card-padded">
          <div className="card-hd" style={{ padding: 0, marginBottom: 12, alignItems: "baseline" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Applied &amp; certified vs FFA</h3>
            <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>portfolio, to date</span>
          </div>
          {applied === 0 && port.ffa === 0 ? <div className="muted" style={{ fontSize: 13 }}>No client applications yet.</div> : (
            <>
              {port.ffa > 0 && <BarRow label="Forecast final account" amount={port.ffa} pctWidth={100} color="var(--line-strong)" />}
              <div role="button" tabIndex={0} style={{ cursor: "pointer" }} title="See the applied value per project"
                onClick={() => openIncomeDrill("applied")} onKeyDown={(e) => e.key === "Enter" && openIncomeDrill("applied")}>
                <BarRow label="Applied" amount={applied} pctWidth={ffaDenom > 0 ? (applied / ffaDenom) * 100 : 0} color="var(--blue)" caption={ffaDenom > 0 ? `${pct(applied, ffaDenom)}% of FFA` : undefined} />
              </div>
              <div role="button" tabIndex={0} style={{ cursor: "pointer" }} title="See the certified value per project"
                onClick={() => openIncomeDrill("certified")} onKeyDown={(e) => e.key === "Enter" && openIncomeDrill("certified")}>
                <BarRow label="Certified" amount={certified} pctWidth={ffaDenom > 0 ? (certified / ffaDenom) * 100 : 0} color="var(--success)" caption={ffaDenom > 0 ? `${pct(certified, ffaDenom)}% of FFA` : undefined} />
              </div>
              <div style={{ borderTop: "1px solid var(--line)", marginTop: 10, paddingTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
                <Mini label="Cert / applied" value={`${certOfApplied}%`} />
                <div role="button" tabIndex={0} style={{ cursor: "pointer" }} title="Applied not yet certified, per project"
                  onClick={() => openIncomeDrill("awaiting")} onKeyDown={(e) => e.key === "Enter" && openIncomeDrill("awaiting")}>
                  <Mini label="Awaiting cert" value={moneyK(awaitingCert)} />
                </div>
                <div role="button" tabIndex={0} style={{ cursor: "pointer" }} title="Retention held, per project"
                  onClick={() => openIncomeDrill("retention")} onKeyDown={(e) => e.key === "Enter" && openIncomeDrill("retention")}>
                  <Mini label="Retention" value={moneyK(retention)} />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="card card-padded">
          <div className="card-hd" style={{ padding: 0, marginBottom: 12, alignItems: "baseline" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Labour expenditure by project</h3>
            <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>certified vs BOQ</span>
          </div>
          {labourRows.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>No labour budget yet.</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
              {labourRows.map((p) => {
                const lp = p.labour_budget > 0 ? pct(p.labour_expended, p.labour_budget) : (p.labour_expended > 0 ? 100 : 0);
                return (
                  <div key={p.id} role="button" tabIndex={0} style={{ cursor: "pointer" }}
                    title="See this project's labour applications"
                    onClick={() => { void openLabourDrill(p); }}
                    onKeyDown={(e) => { if (e.key === "Enter") void openLabourDrill(p); }}>
                    <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 13 }}>{p.code} <span className="muted">{p.name}</span><span className="muted" style={{ fontSize: 11.5 }}> · {moneyK(p.labour_budget)} budget</span></span>
                      <span className="num muted" style={{ fontSize: 12 }}>{moneyK(p.labour_expended)} · {lp}%</span>
                    </div>
                    <Bar pctWidth={lp} color={lp >= 100 ? "var(--danger)" : "var(--success)"} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Preliminaries ───────────────────────────────────────────────── */}
      <div className="card card-padded" style={{ marginTop: 18 }}>
        <div className="card-hd" style={{ padding: 0, marginBottom: 12, alignItems: "baseline" }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>Preliminaries</h3>
          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>budget vs committed</span>
        </div>
        <BudgetBar label="Prelims budget" budget={d.prelims.budget} spent={d.prelims.committed} />
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {money(Math.max(0, d.prelims.budget - d.prelims.committed))} remaining · {d.prelims.po_count} prelim PO{d.prelims.po_count === 1 ? "" : "s"}{d.prelims.plant_accrued > 0 ? ` · ${money(d.prelims.plant_accrued)} plant accrued` : ""}
        </div>
        {(() => {
          const rows = d.by_project.filter((p) => p.prelim_budget > 0 || p.prelim_committed > 0);
          if (rows.length === 0) return null;
          return (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
              {rows.map((p) => {
                const pp = p.prelim_budget > 0 ? pct(p.prelim_committed, p.prelim_budget) : (p.prelim_committed > 0 ? 100 : 0);
                return (
                  <div key={p.id}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{p.code} <span className="muted" style={{ fontWeight: 400 }}>{p.name}</span></div>
                    <Bar pctWidth={pp} color={p.prelim_budget > 0 && p.prelim_committed > p.prelim_budget ? "var(--danger)" : "var(--accent)"} />
                    <div className="muted num" style={{ fontSize: 12, marginTop: 3 }}>{moneyK(p.prelim_committed)} / {moneyK(p.prelim_budget)}</div>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      {/* ── Cash flow ────────────────────────────────────────────────────── */}
      <SectionHeader title="Cash flow" hint={`portfolio · last ${d.filter.months} months`} link={{ to: "/admin", label: "Xero →" }} />
      <CashFlow data={d.cash_monthly} gpPct={portForecastGp ?? 0}
        onMonthClick={(m, chart) => { void openCashDetail(m, chart, portForecastGp); }} />
      {outlook && (
        <CashOutlook data={d.cash_monthly} outlook={outlook}
          onMonthClick={(m) => { void openCashDetail(m, "cash", portForecastGp, outlook.basis); }} />
      )}
      <DrillPanel drill={drill} onClose={() => setDrill(null)} />

      {/* ── Health & safety / compliance ─────────────────────────────────── */}
      <SectionHeader title="Health & safety · compliance" hint="across active sites" link={{ to: "/operatives", label: "Operatives →" }} />
      <div className="kpis">
        <HsCard label="RAMS signed" value={ramsTotal ? `${ramsPct}%` : "—"} tone={ramsPct >= 100 ? "success" : "warn"} barPct={ramsPct} barColor="var(--success)"
          sub={`${d.compliance.rams.signed} signed · ${d.compliance.rams.awaiting} awaiting`} to="/operatives" />
        <HsCard label="Inducted" value={d.compliance.operatives ? `${inductedPct}%` : "—"} tone={inductedPct >= 100 ? "success" : "warn"} barPct={inductedPct} barColor="var(--success)"
          sub={`${d.compliance.inducted} of ${d.compliance.operatives} operatives`} to="/operatives" />
        <HsCard label="Attendance today" value={String(d.operations.on_site_now)} tone={d.operations.on_site_now > 0 ? "success" : "default"}
          sub={`avg ${avgDay} / day · ${d.operations.daily.length} days`} to="/operatives" />
        <HsCard label="Cards expiring / expired" value={String(cardsAttn)} tone={d.compliance.cards.expired > 0 ? "danger" : cardsAttn > 0 ? "warn" : "success"}
          sub={d.compliance.cards.worst_label ?? `${d.compliance.cards.pending} to verify · ${d.compliance.cards.valid} valid`} to="/operatives" />
      </div>

      {/* ── Needs attention · Xero ───────────────────────────────────────── */}
      <div className="dash-grid" style={{ marginTop: 18 }}>
        <div className="card card-padded">
          <div className="card-hd" style={{ padding: 0, marginBottom: 10, alignItems: "center" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Needs attention</h3>
            <span className={`pill ${flags.length ? "warn" : "ok"}`} style={{ marginLeft: "auto" }}>{flags.length || "0"}</span>
          </div>
          {flags.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>All clear — nothing outstanding.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {flags.map((f, i) => (
                <div key={i} className="row" style={{ alignItems: "center", gap: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: f.tone === "danger" ? "var(--danger)" : "var(--warn)", flex: "0 0 auto" }} />
                  <span style={{ flex: 1, fontSize: 13 }}>{f.text}</span>
                  <Link to={f.to} className="no-print" style={{ fontSize: 13 }}>{f.action}</Link>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card card-padded">
          <div className="card-hd" style={{ padding: 0, marginBottom: 10, alignItems: "center" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Upcoming key dates</h3>
            <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>next 14 days</span>
            <Link to="/calendar" className="no-print" style={{ marginLeft: "auto", fontSize: 13 }}>Calendar →</Link>
          </div>
          {d.key_dates.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>Nothing due in the next 14 days.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {d.key_dates.map((k, i) => {
                const m = keyDateMeta(k.entry_type);
                return (
                  <div key={i} className="row" style={{ alignItems: "center", gap: 10 }}>
                    <span className="num" style={{ fontSize: 12.5, width: 54, flexShrink: 0, color: "var(--muted)" }}>
                      {new Date(k.date + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                    </span>
                    <span style={{ flex: 1, fontSize: 13 }}>{m.label}{k.app_number ? ` #${k.app_number}` : ""} · {k.project_code}</span>
                    <span className={`pill ${m.tone}`} style={{ fontSize: 10 }}>{m.badge}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Integrations ─────────────────────────────────────────────────── */}
      <SectionHeader title="Integrations" link={{ to: "/admin", label: "Manage →" }} />
      <div className="card card-padded" style={{ maxWidth: 560 }}>
        <div className="card-hd" style={{ padding: 0, marginBottom: 12, alignItems: "center" }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>Xero</h3>
          {d.xero.tenant && <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>{d.xero.tenant}</span>}
          <span className={`pill ${d.xero.connected ? "ok dot" : "warn"}`} style={{ marginLeft: "auto" }}>{d.xero.connected ? "Connected" : "Not connected"}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          <Mini label="POs synced" value={String(d.xero.pos_synced)} />
          <Mini label="Awaiting push" value={String(d.xero.pos_unsynced)} />
          <Mini label="Invoices raised" value={String(d.xero.invoices_raised)} />
        </div>
        {d.xero.pos_failed > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 10, color: "var(--danger)" }}>{d.xero.pos_failed} sync failure{d.xero.pos_failed === 1 ? "" : "s"} — check Admin.</div>}
      </div>
    </>
  );
}

/** Map a valuation-schedule entry_type to a label + short badge for key dates. */
function keyDateMeta(entryType: string): { label: string; badge: string; tone: string } {
  switch (entryType) {
    case "due": case "cutoff": return { label: "Due date", badge: "Due", tone: "warn" };
    case "notice": return { label: "Notice", badge: "Notice", tone: "neutral" };
    case "application": case "submission": return { label: "Application", badge: "App", tone: "neutral" };
    case "certification": return { label: "Certification", badge: "Cert", tone: "info" };
    case "final_payment": case "payment": return { label: "Final date for payment", badge: "Final", tone: "info" };
    default: return { label: entryType.replace(/_/g, " "), badge: "Date", tone: "neutral" };
  }
}

/** The two cash-flow charts: monthly cash in vs out (+ net), and recognised
 *  revenue/profit with the running net cash position. */
function CashFlow({ data, gpPct, onMonthClick }: {
  data: Report["cash_monthly"]; gpPct: number;
  onMonthClick?: (month: string, chart: "cash" | "revenue") => void;
}) {
  if (!data.length || data.every((m) => m.cash_in === 0 && m.cash_out === 0 && m.revenue === 0 && (m.invoices_due ?? 0) === 0 && (m.labour_due ?? 0) === 0 && (m.labour_applied ?? 0) === 0 && (m.receivables_due ?? 0) === 0)) {
    return <div className="card card-padded"><div className="muted" style={{ fontSize: 13 }}>No cash-flow activity in this period yet — figures appear once invoices are paid and POs settled.</div></div>;
  }
  const label = (m: string) => new Date(m + "-01T00:00:00").toLocaleDateString("en-GB", { month: "short" });
  let running = 0;
  let runningPos = 0;
  const flow = data.map((m) => {
    const net = m.cash_in - m.cash_out;
    running += net;
    // Cumulative position INCLUDING committed-but-unsettled money: expected
    // receipts land as +, payables due land as − — where the bank is heading
    // if everything settles on its due date.
    runningPos += (m.cash_in + (m.receivables_due ?? 0)) - (m.cash_out + (m.invoices_due ?? 0) + (m.labour_due ?? 0));
    const profit = Math.max(0, m.revenue * gpPct);
    return { name: label(m.month), month: m.month, cashIn: m.cash_in, cashOut: m.cash_out, invoicesDue: m.invoices_due ?? 0, labourDue: m.labour_due ?? 0, labourApplied: m.labour_applied ?? 0, receivablesDue: m.receivables_due ?? 0, net, cumPos: Math.round(runningPos * 100) / 100, cost: Math.max(0, m.revenue - profit), profit, netCash: running };
  });
  const fmtTick = (v: number) => (Math.abs(v) >= 1000 ? `£${Math.round(v / 1000)}k` : `£${Math.round(v)}`);
  // Compact tooltip: short series names, zero-value series hidden, small type —
  // the default box grew to six long rows and blotted out the chart.
  const SHORT_NAMES: Record<string, string> = {
    "Cumulative position (incl. expected)": "Cumulative",
    "Net cash position": "Net cash",
    "Profit (est.)": "Profit est.",
  };
  const CompactTip = ({ active, payload, label: tipLabel }: {
    active?: boolean;
    payload?: Array<{ name?: string; value?: number | string; color?: string; stroke?: string }>;
    label?: string;
  }) => {
    if (!active || !payload?.length) return null;
    const rows = payload.filter((p) => Math.abs(Number(p.value) || 0) > 0.004);
    if (rows.length === 0) return null;
    return (
      <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 6, padding: "6px 9px", fontSize: 11, lineHeight: 1.6, boxShadow: "0 4px 14px rgba(0,0,0,.15)", minWidth: 148 }}>
        <div style={{ fontWeight: 700, marginBottom: 1 }}>{tipLabel}</div>
        {rows.map((p, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: p.color ?? p.stroke ?? "#999", flex: "0 0 auto" }} />
            <span style={{ color: "var(--muted)" }}>{SHORT_NAMES[p.name ?? ""] ?? p.name}</span>
            <span style={{ marginLeft: "auto", paddingLeft: 10, fontWeight: 600 }}>{fmtMoney(Number(p.value))}</span>
          </div>
        ))}
      </div>
    );
  };
  // Recharts hands the clicked category's datum back via activePayload
  // (chart-level, v2 shape — kept as a fallback).
  const clickedMonth = (st: unknown): string | null => {
    const s = st as { activePayload?: Array<{ payload?: { month?: string } }> } | null;
    return s?.activePayload?.[0]?.payload?.month ?? null;
  };
  // Recharts v3: the chart-level state no longer carries activePayload, so the
  // dependable gesture is a click on the bar itself — the Bar hands back the
  // clicked entry (datum on `payload`, or spread onto the arg).
  const barMonth = (data: unknown): string | null => {
    const d = data as { month?: string; payload?: { month?: string } } | null;
    return d?.payload?.month ?? d?.month ?? null;
  };
  const barClick = (chart: "cash" | "revenue") => (data: unknown) => {
    const m = barMonth(data);
    if (m) onMonthClick?.(m, chart);
  };
  return (
    <div className="dash-grid">
      <div className="card card-padded">
        <div className="card-hd" style={{ padding: 0, marginBottom: 4, alignItems: "baseline" }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>Cash in vs cash out</h3>
          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>received vs paid out · click a month for the detail</span>
        </div>
        <div style={{ height: 250, cursor: onMonthClick ? "pointer" : undefined }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={flow} margin={{ top: 10, right: 6, left: -6, bottom: 0 }}
              onClick={(st) => { const m = clickedMonth(st); if (m) onMonthClick?.(m, "cash"); }}>
              <CartesianGrid vertical={false} stroke="var(--line)" />
              <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--muted)" }} />
              <YAxis tickFormatter={fmtTick} tickLine={false} axisLine={false} width={46} tick={{ fontSize: 11, fill: "var(--muted)" }} />
              <Tooltip content={<CompactTip />} />
              <ReferenceLine y={0} stroke="var(--line-strong)" />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <RBar name="Cash in" dataKey="cashIn" fill="var(--success)" radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} onClick={barClick("cash")} />
              <RBar name="Expected in" dataKey="receivablesDue" fill="#8fd0a8" radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} onClick={barClick("cash")} />
              <RBar name="Cash out" dataKey="cashOut" fill="#9aa0e0" radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} onClick={barClick("cash")} />
              <RBar name="Invoices due" dataKey="invoicesDue" stackId="due" fill="var(--warn)" maxBarSize={14} isAnimationActive={false} onClick={barClick("cash")} />
              <RBar name="Labour due" dataKey="labourDue" stackId="due" fill="#b0621f" maxBarSize={14} isAnimationActive={false} onClick={barClick("cash")} />
              <RBar name="Labour applied" dataKey="labourApplied" stackId="due" fill="#e5bd7a" radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} onClick={barClick("cash")} />
              <RBar name="Net" dataKey="net" radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} onClick={barClick("cash")}>
                {flow.map((e, i) => <Cell key={i} fill={e.net >= 0 ? "var(--ink)" : "var(--danger)"} />)}
              </RBar>
              {/* Running position if everything settles on its due date: actual
                  receipts/payments plus expected-in minus payables due. Dashed —
                  it's a projection, not banked cash. */}
              <Line name="Cumulative position (incl. expected)" type="monotone" dataKey="cumPos"
                stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 4" dot={{ r: 2.5 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="card card-padded">
        <div className="card-hd" style={{ padding: 0, marginBottom: 4, alignItems: "baseline" }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>Monthly revenue, profit &amp; cash</h3>
          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>recognised vs banked · click a month for the detail</span>
        </div>
        <div style={{ height: 250, cursor: onMonthClick ? "pointer" : undefined }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={flow} margin={{ top: 10, right: 6, left: -6, bottom: 0 }}
              onClick={(st) => { const m = clickedMonth(st); if (m) onMonthClick?.(m, "revenue"); }}>
              <CartesianGrid vertical={false} stroke="var(--line)" />
              <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--muted)" }} />
              <YAxis tickFormatter={fmtTick} tickLine={false} axisLine={false} width={46} tick={{ fontSize: 11, fill: "var(--muted)" }} />
              <Tooltip content={<CompactTip />} />
              <ReferenceLine y={0} stroke="var(--line-strong)" />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <RBar name="Revenue" dataKey="cost" stackId="rev" fill="#cdd0ee" maxBarSize={22} isAnimationActive={false} onClick={barClick("revenue")} />
              <RBar name="Profit (est.)" dataKey="profit" stackId="rev" fill="var(--success)" radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false} onClick={barClick("revenue")} />
              <Line name="Net cash position" type="monotone" dataKey="netCash" stroke="var(--ink)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components (built on the app's existing primitives) ───────────────────
/** Cash outlook — actual, committed and PROJECTED cash on one time axis.
 *  Past months are facts (solid); future months carry the committed pipeline
 *  plus the derived projection (pale shades). One cumulative line runs through
 *  both — solid up to this month, dashed beyond (the projection). */
function CashOutlook({ data, outlook, onMonthClick }: {
  data: Report["cash_monthly"];
  outlook: Awaited<ReturnType<typeof api.reportCashOutlook>>;
  onMonthClick?: (month: string) => void;
}) {
  const thisMonth = outlook.from;
  const projIn = new Map(outlook.months.map((m) => [m.month, m.projected_in]));
  const projOut = new Map(outlook.months.map((m) => [m.month, m.projected_out]));
  const monthSet = new Set<string>([...data.map((m) => m.month), ...outlook.months.map((m) => m.month)]);
  const months = [...monthSet].sort();
  const label = (m: string) => new Date(m + "-01T00:00:00").toLocaleDateString("en-GB", { month: "short" });
  let run = 0;
  const rows = months.map((m) => {
    const c = data.find((x) => x.month === m);
    const committedIn = c?.receivables_due ?? 0;
    const committedOut = (c?.invoices_due ?? 0) + (c?.labour_due ?? 0);
    const pIn = projIn.get(m) ?? 0, pOut = projOut.get(m) ?? 0;
    run += (c?.cash_in ?? 0) + committedIn + pIn - (c?.cash_out ?? 0) - committedOut - pOut;
    const cum = Math.round(run * 100) / 100;
    return {
      name: label(m), month: m,
      actualIn: c?.cash_in ?? 0, committedIn, projectedIn: pIn,
      actualOut: c?.cash_out ?? 0, committedOut, projectedOut: pOut,
      cumSolid: m <= thisMonth ? cum : null,
      cumDash: m >= thisMonth ? cum : null,
    };
  });
  if (rows.every((r) => !r.actualIn && !r.committedIn && !r.projectedIn && !r.actualOut && !r.committedOut && !r.projectedOut)) return null;
  const fmtTick = (v: number) => (Math.abs(v) >= 1000 ? `£${Math.round(v / 1000)}k` : `£${Math.round(v)}`);
  const SHORT: Record<string, string> = { "Cumulative position (projected)": "Cumulative" };
  const Tip = ({ active, payload, label: l }: { active?: boolean; payload?: Array<{ name?: string; value?: number | string; color?: string; stroke?: string }>; label?: string }) => {
    if (!active || !payload?.length) return null;
    const seen = new Set<string>();
    const rows2 = payload.filter((p) => {
      if (Math.abs(Number(p.value) || 0) < 0.005 || seen.has(p.name ?? "")) return false;
      seen.add(p.name ?? ""); return true;
    });
    if (!rows2.length) return null;
    return (
      <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 6, padding: "6px 9px", fontSize: 11, lineHeight: 1.6, boxShadow: "0 4px 14px rgba(0,0,0,.15)", minWidth: 150 }}>
        <div style={{ fontWeight: 700, marginBottom: 1 }}>{l}</div>
        {rows2.map((p, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: p.color ?? p.stroke ?? "#999", flex: "0 0 auto" }} />
            <span style={{ color: "var(--muted)" }}>{SHORT[p.name ?? ""] ?? p.name}</span>
            <span style={{ marginLeft: "auto", paddingLeft: 10, fontWeight: 600 }}>{fmtMoney(Number(p.value))}</span>
          </div>
        ))}
      </div>
    );
  };
  const click = (dat: unknown) => {
    const x = dat as { month?: string; payload?: { month?: string } } | null;
    const m = x?.payload?.month ?? x?.month ?? null;
    if (m) onMonthClick?.(m);
  };
  return (
    <div className="card card-padded" style={{ marginTop: 14 }}>
      <div className="card-hd" style={{ padding: 0, marginBottom: 4, alignItems: "baseline" }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Cash outlook — actual &amp; projected</h3>
        <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>facts to date, then the derived projection · click a month for the basis</span>
      </div>
      <div style={{ height: 280, cursor: onMonthClick ? "pointer" : undefined }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 10, right: 6, left: -6, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--muted)" }} />
            <YAxis tickFormatter={fmtTick} tickLine={false} axisLine={false} width={46} tick={{ fontSize: 11, fill: "var(--muted)" }} />
            <Tooltip content={<Tip />} />
            <ReferenceLine y={0} stroke="var(--line-strong)" />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <RBar name="Received" dataKey="actualIn" stackId="in" fill="var(--success)" maxBarSize={16} isAnimationActive={false} onClick={click} />
            <RBar name="Committed in" dataKey="committedIn" stackId="in" fill="#8fd0a8" maxBarSize={16} isAnimationActive={false} onClick={click} />
            <RBar name="Projected in" dataKey="projectedIn" stackId="in" fill="#cfe8da" radius={[3, 3, 0, 0]} maxBarSize={16} isAnimationActive={false} onClick={click} />
            <RBar name="Paid" dataKey="actualOut" stackId="out" fill="#9aa0e0" maxBarSize={16} isAnimationActive={false} onClick={click} />
            <RBar name="Committed out" dataKey="committedOut" stackId="out" fill="var(--warn)" maxBarSize={16} isAnimationActive={false} onClick={click} />
            <RBar name="Projected out" dataKey="projectedOut" stackId="out" fill="#f0dcb4" radius={[3, 3, 0, 0]} maxBarSize={16} isAnimationActive={false} onClick={click} />
            <Line name="Cumulative (actual + committed)" type="monotone" dataKey="cumSolid" stroke="var(--ink)" strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} />
            <Line name="Cumulative position (projected)" type="monotone" dataKey="cumDash" stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 4" dot={{ r: 2.5 }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }}>
        {outlook.assumptions.join(" ")}
      </div>
    </div>
  );
}

function SectionHeader({ title, hint, link }: { title: string; hint?: string; link?: { to: string; label: string } }) {
  return (
    <div className="row" style={{ alignItems: "baseline", gap: 8, margin: "22px 0 10px" }}>
      <div className="eyebrow" style={{ margin: 0 }}>{title}</div>
      {hint && <span className="muted" style={{ fontSize: 12 }}>{hint}</span>}
      {link && <Link to={link.to} className="no-print" style={{ marginLeft: "auto", fontSize: 13 }}>{link.label}</Link>}
    </div>
  );
}
/** Inline, colour-coded GP% delta in percentage points (green ▲ up / red ▼ down). */
function Delta({ pts }: { pts: number | null }) {
  if (pts == null) return null;
  const up = pts >= 0;
  return (
    <span style={{ color: up ? "var(--success)" : "var(--danger)", fontWeight: 600, fontSize: 12, whiteSpace: "nowrap" }}>
      {up ? "▲" : "▼"} {up ? "+" : ""}{pts.toFixed(1)}
    </span>
  );
}
/** Thin progress bar (reuses the app's .bar track). */
function Bar({ pctWidth, color }: { pctWidth: number; color?: string }) {
  const w = Math.max(0, Math.min(100, pctWidth));
  return <div className="bar" style={{ height: 8 }}><div style={{ width: `${w}%`, background: color }} /></div>;
}
function BarRow({ label, amount, pctWidth, color, caption }: { label: string; amount: number; pctWidth: number; color?: string; caption?: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 5 }}>
        <span className="muted" style={{ fontSize: 13 }}>{label}</span>
        <span className="num" style={{ fontSize: 13 }}>{money(amount)}{caption && <span className="muted" style={{ marginLeft: 6 }}>{caption}</span>}</span>
      </div>
      <Bar pctWidth={pctWidth} color={color} />
    </div>
  );
}
function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="eyebrow" style={{ margin: 0, fontSize: 10 }}>{label}</div>
      <div className="num serif" style={{ fontSize: 18, marginTop: 3 }}>{value}</div>
    </div>
  );
}
function HsCard({ label, value, sub, tone, barPct, barColor, to }: {
  label: string; value: string; sub: string; tone: "default" | "warn" | "danger" | "success";
  barPct?: number; barColor?: string; to: string;
}) {
  return (
    <div className={`kpi${tone !== "default" ? ` tone-${tone}` : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {barPct != null && <div style={{ margin: "8px 0 2px" }}><Bar pctWidth={barPct} color={barColor} /></div>}
      <div className="row" style={{ alignItems: "baseline", gap: 6 }}>
        <span className="kpi-sub" style={{ flex: 1 }}>{sub}</span>
        <Link to={to} className="no-print" style={{ fontSize: 12 }}>View →</Link>
      </div>
    </div>
  );
}
function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: React.ReactNode; tone?: "default" | "warn" | "danger" | "success" }) {
  return (
    <div className={`kpi${tone && tone !== "default" ? ` tone-${tone}` : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
function BudgetBar({ label, budget, spent }: { label: string; budget: number; spent: number }) {
  const w = budget > 0 ? Math.min(100, (spent / budget) * 100) : (spent > 0 ? 100 : 0);
  const over = spent > budget && budget > 0;
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <span className="muted" style={{ fontSize: 13 }}>{label}</span>
        <span className="num" style={{ fontSize: 13 }}>{money(spent)} <span className="muted">/ {money(budget)}</span></span>
      </div>
      <div className="bar" style={{ height: 10 }}><div className={over ? "danger" : ""} style={{ width: `${w}%` }} /></div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{over ? "Over budget" : `${money(Math.max(0, budget - spent))} remaining`}</div>
    </div>
  );
}

// Build a CSV of the headline KPIs + per-project breakdown and trigger a
// client-side download. No server round-trip — the report payload has everything.
function downloadCsv(d: Report, scopeLabel: string, months: number) {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [];
  lines.push("PGP Dashboard export");
  lines.push(`Generated,${esc(new Date().toISOString())}`);
  lines.push(`Scope,${esc(scopeLabel)}`);
  lines.push(`Period,${esc(`Last ${months} months`)}`);
  lines.push("");
  lines.push("Metric,Value");
  const kpis: Array<[string, string | number]> = [
    ["Active projects", d.projects.active],
    ["Completed projects", d.projects.completed],
    ["Priced projects", d.projects.with_boq],
    ["PO committed", d.pos.committed_value],
    ["PO paid", d.pos.paid_value],
    ["PO paid count", d.pos.paid_count],
    ["PO outstanding", d.pos.outstanding_value],
    ["Pending approvals", d.pos.pending_approval],
    ["Prelims budget", d.prelims.budget],
    ["Prelims committed", d.prelims.committed],
    ["Client applied", d.applications.client.applied],
    ["Client certified", d.applications.client.certified],
    ["Client paid (cash in)", d.applications.client.paid],
    ["Net cash position", d.applications.client.paid - d.pos.paid_value - d.applications.labour.paid],
    ["Labour applied", d.applications.labour.applied],
    ["Labour certified", d.applications.labour.certified],
    ["Labour paid", d.applications.labour.paid],
    ["On site now", d.operations.on_site_now],
    ["Signed in today", d.operations.signins_today],
    ["Plant on site", d.operations.plant_on_site],
    ["Operatives", d.compliance.operatives],
    ["Inducted", d.compliance.inducted],
    ["Cards valid", d.compliance.cards.valid],
    ["Cards expiring", d.compliance.cards.expiring],
    ["Cards expired", d.compliance.cards.expired],
    ["Cards pending verify", d.compliance.cards.pending],
    ["RAMS signed", d.compliance.rams.signed],
    ["RAMS awaiting", d.compliance.rams.awaiting],
    ["Xero connected", d.xero.connected ? "yes" : "no"],
    ["Xero POs synced", d.xero.pos_synced],
    ["Xero POs awaiting", d.xero.pos_unsynced],
    ["Xero POs failed", d.xero.pos_failed],
  ];
  for (const [k, v] of kpis) lines.push(`${esc(k)},${esc(v)}`);
  lines.push("");
  lines.push("By project");
  lines.push("Code,Name,Status,Forecast final account,Committed,Labour budget,Labour expended,Contract GP%,Forecast GP%,Forecast GP £,Applied,Certified,Paid,Pending POs,On site");
  const gpCsv = (f: number | null) => (f == null ? "" : (f * 100).toFixed(1));
  for (const p of d.by_project) {
    lines.push([p.code, p.name, p.completed_at ? "Complete" : "Active", p.ffa, p.committed, p.labour_budget, p.labour_expended, gpCsv(p.contract_gp_pct), gpCsv(p.forecast_gp_pct), p.ffa > 0 ? Math.round((p.ffa - p.ffc) * 100) / 100 : "", p.applied, p.certified, p.paid, p.pending, p.on_site].map(esc).join(","));
  }
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pgp-dashboard-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
