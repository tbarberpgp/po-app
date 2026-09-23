import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import { can } from "../../shared/permissions";
import { displayPerson } from "../lib/people";
import type { CurrentUser, PurchaseOrder } from "../../shared/types";
import { poDeliveryLabel } from "../../shared/po-delivery-status";
import { PoRegisterExport } from "./PoRegisterExport";

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
type SortKey = "po_number" | "project_code" | "supplier" | "total_value" | "status" | "delivery" | "created_at" | "created_by";
// Sorts nothing-received first and fully-delivered last, so clicking the
// column heading surfaces the orders most likely to need a delivery logged.
const DELIVERY_RANK: Record<string, number> = { none: 0, part: 1, full: 2 };
const SORTS: Record<SortKey, (r: Row) => string | number> = {
  po_number: (r) => r.po_number ?? "",
  project_code: (r) => r.project_code ?? "",
  supplier: (r) => (r.supplier ?? "").toLowerCase(),
  total_value: (r) => r.total_value ?? 0,
  status: (r) => r.status ?? "",
  delivery: (r) => DELIVERY_RANK[r.delivery_state ?? "none"] ?? 0,
  created_at: (r) => Date.parse(r.created_at ?? "") || 0,
  created_by: (r) => displayPerson(r.created_by_name, r.created_by).toLowerCase(),
};

export function POsList({ me }: { me: CurrentUser | null }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canCreate = can(me, "pos.create");
  const canDelete = can(me, "pos.delete");
  // The order the delete dialog is open for — null when it's closed.
  const [deleting, setDeleting] = useState<Row | null>(null);
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

        <div className="card">
          <div className="card-hd" style={{ flexWrap: "wrap", gap: 10 }}>
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
            <table>
              <thead>
                <tr>
                  <SortTh k="po_number" label="PO" />
                  <SortTh k="project_code" label="Project" className="center" />
                  <SortTh k="supplier" label="Supplier" />
                  <SortTh k="total_value" label="Value" className="num" />
                  <SortTh k="status" label="Status" className="center" />
                  <SortTh k="delivery" label="Delivery" className="center" />
                  <th className="center">Xero</th>
                  <SortTh k="created_at" label="Raised" />
                  <SortTh k="created_by" label="By" />
                  {showingDeleted && <th>Deleted</th>}
                  {showingDeleted && <th>Reason</th>}
                  {canDelete && !showingDeleted && <th style={{ width: 80 }}></th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td><Link to={`/pos/${r.id}`}>{r.po_number}</Link></td>
                    <td className="center" title={r.project_name}>{r.project_code}</td>
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
                    <td className="center">
                      {r.delivery_state && r.delivery_state !== "none" ? (
                        <span
                          className="pill"
                          style={r.delivery_state === "full"
                            ? { background: "var(--warn-soft)", color: "var(--warn)" }
                            : { background: "var(--card-2)", color: "var(--muted)", border: "1px solid var(--line)", fontSize: 10 }}
                          title={r.delivery_lines_total
                            ? `${r.delivery_lines_started ?? 0} of ${r.delivery_lines_total} lines have had a delivery`
                            : undefined}
                        >
                          {poDeliveryLabel({
                            state: r.delivery_state,
                            lines_delivered: r.delivery_lines_delivered ?? 0,
                            lines_started: r.delivery_lines_started ?? 0,
                            lines_total: r.delivery_lines_total ?? 0,
                            drops: r.delivery_drops ?? 0,
                          })}
                        </span>
                      ) : <span className="muted" style={{ fontSize: 11 }}>—</span>}
                    </td>
                    <td className="center">
                      {r.xero_sync_status === "synced" ? (
                        <span
                          className="pill approved"
                          style={{ fontSize: 10 }}
                          title={r.xero_po_number ? `Xero PO ${r.xero_po_number}` : "Synced to Xero"}
                        >
                          ✓ {r.xero_po_number ?? "synced"}
                        </span>
                      ) : r.xero_sync_status === "failed" ? (
                        <span
                          className="pill rejected"
                          style={{ fontSize: 10 }}
                          title={r.xero_sync_error ?? "Last Xero push failed"}
                        >
                          failed
                        </span>
                      ) : r.status === "approved" || r.status === "issued" ? (
                        <span className="pill draft" style={{ fontSize: 10 }} title="Not yet pushed to Xero">
                          pending
                        </span>
                      ) : (
                        <span className="muted" style={{ fontSize: 11 }}>—</span>
                      )}
                    </td>
                    <td className="muted">{fmtDate(r.created_at)}</td>
                    <td className="muted" title={[r.created_by_name, r.created_by].filter(Boolean).join(" · ") || undefined}>{displayPerson(r.created_by_name, r.created_by)}</td>
                    {showingDeleted && (
                      <td className="muted">{fmtDate(r.deleted_at)}<br />{r.deleted_by}</td>
                    )}
                    {showingDeleted && (
                      <td className="muted" style={{ maxWidth: 280, whiteSpace: "normal" }}>
                        {r.deletion_reason ?? "—"}
                      </td>
                    )}
                    {canDelete && !showingDeleted && (
                      <td>
                        <button
                          className="ghost tiny"
                          title={`Delete ${r.po_number}`}
                          onClick={() => { setErr(null); setNotice(null); setDeleting(r); }}
                        >
                          Delete
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
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
