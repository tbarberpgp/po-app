import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { downloadPdf, generatePoPdf } from "../lib/po-pdf";
import { Topbar } from "./Shell";
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
    setBusy(true); setErr(null);
    try { await fn(); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(false); }
  }

  async function onDownloadPdf() {
    if (!po) return;
    setBusy(true); setErr(null);
    try {
      const bytes = await generatePoPdf(po);
      downloadPdf(bytes, `${po.po_number}.pdf`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "PDF failed");
    } finally { setBusy(false); }
  }

  if (!po) return <main className="muted">Loading…</main>;

  const canActOnApproval =
    po.status === "pending_approval" &&
    me?.is_approver &&
    po.approval_tier != null &&
    me.approver_tiers.includes(po.approval_tier);
  const canIssue = po.status === "approved" && me?.email === po.created_by;

  return (
    <>
      <Topbar
        crumbs={<><Link to="/pos">Purchase orders</Link> / {po.po_number}</>}
        title={po.po_number}
        status={<span className={`pill ${po.status} dot`} style={{ verticalAlign: "middle" }}>{po.status.replace("_", " ")}</span>}
        actions={
          <>
            <button className="ghost" onClick={onDownloadPdf} disabled={busy}>Download PDF</button>
            {canActOnApproval && !showReject && (
              <>
                <button className="danger" onClick={() => setShowReject(true)} disabled={busy}>Reject</button>
                <button className="accent" onClick={() => act(() => api.approvePO(po.id))} disabled={busy}>
                  Approve {fmtMoney(po.total_value)}
                </button>
              </>
            )}
            {canIssue && (
              <button className="primary" onClick={() => act(() => api.issuePO(po.id))} disabled={busy}>Mark as issued</button>
            )}
          </>
        }
      />
      <main>
        {err && <div className="flash error">{err}</div>}
        <div className="muted" style={{ marginTop: 0 }}>
          <Link to={`/projects/${po.project_id}`}>{po.project_code} — {po.project_name}</Link>
          {" · "}raised by {po.created_by} on {fmtDate(po.created_at)}
        </div>

        {po.requires_approval && (
          <div className="flash info">
            {po.status === "pending_approval" && <>Needs <b>{po.approval_tier?.replace("_", " ")}</b> approval — reason: {po.approval_reason?.replace("_", " ")}.</>}
            {po.approved_by && <> Approved by <b>{po.approved_by}</b> on {fmtDate(po.approved_at)}.</>}
            {po.rejected_by && <> Rejected by <b>{po.rejected_by}</b> on {fmtDate(po.rejected_at)}{po.rejection_reason ? ` — "${po.rejection_reason}"` : ""}.</>}
          </div>
        )}

        <div className="card">
          <div className="card-bd">
            <div className="row" style={{ alignItems: "flex-start" }}>
              <div className="grow">
                <div className="eyebrow">Supplier</div>
                <div className="serif" style={{ fontSize: 22, marginTop: 4 }}>{po.supplier}</div>
              </div>
              {po.delivery_date && (
                <div>
                  <div className="eyebrow">Delivery date</div>
                  <div style={{ marginTop: 4 }}>{fmtDate(po.delivery_date)}</div>
                </div>
              )}
              <div style={{ textAlign: "right" }}>
                <div className="eyebrow">Total</div>
                <div className="serif num" style={{ fontSize: 30, marginTop: 4 }}>{fmtMoney(po.total_value)}</div>
              </div>
            </div>
            {po.notes && (
              <div style={{ marginTop: 16 }}>
                <div className="eyebrow">Notes</div>
                <div style={{ marginTop: 4 }}>{po.notes}</div>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-hd">
            <h2 style={{ flex: 1 }}>Line items</h2>
            <span className="pill">{po.lines.length}</span>
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
                  <td className="muted">{l.manufacturer ?? ""}</td>
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
        </div>

        {canActOnApproval && showReject && (
          <div className="card">
            <div className="card-hd"><h3>Reject this PO</h3></div>
            <div className="card-bd">
              <label>Reason</label>
              <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} style={{ width: "100%" }} placeholder="Explain why so the requester can address it." />
              <div className="row" style={{ marginTop: 12 }}>
                <button className="danger" disabled={busy || !rejectReason.trim()} onClick={() => act(() => api.rejectPO(po.id, rejectReason))}>Confirm reject</button>
                <button className="ghost" onClick={() => setShowReject(false)}>Cancel</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
