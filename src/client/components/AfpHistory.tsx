import { useEffect, useState } from "react";
import { api, type AfpHistoryEntry } from "../lib/api";

/** Who did what to a labour certificate, and when: submitted, certified (or
 *  fast-track certified), approved, pushed, paid. Shown on the certificate page
 *  and in Accounts. `version` re-reads it after an action changes the cert. */
export function AfpHistory({ afpId, version }: { afpId: number; version?: unknown }) {
  const [rows, setRows] = useState<AfpHistoryEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.getAfpHistory(afpId)
      .then((r) => { if (live) { setRows(r); setErr(null); } })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : "Couldn't load the history"); });
    return () => { live = false; };
  }, [afpId, version]);
  const when = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso.slice(0, 10)
      : d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 6 }}>History</div>
      {err && <div className="muted" style={{ fontSize: 12 }}>{err}</div>}
      {rows && rows.length === 0 && <div className="muted" style={{ fontSize: 12 }}>Nothing recorded yet.</div>}
      {rows && rows.map((e, i) => (
        <div key={i} className="row" style={{ gap: 12, fontSize: 13, padding: "3px 0", alignItems: "baseline" }}>
          <span className="muted" style={{ width: 150, flexShrink: 0, fontSize: 12 }}>{when(e.at)}</span>
          <span>
            <b>{e.what}</b>{e.by ? <> by {e.by}</> : null}
            {e.detail ? <span className="muted"> · {e.detail}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}
