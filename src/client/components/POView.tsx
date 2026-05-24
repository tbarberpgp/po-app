import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import type { CurrentUser, PurchaseOrder } from "../../shared/types";

type Row = PurchaseOrder & { project_code: string; project_name: string };

export function POView({ me }: { me: CurrentUser | null }) {
  const { id } = useParams<{ id: string }>();
  const [po, setPo] = useState<Row | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState(false);

  function refresh() {
    if (!id) return;
    api.getPO(id).then((p) => setPo(p as Row)).catch((e) => setErr(e.message));
  }
  useEffect(refresh, [id]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  if (!po) return <div className="muted">Loading…</div>;
  const canActOnApproval =
    po.status === "pending_approval" &&
    me?.is_approver &&
    po.approval_tier != null &&
    me.approver_tiers.includes(po.approval_tier);
  const canIssue = po.status === "approved" && me?.email === po.created_by;

  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 className="grow">{po.po_number}</h2>
        <span className={`badge ${po.status}`}>{po.status.replace("_", " ")}</span>
      </div>
      <div className="muted" style={{ marginBottom: 16 }}>
        <Link to={`/projects/${po.project_id}`}>{po.project_code} — {po.project_name}</Link> · raised by {po.created_by} on {fmtDate(po.created_at)}
      </div>
      {err && <div className="flash error">{err}</div>}

      {po.requires_approval && (
        <div className="flash info">
          Needs <b>{po.approval_tier?.replace("_", " ")}</b> approval — reason: {po.approval_reason?.replace("_", " ")}.
          {po.approved_by && <> Approved by <b>{po.approved_by}</b> on {fmtDate(po.approved_at)}.</>}
          {po.rejected_by && <> Rejected by <b>{po.rejected_by}</b> on {fmtDate(po.rejected_at)}{po.rejection_reason ? ` — "${po.rejection_reason}"` : ""}.</>}
        </div>
      )}

      <div className="card">
        <div className="row">
          <div className="grow">
            <div className="muted">Supplier</div>
            <div style={{ fontSize: 16, fontWeight: 500 }}>{po.supplier}</div>
          </div>
          {po.delivery_date && (
            <div>
              <div className="muted">Delivery date</div>
              <div>{fmtDate(po.delivery_date)}</div>
            </div>
          )}
          <div style={{ textAlign: "right" }}>
            <div className="muted">Total</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{fmtMoney(po.total_value)}</div>
          </div>
        </div>
        {po.notes && <div style={{ marginTop: 12 }}><div className="muted">Notes</div>{po.notes}</div>}
      </div>

      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Item</th>
            <th>Manufacturer</th>
            <th className="num">Qty</th>
            <th>Unit</th>
            <th className="num">Unit cost</th>
            <th className="num">Line total</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {po.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.type ?? ""}</td>
              <td>{l.item}</td>
              <td>{l.manufacturer ?? ""}</td>
              <td className="num">{l.qty}</td>
              <td>{l.unit}</td>
              <td className="num">{fmtMoney(l.unit_cost)}</td>
              <td className="num">{fmtMoney(l.line_total)}</td>
              <td>
                {l.is_unpriced && <span className="badge unpriced">unpriced</span>}
                {l.is_over_budget && <span className="badge over">over</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row" style={{ marginTop: 24 }}>
        {canActOnApproval && !showReject && (
          <>
            <button disabled={busy} onClick={() => act(() => api.approvePO(po.id))}>Approve</button>
            <button className="secondary" disabled={busy} onClick={() => setShowReject(true)}>Reject…</button>
          </>
        )}
        {canActOnApproval && showReject && (
          <div className="card" style={{ width: "100%" }}>
            <label>Rejection reason</label>
            <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} style={{ width: "100%" }} />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="danger" disabled={busy || !rejectReason.trim()} onClick={() => act(() => api.rejectPO(po.id, rejectReason))}>Confirm reject</button>
              <button className="secondary" onClick={() => setShowReject(false)}>Cancel</button>
            </div>
          </div>
        )}
        {canIssue && (
          <button onClick={() => act(() => api.issuePO(po.id))} disabled={busy}>Mark as issued to supplier</button>
        )}
      </div>
    </>
  );
}
