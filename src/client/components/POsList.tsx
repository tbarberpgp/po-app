import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import { useStickyCard } from "../lib/sticky";
import { can } from "../../shared/permissions";
import { displayPerson } from "../lib/people";
import type { CurrentUser, PurchaseOrder } from "../../shared/types";
import { poDeliveryLabel } from "../../shared/po-delivery-status";
import { PoRegisterExport } from "./PoRegisterExport";
import { XeroPaidCell } from "./XeroPaidCell";
import { isApprovedNotIssued, supplierHasStaleCopy } from "../lib/po-register";
import { ActivityRow, type Activity } from "./POView";

type PickProject = { id: string; code: string; name: string; site_group_name?: string | null };

/** The status dropdown, and how an export describes the slice it took. */
const STATUS_FILTERS: Array<{ value: string; label: string; needsDelete?: boolean }> = [
  { value: "", label: "All statuses" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "approved", label: "Approved" },
  { value: "issued", label: "Issued" },
  { value: "rejected", label: "Rejected" },
  // Deleted orders are hidden from every other view; this is the one place they
  // can be read back, and it takes the same permission as deleting one.
  { value: "deleted", label: "Deleted", needsDelete: true },
];

type Row = PurchaseOrder & { project_code: string; project_name: string };

/** Sortable columns. `get` returns a comparable — string (localeCompare) or
 *  number/date-ms (numeric). */
type SortKey = "po_number" | "supplier" | "total_value" | "status" | "delivery" | "created_at" | "created_by";
// Sorts nothing-received first and fully-delivered last, so clicking the
// column heading surfaces the orders most likely to need a delivery logged.
const DELIVERY_RANK: Record<string, number> = { none: 0, part: 1, full: 2 };
const SORTS: Record<SortKey, (r: Row) => string | number> = {
  po_number: (r) => r.po_number ?? "",
  supplier: (r) => (r.supplier ?? "").toLowerCase(),
  total_value: (r) => r.total_value ?? 0,
  status: (r) => r.status ?? "",
  delivery: (r) => DELIVERY_RANK[r.delivery_state ?? "none"] ?? 0,
  created_at: (r) => Date.parse(r.created_at ?? "") || 0,
  created_by: (r) => displayPerson(r.created_by_name, r.created_by).toLowerCase(),
};

