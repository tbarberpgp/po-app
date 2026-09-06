import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtDate, fmtMoney, fmtQty } from "../lib/api";
import { downloadPdf, generatePoPdf } from "../lib/po-pdf";
import { Topbar } from "./Shell";
import { GroupedCombobox } from "./GroupedCombobox";
import { can } from "../../shared/permissions";
import type { CurrentUser, PoDeliveryDrop, PurchaseOrder, Supplier } from "../../shared/types";
import { poDeliveryLabel } from "../../shared/po-delivery-status";

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
  // Line-item filter. Big framework orders run to a hundred-odd lines, so let
  // people find a material on the order without scrolling it.
  const [lineQ, setLineQ] = useState("");
  // After-the-fact budget coding (retro POs): which line's picker is open, and
  // the project's live materials list (loaded on first use).
  const [assignLineId, setAssignLineId] = useState<number | null>(null);
  // Which lines' delivery history is expanded — "93 received" on its own
  // doesn't say whether that's one drop or five, or let anyone go check the
  // paperwork behind any of them.
  const [openDeliveries, setOpenDeliveries] = useState<Set<number>>(new Set());
  function toggleDeliveries(lineId: number) {
    setOpenDeliveries((s) => {
      const next = new Set(s);
      next.has(lineId) ? next.delete(lineId) : next.add(lineId);
      return next;
    });
  }
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

  // An amend after rejection can leave a PO with no tier at all; the worker
  // then accepts any approver, so mirror that here rather than hiding the
  // button on a PO the API would let you approve.
  const holdsTier = po.approval_tier != null
    ? me?.approver_tiers.includes(po.approval_tier) ?? false
    : me?.is_approver ?? false;
  // A rejection isn't the end of the road: the approver who turned a PO down
  // can change their mind and approve it here, which overturns the rejection.
  const wasRejected = po.status === "rejected";
  const canApprove =
    (po.status === "pending_approval" || wasRejected) &&
    me?.is_approver &&
    holdsTier;
  const canIssue = po.status === "approved" && me?.email === po.created_by && can(me?.role, "pos.issue");
  const isDeleted = po.status === "deleted";
  // Approved-supplier register status for this PO's supplier (same banners as New PO).
  const supplierRecord = approvedSuppliers.find((s) => s.name.toLowerCase() === po.supplier.trim().toLowerCase()) ?? null;

  // Line search runs over the lines already loaded — no round-trip per
  // keystroke. Match on item wording, manufacturer, cost code and budget type,
  // and require every term to hit somewhere, so "alumasc bracket" narrows
  // rather than widens.
  const lineTerms = lineQ.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const lineFilterActive = lineTerms.length > 0;
  const shownLines = !lineFilterActive ? po.lines : po.lines.filter((l) => {
    const hay = `${l.item ?? ""} ${l.manufacturer ?? ""} ${l.cost_code ?? ""} ${l.type ?? ""}`.toLowerCase();
    return lineTerms.every((t) => hay.includes(t));
  });
  const shownLinesTotal = shownLines.reduce((s, l) => s + (Number(l.line_total) || 0), 0);

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
              <div className="card-hd" style={{ flexWrap: "wrap", gap: 8 }}>
                <h2 style={{ flex: 1 }}>Line items</h2>
                {po.lines.length > 1 && (
                  <>
                    <input
                      className="input"
                      value={lineQ}
                      onChange={(e) => setLineQ(e.target.value)}
                      placeholder="Search items, manufacturer, code…"
                      aria-label={`Search the line items on ${po.po_number}`}
                      style={{ width: 240, maxWidth: "45%" }}
                    />
                    {lineQ && <button className="ghost tiny" onClick={() => setLineQ("")}>Clear</button>}
                  </>
                )}
                {canEditPO && !isDeleted && po.lines.length > 1 && assignLineId == null && (
                  <button className="ghost tiny" title="Code every line on this PO to the same budget line" onClick={() => openAssign(-1)}>Assign whole PO to budget…</button>
                )}
                <span className="pill">{lineFilterActive ? `${shownLines.length} of ${po.lines.length}` : po.lines.length}</span>
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
                    {isFramework && <th className="num">Qty left</th>}
                    {isFramework && <th className="num">Budget left</th>}
                    <th className="center">Unit</th>
                    <th className="num">Unit cost</th>
                    <th className="num">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {shownLines.map((l) => {
                    const ordered = Number(l.qty) || 0;
                    const co = l.called_off_qty ?? 0;
                    const remaining = l.available_qty ?? ordered - co;
                    const pct = ordered > 0 ? Math.min(100, (co / ordered) * 100) : 0;
                    const frameworkValue = Number(l.line_total) || 0;
                    const spentValue = l.called_off_value ?? 0;
                    const remainingValue = l.available_value ?? frameworkValue - spentValue;
                    const qtyOver = isFramework && co - ordered > 1e-4;
                    const valueOver = isFramework && spentValue - frameworkValue > 0.005;
                    const frameworkOver = qtyOver || valueOver;
                    return (
                    <tr key={l.id}>
                      <td>
                        {l.item}
                        {l.cost_code && (
                          <div className="muted" style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", marginTop: 2 }}>
                            {l.cost_code}
                          </div>
                        )}
                        {(l.is_unpriced || l.is_over_budget || frameworkOver) && (
                          <div style={{ marginTop: 4, display: "flex", gap: 6 }}>
                            {l.is_unpriced && (l.material_id != null
                              ? <span className="badge" title="Off-BOQ wording, but coded to a budget line — it counts against that budget">coded ✓</span>
                              : <span className="badge unpriced">unpriced</span>)}
                            {l.is_over_budget && <span className="badge over">over</span>}
                            {frameworkOver && (
                              <span
                                className="badge over"
                                title={[
                                  qtyOver ? `${fmtQty(co - ordered)} ${l.unit} more has been called off than this framework line allows` : null,
                                  valueOver ? `£${(spentValue - frameworkValue).toFixed(2)} more has been spent than this framework line's budgeted value` : null,
                                ].filter(Boolean).join(" — ")}
                              >
                                overdrawn
                              </span>
                            )}
                          </div>
                        )}
                        {canEditPO && !isDeleted && l.id != null && (
                          l.material_id == null
                            ? <button className="ghost tiny" style={{ marginTop: 4 }} title="Code this line to a budget line so it counts inside the project budget" onClick={() => openAssign(l.id!)}>＋ Assign to budget</button>
                            : <button className="ghost tiny" style={{ marginTop: 4, opacity: 0.7 }} title="Change which budget line this is coded to" onClick={() => openAssign(l.id!)}>Recode budget line</button>
                        )}
                        {(l.deliveries?.length ?? 0) > 0 && l.id != null && (() => {
                          // Notes, not receipt rows: one note can book this line
                          // in several times over (a scheme line takes a row per
                          // component), and "9 deliveries" for one van reads as
                          // nine visits.
                          const noteCount = new Set(l.deliveries!.map((d) => d.note)).size;
                          return (
                          <div style={{ marginTop: 4 }}>
                            <button className="ghost tiny" onClick={() => toggleDeliveries(l.id!)}>
                              {fmtQty(l.received_qty ?? 0)} {l.unit} received · {noteCount} delivery note{noteCount === 1 ? "" : "s"} {openDeliveries.has(l.id) ? "▾" : "▸"}
                            </button>
                            {openDeliveries.has(l.id) && (
                              <div style={{ marginTop: 4, display: "grid", gap: 2 }}>
                                {l.deliveries!.map((d, i) => {
                                  // The note's ticket and number head its first
                                  // row only — repeating them down nine rows of
                                  // one ticket is what made it look like nine.
                                  // Receipts arrive grouped by note (ordered by
                                  // delivery date then id), so the row before
                                  // settles it.
                                  const heads = i === 0 || l.deliveries![i - 1].note !== d.note;
                                  return (
                                  <div key={i} className="muted" style={{ fontSize: 11.5, display: "flex", gap: 8, alignItems: "center" }}>
                                    {!heads
                                      ? <span style={{ width: 36, flex: "0 0 auto" }} />
                                      : d.ticket_url
                                        ? <TicketThumb url={d.ticket_url} type={d.ticket_type} label={d.dn ? `DN ${d.dn}` : "Delivery note"} size={36} />
                                        : <NoTicketBox size={36} />}
                                    <span style={{ minWidth: 90 }}>{!heads ? "" : d.dn ? `DN ${d.dn}` : `Manual${d.by ? ` · ${d.by.split("@")[0]}` : ""}`}</span>
                                    <span className="num">{fmtQty(d.qty)}{d.unit ? ` ${d.unit}` : ""}</span>
                                    <span>{heads ? fmtDate(d.date) : ""}</span>
                                    {d.duplicate && (
                                      <span
                                        className="badge over"
                                        title="Same line and quantity as a receipt from an earlier check-in of this note — most likely counted twice"
                                      >
                                        possible duplicate
                                      </span>
                                    )}
                                  </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                          );
                        })()}
                      </td>
                      <td className="muted">{l.manufacturer ?? ""}</td>
                      <td className="num">{fmtQty(l.qty)}</td>
                      {isFramework && (
                        <>
                          <td className="num" style={qtyOver ? { color: "var(--danger)" } : undefined}>
                            {fmtQty(co)}
                            <div className="bar layered" style={{ height: 4, marginTop: 4 }} title={`${fmtQty(co)} of ${fmtQty(ordered)} ${l.unit} called off`}>
                              <div className="u-reserved" style={{ width: "100%" }} />
                              <div className={qtyOver ? "danger" : "accent"} style={{ width: `${pct}%` }} />
                            </div>
                          </td>
                          <td className="num" style={qtyOver ? { color: "var(--danger)", fontWeight: 600 } : undefined}>{fmtQty(remaining)}</td>
                          <td className="num" style={valueOver ? { color: "var(--danger)", fontWeight: 600 } : undefined} title={`£${spentValue.toFixed(2)} of £${frameworkValue.toFixed(2)} budgeted spent`}>
                            {fmtMoney(remainingValue)}
                          </td>
                        </>
                      )}
                      <td className="center">{l.unit}</td>
                      <td className="num">{fmtMoney(l.unit_cost)}</td>
                      <td className="num">{fmtMoney(l.line_total)}</td>
                    </tr>
                    );
                  })}
                  {shownLines.length === 0 && (
                    <tr>
                      <td colSpan={isFramework ? 9 : 6} className="muted" style={{ padding: 24, textAlign: "center" }}>
                        Nothing on this order matches “{lineQ.trim()}”.{" "}
                        <button className="ghost tiny" onClick={() => setLineQ("")}>Clear</button>
                      </td>
                    </tr>
                  )}
                  <tr style={{ background: "var(--card-2)" }}>
                    <td colSpan={isFramework ? 8 : 5} style={{ fontWeight: 600, textAlign: "right" }}>
                      {lineFilterActive
                        ? <>Matching lines <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>— whole PO {fmtMoney(po.total_value)}</span></>
                        : "Subtotal"}
                    </td>
                    <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(lineFilterActive ? shownLinesTotal : po.total_value)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <DeliveriesCard po={po} />

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
                <div className="eyebrow">{wasRejected ? "Changed your mind?" : "Your decision"}</div>
                <h3 className="serif">Approve {po.po_number}?</h3>
                {wasRejected ? (
                  <p className="explainer">
                    This PO was <b>rejected</b>
                    {po.rejected_by ? <> by {po.rejected_by === me?.email ? "you" : po.rejected_by}</> : null}
                    {po.rejected_at ? <> on {fmtDate(po.rejected_at)}</> : null}
                    {po.rejection_reason ? <> — “{po.rejection_reason}”</> : null}.
                    Approving now overturns that: {po.created_by} is told it's approved and the
                    order can be issued. The rejection stays in the activity trail below.
                  </p>
                ) : (
                  <p className="explainer">
                    This PO needs <b>{po.approval_tier?.replace("_", " ")}</b> approval — reason: {po.approval_reason?.replace("_", " ")}.
                  </p>
                )}
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
                    {wasRejected ? "Approve anyway" : "Approve"} {fmtMoney(po.total_value)}
                  </button>
                  {!wasRejected && (
                    <div className="pair">
                      <button className="ghost" disabled={busy}>Request changes</button>
                      <button className="danger" disabled={busy} onClick={() => setShowReject(true)}>Reject</button>
                    </div>
                  )}
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

/* ── The delivery note itself ─────────────────────────────────────────────
   A DN number is a reference to a piece of paper, and the paper is what
   settles an argument about what actually turned up. The thumbnail sits
   inline with the receipt and opens full size, so checking the ticket never
   means leaving the order to go and find it.

   The crop is anchored to the TOP of the photo on purpose: that is where the
   letterhead and the note number are, so a square thumbnail of a portrait
   ticket is still recognisable as which ticket it is. A PDF can't be
   thumbnailed in the page, and an image that fails to load shouldn't leave a
   broken icon behind — both fall back to a plain link. */
function TicketThumb(
  { url, type, label, size, kind = "ticket" }:
  { url: string; type: string | null; label: string; size: number; kind?: "ticket" | "invoice" },
) {
  const [lb, setLb] = useState(false);
  const [broken, setBroken] = useState(false);
  const isPdf = /pdf/i.test(type ?? "") || /\.pdf(\?|$)/i.test(url);
  // Goods collected from a counter are evidenced by the supplier's invoice, so
  // the same component shows it — calling it a ticket in the fallback would
  // name the wrong document.
  const noun = kind === "invoice" ? "invoice" : "ticket";

  useEffect(() => {
    if (!lb) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLb(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lb]);

  if (isPdf || broken) {
    return (
      <a className="ghost tiny" href={url} target="_blank" rel="noreferrer" style={{ flex: "0 0 auto" }}>
        {isPdf ? `${kind === "invoice" ? "Invoice" : "Ticket"} (PDF) ↗` : `Open ${noun} ↗`}
      </a>
    );
  }
  // The thumbnail asks the file route to downscale — at 2× for retina — so a
  // register of twenty notes doesn't pull twenty full-size phone photos. The
  // lightbox still opens the original.
  const thumbSrc = `${url}${url.includes("?") ? "&" : "?"}w=${size * 2}`;
  return (
    <>
      <img
        src={thumbSrc}
        alt={kind === "invoice" ? `${label} — supplier invoice` : `${label} — delivery note`}
        title={`${label} — click to enlarge`}
        loading="lazy"
        onClick={() => setLb(true)}
        onError={() => setBroken(true)}
        style={{
          width: size, height: size, flex: "0 0 auto", objectFit: "cover", objectPosition: "top",
          borderRadius: 6, border: "1px solid var(--line)", background: "#fff", cursor: "zoom-in",
        }}
      />
      {lb && (
        <div className="acctx-lb" onClick={(e) => { if (e.target === e.currentTarget) setLb(false); }}>
          <div className="lb-bar">
            <div className="ti">{label}</div>
            <span className="sp" />
            <a className="lb-vbtn" href={url} target="_blank" rel="noreferrer">Open ↗</a>
            <button className="lb-vbtn" onClick={() => setLb(false)}>Close ✕</button>
          </div>
          <div className="lb-stage" onClick={(e) => { if (e.target === e.currentTarget) setLb(false); }}>
            <img className="lb-img" src={url} alt={kind === "invoice" ? `${label} — supplier invoice` : `${label} — delivery note`} />
          </div>
        </div>
      )}
    </>
  );
}

/* ── A drop with no paperwork behind it ───────────────────────────────────
   Holds the thumbnail's place so the notes line up, and says why it's empty
   rather than leaving a gap the reader has to interpret. */
function NoTicketBox({ size }: { size: number }) {
  // "no ticket" only fits once the box is big enough to hold it; at thumbnail
  // size it clipped into two cramped lines, so a small box says it with a dash
  // and leaves the wording to the tooltip.
  const roomy = size >= 56;
  return (
    <div
      title="No ticket — these goods were logged without paperwork"
      style={{
        width: size, height: size, flex: "0 0 auto", borderRadius: 6,
        border: "1px dashed var(--line-strong, var(--line))", color: "var(--muted)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: roomy ? 10 : 12, textAlign: "center", lineHeight: 1.2, padding: 4,
      }}
    >
      {roomy ? "no ticket" : "—"}
    </div>
  );
}

/** How a collection's invoice is referred to on screen: the supplier's number
 *  when the paperwork carried one, and our own id when it didn't. */
function invoiceRef(from: NonNullable<PoDeliveryDrop["collected_from"]>): string {
  return from.invoice_number || `#${from.invoice_id}`;
}

/* ── The paperwork behind a collection ────────────────────────────────────
   Goods collected from a trade counter come with the supplier's invoice and no
   delivery note, so the invoice IS this receipt's paperwork and takes the
   ticket's place in the column. The register drew collections as "no ticket"
   for as long as the link between the two was prose in a notes field — and "no
   ticket" is this app's phrase for goods logged from memory with nothing behind
   them at all. Understating evidence that exists misleads as surely as
   overstating it.

   A reader without commercial access is given the NAME of the document and not
   the document: this register is read on site, and the invoice is priced. */
function CollectedEvidence({ from, size }: { from: NonNullable<PoDeliveryDrop["collected_from"]>; size: number }) {
  if (from.file_url) {
    return <TicketThumb url={from.file_url} type={from.file_type} label={`Invoice ${invoiceRef(from)}`} size={size} kind="invoice" />;
  }
  return (
    <div
      title={from.viewable
        ? `Collected from the supplier and receipted against invoice ${invoiceRef(from)}, which has no stored copy`
        : `Collected from the supplier and receipted against invoice ${invoiceRef(from)}`}
      style={{
        width: size, height: size, flex: "0 0 auto", borderRadius: 6,
        border: "1px solid var(--line)", background: "var(--card-2)", color: "var(--muted)",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2,
        fontSize: 10.5, textAlign: "center", lineHeight: 1.2, padding: 4,
      }}
    >
      <span>collected</span>
      <span style={{ fontSize: 9.5, opacity: 0.85 }}>on invoice</span>
    </div>
  );
}

/* ── The order's delivery register ────────────────────────────────────────
   One order takes as many delivery notes as the supplier chooses to send.
   Until this card, the page carried those receipts only per LINE — you could
   open an item and see "93 received", but nothing on the page said whether
   the 93 came in on one van or five, which note was which, or where the
   paperwork for any of them was. The register lists the notes themselves, in
   the order they arrived, each with the items it actually carried.

   The unit is the NOTE, not the receipt row: a ticket checked in against five
   lines writes five rows and is still one delivery. The worker regroups them
   (see `deliveryNoteKey`) so this reads "1 delivery, 5 items". */
function DeliveriesCard({ po }: { po: Row }) {
  const drops = po.deliveries ?? [];
  const state = po.delivery_state ?? "none";
  const label = poDeliveryLabel({
    state,
    lines_delivered: po.delivery_lines_delivered ?? 0,
    lines_started: po.delivery_lines_started ?? 0,
    lines_total: po.delivery_lines_total ?? po.lines.length,
    drops: po.delivery_drops ?? drops.length,
  });

  return (
    <div className="card">
      <div className="card-hd" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ flex: 1 }}>Deliveries</h2>
        <span
          className="pill"
          style={state === "full"
            ? { background: "var(--success-soft)", color: "var(--success)" }
            : state === "part"
              ? { background: "var(--warn-soft)", color: "var(--warn)" }
              : { background: "var(--card-2)", color: "var(--muted)", border: "1px solid var(--line)" }}
        >
          {label}
        </span>
      </div>
      {drops.length === 0 ? (
        <div className="card-bd">
          <div className="muted" style={{ fontSize: 13 }}>
            Nothing has been booked in against this order yet. Delivery notes appear here as
            soon as a ticket is checked in against {po.po_number} on the Deliveries screen
            {" "}(<Link to="/deliveries">open it</Link>).
          </div>
        </div>
      ) : (
        <div style={{ display: "grid" }}>
          {drops.map((d, i) => <DeliveryDropRow key={d.key} drop={d} index={i + 1} total={drops.length} />)}
        </div>
      )}
    </div>
  );
}

function DeliveryDropRow({ drop, index, total }: { drop: PoDeliveryDrop; index: number; total: number }) {
  const [open, setOpen] = useState(total <= 3);
  // A check-in writes its own explanatory preamble ("Checked in from WhatsApp
  // delivery ticket", "MANUAL CHECK-IN — no delivery ticket. Logged by …"),
  // which only repeats what the row already says. A manual check-in appends
  // whatever the person typed AFTER that preamble, so it is stripped rather
  // than used to discard the note — the typed half is the half worth reading.
  const preamble = (drop.notes ?? "")
    .replace(/^MANUAL CHECK-IN\s*—\s*no delivery ticket\.\s*Logged by \S+\.?\s*/i, "")
    .replace(/^Checked in from [^.]*$/i, "");
  // A collection's note is the route's own sentence naming the invoice, which
  // the title and the link beside it now both say. Stripped only when that link
  // resolved: without it the prose is the sole pointer to the paperwork, and
  // dropping it would leave the reader with less than they had before.
  const written = (drop.collected_from
    ? preamble.replace(/^Collected from supplier\s*—\s*marked from invoice \S+\s*$/i, "")
    : preamble).trim() || null;
  const title = drop.dn ? `DN ${drop.dn}`
    : drop.collected_from ? "Collected from supplier"
    : drop.manual ? "Manual check-in"
    : "Delivery note";

  return (
    <div style={{ padding: "12px 14px", borderTop: index === 1 ? "none" : "1px solid var(--line)", display: "flex", gap: 12, alignItems: "flex-start" }}>
      {/* The note itself, big enough to recognise across the desk. A note
          photographed twice shows both; drops with no paperwork keep the
          column so the register stays in line. */}
      {drop.collected_from
        ? <CollectedEvidence from={drop.collected_from} size={72} />
        : drop.tickets.length === 0
        ? <NoTicketBox size={72} />
        : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "0 0 auto" }}>
            {drop.tickets.map((t, i) => (
              <TicketThumb
                key={t.url}
                url={t.url}
                type={t.type}
                label={drop.tickets.length > 1 ? `${title} — photo ${i + 1} of ${drop.tickets.length}` : title}
                size={72}
              />
            ))}
          </div>
        )}
      <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span className="pill neutral" style={{ fontSize: 11 }} title={`Delivery ${index} of ${total} against this order`}>
          {index} of {total}
        </span>
        <b style={{ fontSize: 14 }}>{title}</b>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {fmtDate(drop.delivered_at)}
          {drop.supplier ? ` · ${drop.supplier}` : ""}
          {drop.signed_by ? ` · signed by ${drop.signed_by}` : ""}
        </span>
        {drop.collected_from && (
          <span className="muted" style={{ fontSize: 12.5 }}>
            {"· from "}
            {drop.collected_from.viewable
              ? (
                <Link
                  to={`/accounts?invoice=${drop.collected_from.invoice_id}`}
                  title="Open the invoice these goods were receipted against"
                >
                  invoice {invoiceRef(drop.collected_from)}
                </Link>
              )
              : <>invoice {invoiceRef(drop.collected_from)}</>}
          </span>
        )}
        {drop.whole_order && (
          <span className="pill" style={{ fontSize: 10 }} title="Signed for as one drop, with no per-item breakdown">
            whole order
          </span>
        )}
        {drop.status === "rejected" && <span className="badge rejected" title="This delivery was rejected on site">rejected</span>}
        {drop.status === "partial" && <span className="badge over" title="Logged as a part load">part load</span>}
        {drop.linked_by === "po_number" && (
          <span className="badge" title="Matched to this order by its PO number — booked in before deliveries recorded the order itself">
            matched by number
          </span>
        )}
        <span style={{ flex: 1 }} />
        {drop.items.length > 0 && (
          <button className="ghost tiny" onClick={() => setOpen((v) => !v)}>
            {drop.items.length} item{drop.items.length === 1 ? "" : "s"} {open ? "▾" : "▸"}
          </button>
        )}
      </div>

      {/* The quantities are the point, not the tidiness: a note checked in
          twice books its goods twice, so the order believes it received more
          than it did. Named rather than folded away, because only a person can
          say which of two identical receipts was the mistake. */}
      {drop.duplicates > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--warn)", display: "flex", gap: 6 }}>
          <span aria-hidden>⚠</span>
          <span>
            This note was checked in more than once.{" "}
            {drop.duplicates === 1 ? "One receipt below repeats" : `${drop.duplicates} receipts below repeat`}{" "}
            an earlier check-in of the same note, so {drop.duplicates === 1 ? "that quantity is" : "those quantities are"}{" "}
            counted twice on this order. Delete the repeat on the Deliveries screen to correct it.
          </span>
        </div>
      )}

      {written && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>“{written}”</div>}

      {open && drop.items.length > 0 && (
        <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
          {drop.items.map((it) => (
            <div key={it.id} style={{ display: "flex", gap: 10, fontSize: 12.5, alignItems: "baseline" }}>
              <span className="num" style={{ minWidth: 76, fontWeight: 600 }}>
                {it.qty != null ? `${fmtQty(it.qty)}${it.unit ? ` ${it.unit}` : ""}` : "—"}
              </span>
              <span style={{ flex: 1 }}>
                {it.description || it.line_desc || "—"}
                {/* What the ticket calls the goods and what the order calls
                    them are routinely different words for the same thing, so
                    the line it was booked against is shown whenever it adds
                    something the description doesn't already say. */}
                {it.line_desc && it.line_desc !== it.description && (
                  <span className="muted"> → {it.line_desc}</span>
                )}
              </span>
              {it.duplicate && (
                <span
                  className="badge over"
                  title="Same line and quantity as a receipt from an earlier check-in of this note — most likely the same goods entered twice"
                >
                  possible duplicate
                </span>
              )}
              {it.completes && (
                <span className="badge approved" title="This receipt finished that line off">complete</span>
              )}
            </div>
          ))}
        </div>
      )}

      {drop.items.length === 0 && !drop.whole_order && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>No item detail was recorded against this note.</div>
      )}
      </div>
    </div>
  );
}

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
  const overturn = entry.details ? tryParseOverturn(entry.details) : null;
  return (
    <div className="activity-row">
      <div className={`avatar${highlight ? " accent" : ""}`}>{initials(entry.actor)}</div>
      <div className="body">
        <div><b>{entry.actor}</b> {actionVerb(entry.action)} this PO</div>
        {entry.details && tryParseQuote(entry.details) && (
          <div className="quote">“{tryParseQuote(entry.details)}”</div>
        )}
        {overturn && (
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            Overturned the earlier rejection{overturn.rejected_by ? ` by ${overturn.rejected_by}` : ""}.
          </div>
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

/** An approval that overturned a rejection carries the rejection it replaced. */
function tryParseOverturn(details: string): { rejected_by: string | null } | null {
  try {
    const o = JSON.parse(details);
    return o?.overturned_rejection ?? null;
  } catch { return null; }
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
