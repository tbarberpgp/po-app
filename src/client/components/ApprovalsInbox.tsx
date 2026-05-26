import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import type { CurrentUser, PurchaseOrder } from "../../shared/types";

type Row = PurchaseOrder & { project_code: string; project_name: string };

export function ApprovalsInbox({ me }: { me: CurrentUser | null }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.listPOs({ status: "pending_approval" })
      .then((rs) => setRows(rs as Row[]))
      .catch((e) => setErr(e.message));
  }, []);

  const mine = me ? rows.filter((r) => r.approval_tier && me.approver_tiers.includes(r.approval_tier)) : [];

  return (
    <>
      <Topbar
        crumbs="Workspace"
        title="Approvals"
        status={mine.length > 0 ? <span className="pill pending dot" style={{ verticalAlign: "middle" }}>{mine.length} pending</span> : undefined}
      />
      <main>
        {err && <div className="flash error">{err}</div>}
        {!me?.is_approver ? (
          <div className="empty">You are not configured as an approver.</div>
        ) : mine.length === 0 ? (
          <div className="empty">Nothing waiting for your approval.</div>
        ) : (
          <div className="card">
            <div className="card-hd"><h2>Waiting on you</h2><span className="pill">{mine.length}</span></div>
            <table>
              <thead>
                <tr>
                  <th>PO</th>
                  <th className="center">Project</th>
                  <th>Supplier</th>
                  <th className="num">Value</th>
                  <th className="center">Tier</th>
                  <th className="center">Reason</th>
                  <th>Raised</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {mine.map((r) => (
                  <tr key={r.id}>
                    <td><Link to={`/approvals/${r.id}`}>{r.po_number}</Link></td>
                    <td className="center">{r.project_code}</td>
                    <td>{r.supplier}</td>
                    <td className="num">{fmtMoney(r.total_value)}</td>
                    <td className="center">{r.approval_tier?.replace("_", " ")}</td>
                    <td className="center">{r.approval_reason?.replace("_", " ")}</td>
                    <td className="muted">{fmtDate(r.created_at)}</td>
                    <td className="muted">{r.created_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
