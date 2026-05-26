import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import { can } from "../../shared/permissions";
import type { CurrentUser, PurchaseOrder } from "../../shared/types";

type Row = PurchaseOrder & { project_code: string; project_name: string };

export function POsList({ me }: { me: CurrentUser | null }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [pendingXero, setPendingXero] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<Awaited<ReturnType<typeof api.xeroBulkPush>> | null>(null);

  const canPushXero = can(me?.role, "pos.push_to_xero");

  function refresh() {
    api.listPOs({ status: status || undefined })
      .then((rs) => setRows(rs as Row[]))
      .catch((e) => setErr(e.message));
    if (canPushXero) {
      api.xeroPendingCount().then((r) => setPendingXero(r.pending)).catch(() => setPendingXero(null));
    }
  }
  useEffect(refresh, [status, canPushXero]);

  async function bulkPushToXero() {
    if (!canPushXero) return;
    if (!confirm(`Push ${pendingXero ?? 0} approved/issued PO(s) to Xero? This runs sequentially and may take a minute or two. Failures will be reported individually — successful ones won't be re-attempted.`)) return;
    setBulkBusy(true);
    setErr(null);
    setBulkResult(null);
    try {
      const r = await api.xeroBulkPush();
      setBulkResult(r);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "bulk push failed");
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <>
      <Topbar
        crumbs="Workspace"
        title="Purchase orders"
        actions={
          canPushXero ? (
            pendingXero == null ? (
              <span className="muted" style={{ fontSize: 12 }}>Xero: checking…</span>
            ) : pendingXero === 0 ? (
              <span className="pill approved" style={{ fontSize: 11 }} title="No approved or issued POs are missing from Xero">
                ✓ Xero in sync
              </span>
            ) : (
              <button className="accent" onClick={bulkPushToXero} disabled={bulkBusy}>
                {bulkBusy ? "Pushing…" : `↑ Push ${pendingXero} to Xero`}
              </button>
            )
          ) : null
        }
      />
      <main>
        {err && <div className="flash error">{err}</div>}

        {bulkResult && (
          <div className={`flash ${bulkResult.failed === 0 ? "success" : "info"}`}>
            <b>Bulk push complete:</b> {bulkResult.pushed} succeeded, {bulkResult.failed} failed of {bulkResult.total} attempted.
            {bulkResult.failed > 0 && (
              <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 20 }}>
                {bulkResult.results.filter((r) => !r.ok).slice(0, 8).map((r) => (
                  <li key={r.po_number} style={{ fontSize: 13 }}>
                    <b>{r.po_number}</b> ({r.supplier}) — {r.error}
                  </li>
                ))}
                {bulkResult.results.filter((r) => !r.ok).length > 8 && (
                  <li style={{ fontSize: 13 }}>… and {bulkResult.results.filter((r) => !r.ok).length - 8} more</li>
                )}
              </ul>
            )}
            <div style={{ marginTop: 6, fontSize: 12 }}>
              <button className="ghost tiny" onClick={() => setBulkResult(null)}>Dismiss</button>
            </div>
          </div>
        )}

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
                  <th>Xero</th>
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
                    <td>
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
