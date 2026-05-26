import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { downloadPdf, generatePoPdf } from "../lib/po-pdf";
import { Topbar } from "./Shell";
import type { CurrentUser, PurchaseOrder } from "../../shared/types";

type Row = PurchaseOrder & { project_code: string; project_name: string };
type Activity = Awaited<ReturnType<typeof api.getPOActivity>>;

export function POView({ me }: { me: CurrentUser | null }) {
  const { id } = useParams<{ id: string }>();
  const [po, setPo] = useState<Row | null>(null);
  const [activity, setActivity] = useState<Activity>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [approveNote, setApproveNote] = useState("");

  function refresh() {
    if (!id) return;
    api.getPO(id).then((p) => setPo(p as Row)).catch((e) => setErr(e.message));
    api.getPOActivity(id).then(setActivity).catch(() => setActivity([]));
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

  const canApprove =
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
        actions={<button className="ghost" onClick={onDownloadPdf} disabled={busy}>Download PDF</button>}
      />
      <main>
        {err && <div className="flash error">{err}</div>}

        <div className="split">
          {/* Left column ─ summary, lines, activity */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <SummaryCard po={po} />

            <div className="card">
              <div className="card-hd">
                <h2 style={{ flex: 1 }}>Line items</h2>
                <span className="pill">{po.lines.length}</span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Manufacturer</th>
                    <th className="num">Qty</th>
                    <th>Unit</th>
                    <th className="num">Unit cost</th>
                    <th className="num">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {po.lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.item}
                        {(l.is_unpriced || l.is_over_budget) && (
                          <div style={{ marginTop: 4, display: "flex", gap: 6 }}>
                            {l.is_unpriced && <span className="badge unpriced">unpriced</span>}
                            {l.is_over_budget && <span className="badge over">over</span>}
                          </div>
                        )}
                      </td>
                      <td className="muted">{l.manufacturer ?? ""}</td>
                      <td className="num">{l.qty}</td>
                      <td>{l.unit}</td>
                      <td className="num">{fmtMoney(l.unit_cost)}</td>
                      <td className="num">{fmtMoney(l.line_total)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: "var(--card-2)" }}>
                    <td colSpan={5} style={{ fontWeight: 600, textAlign: "right" }}>Subtotal</td>
                    <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(po.total_value)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {activity.length > 0 && (
              <div className="card">
                <div className="card-hd"><h2>Activity</h2></div>
                <div className="card-bd">
                  <div className="activity">
                    {activity.map((a, idx) => (
                      <ActivityRow key={a.id} entry={a} highlight={idx === activity.length - 1 && po.status === "pending_approval"} />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right column ─ sticky inspector */}
          <div className="inspector">
            {canApprove && !showReject && (
              <div className="decision-card">
                <div className="eyebrow">Your decision</div>
                <h3 className="serif">Approve {po.po_number}?</h3>
                <p className="explainer">
                  This PO needs <b>{po.approval_tier?.replace("_", " ")}</b> approval — reason: {po.approval_reason?.replace("_", " ")}.
                </p>
                <textarea
                  rows={3}
                  value={approveNote}
                  onChange={(e) => setApproveNote(e.target.value)}
                  placeholder="Add a note (optional)…"
                  style={{ resize: "vertical" }}
                />
                <div className="action-stack">
                  <button
                    className="accent"
                    disabled={busy}
                    onClick={() => act(() => api.approvePO(po.id))}
                  >
                    Approve {fmtMoney(po.total_value)}
                  </button>
                  <div className="pair">
                    <button className="ghost" disabled={busy}>Request changes</button>
                    <button className="danger" disabled={busy} onClick={() => setShowReject(true)}>Reject</button>
                  </div>
                </div>
              </div>
            )}

            {canApprove && showReject && (
              <div className="card">
                <div className="card-hd"><h3>Reject {po.po_number}</h3></div>
                <div className="card-bd">
                  <label>Reason</label>
                  <textarea
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    rows={4}
                    placeholder="Explain so the requester can fix it."
                    style={{ resize: "vertical" }}
                  />
                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="danger" disabled={busy || !rejectReason.trim()} onClick={() => act(() => api.rejectPO(po.id, rejectReason))}>
                      Confirm reject
                    </button>
                    <button className="ghost" onClick={() => setShowReject(false)}>Cancel</button>
                  </div>
                </div>
              </div>
            )}

            {canIssue && (
              <div className="card">
                <div className="card-bd">
                  <div className="stat">
                    <div className="label">Approved & ready</div>
                    <div className="sub">Mark as issued when the PO has been sent to the supplier.</div>
                  </div>
                  <button className="primary" onClick={() => act(() => api.issuePO(po.id))} disabled={busy} style={{ width: "100%", marginTop: 12, justifyContent: "center" }}>
                    Mark as issued to supplier
                  </button>
                </div>
              </div>
            )}

            <ApprovalRouteCard po={po} />

            {po.requires_approval && po.approval_reason && (
              <div className="card">
                <div className="card-hd"><h3>Why approval is needed</h3></div>
                <div className="card-bd">
                  <ReasonExplainer po={po} />
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}

/* ── Sub-components ───────────────────────────────────────────────────── */

function SummaryCard({ po }: { po: PurchaseOrder & { project_code: string; project_name: string } }) {
  return (
    <div className="card">
      <div className="card-bd">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 24, alignItems: "start" }}>
          <Stat label="Supplier" value={po.supplier} />
          <Stat label="Project" value={`${po.project_code} — ${po.project_name}`} />
          <Stat label="Required by" value={po.delivery_date ? fmtDate(po.delivery_date) : "—"} sub={`Raised ${fmtDate(po.created_at)}`} />
          <div style={{ textAlign: "right" }}>
            <div className="eyebrow">Total</div>
            <div className="serif" style={{ fontSize: 30, marginTop: 6 }}>{fmtMoney(po.total_value)}</div>
            <div className="muted" style={{ fontSize: 12 }}>ex VAT</div>
          </div>
        </div>
        {po.notes && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
            <div className="eyebrow">Notes</div>
            <div style={{ marginTop: 4 }}>{po.notes}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div style={{ fontSize: 15, marginTop: 6, fontWeight: 500 }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function ApprovalRouteCard({ po }: { po: PurchaseOrder }) {
  if (!po.requires_approval) {
    return (
      <div className="card">
        <div className="card-hd"><h3>Approval route</h3></div>
        <div className="card-bd">
          <div className="approval-step done">
            <div className="avatar">✓</div>
            <div>
              <div className="who">Auto-approved</div>
              <div className="role">All lines priced and within allowance</div>
            </div>
            <span className="pill approved">approved</span>
          </div>
        </div>
      </div>
    );
  }

  const tiers: Array<{ key: "line_manager" | "commercial_manager" | "director"; label: string }> = [
    { key: "line_manager", label: "Line Manager" },
    { key: "commercial_manager", label: "Commercial Manager" },
    { key: "director", label: "Director" },
  ];
  const activeIdx = tiers.findIndex((t) => t.key === po.approval_tier);
  const isApproved = po.status === "approved" || po.status === "issued";
  const isRejected = po.status === "rejected";

  return (
    <div className="card">
      <div className="card-hd"><h3>Approval route</h3></div>
      <div className="card-bd">
        <div className="approval-route">
          {tiers.map((t, idx) => {
            const isActive = idx === activeIdx;
            const isDone = isApproved && idx <= activeIdx;
            const isRejectedHere = isRejected && idx === activeIdx;
            const stepClass = isDone ? "done" : isActive ? "now" : "next";
            return (
              <div key={t.key} className={`approval-step ${stepClass}`}>
                <div className="avatar">{isDone ? "✓" : isRejectedHere ? "✕" : idx + 1}</div>
                <div>
                  <div className="who">{t.label}</div>
                  <div className="role">
                    {isActive && po.approved_by ? po.approved_by : ""}
                    {isActive && po.rejected_by ? po.rejected_by : ""}
                    {!isActive && idx < activeIdx ? "skipped" : ""}
                    {!isActive && idx > activeIdx ? "not required" : ""}
                  </div>
                </div>
                <span className={`pill ${isDone ? "approved" : isRejectedHere ? "rejected" : isActive ? "pending dot" : "draft"}`}>
                  {isDone ? "approved" : isRejectedHere ? "rejected" : isActive ? "now" : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ReasonExplainer({ po }: { po: PurchaseOrder }) {
  const unpriced = po.lines.filter((l) => l.is_unpriced);
  const over = po.lines.filter((l) => l.is_over_budget);
  return (
    <>
      {over.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div className="eyebrow">Over priced allowance</div>
          <ul style={{ margin: "4px 0 0 18px", padding: 0, fontSize: 13 }}>
            {over.map((l) => <li key={l.id}>{l.item}</li>)}
          </ul>
        </div>
      )}
      {unpriced.length > 0 && (
        <div>
          <div className="eyebrow">Outside the priced BOQ</div>
          <ul style={{ margin: "4px 0 0 18px", padding: 0, fontSize: 13 }}>
            {unpriced.map((l) => <li key={l.id}>{l.item}</li>)}
          </ul>
        </div>
      )}
    </>
  );
}

function ActivityRow({ entry, highlight }: { entry: Activity[number]; highlight: boolean }) {
  return (
    <div className="activity-row">
      <div className={`avatar${highlight ? " accent" : ""}`}>{initials(entry.actor)}</div>
      <div className="body">
        <div><b>{entry.actor}</b> {actionVerb(entry.action)} this PO</div>
        {entry.details && tryParseQuote(entry.details) && (
          <div className="quote">“{tryParseQuote(entry.details)}”</div>
        )}
      </div>
      <div className="ts">{fmtDate(entry.created_at)}</div>
    </div>
  );
}

function actionVerb(a: string): string {
  switch (a) {
    case "created": return "raised";
    case "approved": return "approved";
    case "rejected": return "rejected";
    case "issued": return "marked as issued for";
    default: return a;
  }
}

function tryParseQuote(details: string): string | null {
  try {
    const o = JSON.parse(details);
    return o.reason ?? null;
  } catch { return null; }
}

function initials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (local.slice(0, 2) || "??").toUpperCase();
}
