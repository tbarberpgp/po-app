import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import type { CurrentUser, PendingPriceApproval, PendingSubstitution, PurchaseOrder } from "../../shared/types";

type Row = PurchaseOrder & { project_code: string; project_name: string };
type Upload = Awaited<ReturnType<typeof api.listPendingUploads>>[number];
type TabKey = "pos" | "prices" | "subs" | "uploads";

export function ApprovalsInbox({ me }: { me: CurrentUser | null }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [prices, setPrices] = useState<PendingPriceApproval[]>([]);
  const [subs, setSubs] = useState<PendingSubstitution[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
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
  }
  useEffect(refresh, []);

  // Superadmins oversee every approval regardless of tier; others see only the
  // tiers they hold.
  const isSuper = me?.role === "superadmin";
  const minePOs = me ? rows.filter((r) => isSuper || (r.approval_tier && me.approver_tiers.includes(r.approval_tier))) : [];
  const minePrices = me
    ? prices.filter((p) => isSuper || (p.approval_tier && me.approver_tiers.includes(p.approval_tier)))
    : [];
  const mineSubs = me
    ? subs.filter((s) => isSuper || (s.approval_tier && me.approver_tiers.includes(s.approval_tier)))
    : [];

  const tabs: Array<{ key: TabKey; label: string; count: number }> = [
    { key: "pos", label: "Purchase orders", count: minePOs.length },
    { key: "prices", label: "Price approvals", count: minePrices.length },
    { key: "subs", label: "Substitutions", count: mineSubs.length },
    ...(isSuper ? [{ key: "uploads" as TabKey, label: "Pricing uploads", count: uploads.length }] : []),
  ];

  // On first data arrival, land on the first tab that actually has something.
  useEffect(() => {
    if (didInit.current) return;
    const first = tabs.find((t) => t.count > 0);
    if (first) { setTab(first.key); didInit.current = true; }
  }, [minePOs.length, minePrices.length, mineSubs.length, uploads.length]);

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

  const totalMine = minePOs.length + minePrices.length + mineSubs.length + uploads.length;

  return (
    <>
      <Topbar
        crumbs="Workspace"
        title="Approvals"
        status={totalMine > 0 ? <span className="pill pending dot" style={{ verticalAlign: "middle" }}>{totalMine} pending</span> : undefined}
      />
      <main>
        {err && <div className="flash error">{err}</div>}
        {!me?.is_approver ? (
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

            {tab === "pos" && (
              minePOs.length === 0 ? <div className="empty">No purchase orders awaiting your approval.</div> : (
              <div className="card">
                <div className="card-hd">
                  <span className="muted" style={{ fontSize: 12.5, flex: 1 }}>
                    {selected.size > 0
                      ? `${selected.size} of ${minePOs.length} selected · ${fmtMoney(minePOs.filter((r) => selected.has(String(r.id))).reduce((s, r) => s + (r.total_value ?? 0), 0))}`
                      : "Tick rows to approve several at once — click a PO number to review it first."}
                  </span>
                  {selected.size > 0 && (
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
                        <input
                          type="checkbox"
                          style={{ minHeight: 0 }}
                          checked={selected.size === minePOs.length && minePOs.length > 0}
                          onChange={(e) => setSelected(e.target.checked ? new Set(minePOs.map((r) => String(r.id))) : new Set())}
                          title="Select all"
                        />
                      </th>
                      <th>PO</th>
                      <th className="center">Project</th>
                      <th>Supplier</th>
                      <th className="num">Value</th>
                      <th className="center">Tier</th>
                      <th className="center">Reason</th>
                      <th>Raised</th>
                      <th>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {minePOs.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <input
                            type="checkbox"
                            style={{ minHeight: 0 }}
                            checked={selected.has(String(r.id))}
                            onChange={() => toggleSelected(String(r.id))}
                          />
                        </td>
                        <td><Link to={`/approvals/${r.id}`}>{r.po_number}</Link></td>
                        <td className="center">{r.project_code}</td>
                        <td>{r.supplier}</td>
                        <td className="num">{fmtMoney(r.total_value)}</td>
                        <td className="center">{r.approval_tier?.replace("_", " ")}</td>
                        <td className="center">{r.approval_reason?.replace("_", " ")}</td>
                        <td className="muted">{fmtDate(r.created_at)}</td>
                        <td className="muted">{r.created_by}</td>
                      </tr>
                    ))}
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
                          <button className="primary tiny" onClick={() => decide(p.id, "approve")}>Approve</button>{" "}
                          <button className="ghost tiny" onClick={() => decide(p.id, "reject")}>Reject</button>
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
                            <button className="primary tiny" onClick={() => decideSub(s.id, "approve")}>Approve</button>{" "}
                            <button className="ghost tiny" onClick={() => decideSub(s.id, "reject")}>Reject</button>
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

