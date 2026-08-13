// Individual site report as its own page (/reports/:id) — mirrors the
// list → detail routing of Applications (/applications/:id) and POs
// (/pos/:id). The report body is the shared SiteReportDoc.

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { Topbar } from "./Shell";
import { SiteReportDoc } from "./SiteReportDoc";

type FullReport = Awaited<ReturnType<typeof api.getSiteReport>>;

export function ReportView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const reportId = Number(id);
  const [report, setReport] = useState<FullReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!Number.isFinite(reportId)) { setErr("Report not found."); return; }
    api.getSiteReport(reportId)
      .then(setReport)
      .catch((e) => setErr(e instanceof Error ? e.message : "Couldn't load this report."));
  }, [reportId]);

  async function email() {
    if (!report) return;
    setBusy(true); setErr(null); setNotice(null);
    try {
      const r = await api.sendSiteReport(report.id);
      setNotice(`Emailed to ${r.sent_to.join(", ")}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't email — check the project's manager emails and the mail key.");
    } finally { setBusy(false); }
  }

  const label = report
    ? (report.project_id ? `${report.project_code ?? ""} ${report.project_name ?? ""}`.trim() : "Portfolio")
    : "";
  const periodLabel = report ? (report.period_type === "daily" ? "Daily" : "Weekly") : "";

  return (
    <>
      <Topbar
        crumbs={<><Link to="/reports">Reports</Link> / {report ? `${periodLabel} · ${label}` : "Report"}</>}
        title={report ? `${periodLabel} site report` : "Site report"}
      />
      <main>
        {err && <div className="flash error">{err}</div>}
        {notice && <div className="flash info">{notice}</div>}
        {!report
          ? (!err && <div className="muted">Loading…</div>)
          : <SiteReportDoc report={report} busy={busy} onEmail={email} onClose={() => navigate("/reports")} />}
      </main>
    </>
  );
}
