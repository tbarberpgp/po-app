import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import type { CurrentUser, PendingPriceApproval, PurchaseOrder } from "../../shared/types";

type Row = PurchaseOrder & { project_code: string; project_name: string };
type PendingAfp = Awaited<ReturnType<typeof api.listPendingAfps>>[number];

export function ApprovalsInbox({ me }: { me: CurrentUser | null }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [prices, setPrices] = useState<PendingPriceApproval[]>([]);
  const [afps, setAfps] = useState<PendingAfp[]>([]);
  const [err, setErr] = useState<string | null>(null);

  function refresh() {
    api.listPOs({ status: "pending_approval" })
      .then((rs) => setRows(rs as Row[]))
      .catch((e) => setErr(e.message));
    api.listPendingPriceApprovals().then(setPrices).catch(() => setPrices([]));
    api.listPendingAfps().then(setAfps).catch(() => setAfps([]));
  }
  useEffect(refresh, []);

  const minePOs = me ? rows.filter((r) => r.approval_tier && me.approver_tiers.includes(r.approval_tier)) : [];
  const minePrices = me
    ? prices.filter((p) => p.approval_tier && me.approver_tiers.includes(p.approval_tier))
    : [];
  // AfPs route to director-tier approvers
  const myAfps = me?.approver_tiers.includes("director") ? afps : [];

  async function decide(id: number, action: "approve" | "reject") {
    if (action === "reject") {
      const reason = prompt("Reason for rejection (optional)") ?? undefined;
      await api.decidePendingPrice(id, "reject", reason);
    } else {
      await api.decidePendingPrice(id, "approve");
    }
    refresh();
  }

  const totalMine = minePOs.length + minePrices.length + myAfps.length;

  return (
    <>
      <Topbar
        crumbs="Workspace"
        title="Approvals"
        status={totalMine > 0 ? <span className="pill pending dot" style={{ verticalAlign: "middle" }}>{totalMine} pending</span> : undefined}
      />
      <main>
        {err && <div className="flash error">{err}</div>}
        {!me?.is_approver ? (
          <div className="empty">You are not configured as an approver.</div>
        ) : totalMine === 0 ? (
          <div className="empty">Nothing waiting for your approval.</div>
        ) : (
          <>
            {minePOs.length > 0 && (
              <div className="card">
                <div className="card-hd"><h2>POs awaiting your approval</h2><span className="pill">{minePOs.length}</span></div>
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
                    {minePOs.map((r) => (
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

            {myAfps.length > 0 && (
              <div className="card" style={{ marginTop: 16 }}>
                <div className="card-hd"><h2>AfPs awaiting director approval</h2><span className="pill">{myAfps.length}</span></div>
                <table>
                  <thead>
                    <tr>
                      <th className="center">Project</th>
                      <th className="center">#</th>
                      <th className="center">Direction</th>
                      <th>Period ending</th>
                      <th className="num">Cumulative</th>
                      <th className="num">Total invoice</th>
                      <th>Submitted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {myAfps.map((a) => (
                      <tr key={a.id}>
                        <td className="center">{a.project_code}</td>
                        <td className="center"><Link to={`/applications/${a.id}`}>#{a.app_number}</Link></td>
                        <td className="center">{a.direction === "outgoing" ? "Outgoing" : "Incoming labour"}</td>
                        <td>{fmtDate(a.period_end)}</td>
                        <td className="num">{a.cumulative_value != null ? fmtMoney(a.cumulative_value) : "—"}</td>
                        <td className="num"><b>{a.total_invoice != null ? fmtMoney(a.total_invoice) : "—"}</b></td>
                        <td className="muted">{fmtDate(a.submitted_at)} · {a.submitted_by}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {minePrices.length > 0 && (
              <div className="card" style={{ marginTop: 16 }}>
                <div className="card-hd">
                  <h2>Price approvals (over BOQ)</h2>
                  <span className="pill">{minePrices.length}</span>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th className="center">Project</th>
                      <th>Material</th>
                      <th>Supplier</th>
                      <th className="num">BOQ unit cost</th>
                      <th className="num">Quoted unit</th>
                      <th className="num">Overspend</th>
                      <th className="center">Tier</th>
                      <th style={{ width: 160 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {minePrices.map((p) => (
                      <tr key={p.id}>
                        <td className="center">{p.project_code}</td>
                        <td>
                          <div>{p.material_item}</div>
                          {p.material_element_code && (
                            <div className="muted" style={{ fontSize: 11 }}>Element {p.material_element_code}</div>
                          )}
                        </td>
                        <td>{p.supplier_name}</td>
                        <td className="num">{p.boq_unit_cost != null ? fmtMoney(p.boq_unit_cost) : "—"}</td>
                        <td className="num">{fmtMoney(p.unit_price)}</td>
                        <td className="num" style={{ color: "var(--danger)" }}>+ {fmtMoney(p.over_amount)}</td>
                        <td className="center">{p.approval_tier?.replace("_", " ")}</td>
                        <td>
                          <button className="primary tiny" onClick={() => decide(p.id, "approve")}>Approve</button>{" "}
                          <button className="ghost tiny" onClick={() => decide(p.id, "reject")}>Reject</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}
