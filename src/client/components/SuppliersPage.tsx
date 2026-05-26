import { useEffect, useMemo, useState } from "react";
import { api, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import { can } from "../../shared/permissions";
import type { CurrentUser, Element, Supplier, SupplierStatus } from "../../shared/types";

const STATUS_LABEL: Record<SupplierStatus, string> = {
  approved: "Approved",
  preferred: "Preferred",
  suspended: "Suspended",
  pending: "Pending",
};

/** UK trade payment terms. Anything stored on a supplier outside this list is
 * preserved by prepending it as a one-off "(custom)" option in the dropdown. */
const PAYMENT_TERMS_OPTIONS = [
  "Pro forma",
  "COD",
  "Net 7 days",
  "Net 14 days",
  "Net 21 days",
  "Net 30 days",
  "Net 30 days EOM",
  "Net 45 days",
  "Net 60 days",
  "Net 60 days EOM",
  "Net 75 days",
  "Net 90 days",
  "2/10 Net 30",
];

const STATUS_PILL: Record<SupplierStatus, string> = {
  approved: "approved",
  preferred: "issued",     // accent-tinted pill style
  suspended: "rejected",
  pending: "pending",
};

export function SuppliersPage({ me }: { me: CurrentUser | null }) {
  const [rows, setRows] = useState<Supplier[]>([]);
  const [elements, setElements] = useState<Element[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | SupplierStatus>("all");
  const [filter, setFilter] = useState("");
  const [xeroConnected, setXeroConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const canManage = can(me?.role, "approvers.manage");

  function refresh() {
    api.listSuppliers().then(setRows).catch((e) => setErr(e.message));
    api.listElements().then(setElements).catch((e) => setErr(e.message));
    api.xeroStatus().then((s) => setXeroConnected(s.connected)).catch(() => setXeroConnected(false));
  }
  useEffect(refresh, []);

  async function syncFromXero() {
    if (!confirm("Pull supplier contacts from Xero? Existing suppliers will be matched by Xero ID or name and updated; unknown ones will be created as 'approved'.")) return;
    setSyncing(true); setErr(null); setInfo(null);
    try {
      const res = await api.xeroSyncSuppliers();
      setInfo(`Synced from Xero: ${res.created} created, ${res.updated} updated${res.skipped ? `, ${res.skipped} skipped (no name)` : ""}. ${res.total_from_xero} contacts pulled.`);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "sync failed");
    } finally {
      setSyncing(false);
    }
  }

  const visible = rows
    .filter((s) => statusFilter === "all" || s.status === statusFilter)
    .filter((s) => !filter || (s.name + (s.contact_name ?? "") + (s.contact_email ?? "")).toLowerCase().includes(filter.toLowerCase()));

  const byStatus = useMemo(() => {
    const m: Record<SupplierStatus, number> = { approved: 0, preferred: 0, suspended: 0, pending: 0 };
    for (const r of rows) m[r.status] += 1;
    return m;
  }, [rows]);

  return (
    <>
      <Topbar
        crumbs="Master data"
        title="Approved suppliers"
        actions={
          <>
            {canManage && xeroConnected && (
              <button className="ghost" onClick={syncFromXero} disabled={syncing}>
                {syncing ? "Syncing…" : "↻ Sync from Xero"}
              </button>
            )}
            {canManage && <button className="accent" onClick={() => setShowAdd(true)}>+ New supplier</button>}
          </>
        }
      />
      <main>
        {err && <div className="flash error">{err}</div>}
        {info && <div className="flash success">{info}</div>}

        <div className="kpis" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
          <KpiSmall label="Preferred" value={byStatus.preferred} tone="accent" />
          <KpiSmall label="Approved" value={byStatus.approved} tone="success" />
          <KpiSmall label="Pending" value={byStatus.pending} tone="warn" />
          <KpiSmall label="Suspended" value={byStatus.suspended} tone="danger" />
        </div>

        {showAdd && (
          <SupplierForm
            elements={elements}
            onCancel={() => setShowAdd(false)}
            onSaved={() => { setShowAdd(false); refresh(); }}
          />
        )}

        <div className="card">
          <div className="card-hd">
            <h2 style={{ flex: 1 }}>Suppliers</h2>
            <input
              placeholder="Filter by name / contact…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ width: 240 }}
            />
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
              <option value="all">All statuses</option>
              <option value="preferred">Preferred</option>
              <option value="approved">Approved</option>
              <option value="pending">Pending</option>
              <option value="suspended">Suspended</option>
            </select>
          </div>
          {visible.length === 0 ? (
            <div style={{ padding: 32 }}>
              <div className="empty">
                {rows.length === 0
                  ? canManage
                    ? "No suppliers yet — click + New supplier to add the first one."
                    : "No suppliers configured."
                  : "No suppliers match the current filter."}
              </div>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th className="center">Status</th>
                  <th>Scope (elements)</th>
                  <th>Payment terms</th>
                  <th>Contact</th>
                  <th className="num">Credit limit</th>
                  <th className="num">Products</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s) =>
                  editingId === s.id ? (
                    <SupplierForm
                      key={s.id}
                      asRow
                      initial={s}
                      elements={elements}
                      onCancel={() => setEditingId(null)}
                      onSaved={() => { setEditingId(null); refresh(); }}
                    />
                  ) : (
                    <tr key={s.id}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{s.name}</div>
                        {s.scope_notes && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{s.scope_notes}</div>}
                      </td>
                      <td className="center">
                        <span className={`pill ${STATUS_PILL[s.status]}`}>{STATUS_LABEL[s.status]}</span>
                        {s.xero_contact_id && (
                          <span className="pill issued" style={{ marginLeft: 6, fontSize: 10 }} title={`Xero Contact ID: ${s.xero_contact_id}`}>Xero</span>
                        )}
                      </td>
                      <td>
                        {s.approved_elements.length === 0 ? (
                          <span className="muted" style={{ fontSize: 12 }}>—</span>
                        ) : (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {s.approved_elements.slice(0, 6).map((code) => (
                              <span key={code} className="badge" title={elements.find((e) => e.code === code)?.name ?? code} style={{ fontFamily: "ui-monospace, monospace" }}>{code}</span>
                            ))}
                            {s.approved_elements.length > 6 && (
                              <span className="badge draft">+{s.approved_elements.length - 6}</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="muted" style={{ fontSize: 13 }}>{s.payment_terms ?? "—"}</td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {s.contact_name && <div>{s.contact_name}</div>}
                        {s.contact_email && <div>{s.contact_email}</div>}
                        {s.contact_phone && <div>{s.contact_phone}</div>}
                        {!s.contact_name && !s.contact_email && !s.contact_phone && "—"}
                      </td>
                      <td className="num">
                        {s.credit_limit_gbp != null ? fmtMoney(s.credit_limit_gbp) : <span className="muted">—</span>}
                      </td>
                      <td className="num">{s.product_supplier_count}</td>
                      <td>
                        {canManage && (
                          <>
                            <button className="ghost tiny" onClick={() => setEditingId(s.id)}>Edit</button>{" "}
                            <button className="ghost tiny" onClick={async () => {
                              if (!confirm(`Remove ${s.name}? Existing product-level supplier entries with this name will be preserved.`)) return;
                              await api.removeSupplier(s.id);
                              refresh();
                            }}>×</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}

function KpiSmall({ label, value, tone }: { label: string; value: number; tone: "accent" | "success" | "warn" | "danger" }) {
  const color = tone === "accent" ? "var(--accent-2)"
    : tone === "success" ? "var(--success)"
    : tone === "warn" ? "var(--warn)"
    : "var(--danger)";
  return (
    <div className="kpi">
      <div className="kpi-label" style={{ color }}>{label}</div>
      <div className="kpi-value">{value}</div>
    </div>
  );
}

/* ── Supplier add/edit form ─────────────────────────────────────────────── */

function SupplierForm({
  asRow, initial, elements, onCancel, onSaved,
}: {
  asRow?: boolean;
  initial?: Supplier;
  elements: Element[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    status: initial?.status ?? "approved" as SupplierStatus,
    scope_notes: initial?.scope_notes ?? "",
    payment_terms: initial?.payment_terms ?? "",
    contact_name: initial?.contact_name ?? "",
    contact_email: initial?.contact_email ?? "",
    contact_phone: initial?.contact_phone ?? "",
    address: initial?.address ?? "",
    vat_number: initial?.vat_number ?? "",
    credit_limit_gbp: initial?.credit_limit_gbp?.toString() ?? "",
    notes: initial?.notes ?? "",
  });
  const [scope, setScope] = useState<Set<string>>(
    () => new Set(initial?.approved_elements ?? []),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggleElement(code: string) {
    setScope((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      const payload = {
        name: form.name.trim(),
        status: form.status,
        scope_notes: form.scope_notes.trim() || null,
        payment_terms: form.payment_terms.trim() || null,
        contact_name: form.contact_name.trim() || null,
        contact_email: form.contact_email.trim() || null,
        contact_phone: form.contact_phone.trim() || null,
        address: form.address.trim() || null,
        vat_number: form.vat_number.trim() || null,
        credit_limit_gbp: form.credit_limit_gbp ? Number(form.credit_limit_gbp) : null,
        notes: form.notes.trim() || null,
        approved_elements: [...scope].sort(),
      };
      if (initial) await api.updateSupplier(initial.id, payload);
      else await api.addSupplier(payload);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  const body = (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr", gap: 12 }}>
        <div>
          <label>Supplier name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. SIG Roofing" />
        </div>
        <div>
          <label>Status</label>
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as SupplierStatus })}>
            <option value="preferred">Preferred</option>
            <option value="approved">Approved</option>
            <option value="pending">Pending onboarding</option>
            <option value="suspended">Suspended</option>
          </select>
        </div>
        <div>
          <label>Payment terms</label>
          <select
            value={form.payment_terms}
            onChange={(e) => setForm({ ...form, payment_terms: e.target.value })}
          >
            <option value="">— Not set —</option>
            {/* Preserve any existing custom value (legacy free-text entries) */}
            {form.payment_terms && !PAYMENT_TERMS_OPTIONS.includes(form.payment_terms) && (
              <option value={form.payment_terms}>{form.payment_terms} (custom)</option>
            )}
            {PAYMENT_TERMS_OPTIONS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <label>Scope (short description)</label>
        <input value={form.scope_notes} onChange={(e) => setForm({ ...form, scope_notes: e.target.value })} placeholder="What they supply us with — e.g. 'roofing accessories + flashings, no insulation'" />
      </div>

      <div style={{ marginTop: 12 }}>
        <label>Approved elements (tick all this supplier is approved to provide)</label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 4, padding: 8, border: "1px solid var(--line)", borderRadius: 8, background: "var(--card-2)" }}>
          {elements.map((e) => (
            <label key={e.code} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "4px 6px", textTransform: "none", letterSpacing: 0, color: "var(--ink)", cursor: "pointer", margin: 0, borderRadius: 4 }}>
              <input
                type="checkbox"
                checked={scope.has(e.code)}
                onChange={() => toggleElement(e.code)}
                style={{ minHeight: 0 }}
              />
              <span style={{ fontFamily: "ui-monospace, monospace", color: "var(--muted)", fontSize: 11 }}>{e.code}</span>
              <span>{e.name}</span>
            </label>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {scope.size === 0 ? "None — supplier can be used on any element." : `${scope.size} element${scope.size === 1 ? "" : "s"} ticked.`}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 12 }}>
        <div>
          <label>Contact name</label>
          <input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} />
        </div>
        <div>
          <label>Contact email</label>
          <input type="email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} />
        </div>
        <div>
          <label>Contact phone</label>
          <input value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12, marginTop: 12 }}>
        <div>
          <label>Address</label>
          <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Trading address" />
        </div>
        <div>
          <label>VAT number</label>
          <input value={form.vat_number} onChange={(e) => setForm({ ...form, vat_number: e.target.value })} />
        </div>
        <div>
          <label>Credit limit (£)</label>
          <input type="number" step="100" className="num" value={form.credit_limit_gbp} onChange={(e) => setForm({ ...form, credit_limit_gbp: e.target.value })} />
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <label>Internal notes</label>
        <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Account manager, discount band, anything to remember…" style={{ width: "100%" }} />
      </div>

      {err && <div className="flash error" style={{ marginTop: 12 }}>{err}</div>}

      <div className="row" style={{ marginTop: 16 }}>
        <button className="primary" onClick={save} disabled={busy || !form.name.trim()}>{initial ? "Save" : "Add supplier"}</button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </>
  );

  if (asRow) {
    return (
      <tr style={{ background: "var(--accent-soft)" }}>
        <td colSpan={8} style={{ padding: 20 }}>{body}</td>
      </tr>
    );
  }
  return (
    <div className="card">
      <div className="card-hd"><h3>{initial ? "Edit supplier" : "New supplier"}</h3></div>
      <div className="card-bd">{body}</div>
    </div>
  );
}
