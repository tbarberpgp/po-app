import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import type { PurchaseOrder } from "../../shared/types";

type Row = PurchaseOrder & { project_code: string; project_name: string };

export function POsList() {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.listPOs({ status: status || undefined })
      .then((rs) => setRows(rs as Row[]))
      .catch((e) => setErr(e.message));
  }, [status]);

  return (
    <>
      <Topbar crumbs="Workspace" title="Purchase orders" />
      <main>
        {err && <div className="flash error">{err}</div>}
        <div className="card">
          <div className="card-hd">
            <h2 style={{ flex: 1 }}>All purchase orders</h2>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="pending_approval">Pending approval</option>
              <option value="approved">Approved</option>
              <option value="issued">Issued</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
          {rows.length === 0 ? (
            <div style={{ padding: 32 }}><div className="empty">No POs match.</div></div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>PO</th>
                  <th>Project</th>
                  <th>Supplier</th>
                  <th className="num">Value</th>
                  <th>Status</th>
                  <th>Raised</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><Link to={`/pos/${r.id}`}>{r.po_number}</Link></td>
                    <td>{r.project_code}</td>
                    <td>{r.supplier}</td>
                    <td className="num">{fmtMoney(r.total_value)}</td>
                    <td><span className={`pill ${r.status}`}>{r.status.replace("_", " ")}</span></td>
                    <td className="muted">{fmtDate(r.created_at)}</td>
                    <td className="muted">{r.created_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}
