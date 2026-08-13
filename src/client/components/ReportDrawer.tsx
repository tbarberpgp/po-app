import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { SiteReportDoc } from "./SiteReportDoc";

type FullReport = Awaited<ReturnType<typeof api.getSiteReport>>;

/**
 * Views a site report in a right-hand slide-over (reusing the `.od-drawer`
 * styling, widened for a document). Fetches by id so callers just pass the row
 * id — used by both the workspace Reports page and the project Reports tab so a
 * report opens in place instead of a full-page navigation.
 */
export function ReportDrawer({ reportId, onClose, onEmailed }: {
  reportId: number | null;
  onClose: () => void;
  onEmailed?: () => void;
}) {
  const [report, setReport] = useState<FullReport | null>(null);
  const [busy, setBusy] = useState(false);
  const open = reportId != null;

  useEffect(() => {
    if (reportId == null) { setReport(null); return; }
    setReport(null);
    let live = true;
    api.getSiteReport(reportId).then((r) => { if (live) setReport(r); }).catch(() => { if (live) setReport(null); });
    return () => { live = false; };
  }, [reportId]);

  async function email() {
    if (!report) return;
    setBusy(true);
    try { await api.sendSiteReport(report.id); onEmailed?.(); }
    finally { setBusy(false); }
  }
  // Re-fetch in place (no loading flash) after an edit like the photo picker saving.
  const refresh = () => { if (reportId != null) api.getSiteReport(reportId).then(setReport).catch(() => {}); };

  return (
    <>
      <div className={`drill-scrim${open ? " show" : ""}`} aria-hidden onClick={onClose} />
      <aside className={`od-drawer report-drawer${open ? " open" : ""}`} role="dialog" aria-modal="false" aria-label="Site report">
        {report
          ? <div className="od-inner"><SiteReportDoc key={report.id} report={report} busy={busy} onEmail={email} onClose={onClose} onSaved={refresh} /></div>
          : open ? <div className="empty" style={{ padding: 40 }}>Loading report…</div> : null}
      </aside>
    </>
  );
}
