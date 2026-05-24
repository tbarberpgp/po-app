import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
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
      <div className="row" style={{ marginBottom: 16 }}>
        <h2 className="grow">Purchase orders</h2>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="pending_approval">Pending approval</option>
          <option value="approved">Approved</option>
          <option value="issued">Issued</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>
      {err && <div className="flash error">{err}</div>}
      {rows.length === 0 ? (
        <div className="empty">No POs match.</div>
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
                <td><span className={`badge ${r.status}`}>{r.status.replace("_", " ")}</span></td>
                <td>{fmtDate(r.created_at)}</td>
                <td>{r.created_by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