export function POsList({ me }: { me: CurrentUser | null }) {
  const [rows, setRows] = useState<Row[]>([]);
  const cardRef = useStickyCard();
  const [status, setStatus] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canCreate = can(me, "pos.create");
  const canDelete = can(me, "pos.delete");
  // The order the delete dialog is open for — null when it's closed.
  const [deleting, setDeleting] = useState<Row | null>(null);
  // The order picked in the list. On a wide screen the panel is always open:
  // it shows the picked order, or the top of the list until one is picked.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const wide = useWideScreen();
  // Deleted orders are only ever fetched when they're asked for by name, so
  // the columns that explain the deletion earn their space only on that view.
  const showingDeleted = status === "deleted";
  const nav = useNavigate();
  const [projects, setProjects] = useState<PickProject[]>([]);
  const [picking, setPicking] = useState(false);
  const [pickId, setPickId] = useState("");
  // Search + sort run over the loaded rows — no round-trip per keystroke.
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  function sortBy(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    // Text sorts read best A→Z; money and dates read best biggest/newest first.
    else { setSortKey(k); setSortDir(k === "total_value" || k === "created_at" ? "desc" : "asc"); }
  }

  useEffect(() => {
    if (canCreate) api.listProjects().then((r) => setProjects(r as unknown as PickProject[])).catch(() => setProjects([]));
  }, [canCreate]);

  function refresh() {
    api.listPOs({ status: status || undefined })
      .then((rs) => setRows(rs as Row[]))
      .catch((e) => setErr(e.message));
  }
  useEffect(refresh, [status]);

  // Match on everything you'd plausibly search a PO by: number, supplier,
  // project code/name and who raised it. Every term must hit somewhere, so
  // "toolstation 26001" narrows rather than widens.
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = terms.length === 0 ? rows : rows.filter((r) => {
    const hay = `${r.po_number ?? ""} ${r.supplier ?? ""} ${r.project_code ?? ""} ${r.project_name ?? ""} ${r.created_by ?? ""} ${displayPerson(r.created_by_name, r.created_by)}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const shown = [...filtered].sort((a, b) => {
    const av = SORTS[sortKey](a), bv = SORTS[sortKey](b);
    const c = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : Number(av) - Number(bv);
    return sortDir === "asc" ? c : -c;
  });
  const openId = shown.some((r) => r.id === pickedId) ? pickedId : wide ? shown[0]?.id ?? null : null;
  const total = shown.reduce((s, r) => s + (r.total_value ?? 0), 0);
  // How an export labels this slice — the filter, the search and how much of
  // the register it covers.
  const scope = [
    STATUS_FILTERS.find((f) => f.value === status)?.label ?? "All statuses",
    q.trim() ? `search “${q.trim()}”` : "",
    shown.length === rows.length ? `${rows.length} orders` : `${shown.length} of ${rows.length} orders`,
  ].filter(Boolean).join(" · ");
  // Independent of the search box / status filter — "Needs attention" always
  // reflects the true current state, not whatever the user happens to be
  // looking at right now.
  const overdrawn = rows.filter((r) => r.is_overdrawn);

  const SortTh = ({ k, label, className }: { k: SortKey; label: string; className?: string }) => (
    <th className={className}
      onClick={() => sortBy(k)}
      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
      title={`Sort by ${label.toLowerCase()}`}>
      {label}
      <span className="muted" style={{ marginLeft: 4, opacity: sortKey === k ? 1 : 0.25, fontSize: 10 }}>
        {sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
      </span>
    </th>
  );

  return (
    <>
      <Topbar
        crumbs="Workspace"
        title="Purchase orders"
        actions={
          <>
            {canCreate && (
              <button className="accent" onClick={() => setPicking((p) => !p)}>+ New PO</button>
            )}
          </>
        }
      />
      <main>
        {err && <div className="flash error">{err}</div>}
        {notice && <div className="flash info">{notice}</div>}

        {overdrawn.length > 0 && (
          <div className="card card-padded" style={{ marginBottom: 16, borderColor: "var(--danger)" }}>
            <div className="card-hd" style={{ padding: 0, marginBottom: 8, alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Needs attention</h3>
              <span className="pill warn" style={{ marginLeft: "auto" }}>{overdrawn.length}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {overdrawn.map((r) => (
                <div key={r.id} className="row" style={{ alignItems: "center", gap: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--danger)", flex: "0 0 auto" }} />
                  <span style={{ flex: 1, fontSize: 13 }}>
                    <Link to={`/pos/${r.id}`}>{r.po_number}</Link> — {r.project_code}, {r.supplier}: call-offs exceed the agreed qty or cost
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {picking && canCreate && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-hd"><h2 style={{ flex: 1 }}>Raise a purchase order</h2></div>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", padding: 16 }}>
              <label className="field" style={{ minWidth: 300, flex: "1 1 300px" }}><span>Which project / block?</span>
                <select value={pickId} onChange={(e) => setPickId(e.target.value)} autoFocus>
                  <option value="">Choose a project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.code} — {p.name}{p.site_group_name ? ` · ${p.site_group_name}` : ""}</option>
                  ))}
                </select>
              </label>
              <button className="btn accent" disabled={!pickId} onClick={() => pickId && nav(`/projects/${pickId}/new-po`)} style={{ minHeight: 37 }}>Continue →</button>
              <button className="btn ghost" onClick={() => { setPicking(false); setPickId(""); }} style={{ minHeight: 37 }}>Cancel</button>
              <span className="muted" style={{ fontSize: 12, maxWidth: 340 }}>A PO belongs to one contract (its own budget, certification &amp; Xero). For a grouped site, pick the specific block it's for.</span>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div className="card" ref={cardRef} style={{ flex: 1, minWidth: 0 }}>
          <div className="card-hd sticky-bar" style={{ flexWrap: "wrap", gap: 10 }}>
            <h2>All purchase orders</h2>
            <span className="pill neutral">{shown.length}{shown.length !== rows.length ? ` of ${rows.length}` : ""}</span>
            {shown.length > 0 && <span className="muted" style={{ fontSize: 12.5 }}>{fmtMoney(total)}</span>}
            <span style={{ flex: 1 }} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search PO, supplier, project, raised by…"
              style={{ width: 280, maxWidth: "45%" }} />
            {q && <button className="ghost tiny" onClick={() => setQ("")}>Clear</button>}
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUS_FILTERS.filter((f) => !f.needsDelete || canDelete).map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
            {/* Exports exactly what's on screen — `shown` is already searched,
                filtered and sorted, so the file matches the table above it. */}
            <PoRegisterExport
              rows={shown}
              opts={{ subject: "All projects", scope, showProject: true, showDeleted: showingDeleted }}
              filename={`purchase-orders${status ? `-${status}` : ""}`} />
          </div>
          {shown.length === 0 ? (
            <div style={{ padding: 32 }}>
              <div className="empty">{rows.length === 0 ? "No POs match." : `No POs match “${q}”.`}</div>
            </div>
          ) : (
            <table className="sticky-head">
              <thead>
                <tr>
                  {/* No project column: every number is PO-<project>-<seq>, so
                      the project is already in the PO, and sorting by PO groups
                      the register by project. Project code and name still feed
                      the search box and both exports. */}
                  <SortTh k="po_number" label="PO" />
                  <SortTh k="supplier" label="Supplier" />
                  <SortTh k="total_value" label="Value" className="num" />
                  <SortTh k="status" label="Status" className="center" />
                  {!openId && <th className="center">Xero</th>}
                  {showingDeleted && <th>Deleted</th>}
                  {showingDeleted && <th>Reason</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}
                    onClick={() => setPickedId(!wide && openId === r.id ? null : r.id)}
                    style={{ cursor: "pointer", ...(openId === r.id ? { background: "var(--accent-soft)", boxShadow: "inset 3px 0 0 var(--accent)" } : {}) }}>
                    <td><Link to={`/pos/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.po_number}</Link></td>
                    <td>{r.supplier}</td>
                    <td className="num">{fmtMoney(r.total_value)}</td>
                    <td className="center">
                      <span
                        className={`pill ${r.status}`}
                        title={r.status === "deleted" && r.deleted_by
                          ? `Deleted by ${r.deleted_by} on ${fmtDate(r.deleted_at)}${r.deletion_reason ? ` — “${r.deletion_reason}”` : ""}`
                          : undefined}
                      >
                        {r.status.replace("_", " ")}
                      </span>
                      <DeliveryPill po={r} />
                      {/* Stale beats not-issued: an amendment clears issued_at,
                          so a superseded order matches both, and only one of
                          them tells you a supplier is acting on wrong figures. */}
                      {supplierHasStaleCopy(r) ? (
                        <span
                          className="pill error"
                          style={{ fontSize: 10, marginLeft: 4 }}
                          title={`Amended since it was issued — the supplier is holding the copy from ${fmtDate(r.supplier_copy_issued_at)} and has not been sent this version`}
                        >
                          supplier has old version
                        </span>
                      ) : isApprovedNotIssued(r) && (
                        <span
                          className="pill warn"
                          style={{ fontSize: 10, marginLeft: 4 }}
                          title="Approved, so the money is committed against budget — but the order has never been issued to the supplier"
                        >
                          not issued
                        </span>
                      )}
                      {r.order_type === "framework" && <span className="pill info" style={{ fontSize: 10, marginLeft: 4 }}>framework</span>}
                      {r.order_type === "call_off" && <span className="pill neutral" style={{ fontSize: 10, marginLeft: 4 }}>call-off</span>}
                      {r.category === "prelims" && <span className="pill warn" style={{ fontSize: 10, marginLeft: 4 }}>prelim</span>}
                      {r.paid_at && (
                        <span className="pill approved" style={{ fontSize: 10, marginLeft: 4 }} title={`Settled in Xero on ${fmtDate(r.paid_at)}`}>paid</span>
                      )}
                      {r.is_overdrawn && (
                        <span className="badge over" style={{ marginLeft: 4 }} title="One or more lines have been called off past the agreed qty or cost">
                          overdrawn
                        </span>
                      )}
                    </td>
                    {!openId && <td className="center"><XeroPaidCell po={r} /></td>}
                    {showingDeleted && (
                      <td className="muted">{fmtDate(r.deleted_at)}<br />{r.deleted_by}</td>
                    )}
                    {showingDeleted && (
                      <td className="muted" style={{ maxWidth: 280, whiteSpace: "normal" }}>
                        {r.deletion_reason ?? "—"}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {openId && (
          <POPeek
            id={openId}
            onClose={wide ? undefined : () => setPickedId(null)}
            onDelete={canDelete && !showingDeleted ? (r) => { setErr(null); setNotice(null); setDeleting(r); } : undefined}
          />
        )}
        </div>

        {deleting && (
          <DeletePOModal
            po={deleting}
            onCancel={() => setDeleting(null)}
            onDone={(msg) => { setDeleting(null); setNotice(msg); refresh(); }}
          />
        )}
      </main>
    </>
  );
}

/** Room for the list and the panel side by side. Narrower than this the
 *  panel only opens on a click, so the list keeps the width on a phone. */
function useWideScreen(): boolean {
  const query = "(min-width: 1100px)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

/**
 * Whether the goods are here, next to whether the order is signed off — the
 * two things you scan the register for. Rejected and deleted orders have
 * nothing coming, so they carry no delivery state.
 */
function DeliveryPill({ po }: { po: PurchaseOrder }) {
  if (po.status === "rejected" || po.status === "deleted") return null;
  const state = po.delivery_state ?? "none";
  const [label, cls] = state === "full" ? ["fully delivered", "approved"]
    : state === "part" ? ["part delivered", "warn"]
    : ["not delivered", "neutral"];
  return (
    <span className={`pill ${cls}`} style={{ marginLeft: 4 }}
      title={poDeliveryLabel({
        state,
        lines_delivered: po.delivery_lines_delivered ?? 0,
        lines_started: po.delivery_lines_started ?? 0,
        lines_total: po.delivery_lines_total ?? 0,
        drops: po.delivery_drops ?? 0,
      })}>
      {label}
    </span>
  );
}

/**
 * One order previewed beside the list: what was ordered, and its audit trail —
 * who raised it and when lives here rather than as columns on every row.
 */
function POPeek({ id, onClose, onDelete }: { id: string; onClose?: () => void; onDelete?: (r: Row) => void }) {
  const [po, setPo] = useState<Row & { lines: PurchaseOrder["lines"] } | null>(null);
  const [activity, setActivity] = useState<Activity>([]);
  useEffect(() => {
    setPo(null);
    api.getPO(id).then((p) => setPo(p as Row & { lines: PurchaseOrder["lines"] })).catch(() => setPo(null));
    api.getPOActivity(id).then(setActivity).catch(() => setActivity([]));
  }, [id]);
  const fact = (label: string, value: React.ReactNode) => (
    <><span className="muted">{label}</span><span>{value}</span></>
  );
  return (
    <aside className="card" style={{ width: 420, flex: "0 0 420px", position: "sticky", top: 16, maxHeight: "calc(100vh - 32px)", overflow: "auto" }}>
      {!po ? <div className="card-bd muted">Loading…</div> : (
        <>
          <div className="card-hd" style={{ alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em" }}>Purchase order</div>
              <h2 style={{ margin: "2px 0 6px" }}>{po.po_number}</h2>
              <span className={`pill ${po.status}`}>{po.status.replace("_", " ")}</span>
              <DeliveryPill po={po} />
            </div>
            {onClose && <button className="ghost tiny" onClick={onClose} title="Close">✕</button>}
          </div>
          <div className="card-bd" style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: "6px 12px", fontSize: 13 }}>
            {fact("Supplier", po.supplier)}
            {fact("Project", `${po.project_code} · ${po.project_name}`)}
            {fact("Category", po.category === "prelims" ? "Prelims" : "Materials")}
            {fact("Needed by", po.delivery_date ? fmtDate(po.delivery_date) : "—")}
            {fact("Xero", po.xero_po_number ?? (po.xero_sync_status ?? "—"))}
          </div>
          <div className="card-bd" style={{ borderTop: "1px solid var(--line)" }}>
            {po.lines.map((l, i) => (
              <div key={l.id ?? i} style={{ display: "flex", gap: 12, fontSize: 13, padding: "4px 0" }}>
                <span style={{ flex: 1 }}>{l.item}<div className="muted" style={{ fontSize: 12 }}>{l.qty} {l.unit} × {fmtMoney(l.unit_cost)}</div></span>
                <span className="num">{fmtMoney(l.line_total)}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1.5px solid var(--ink)", marginTop: 8, paddingTop: 8, fontWeight: 700 }}>
              <span>Total</span><span>{fmtMoney(po.total_value)}</span>
            </div>
          </div>
          <div className="card-bd" style={{ borderTop: "1px solid var(--line)", display: "flex", gap: 8 }}>
            <Link className="btn accent" to={`/pos/${po.id}`} style={{ flex: 1, textAlign: "center" }}>
              {po.status === "pending_approval" ? "Review & approve →" : "Open full PO →"}
            </Link>
            {onDelete && <button className="ghost" onClick={() => onDelete(po)}>Delete</button>}
          </div>
          <div className="card-hd" style={{ borderTop: "1px solid var(--line)" }}><h3>Audit trail</h3></div>
          <div className="card-bd">
            {activity.length === 0
              ? [
                  ["Raised by", displayPerson(po.created_by_name, po.created_by), po.created_at],
                  ["Approved by", po.approved_by, po.approved_at],
                  ["Issued to supplier", po.supplier, po.issued_at],
                  ["Pushed to Xero", po.xero_po_number, po.xero_synced_at],
                  ["Paid in Xero", null, po.paid_at],
                ].filter(([, , at]) => at).map(([what, who, at]) => (
                  <div key={what} style={{ display: "flex", gap: 8, fontSize: 13, padding: "5px 0" }}>
                    <span style={{ flex: 1 }}><span className="muted">{what}</span> {who && <b>{who}</b>}</span>
                    <span className="muted">{fmtDate(at)}</span>
                  </div>
                ))
              : activity.map((a, idx) => (
                <ActivityRow key={a.id} entry={a} highlight={idx === activity.length - 1 && po.status === "pending_approval"} />
              ))}
          </div>
        </>
      )}
    </aside>
  );
}

/**
 * Delete one order, straight from the list. A soft delete: the row keeps its
 * audit trail and turns up again under the "Deleted" filter, which is why the
 * reason is mandatory — it is the only record of WHY, and the person reading
 * it back will not be the person who typed it.
 */
function DeletePOModal({ po, onCancel, onDone }: {
  po: Row;
  onCancel: () => void;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function confirm() {
    const r = reason.trim();
    if (!r) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deletePO(po.id, r);
      onDone(`${po.po_number} deleted — find it under the “Deleted” filter.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "couldn't delete that PO");
      setBusy(false);
    }
  }

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(15,17,48,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1400 }}
      onClick={() => !busy && onCancel()}
    >
      <div className="card" style={{ maxWidth: 520, width: "calc(100% - 32px)", maxHeight: "calc(100vh - 64px)", overflow: "auto" }}
        onClick={(e) => e.stopPropagation()}>
        <div className="card-hd"><h3 style={{ flex: 1 }}>Delete {po.po_number}</h3></div>
        <div className="card-bd">
          {err && <div className="flash error" style={{ marginBottom: 10 }}>{err}</div>}
          <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
            {po.project_code} · {po.supplier} · {fmtMoney(po.total_value)}
          </p>
          <p className="muted" style={{ fontSize: 12.5 }}>
            This soft-deletes the order: it leaves every list and stops counting against the
            project's committed budget, but the record and its audit trail stay — it reappears
            under the <b>Deleted</b> filter.
          </p>
          {po.order_type === "framework" && (
            <p className="muted" style={{ fontSize: 12.5 }}>
              <b>This is a framework order.</b> Call-offs already drawn against it are not
              deleted with it, and will be left pointing at a deleted parent.
            </p>
          )}
          <label>Reason (required)</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            autoFocus
            placeholder="e.g. raised in error, duplicate of PO-XXX, supplier cancelled"
            style={{ resize: "vertical" }}
          />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="danger" disabled={busy || !reason.trim()} onClick={confirm}>
              {busy ? "Deleting…" : "Confirm delete"}
            </button>
            <button className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
