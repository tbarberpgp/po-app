import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtDate, fmtMoney, fmtQty } from "../lib/api";
import { downloadPdf, generatePoPdf } from "../lib/po-pdf";
import { Topbar } from "./Shell";
import { GroupedCombobox } from "./GroupedCombobox";
import { can } from "../../shared/permissions";
import type { CurrentUser, PurchaseOrder, Supplier } from "../../shared/types";

type Row = PurchaseOrder & {
  project_code: string; project_name: string;
  call_offs?: Array<{ id: string; po_number: string; status: string; total_value: number; created_at: string }>;
  parent?: { id: string; po_number: string } | null;
};
type Activity = Awaited<ReturnType<typeof api.getPOActivity>>;

export function POView({ me }: { me: CurrentUser | null }) {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [po, setPo] = useState<Row | null>(null);
  const [activity, setActivity] = useState<Activity>([]);
  const [approvedSuppliers, setApprovedSuppliers] = useState<Supplier[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [approveNote, setApproveNote] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [showEdit, setShowEdit] = useState(false);
  // After-the-fact budget coding (retro POs): which line's picker is open, and
  // the project's live materials list (loaded on first use).
  const [assignLineId, setAssignLineId] = useState<number | null>(null);
  const [budgetMats, setBudgetMats] = useState<Awaited<ReturnType<typeof api.listMaterials>> | null>(null);
  const [assignBusy, setAssignBusy] = useState(false);
  async function openAssign(lineId: number) {
    setAssignLineId(lineId);
    if (!budgetMats && po) {
      try { setBudgetMats(await api.listMaterials(po.project_id)); } catch { setBudgetMats([]); }
    }
  }
  async function assignBudget(lineId: number, materialId: number | null) {
    if (!po) return;
    setAssignBusy(true);
    try { await api.assignPoLineBudget(po.id, lineId, materialId); setAssignLineId(null); await refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't assign the budget line"); }
    finally { setAssignBusy(false); }
  }
  // Whole-order coding: every line → the same budget line. -1 marks the
  // whole-PO picker open (line pickers use real line ids).
  async function assignWholePo(materialId: number | null) {
    if (!po) return;
    setAssignBusy(true);
    try { await api.assignPoBudget(po.id, materialId); setAssignLineId(null); await refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't assign the budget line"); }
    finally { setAssignBusy(false); }
  }
  const [notice, setNotice] = useState<string | null>(null);
  const canDelete = can(me?.role, "pos.delete");
  const canEditPO = can(me?.role, "pos.edit"); // admin / superadmin only
  const canCreatePO = can(me?.role, "pos.create");
  const canManualCheckin = can(me?.role, "delivery.checkin_manual"); // admin / superadmin only
  const [showCheckin, setShowCheckin] = useState(false);
  const calledOff = (po?.call_offs ?? []).reduce((s, k) => s + (k.total_value || 0), 0);
  const isFramework = po?.order_type === "framework";

  function refresh() {
    if (!id) return;
    api.getPO(id).then((p) => setPo(p as Row)).catch((e) => setErr(e.message));
    api.getPOActivity(id).then(setActivity).catch(() => setActivity([]));
  }
  useEffect(refresh, [id]);
  useEffect(() => {
    api.listSuppliers().then(setApprovedSuppliers).catch(() => setApprovedSuppliers([]));
  }, []);

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
      const bytes = await generatePoPdf({ ...po, parent_po_number: po.parent?.po_number ?? null });
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
  const canIssue = po.status === "approved" && me?.email === po.created_by && can(me?.role, "pos.issue");
  const isDeleted = po.status === "deleted";
  // Approved-supplier register status for this PO's supplier (same banners as New PO).
  const supplierRecord = approvedSuppliers.find((s) => s.name.toLowerCase() === po.supplier.trim().toLowerCase()) ?? null;

  return (
    <>
      <Topbar
        crumbs={<><Link to="/pos">Purchase orders</Link> / {po.po_number}</>}
        title={po.po_number}
        status={
          <>
            <span className={`pill ${po.status} dot`} style={{ verticalAlign: "middle" }}>{po.status.replace("_", " ")}</span>
            {po.order_type === "framework" && <span className="pill info" style={{ verticalAlign: "middle", marginLeft: 6 }}>Framework</span>}
            {po.order_type === "call_off" && <span className="pill neutral" style={{ verticalAlign: "middle", marginLeft: 6 }}>Call-off</span>}
            {po.category === "prelims" && <span className="pill warn" style={{ verticalAlign: "middle", marginLeft: 6 }}>Prelims</span>}
            {po.paid_at && <span className="pill approved" style={{ verticalAlign: "middle", marginLeft: 6 }}>Paid</span>}
            {!!po.part_delivery && <span className="pill warn" style={{ verticalAlign: "middle", marginLeft: 6 }} title="Ordered as one drop but the supplier is delivering it piecemeal — partial receipts are expected">Arriving in parts</span>}
          </>
        }
        actions={
          <>
            <button className="ghost" onClick={onDownloadPdf} disabled={busy}>Download PDF</button>
            {canEditPO && !isDeleted && (
              <button className="ghost" onClick={() => setShowEdit(true)} disabled={busy} title="Amend this purchase order (admin)">Edit</button>
            )}
            {canCreatePO && !isDeleted && po.order_type !== "framework" && (
              <button className="ghost" disabled={busy} title="Ordered whole but the supplier is delivering it piecemeal — flags the order so partial receipts read as expected"
                onClick={async () => { try { await api.setPoPartDelivery(po.id, !po.part_delivery); refresh(); } catch { /* surfaced on reload */ } }}>
                {po.part_delivery ? "Unmark arriving in parts" : "Mark as arriving in parts"}
              </button>
            )}
            {canManualCheckin && !isDeleted && po.order_type !== "framework" && (po.status === "approved" || po.status === "issued") && (
              <button className="ghost" disabled={busy}
                title="Log goods received with NO delivery ticket (admin only) — flagged as a manual check-in"
                onClick={() => setShowCheckin(true)}>
                Check in — no ticket
              </button>
            )}
            {po.order_type === "framework" && canCreatePO && !isDeleted && (
              <button className="accent" onClick={() => nav(`/projects/${po.project_id}/new-po?framework=${po.id}`)} disabled={busy}>Create call-off</button>
            )}
            {po.order_type !== "framework" && !po.parent_po_id && canCreatePO && !isDeleted && (
              <button className="ghost" onClick={() => act(() => api.makeFramework(po.id))} disabled={busy} title="Turn this into a framework/blanket order. Once it's a framework, a 'Create call-off' button appears here to draw call-off orders against it.">Make framework (for call-offs)</button>
            )}
            {canCreatePO && !isDeleted && (
              <button className="ghost" onClick={() => act(() => api.setPoCategory(po.id, po.category === "prelims" ? "materials" : "prelims"))} disabled={busy} title="Tag this PO's spend as preliminaries or materials">
                {po.category === "prelims" ? "Tag as materials" : "Tag as prelim"}
              </button>
            )}
            {canDelete && !isDeleted && (
              <button className="danger" onClick={() => setShowDelete(true)} disabled={busy}>Delete PO</button>
            )}
          </>
        }
      />
      <main>
        {err && <div className="flash error">{err}</div>}
        {notice && <div className="flash info">{notice}</div>}

        {isDeleted && (
          <div className="flash error">
            <b>Deleted</b> by {po.deleted_by} on {fmtDate(po.deleted_at)}
            {po.deletion_reason && <> — “{po.deletion_reason}”</>}.
            This PO no longer counts against project committed budget.
          </div>
        )}

        {!isDeleted && supplierRecord?.status === "suspended" && (
          <div className="flash error">
            <b>{po.supplier}</b> is currently <b>suspended</b> in the approved-suppliers register. Speak to admin before progressing this PO.
          </div>
        )}
        {!isDeleted && supplierRecord?.status === "pending" && (
          <div className="flash info">
            <b>{po.supplier}</b> is still in onboarding (pending). Credit terms may not be set up yet — check before issuing.
          </div>
        )}
        {!isDeleted && !supplierRecord && approvedSuppliers.length > 0 && (
          <div className="flash info">
            <b>{po.supplier}</b> isn't in the <Link to="/suppliers">approved suppliers</Link> register.
            Adding them gives you payment terms, scope and contact details on future POs.
          </div>
        )}

        {po.xero_sync_status === "synced" && po.xero_po_number && (
          <div className="flash success" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="pill issued" style={{ fontSize: 11 }}>Xero</span>
            <span>Posted to Xero as <b>{po.xero_po_number}</b> on {fmtDate(po.xero_synced_at)} — AP can match incoming invoices to it.</span>
          </div>
        )}
        {po.xero_sync_status === "failed" && (
          <div className="flash error" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="pill rejected" style={{ fontSize: 11 }}>Xero</span>
            <span>Xero push failed: {po.xero_sync_error}</span>
            <span className="muted" style={{ fontSize: 12 }}>Click <b>Retry Xero push</b> above when fixed.</span>
          </div>
        )}
        {po.paid_at && (
          <div className="flash success" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="pill approved" style={{ fontSize: 11 }}>Paid</span>
            <span>Settled in Xero{po.paid_reference ? <> (bill <b>{po.paid_reference}</b>)</> : null} on {fmtDate(po.paid_at)}.</span>
          </div>
        )}

        {po.order_type === "call_off" && po.parent && (
          <div className="flash info" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="pill neutral" style={{ fontSize: 11 }}>Call-off</span>
            <span>Drawn down against framework order <Link to={`/pos/${po.parent.id}`}><b>{po.parent.po_number}</b></Link>.</span>
          </div>
        )}

        {po.order_type === "framework" && (
          <div className="card" style={{ padding: 16, marginBottom: 16 }}>
            <div className="ops-notice-head" style={{ marginBottom: 8 }}>
              <span className="pill info">Framework order</span>
              <span className="muted" style={{ fontSize: 12 }}>Call-offs draw down against this blanket order. Not posted to Xero — each call-off is pushed individually.</span>
            </div>
            <div className="kpis" style={{ marginBottom: 12 }}>
              <div className="kpi"><div className="kpi-label">Agreed total</div><div className="kpi-value">{fmtMoney(po.total_value)}</div></div>
              <div className="kpi"><div className="kpi-label">Called off</div><div className="kpi-value">{fmtMoney(calledOff)}</div><div className="kpi-sub">{(po.call_offs ?? []).length} call-off{(po.call_offs ?? []).length === 1 ? "" : "s"}</div></div>
              <div className={`kpi${po.total_value - calledOff < 0 ? " tone-danger" : ""}`}><div className="kpi-label">Remaining</div><div className="kpi-value">{fmtMoney(po.total_value - calledOff)}</div></div>
            </div>
            {(po.call_offs ?? []).length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>No call-offs yet — use <b>Create call-off</b> above to draw against this order.</div>
            ) : (
              <table>
                <thead><tr><th>Call-off</th><th className="center">Status</th><th className="num">Value</th><th>Raised</th></tr></thead>
                <tbody>
                  {(po.call_offs ?? []).map((k) => (
                    <tr key={k.id}>
                      <td><Link to={`/pos/${k.id}`}>{k.po_number}</Link></td>
                      <td className="center"><span className={`pill ${k.status}`}>{k.status.replace("_", " ")}</span></td>
                      <td className="num">{fmtMoney(k.total_value)}</td>
                      <td className="muted">{fmtDate(k.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {showDelete && (
          <div className="card">
            <div className="card-hd"><h3>Delete {po.po_number}</h3></div>
            <div className="card-bd">
              <p className="muted" style={{ marginTop: 0 }}>
                This soft-deletes the PO. It disappears from lists and stops counting against
                the project's committed budget, but the audit trail is preserved. Only a
                Superadmin can do this.
              </p>
              <label>Reason (required)</label>
              <textarea
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                rows={3}
                placeholder="e.g. raised in error, duplicate of PO-XXX, supplier cancelled, etc."
                style={{ resize: "vertical" }}
              />
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  className="danger"
                  disabled={busy || !deleteReason.trim()}
                  onClick={() => act(async () => {
                    await api.deletePO(po.id, deleteReason.trim());
                    nav("/pos");
                  })}
                >
                  Confirm delete
                </button>
                <button className="ghost" onClick={() => setShowDelete(false)}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {showEdit && (
          <POEditModal
            po={po}
            supplierNames={approvedSuppliers.map((s) => s.name)}
            onCancel={() => setShowEdit(false)}
            onSaved={(msg) => { setShowEdit(false); setErr(null); setNotice(msg); refresh(); }}
            onError={(m) => setErr(m)}
          />
        )}

        {showCheckin && (
          <ManualCheckInModal
            po={po}
            onClose={() => setShowCheckin(false)}
            onDone={(msg) => { setShowCheckin(false); setNotice(msg); refresh(); }}
          />
        )}

        <div className="split">
          {/* Left column ─ summary, lines, activity */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <SummaryCard po={po} />

            <div className="card">
              <div className="card-hd">
                <h2 style={{ flex: 1 }}>Line items</h2>
                {canEditPO && !isDeleted && po.lines.length > 1 && assignLineId == null && (
                  <button className="ghost tiny" title="Code every line on this PO to the same budget line" onClick={() => openAssign(-1)}>Assign whole PO to budget…</button>
                )}
                <span className="pill">{po.lines.length}</span>
              </div>
              {canEditPO && assignLineId != null && (() => {
                const target = assignLineId === -1 ? null : po.lines.find((x) => x.id === assignLineId) ?? null;
                const mats = budgetMats ?? [];
                const byGroup = new Map<string, typeof mats>();
                for (const m of mats) {
                  const g = m.element_name || m.type || "Other";
                  if (!byGroup.has(g)) byGroup.set(g, []);
                  byGroup.get(g)!.push(m);
                }
                const groups = [
                  { label: "", options: [{ value: "", label: "— Not coded to the budget —" }] },
                  ...[...byGroup.entries()].map(([label, ms]) => ({
                    label,
                    options: ms.map((m) => ({
                      value: String(m.id),
                      label: m.item,
                      hint: [m.element_code, m.total_qty != null ? `${m.total_qty}${m.rate_unit ? ` ${m.rate_unit}` : ""} budgeted` : null].filter(Boolean).join(" · ") || undefined,
                    })),
                  })),
                ];
                return (
                  <div style={{ padding: "8px 14px", display: "grid", gap: 6, maxWidth: 480, borderBottom: "1px solid var(--line)" }}>
                    <div className="eyebrow" style={{ fontSize: 11 }}>
                      {target ? <>Coding “{target.item}” to the budget</> : "Coding the whole order to one budget line"}
                    </div>
                    <GroupedCombobox
                      groups={groups}
                      value={target?.material_id != null ? String(target.material_id) : ""}
                      onChange={(v) => (assignLineId === -1 ? assignWholePo(v ? Number(v) : null) : assignBudget(assignLineId, v ? Number(v) : null))}
                      placeholder={budgetMats == null ? "Loading budget lines…" : target ? "Pick the budget line this cost belongs to…" : "Pick the budget line for the whole order…"}
                      searchPlaceholder="Search the materials budget…"
                      ariaLabel={target ? `Budget line for ${target.item}` : "Budget line for the whole PO"}
                    />
                    <div><button className="ghost tiny" disabled={assignBusy} onClick={() => setAssignLineId(null)}>Cancel</button></div>
                  </div>
                );
              })()}
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Manufacturer</th>
                    <th className="num">{isFramework ? "Ordered" : "Qty"}</th>
                    {isFramework && <th className="num">Called off</th>}
                    {isFramework && <th className="num">Remaining</th>}
                    <th className="center">Unit</th>
                    <th className="num">Unit cost</th>
                    <th className="num">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {po.lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.item}
                        {l.cost_code && (
                          <div className="muted" style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", marginTop: 2 }}>
                            {l.cost_code}
                          </div>
                        )}
                        {(l.is_unpriced || l.is_over_budget) && (
                          <div style={{ marginTop: 4, display: "flex", gap: 6 }}>
                            {l.is_unpriced && (l.material_id != null
                              ? <span className="badge" title="Off-BOQ wording, but coded to a budget line — it counts against that budget">coded ✓</span>
                              : <span className="badge unpriced">unpriced</span>)}
                            {l.is_over_budget && <span className="badge over">over</span>}
                          </div>
                        )}
                        {canEditPO && !isDeleted && l.id != null && (
                          l.material_id == null
                            ? <button className="ghost tiny" style={{ marginTop: 4 }} title="Code this line to a budget line so it counts inside the project budget" onClick={() => openAssign(l.id!)}>＋ Assign to budget</button>
                            : <button className="ghost tiny" style={{ marginTop: 4, opacity: 0.7 }} title="Change which budget line this is coded to" onClick={() => openAssign(l.id!)}>Recode budget line</button>
                        )}
                      </td>
                      <td className="muted">{l.manufacturer ?? ""}</td>
                      <td className="num">{fmtQty(l.qty)}</td>
                      {isFramework && (() => {
                        const ordered = Number(l.qty) || 0;
                        const co = l.called_off_qty ?? 0;
                        const remaining = l.available_qty ?? Math.max(0, ordered - co);
                        const pct = ordered > 0 ? Math.min(100, (co / ordered) * 100) : 0;
                        const over = co - ordered > 1e-4;
                        return (
                          <>
                            <td className="num" style={over ? { color: "var(--danger)" } : undefined}>
                              {fmtQty(co)}
                              <div className="bar layered" style={{ height: 4, marginTop: 4 }} title={`${fmtQty(co)} of ${fmtQty(ordered)} ${l.unit} called off`}>
                                <div className="u-reserved" style={{ width: "100%" }} />
                                <div className={over ? "danger" : "accent"} style={{ width: `${pct}%` }} />
                              </div>
                            </td>
                            <td className="num">{fmtQty(remaining)}</td>
                          </>
                        );
                      })()}
                      <td className="center">{l.unit}</td>
                      <td className="num">{fmtMoney(l.unit_cost)}</td>
                      <td className="num">{fmtMoney(l.line_total)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: "var(--card-2)" }}>
                    <td colSpan={isFramework ? 7 : 5} style={{ fontWeight: 600, textAlign: "right" }}>Subtotal</td>
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

/* ── Admin PO edit modal (header + lines) ──────────────────────────────── */

type EditLine = {
  material_id: number | null;
  item: string;
  type: string | null;
  manufacturer: string | null;
  qty: string;        // kept as strings while editing the inputs
  unit: string;
  unit_cost: string;
};

function POEditModal({
  po, supplierNames, onCancel, onSaved, onError,
}: {
  po: Row;
  supplierNames: string[];
  onCancel: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [supplier, setSupplier] = useState(po.supplier ?? "");
  const [deliveryDate, setDeliveryDate] = useState(po.delivery_date ? po.delivery_date.slice(0, 10) : "");
  const [notes, setNotes] = useState(po.notes ?? "");
  const [category, setCategory] = useState<"materials" | "prelims">(po.category === "prelims" ? "prelims" : "materials");
  const [lines, setLines] = useState<EditLine[]>(
    (po.lines ?? []).map((l) => ({
      material_id: l.material_id ?? null,
      item: l.item ?? "",
      type: l.type ?? null,
      manufacturer: l.manufacturer ?? null,
      qty: String(l.qty ?? ""),
      unit: l.unit ?? "",
      unit_cost: String(l.unit_cost ?? ""),
    })),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const listId = `po-edit-suppliers-${po.id}`;

  const setLine = (i: number, patch: Partial<EditLine>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () =>
    setLines((ls) => [...ls, { material_id: null, item: "", type: null, manufacturer: null, qty: "", unit: "", unit_cost: "" }]);
  const removeLine = (i: number) => setLines((ls) => ls.filter((_, idx) => idx !== i));

  const total = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_cost) || 0), 0);
  const valid = supplier.trim() !== "" && lines.length > 0 &&
    lines.every((l) => l.item.trim() !== "" && l.qty !== "" && l.unit_cost !== "");

  async function save() {
    if (!valid) { setErr("Every line needs an item, quantity and unit cost, and a supplier is required."); return; }
    setBusy(true); setErr(null);
    try {
      const res = await api.updatePO(po.id, {
        supplier: supplier.trim(),
        notes: notes.trim() || null,
        delivery_date: deliveryDate || null,
        category,
        lines: lines.map((l) => ({
          material_id: l.material_id,
          item: l.item.trim(),
          type: l.type,
          manufacturer: l.manufacturer,
          qty: Number(l.qty),
          unit: l.unit.trim(),
          unit_cost: Number(l.unit_cost),
        })),
      });
      const xeroMsg = res.xero
        ? res.xero.ok
          ? " The linked Xero PO was updated too."
          : ` But the Xero update failed: ${res.xero.error ?? "unknown error"} — re-push from this page once resolved.`
        : "";
      onSaved(`PO updated.${xeroMsg}`);
    } catch (e) {
      const m = e instanceof Error ? e.message : "save failed";
      setErr(m); onError(m);
    } finally { setBusy(false); }
  }

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(15,17,48,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
      onClick={onCancel}
    >
      <div className="card" style={{ maxWidth: 760, width: "calc(100% - 32px)", maxHeight: "calc(100vh - 64px)", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div className="card-hd">
          <h3 style={{ flex: 1 }}>Edit {po.po_number}</h3>
          <span className={`pill ${po.status} dot`}>{po.status.replace("_", " ")}</span>
        </div>
        <div className="card-bd">
          {err && <div className="flash error" style={{ marginBottom: 8 }}>{err}</div>}
          <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
            Admin edit — {po.project_code} {po.project_name}. The project and any framework/call-off link stay as they are, and the PO keeps its current status.
            {po.xero_sync_status === "synced" && <> Saving will also update the linked Xero draft.</>}
          </div>

          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 240px" }}>
              <label>Supplier</label>
              <input value={supplier} onChange={(e) => setSupplier(e.target.value)} list={listId} placeholder="Pick or type a supplier" />
              <datalist id={listId}>{supplierNames.map((n) => <option key={n} value={n} />)}</datalist>
            </div>
            <div style={{ flex: "0 1 160px" }}>
              <label>Delivery date</label>
              <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
            </div>
            <div style={{ flex: "0 1 150px" }}>
              <label>Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value as "materials" | "prelims")}>
                <option value="materials">Materials</option>
                <option value="prelims">Preliminaries</option>
              </select>
            </div>
          </div>

          <div style={{ marginTop: 8 }}>
            <label>Notes</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional note shown on the PO" />
          </div>

          <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>Line items</div>
          <table className="po-edit-lines">
            <thead><tr><th>Item</th><th className="num">Qty</th><th>Unit</th><th className="num">Unit cost £</th><th className="num">Line</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td><input value={l.item} onChange={(e) => setLine(i, { item: e.target.value })} placeholder="Description" style={{ width: "100%" }} /></td>
                  <td className="num"><input type="number" step="any" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} style={{ width: 76, textAlign: "right" }} /></td>
                  <td><input value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} placeholder="ea" style={{ width: 64 }} /></td>
                  <td className="num"><input type="number" step="any" value={l.unit_cost} onChange={(e) => setLine(i, { unit_cost: e.target.value })} style={{ width: 90, textAlign: "right" }} /></td>
                  <td className="num">{fmtMoney((Number(l.qty) || 0) * (Number(l.unit_cost) || 0))}</td>
                  <td><button className="ghost tiny" onClick={() => removeLine(i)} title="Remove line" disabled={lines.length <= 1}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="ghost tiny" onClick={addLine} style={{ marginTop: 8 }}>+ Add line</button>

          <div className="row" style={{ justifyContent: "flex-end", marginTop: 12, fontWeight: 700 }}>
            Total {fmtMoney(total)}<span className="muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: 6 }}>ex VAT</span>
          </div>
        </div>
        <div className="card-hd" style={{ borderTop: "1px solid var(--line)", borderBottom: "none" }}>
          <div style={{ flex: 1 }} />
          <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>{" "}
          <button className="accent" onClick={save} disabled={busy || !valid}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      </div>
    </div>
  );
}

/* ── Manual check-in (no delivery ticket) — admin only ──────────────────────
   Logs goods received when the paperwork never arrived (or is lost). Whole
   order in one tick, or received quantities per line; the record is flagged
   as a manual check-in and feeds the normal delivery burn-down. */
function ManualCheckInModal({ po, onClose, onDone }: {
  po: Row;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [wholeOrder, setWholeOrder] = useState(false);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lines = po.lines.filter((l) => l.id != null);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const entered = lines
        .map((l) => ({ line: l, v: Number((qty[l.id!] ?? "").trim()) }))
        .filter((x) => Number.isFinite(x.v) && x.v > 0);
      if (!wholeOrder && entered.length === 0) {
        setErr("Enter a received quantity for at least one line, or tick “whole order delivered”.");
        setBusy(false);
        return;
      }
      await api.manualDeliveryCheckIn(po.project_id, {
        po_id: po.id,
        whole_order: wholeOrder,
        delivered_at: `${date}T12:00:00.000Z`,
        notes: note.trim() || undefined,
        lines: wholeOrder ? undefined : entered.map((x) => ({
          po_line_id: x.line.id!,
          po_line_desc: x.line.item,
          received_qty: x.v,
          received_unit: x.line.unit ?? undefined,
        })),
      });
      onDone(wholeOrder ? "Whole order checked in (manual — no ticket)." : `${entered.length} line${entered.length === 1 ? "" : "s"} checked in (manual — no ticket).`);
    } catch (e) { setErr(e instanceof Error ? e.message : "check-in failed"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,17,48,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1400 }}
      onClick={() => !busy && onClose()}>
      <div className="card" style={{ maxWidth: 560, width: "calc(100% - 32px)", maxHeight: "calc(100vh - 64px)", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div className="card-hd"><h3 style={{ flex: 1 }}>Check in — no delivery ticket</h3></div>
        <div className="card-bd">
          {err && <div className="flash error" style={{ marginBottom: 10 }}>{err}</div>}
          <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
            For goods that arrived without paperwork. The delivery is logged against {po.po_number} flagged
            as a <b>manual check-in</b> with your name on it — if a ticket turns up later, check it in through
            Deliveries as usual.
          </p>
          <label className="row" style={{ gap: 8, fontSize: 13.5, marginBottom: 10 }}>
            <input type="checkbox" style={{ minHeight: 0 }} checked={wholeOrder} onChange={(e) => setWholeOrder(e.target.checked)} />
            Whole order delivered — mark every line complete
          </label>
          {!wholeOrder && (
            <table style={{ marginBottom: 10 }}>
              <thead>
                <tr><th>Line</th><th className="num">Ordered</th><th className="num" style={{ width: 130 }}>Received now</th></tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td style={{ fontSize: 13 }}>{l.item}</td>
                    <td className="num">{l.qty ?? "—"}{l.unit ? ` ${l.unit}` : ""}</td>
                    <td className="num">
                      <input className="input" inputMode="decimal" placeholder="0" value={qty[l.id!] ?? ""}
                        onChange={(e) => setQty((prev) => ({ ...prev, [l.id!]: e.target.value }))} style={{ maxWidth: 110, textAlign: "right" }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <label className="field" style={{ width: 170 }}>
              <span>Delivered on</span>
              <input className="input" type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)}
                onClick={(e) => { try { (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.(); } catch { /* typed entry still works */ } }} />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 220 }}>
              <span>Why is there no ticket? (kept on the record)</span>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. driver left no paperwork" />
            </label>
          </div>
        </div>
        <div className="card-hd" style={{ borderTop: "1px solid var(--line)", borderBottom: "none" }}>
          <div className="grow" />
          <button className="ghost" onClick={onClose} disabled={busy}>Cancel</button>{" "}
          <button className="accent" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Check in"}</button>
        </div>
      </div>
    </div>
  );
}
