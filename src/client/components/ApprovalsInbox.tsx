import { Fragment, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import type { CurrentUser, InvoiceQueueRow, PendingPriceApproval, PendingSubstitution, PoApprovalEvidence, PurchaseOrder } from "../../shared/types";

type Row = PurchaseOrder & { project_code: string; project_name: string };
type Upload = Awaited<ReturnType<typeof api.listPendingUploads>>[number];
type TabKey = "pos" | "invoices" | "prices" | "subs" | "uploads";

export function ApprovalsInbox({ me }: { me: CurrentUser | null }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [prices, setPrices] = useState<PendingPriceApproval[]>([]);
  const [subs, setSubs] = useState<PendingSubstitution[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [invoices, setInvoices] = useState<InvoiceQueueRow[]>([]);
  const [invBusy, setInvBusy] = useState<number | null>(null);
  const [evidence, setEvidence] = useState<Record<string, PoApprovalEvidence>>({});
  const [openEvidence, setOpenEvidence] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("pos");
  const didInit = useRef(false);

  // Applications for payment no longer require director approval, so they no
  // longer appear here — only purchase orders, material price overspends and
  // (for superadmins) pending pricing uploads do.
  function refresh() {
    api.listPOs({ status: "pending_approval" })
      .then((rs) => setRows(rs as Row[]))
      .catch((e) => setErr(e.message));
    api.listPendingPriceApprovals().then(setPrices).catch(() => setPrices([]));
    api.listPendingSubstitutions().then(setSubs).catch(() => setSubs([]));
    api.listPendingUploads().then(setUploads).catch(() => setUploads([]));
    api.invoiceQueues().then((q) => setInvoices(q.awaiting)).catch(() => setInvoices([]));
    // Evidence is supporting detail: if it fails the queue still works, it
    // just goes back to saying nothing about the paperwork.
    api.listApprovalEvidence().then(setEvidence).catch(() => setEvidence({}));
  }
  useEffect(refresh, []);

  // Superadmins oversee every approval regardless of tier; others see only the
  // tiers they hold.
  const isSuper = me?.role === "superadmin";
  // Seeing the queue and being able to decide on it are separate things.
  // Authority to approve is held by the `approvers` table, by email — a role
  // never confers it, and the PO endpoint enforces exactly that. A superadmin
  // who is not an approver is here to look, so the decision controls are not
  // drawn for them: the price and substitution endpoints gate on
  // `suppliers.manage` rather than on the approvers table, so those buttons
  // WOULD go through, and offering them would hand out authority this view was
  // never meant to grant.
  const canDecide = !!me?.is_approver;
  // Invoices are a separate authority from PO tiers: the release allowlist,
  // by name. Someone can hold one and not the other, so the invoice tab is
  // gated on its own right rather than on `canDecide`.
  const canDecideInvoices = me?.can_release_payables === true;
  const minePOs = me ? rows.filter((r) => isSuper || (r.approval_tier && me.approver_tiers.includes(r.approval_tier))) : [];
  const minePrices = me
    ? prices.filter((p) => isSuper || (p.approval_tier && me.approver_tiers.includes(p.approval_tier)))
    : [];
  const mineSubs = me
    ? subs.filter((s) => isSuper || (s.approval_tier && me.approver_tiers.includes(s.approval_tier)))
    : [];

  const tabs: Array<{ key: TabKey; label: string; count: number }> = [
    { key: "pos", label: "Purchase orders", count: minePOs.length },
    ...(canDecideInvoices || invoices.length
      ? [{ key: "invoices" as TabKey, label: "Invoices", count: invoices.length }]
      : []),
    { key: "prices", label: "Price approvals", count: minePrices.length },
    { key: "subs", label: "Substitutions", count: mineSubs.length },
    ...(isSuper ? [{ key: "uploads" as TabKey, label: "Pricing uploads", count: uploads.length }] : []),
  ];

  // On first data arrival, land on the first tab that actually has something.
  useEffect(() => {
    if (didInit.current) return;
    const first = tabs.find((t) => t.count > 0);
    if (first) { setTab(first.key); didInit.current = true; }
  }, [minePOs.length, invoices.length, minePrices.length, mineSubs.length, uploads.length]);

  // Bulk PO approval — tick rows, approve in one go. Sequential so each PO
  // still gets its own audit trail + notification emails.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  async function approveSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!confirm(`Approve ${ids.length} purchase order${ids.length === 1 ? "" : "s"}?`)) return;
    setBulkBusy(true); setErr(null);
    const fails: string[] = [];
    for (const id of ids) {
      try { await api.approvePO(id); }
      catch (e) {
        const po = minePOs.find((r) => String(r.id) === id);
        fails.push(`${po?.po_number ?? id} — ${e instanceof Error ? e.message : "failed"}`);
      }
    }
    setBulkBusy(false);
    setSelected(new Set());
    refresh();
    if (fails.length) setErr(`Approved ${ids.length - fails.length}. ${fails.length} failed:\n• ${fails.join("\n• ")}`);
  }

  async function decide(id: number, action: "approve" | "reject") {
    if (action === "reject") {
      const reason = prompt("Reason for rejection (optional)") ?? undefined;
      await api.decidePendingPrice(id, "reject", reason);
    } else {
      await api.decidePendingPrice(id, "approve");
    }
    refresh();
  }

  async function decideSub(id: number, action: "approve" | "reject") {
    if (action === "reject") {
      const reason = prompt("Reason for rejection (optional)") ?? undefined;
      await api.decideSubstitution(id, "reject", reason);
    } else {
      await api.decideSubstitution(id, "approve");
    }
    refresh();
  }

  const totalMine = minePOs.length + invoices.length + minePrices.length + mineSubs.length + uploads.length;

  return (
    <>
      <Topbar
        crumbs="Workspace"
        title="Approvals"
        status={totalMine > 0 ? <span className="pill pending dot" style={{ verticalAlign: "middle" }}>{totalMine} pending</span> : undefined}
      />
      <main>
        {err && <div className="flash error">{err}</div>}
        {!me?.is_approver && !isSuper && !canDecideInvoices ? (
          <div className="empty">You are not configured as an approver.</div>
        ) : (
          <>
            <nav className="tabs" role="tablist" style={{ marginBottom: 16 }}>
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={`tab-btn${tab === t.key ? " active" : ""}`}
                  onClick={() => { setTab(t.key); didInit.current = true; }}
                >
                  {t.label}
                  {t.count > 0 && <span className="count">{t.count}</span>}
                </button>
              ))}
            </nav>

            {!canDecide && (
              <div className="flash" style={{ marginBottom: 14 }}>
                Read-only — you are a superadmin but not a configured approver, so you can review
                what is waiting but not decide it. Approvers are set in Admin → Approvers.
              </div>
            )}

            {tab === "invoices" && (
              invoices.length === 0
                ? <div className="empty">Nothing waiting for approval.</div>
                : (
                  <>
                    {!canDecideInvoices && (
                      <div className="flash" style={{ marginBottom: 14 }}>
                        Read-only — approving an invoice for payment is held by name, and you are not
                        on that list. This is what Accounts is waiting on.
                      </div>
                    )}
                    <div className="table-wrap">
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>Supplier</th><th>Invoice</th><th>Job</th>
                            <th className="num">Gross</th><th>Committed by</th><th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {invoices.map((r) => (
                            <tr key={r.id}>
                              <td>{r.supplier_name ?? "—"}</td>
                              <td>
                                {/* Straight to the invoice: approving off a row of
                                    figures alone is how the wrong thing gets approved,
                                    and the match evidence only lives on the detail. */}
                                <Link to={`/accounts?invoice=${r.id}`}>{r.invoice_number ?? `#${r.id}`}</Link>
                                {r.approval_note && (
                                  <div className="muted" style={{ fontSize: 11 }} title="Reason given when it was committed">
                                    “{r.approval_note}”
                                  </div>
                                )}
                              </td>
                              <td>{r.project_code ?? (r.kind === "overhead" ? "Overhead" : "—")}</td>
                              <td className="num">{fmtMoney(r.gross_amount ?? 0, r.currency || "GBP")}</td>
                              <td>
                                {r.approved_by ?? "—"}
                                <div className="muted" style={{ fontSize: 11 }}>{fmtDate(r.approved_at)}</div>
                              </td>
                              <td style={{ textAlign: "right" }}>
                                {canDecideInvoices && (
                                  <button className="accent tiny" disabled={invBusy === r.id}
                                    onClick={async () => {
                                      setInvBusy(r.id); setErr(null);
                                      try {
                                        await api.releaseInvoice(r.id);
                                        setInvoices((xs) => xs.filter((x) => x.id !== r.id));
                                      } catch (e) {
                                        setErr(e instanceof Error ? e.message : "approval failed");
                                      } finally { setInvBusy(null); }
                                    }}
                                    title="Approve for payment. Accounts then pushes it to Xero.">Approve</button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="muted" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.5 }}>
                      Approving is the decision, not the posting — Accounts sends the bill to Xero afterwards.
                      Open an invoice to see its PO match and delivery evidence before deciding.
                    </p>
                  </>
                )
            )}

            {tab === "pos" && (
              minePOs.length === 0 ? <div className="empty">No purchase orders awaiting your approval.</div> : (
              <div className="card">
                <div className="card-hd">
                  <span className="muted" style={{ fontSize: 12.5, flex: 1 }}>
                    {!canDecide
                      ? "Click a PO number to review it, or open a row to see the paperwork behind it."
                      : selected.size > 0
                        ? `${selected.size} of ${minePOs.length} selected · ${fmtMoney(minePOs.filter((r) => selected.has(String(r.id))).reduce((s, r) => s + (r.total_value ?? 0), 0))}`
                        : "Tick rows to approve several at once — click a PO number to review it first."}
                  </span>
                  {canDecide && selected.size > 0 && (
                    <>
                      <button className="ghost tiny" onClick={() => setSelected(new Set())} disabled={bulkBusy}>Clear</button>{" "}
                      <button className="accent" onClick={() => void approveSelected()} disabled={bulkBusy}>
                        {bulkBusy ? "Approving…" : `Approve ${selected.size} selected`}
                      </button>
                    </>
                  )}
                </div>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 34 }}>
                        {canDecide && (
                          <input
                            type="checkbox"
                            style={{ minHeight: 0 }}
                            checked={selected.size === minePOs.length && minePOs.length > 0}
                            onChange={(e) => setSelected(e.target.checked ? new Set(minePOs.map((r) => String(r.id))) : new Set())}
                            title="Select all"
                          />
                        )}
                      </th>
                      <th>PO</th>
                      <th className="center">Project</th>
                      <th>Supplier</th>
                      <th className="num">Value</th>
                      <th className="center">Tier</th>
                      <th className="center">Reason</th>
                      <th>Paperwork</th>
                      <th>Raised</th>
                      <th>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {minePOs.map((r) => { const ev = evidence[String(r.id)]; const open = openEvidence.has(String(r.id)); return (
                      <Fragment key={r.id}>
                      <tr>
                        <td>
                          {canDecide && (
                            <input
                              type="checkbox"
                              style={{ minHeight: 0 }}
                              checked={selected.has(String(r.id))}
                              onChange={() => toggleSelected(String(r.id))}
                            />
                          )}
                        </td>
                        <td><Link to={`/approvals/${r.id}`}>{r.po_number}</Link></td>
                        <td className="center">{r.project_code}</td>
                        <td>{r.supplier}</td>
                        <td className="num">{fmtMoney(r.total_value)}</td>
                        <td className="center">{r.approval_tier?.replace("_", " ")}</td>
                        <td className="center">{r.approval_reason?.replace("_", " ")}</td>
                        <td>
                          <button
                            className="ghost tiny"
                            onClick={() => setOpenEvidence((prev) => {
                              const next = new Set(prev);
                              if (next.has(String(r.id))) next.delete(String(r.id)); else next.add(String(r.id));
                              return next;
                            })}
                            title="Show the invoice and delivery notes behind this order"
                            style={{ display: "inline-flex", gap: 6, alignItems: "center" }}
                          >
                            <EvidenceCell ev={ev} />
                            <span aria-hidden>{open ? "▾" : "▸"}</span>
                          </button>
                        </td>
                        <td className="muted">{fmtDate(r.created_at)}</td>
                        <td className="muted">{r.created_by}</td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={10} style={{ background: "var(--card-2)" }}>
                            <EvidenceDetail ev={ev} />
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    ); })}
                  </tbody>
                </table>
              </div>
              )
            )}

            {tab === "prices" && (
              minePrices.length === 0 ? <div className="empty">No price approvals waiting.</div> : (
              <div className="card">
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
                          {canDecide && (<>
                            <button className="primary tiny" onClick={() => decide(p.id, "approve")}>Approve</button>{" "}
                            <button className="ghost tiny" onClick={() => decide(p.id, "reject")}>Reject</button>
                          </>)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              )
            )}

            {tab === "subs" && (
              mineSubs.length === 0 ? <div className="empty">No part-substitutions waiting.</div> : (
              <div className="card">
                <table>
                  <thead>
                    <tr>
                      <th className="center">Project</th>
                      <th>Material → replacement</th>
                      <th className="num">Substituting</th>
                      <th className="num">Line allowance (£)</th>
                      <th className="num">Blended cost (£)</th>
                      <th className="center">Tier</th>
                      <th style={{ width: 160 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {mineSubs.map((s) => {
                      const u = s.original_unit ?? "";
                      const allowance = (s.original_total_units ?? 0) * (s.original_cost ?? 0);
                      const remainder = (s.original_total_units ?? 0) - (s.sub_units ?? 0);
                      const blended = (s.sub_units ?? 0) * (s.replacement_cost ?? 0) + Math.max(0, remainder) * (s.original_cost ?? 0);
                      const over = blended - allowance;
                      return (
                        <tr key={s.id}>
                          <td className="center">{s.project_code}</td>
                          <td>
                            <div style={{ fontWeight: 600 }}>{s.replacement_item}</div>
                            <div className="muted" style={{ fontSize: 11 }}>from {s.material_item}{s.replacement_supplier ? ` · ${s.replacement_supplier}` : ""}</div>
                            {s.reason && <div className="muted" style={{ fontSize: 11 }}>“{s.reason}”</div>}
                          </td>
                          <td className="num">{s.sub_units != null ? `${s.sub_units.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${u}` : "—"}<div className="muted" style={{ fontSize: 10 }}>of {(s.original_total_units ?? 0).toLocaleString("en-GB", { maximumFractionDigits: 2 })} {u}</div></td>
                          <td className="num">{fmtMoney(allowance)}</td>
                          <td className="num">
                            {fmtMoney(blended)}
                            {Math.abs(over) >= 0.005 && (
                              <div className="muted" style={{ fontSize: 10, color: over > 0 ? "var(--danger)" : "var(--success)" }}>{over > 0 ? "↑" : "↓"} {fmtMoney(Math.abs(over))}</div>
                            )}
                          </td>
                          <td className="center">{s.approval_tier?.replace("_", " ")}</td>
                          <td>
                            {canDecide && (<>
                              <button className="primary tiny" onClick={() => decideSub(s.id, "approve")}>Approve</button>{" "}
                              <button className="ghost tiny" onClick={() => decideSub(s.id, "reject")}>Reject</button>
                            </>)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              )
            )}

            {tab === "uploads" && (
              uploads.length === 0 ? <div className="empty">No pricing uploads awaiting approval.</div> : (
              <div className="card">
                <table>
                  <thead>
                    <tr>
                      <th className="center">Project</th>
                      <th>File</th>
                      <th className="num">Rows</th>
                      <th>Uploaded</th>
                      <th>By</th>
                      <th style={{ width: 120 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {uploads.map((u) => (
                      <tr key={u.project_id}>
                        <td className="center">{u.project_code ?? u.project_id.slice(0, 8)}</td>
                        <td>{u.filename}</td>
                        <td className="num">{u.rows ?? "—"}</td>
                        <td className="muted">{fmtDate(u.uploaded_at)}</td>
                        <td className="muted">{u.uploaded_by}</td>
                        <td><Link to={`/projects/${u.project_id}`}>Review →</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              )
            )}
          </>
        )}
      </main>
    </>
  );
}


/* ── The paperwork behind an order awaiting approval ──────────────────────
   Every order in the queue as this was written had been raised retrospectively
   to cover an invoice that had already arrived, and most of those invoices had
   already been pushed to Xero. The list showed a number, a value and a tier —
   nothing about whether the goods it pays for ever turned up. This is that
   missing half: the invoice the order was raised against, and the delivery
   notes linked to it, with the ticket itself one click away. */

/** The ticket as a thumbnail. A PDF has no inline preview, so it says so
 *  rather than rendering a broken image well. */
function TicketThumb({ url, type, label }: { url: string; type: string | null; label: string }) {
  const isPdf = (type ?? "").includes("pdf") || /\.pdf($|\?)/i.test(url);
  if (isPdf) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="ghost tiny" title={`${label} — open the PDF ticket`}>
        PDF ↗
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" title={`${label} — open full size`}>
      <img
        src={url}
        alt={`${label} — delivery note`}
        style={{ width: 34, height: 34, objectFit: "cover", borderRadius: 3, border: "1px solid var(--line)", display: "block" }}
      />
    </a>
  );
}

function fmtQ(n: number | null | undefined): string {
  if (n == null) return "—";
  return Number.isInteger(n) ? n.toLocaleString("en-GB") : String(Math.round(n * 100) / 100);
}

/** The one-glance verdict that sits in the row: is there paper behind this. */
function EvidenceCell({ ev }: { ev: PoApprovalEvidence | undefined }) {
  if (!ev) return <span className="muted">—</span>;
  const notes = ev.deliveries.length;
  const bits: React.ReactNode[] = [];
  if (notes === 0) {
    bits.push(
      <span key="none" className="pill warn" title="Nothing has been booked in against this order — there is no record that the goods arrived">
        No delivery note
      </span>,
    );
  } else {
    bits.push(<span key="n">{notes} note{notes === 1 ? "" : "s"}</span>);
  }
  if (ev.over_delivered.length > 0) {
    bits.push(
      <span key="over" className="pill danger" title="More has arrived than the order asked for">
        over-delivered
      </span>,
    );
  }
  if (ev.invoice) bits.push(<span key="inv" className="muted">· inv {ev.invoice.invoice_number ?? `#${ev.invoice.id}`}</span>);
  return <span style={{ display: "inline-flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>{bits}</span>;
}

/** The expanded panel: invoice first (what is being paid), then each note. */
function EvidenceDetail({ ev }: { ev: PoApprovalEvidence | undefined }) {
  if (!ev) return <div className="muted">No paperwork found for this order.</div>;
  return (
    <div style={{ display: "grid", gap: 10, padding: "4px 2px 8px" }}>
      {ev.invoice && (
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <span className="eyebrow" style={{ margin: 0 }}>Invoice</span>
          <b>{ev.invoice.invoice_number ?? `#${ev.invoice.id}`}</b>
          <span className="muted">{fmtDate(ev.invoice.invoice_date)}</span>
          <span className="num">{ev.invoice.net_amount != null ? fmtMoney(ev.invoice.net_amount) : "—"}</span>
          {ev.invoice.status === "pushed" && (
            <span className="pill warn" title="This bill is already in Xero — the money has moved, and approving now records the authority after the fact">
              already in Xero{ev.invoice.xero_bill_number ? ` · ${ev.invoice.xero_bill_number}` : ""}
            </span>
          )}
          {ev.invoice.file_url && (
            <a href={ev.invoice.file_url} target="_blank" rel="noreferrer">Open invoice ↗</a>
          )}
        </div>
      )}

      {ev.over_delivered.length > 0 && (
        <div className="flash error" style={{ margin: 0 }}>
          More arrived than was ordered:{" "}
          {ev.over_delivered.map((o, i) => (
            <span key={o.po_line_id}>
              {i > 0 ? "; " : ""}
              {o.description || `line ${o.po_line_id}`} — {fmtQ(o.received_qty)} received against {fmtQ(o.ordered_qty)} ordered
              {o.unit ? ` ${o.unit}` : ""}
            </span>
          ))}
        </div>
      )}

      {ev.deliveries.length === 0 ? (
        <div className="muted">
          Nothing booked in against this order — no delivery note, no ticket, no signature.
          {ev.unlinked_supplier_deliveries > 0 && (
            <>
              {" "}
              This supplier has <b>{ev.unlinked_supplier_deliveries}</b> deliver
              {ev.unlinked_supplier_deliveries === 1 ? "y" : "ies"} on this project matched to no order —
              {" "}<Link to="/deliveries">check the deliveries inbox</Link> before approving.
            </>
          )}
        </div>
      ) : (
        <table style={{ margin: 0 }}>
          <thead>
            <tr>
              <th style={{ width: 46 }}>Ticket</th>
              <th>Delivery note</th>
              <th>Received</th>
              <th>Signed by</th>
            </tr>
          </thead>
          <tbody>
            {ev.deliveries.map((d) => (
              <tr key={d.key}>
                <td>
                  {d.ticket_url
                    ? <TicketThumb url={d.ticket_url} type={d.ticket_type} label={d.dn ? `DN ${d.dn}` : "Delivery note"} />
                    : <span className="muted" style={{ fontSize: 10.5 }} title="Logged with no paperwork behind it">no ticket</span>}
                </td>
                <td>
                  <div>{d.dn ? `DN ${d.dn}` : <span className="muted">No DN number</span>}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {fmtDate(d.delivered_at)}
                    {d.manual && " · logged from memory"}
                    {d.status && d.status !== "received" ? ` · ${d.status}` : ""}
                  </div>
                </td>
                <td>
                  {d.items.length === 0
                    ? <span className="muted">Whole order signed for in one go</span>
                    : d.items.map((it, i) => (
                        <div key={i} style={{ fontSize: 12 }}>
                          {fmtQ(it.qty)}{it.unit ? ` ${it.unit}` : ""}
                          {it.ordered_qty != null && (
                            <span className="muted"> of {fmtQ(it.ordered_qty)} ordered</span>
                          )}
                          {" — "}{it.description}
                        </div>
                      ))}
                </td>
                <td className="muted">{d.signed_by ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
