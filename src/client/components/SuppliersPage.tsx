import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import { can } from "../../shared/permissions";
import type { CurrentUser, Element, Supplier, SupplierQuote, SupplierStatus } from "../../shared/types";

const STATUS_LABEL: Record<SupplierStatus, string> = {
  approved: "Approved",
  preferred: "Preferred",
  suspended: "Suspended",
  pending: "Pending",
};

import { CIS_RATES, PAYMENT_TERMS_OPTIONS, cisRateLabel } from "../../shared/payment-terms";

const STATUS_PILL: Record<SupplierStatus, string> = {
  approved: "approved",
  preferred: "issued",     // accent-tinted pill style
  suspended: "rejected",
  pending: "pending",
};

export function SuppliersPage({ me }: { me: CurrentUser | null }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Supplier[]>([]);
  const [elements, setElements] = useState<Element[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState<false | "materials" | "labour">(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | SupplierStatus>("all");
  const [filter, setFilter] = useState("");
  const [section, setSection] = useState<"materials" | "labour">("materials");
  const [xeroConnected, setXeroConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pushingId, setPushingId] = useState<number | null>(null);
  const [pushingAll, setPushingAll] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [supplierPicker, setSupplierPicker] = useState<{
    file: File;
    detectedName: string | null;
    candidates: Array<{ id: number; name: string; score: number }>;
    extractedCount: number;
  } | null>(null);

  // Managing the register (add / edit / delete suppliers) is suppliers.manage —
  // which Commercial holds — not approvers.manage (that's PO sign-off).
  const canManage = can(me?.role, "suppliers.manage");
  const canUploadQuotes = can(me?.role, "suppliers.manage");

  async function handleUpload(file: File, supplierId?: number) {
    setUploading(true); setErr(null);
    try {
      const r = await api.uploadQuote(file, supplierId != null ? { supplierId } : undefined);
      setSupplierPicker(null);
      navigate(`/quotes/${r.quote_id}`);
    } catch (e) {
      // 422 = supplier couldn't be matched — surface the picker.
      const msg = e instanceof Error ? e.message : "upload failed";
      try {
        const parsed = JSON.parse(msg) as {
          error?: string;
          detected_name?: string | null;
          candidates?: Array<{ id: number; name: string; score: number }>;
          extracted_count?: number;
        };
        if (parsed.error === "supplier_unmatched") {
          setSupplierPicker({
            file,
            detectedName: parsed.detected_name ?? null,
            candidates: parsed.candidates ?? [],
            extractedCount: parsed.extracted_count ?? 0,
          });
          return;
        }
      } catch {/* not JSON — fall through */}
      setErr(msg);
    } finally {
      setUploading(false);
    }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (uploadRef.current) uploadRef.current.value = "";
    if (f) handleUpload(f);
  }

  function refresh() {
    api.listSuppliers().then(setRows).catch((e) => setErr(e.message));
    api.listElements().then(setElements).catch((e) => setErr(e.message));
    api.xeroStatus().then((s) => setXeroConnected(s.connected)).catch(() => setXeroConnected(false));
  }
  useEffect(refresh, []);

  async function syncFromXero() {
    if (!confirm("Sync with Xero? Linked suppliers' current details (incl. bank) are pushed up to their Xero contact, then contacts are pulled down — matched by Xero ID or name and updated; unknown ones created as 'approved'.")) return;
    setSyncing(true); setErr(null); setInfo(null);
    try {
      const res = await api.xeroSyncSuppliers();
      const pushBit = res.pushed != null ? `${res.pushed} pushed up (incl. bank)` : "";
      const pullBit = `${res.created} created, ${res.updated} updated${res.skipped ? `, ${res.skipped} skipped (no name)` : ""} from ${res.total_from_xero} pulled`;
      setInfo(`Synced with Xero — ${[pushBit, pullBit].filter(Boolean).join("; ")}.${res.push_failed?.length ? ` Push issues: ${res.push_failed.slice(0, 3).join("; ")}${res.push_failed.length > 3 ? "…" : ""}` : ""}`);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function pushToXero(s: Supplier) {
    setPushingId(s.id); setErr(null); setInfo(null);
    try {
      const r = await api.xeroPushSupplier(s.id);
      setInfo(r.created ? `${s.name} created in Xero.` : `${s.name} synced to Xero — details (incl. bank) updated.`);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Push to Xero failed");
    } finally {
      setPushingId(null);
    }
  }

  // Push every supplier that isn't linked to a Xero contact yet — clears the
  // backlog of suppliers whose auto-push on create failed (or that were created
  // via a PO / subbie flow that doesn't auto-push), and reports any that fail.
  async function pushAllUnlinked() {
    const unlinked = rows.filter((s) => !s.xero_contact_id);
    if (unlinked.length === 0) return;
    if (!confirm(`Push ${unlinked.length} un-linked supplier${unlinked.length === 1 ? "" : "s"} to Xero (create or link their contacts)?`)) return;
    setPushingAll(true); setErr(null); setInfo(null);
    let ok = 0; const fails: string[] = [];
    for (const s of unlinked) {
      try { await api.xeroPushSupplier(s.id); ok++; }
      catch (e) { fails.push(`${s.name} — ${e instanceof Error ? e.message : "failed"}`); }
    }
    setPushingAll(false); refresh();
    if (fails.length === 0) setInfo(`Pushed ${ok} supplier${ok === 1 ? "" : "s"} to Xero.`);
    else setErr(`Pushed ${ok}. ${fails.length} couldn't push:\n• ${fails.slice(0, 6).join("\n• ")}${fails.length > 6 ? `\n…and ${fails.length - 6} more` : ""}`);
  }

  const visible = rows
    .filter((s) => statusFilter === "all" || s.status === statusFilter)
    .filter((s) => !filter || (s.name + (s.contact_name ?? "") + (s.contact_email ?? "")).toLowerCase().includes(filter.toLowerCase()));

  // The register holds both kinds; show them as their own sections with the
  // columns that matter for each (materials: scope/credit/products, labour:
  // UTR/bank — the details needed before a subbie can actually be paid).
  const materials = visible.filter((s) => !s.is_labour_supplier);
  const labour = visible.filter((s) => s.is_labour_supplier);

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
            {canUploadQuotes && (
              <>
                <input
                  ref={uploadRef}
                  type="file"
                  accept="application/pdf"
                  style={{ display: "none" }}
                  onChange={onPickFile}
                />
                <button
                  className="ghost"
                  onClick={() => uploadRef.current?.click()}
                  disabled={uploading}
                  title="Upload a supplier quote PDF — Claude auto-detects the supplier and extracts line items"
                >
                  {uploading ? "Reading PDF…" : "↑ Upload quote"}
                </button>
              </>
            )}
            {canManage && xeroConnected && rows.some((s) => !s.xero_contact_id) && (
              <button className="ghost" onClick={pushAllUnlinked} disabled={pushingAll}
                title="Create/link a Xero contact for every supplier not yet in Xero">
                {pushingAll ? "Pushing…" : `↑ Push ${rows.filter((s) => !s.xero_contact_id).length} to Xero`}
              </button>
            )}
            {canManage && xeroConnected && (
              <button className="ghost" onClick={syncFromXero} disabled={syncing}>
                {syncing ? "Syncing…" : "↻ Sync with Xero"}
              </button>
            )}
            {canManage && <button className="accent" onClick={() => setShowAdd("materials")}>+ New supplier</button>}
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

        <div className="row" style={{ margin: "4px 0 12px", gap: 8, alignItems: "center" }}>
          <div className="seg">
            <button className={`seg-btn${section === "materials" ? " active" : ""}`} onClick={() => setSection("materials")}>
              Materials suppliers ({materials.length})
            </button>
            <button className={`seg-btn${section === "labour" ? " active" : ""}`} onClick={() => setSection("labour")}>
              Labour subcontractors ({labour.length})
            </button>
          </div>
          <input
            placeholder="Filter by name / contact…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: 260 }}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="all">All statuses</option>
            <option value="preferred">Preferred</option>
            <option value="approved">Approved</option>
            <option value="pending">Pending</option>
            <option value="suspended">Suspended</option>
          </select>
        </div>

        {/* ── Materials suppliers ── */}
        {section === "materials" && (
        <div className="card">
          <div className="card-hd">
            <h2 style={{ flex: 1 }}>
              Materials suppliers <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>({materials.length})</span>
            </h2>
          </div>
          {materials.length === 0 ? (
            <div style={{ padding: 32 }}>
              <div className="empty">
                {rows.length === 0
                  ? canManage
                    ? "No suppliers yet — click + New supplier to add the first one."
                    : "No suppliers configured."
                  : "No materials suppliers match the current filter."}
              </div>
            </div>
          ) : (
            <table className="register">
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
                {materials.map((s) => (
                    <tr key={s.id} onClick={() => canManage && setEditingId(s.id)} title={canManage ? "Click to view / edit" : undefined}>
                      <td style={{ maxWidth: 320 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                          <span style={{ fontWeight: 500, whiteSpace: "nowrap" }}>{s.name}</span>
                          {s.scope_notes && (
                            <span className="muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.scope_notes}>
                              {s.scope_notes}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="center" style={{ whiteSpace: "nowrap" }}>
                        <span className={`pill ${STATUS_PILL[s.status]}`}>{STATUS_LABEL[s.status]}</span>
                        {s.xero_contact_id && (
                          <span className="pill issued" style={{ marginLeft: 6, fontSize: 10 }} title={`Xero Contact ID: ${s.xero_contact_id}`}>Xero</span>
                        )}
                      </td>
                      <td>
                        {s.approved_elements.length === 0 ? (
                          <span className="muted" style={{ fontSize: 12 }}>—</span>
                        ) : (
                          <div style={{ display: "flex", flexWrap: "nowrap", gap: 4, overflow: "hidden" }}
                            title={s.approved_elements.map((code) => elements.find((e) => e.code === code)?.name ?? code).join(", ")}>
                            {s.approved_elements.slice(0, 4).map((code) => (
                              <span key={code} className="badge" style={{ fontFamily: "ui-monospace, monospace" }}>{code}</span>
                            ))}
                            {s.approved_elements.length > 4 && (
                              <span className="badge draft">+{s.approved_elements.length - 4}</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="muted" style={{ fontSize: 13, whiteSpace: "nowrap" }}>{s.payment_terms ?? "—"}</td>
                      <td className="muted" style={{ fontSize: 12, maxWidth: 230 }}>
                        <div
                          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={[s.contact_name, s.contact_email, s.contact_phone].filter(Boolean).join(" · ") || undefined}
                        >
                          {s.contact_email ?? s.contact_name ?? s.contact_phone ?? "—"}
                        </div>
                      </td>
                      <td className="num">
                        {s.credit_limit_gbp != null ? fmtMoney(s.credit_limit_gbp) : <span className="muted">—</span>}
                      </td>
                      <td className="num">{s.product_supplier_count}</td>
                      <td style={{ whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                        {canManage && (
                          <>
                            <QuoteActionsCell supplier={s} />
                            <RowActions
                              s={s}
                              xeroConnected={xeroConnected}
                              pushingId={pushingId}
                              onPush={() => pushToXero(s)}
                              onRemoved={refresh}
                            />
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

        )}

        {/* ── Labour subcontractors ── */}
        {section === "labour" && (
        <div className="card">
          <div className="card-hd">
            <h2 style={{ flex: 1 }}>
              Labour subcontractors <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>({labour.length})</span>
            </h2>
            {canManage && (
              <button className="ghost" onClick={() => setShowAdd("labour")} title="Add a subcontractor to the approved list — appears in the incoming-labour AfP picker">
                + New subcontractor
              </button>
            )}
          </div>
          {labour.length === 0 ? (
            <div style={{ padding: 32 }}>
              <div className="empty">
                {rows.some((s) => s.is_labour_supplier)
                  ? "No labour subcontractors match the current filter."
                  : "No labour subcontractors yet — add one here, or tick “Labour supplier” when editing an existing supplier."}
              </div>
            </div>
          ) : (
            <table className="register">
              <thead>
                <tr>
                  <th>Subcontractor</th>
                  <th className="center">Status</th>
                  <th>Payment terms</th>
                  <th className="center">CIS</th>
                  <th className="center">UTR</th>
                  <th className="center">Bank details</th>
                  <th className="center">VAT no.</th>
                  <th>Contact</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {labour.map((s) => (
                    <tr key={s.id} onClick={() => canManage && setEditingId(s.id)} title={canManage ? "Click to view / edit" : undefined}>
                      <td style={{ maxWidth: 320 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                          <span style={{ fontWeight: 500, whiteSpace: "nowrap" }}>{s.name}</span>
                          {s.scope_notes && (
                            <span className="muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.scope_notes}>
                              {s.scope_notes}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="center" style={{ whiteSpace: "nowrap" }}>
                        <span className={`pill ${STATUS_PILL[s.status]}`}>{STATUS_LABEL[s.status]}</span>
                        {s.xero_contact_id && (
                          <span className="pill issued" style={{ marginLeft: 6, fontSize: 10 }} title={`Xero Contact ID: ${s.xero_contact_id}`}>Xero</span>
                        )}
                      </td>
                      <td className="muted" style={{ fontSize: 13, whiteSpace: "nowrap" }}>{s.payment_terms ?? "—"}</td>
                      <td className="center">
                        {s.cis_rate == null
                          ? <span className="pill pending" style={{ fontSize: 10 }} title="No CIS rate set — their labour certificates will push to Xero with no deduction. Edit the subcontractor to set it.">Not set</span>
                          : <span className={`pill ${s.cis_rate === 0 ? "neutral" : "approved"}`} style={{ fontSize: 10 }} title={s.cis_rate === 0 ? "Gross payment status — no deduction taken" : `${s.cis_rate}% deducted from the labour element of their certificates`}>{cisRateLabel(s.cis_rate).replace("CIS ", "")}</span>}
                      </td>
                      <td className="center">
                        {s.utr
                          ? <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{s.utr}</span>
                          : <span className="pill pending" style={{ fontSize: 10 }} title="No UTR on file — needed for CIS. Edit the subcontractor to add it.">Missing</span>}
                      </td>
                      <td className="center">
                        {s.bank_account_number
                          ? <span className="pill approved" style={{ fontSize: 10 }} title={`${s.bank_account_name ?? s.name} · ${s.bank_sort_code ?? "no sort code"} · ${s.bank_account_number}${s.bank_name ? ` · ${s.bank_name}` : ""}`}>On file</span>
                          : <span className="pill pending" style={{ fontSize: 10 }} title="No bank account on file — needed to pay them. Edit the subcontractor to add it.">Missing</span>}
                      </td>
                      <td className="center">
                        {s.vat_number
                          ? <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{s.vat_number}</span>
                          : <span className="muted" style={{ fontSize: 12 }}>—</span>}
                      </td>
                      <td className="muted" style={{ fontSize: 12, maxWidth: 230 }}>
                        <div
                          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={[s.contact_name, s.contact_email, s.contact_phone].filter(Boolean).join(" · ") || undefined}
                        >
                          {s.contact_email ?? s.contact_name ?? s.contact_phone ?? "—"}
                        </div>
                      </td>
                      <td style={{ whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                        {canManage && (
                          <RowActions
                            s={s}
                            xeroConnected={xeroConnected}
                            pushingId={pushingId}
                            onPush={() => pushToXero(s)}
                            onRemoved={refresh}
                          />
                        )}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          )}
        </div>
        )}
      </main>

      {/* Add / edit slide-over — same chrome as the drill drawers elsewhere. */}
      <SupplierDrawer
        open={showAdd !== false || editingId != null}
        editing={editingId != null ? rows.find((r) => r.id === editingId) : undefined}
        addKind={showAdd}
        elements={elements}
        onClose={() => { setShowAdd(false); setEditingId(null); }}
        onSaved={(created) => {
          setShowAdd(false); setEditingId(null); refresh();
          if (created && created.xero_pushed === false && xeroConnected) {
            setInfo("Supplier saved — but it didn't auto-push to Xero. Use the “↑ Push to Xero” button to retry.");
          }
        }}
      />

      {supplierPicker && (
        <SupplierConfirmModal
          detectedName={supplierPicker.detectedName}
          candidates={supplierPicker.candidates}
          extractedCount={supplierPicker.extractedCount}
          suppliers={rows}
          busy={uploading}
          onCancel={() => setSupplierPicker(null)}
          onConfirm={(supplierId) => handleUpload(supplierPicker.file, supplierId)}
        />
      )}
    </>
  );
}

/* ── Add / edit slide-over ──────────────────────────────────────────────── */

function SupplierDrawer({ open, editing, addKind, elements, onClose, onSaved }: {
  open: boolean;
  editing?: Supplier;
  addKind: false | "materials" | "labour";
  elements: Element[];
  onClose: () => void;
  onSaved: (created?: { id: number; xero_pushed?: boolean }) => void;
}) {
  const title = editing
    ? `Edit — ${editing.name}`
    : addKind === "labour" ? "New subcontractor" : "New supplier";
  return (
    <>
      <div className={`drill-scrim${open ? " show" : ""}`} aria-hidden onClick={onClose} />
      <aside className={`od-drawer report-drawer${open ? " open" : ""}`} role="dialog" aria-modal="false" aria-label={title}>
        {open && (
          <div className="od-inner">
            <div className="card-hd od-hd" style={{ alignItems: "flex-start", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3 style={{ margin: 0 }}>{title}</h3>
                {editing && (
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                    {editing.is_labour_supplier ? "Labour subcontractor" : "Materials supplier"} · added {editing.created_at?.slice(0, 10) ?? "—"}
                  </div>
                )}
              </div>
              <button className="ghost tiny" onClick={onClose} aria-label="Close">✕</button>
            </div>
            <div style={{ padding: "4px 20px 24px" }}>
              <SupplierForm
                key={editing?.id ?? `new-${addKind}`}
                initial={editing}
                elements={elements}
                defaultLabour={addKind === "labour"}
                onCancel={onClose}
                onSaved={onSaved}
              />
            </div>
          </div>
        )}
      </aside>
    </>
  );
}

/** Push-to-Xero / remove — shared by both register sections (the row itself
 * opens the edit drawer, so there's no Edit button). */
function RowActions({ s, xeroConnected, pushingId, onPush, onRemoved }: {
  s: Supplier;
  xeroConnected: boolean;
  pushingId: number | null;
  onPush: () => void;
  onRemoved: () => void;
}) {
  return (
    <>
      {xeroConnected && (
        <>
          <button className="ghost tiny" disabled={pushingId === s.id} onClick={onPush}
            title={s.xero_contact_id ? "Re-sync this supplier's details (incl. bank) to its Xero contact" : "Create this supplier as a contact in Xero"}>
            {pushingId === s.id ? (s.xero_contact_id ? "Syncing…" : "Pushing…") : (s.xero_contact_id ? "↻ Xero" : "↑ Xero")}
          </button>{" "}
        </>
      )}
      <button className="ghost tiny" onClick={async () => {
        if (!confirm(`Remove ${s.name}? Existing product-level supplier entries with this name will be preserved.`)) return;
        await api.removeSupplier(s.id);
        onRemoved();
      }}>×</button>
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
  initial, elements, defaultLabour, onCancel, onSaved,
}: {
  initial?: Supplier;
  elements: Element[];
  /** Pre-tick the labour flag — used by “+ New subcontractor”. */
  defaultLabour?: boolean;
  onCancel: () => void;
  onSaved: (created?: { id: number; xero_pushed?: boolean }) => void;
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
    utr: initial?.utr ?? "",
    bank_account_name: initial?.bank_account_name ?? "",
    bank_sort_code: initial?.bank_sort_code ?? "",
    bank_account_number: initial?.bank_account_number ?? "",
    bank_name: initial?.bank_name ?? "",
    credit_limit_gbp: initial?.credit_limit_gbp?.toString() ?? "",
    notes: initial?.notes ?? "",
    is_labour_supplier: initial?.is_labour_supplier ?? defaultLabour ?? false,
    // "" = not applicable (stored as NULL); "0" | "20" | "30" = the CIS rate.
    cis_rate: initial?.cis_rate != null ? String(initial.cis_rate) : "",
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
        utr: form.utr.trim() || null,
        bank_account_name: form.bank_account_name.trim() || null,
        bank_sort_code: form.bank_sort_code.trim() || null,
        bank_account_number: form.bank_account_number.trim() || null,
        bank_name: form.bank_name.trim() || null,
        credit_limit_gbp: form.credit_limit_gbp ? Number(form.credit_limit_gbp) : null,
        notes: form.notes.trim() || null,
        is_labour_supplier: form.is_labour_supplier,
        // CIS only applies to labour subcontractors — clearing the labour flag
        // clears the rate so a materials supplier can't carry one.
        cis_rate: form.is_labour_supplier && form.cis_rate !== "" ? Number(form.cis_rate) : null,
        approved_elements: [...scope].sort(),
      };
      if (initial) { await api.updateSupplier(initial.id, payload); onSaved(); }
      else { const created = await api.addSupplier(payload); onSaved(created); }
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
        <label style={{ display: "flex", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0, color: "var(--ink)", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>
          <input
            type="checkbox"
            checked={form.is_labour_supplier}
            onChange={(e) => setForm({ ...form, is_labour_supplier: e.target.checked })}
            style={{ minHeight: 0 }}
          />
          <span>Labour supplier (subcontractor)</span>
        </label>
        <div className="muted" style={{ fontSize: 12, marginTop: 4, marginLeft: 24 }}>
          Tick if this supplier provides labour. Only ticked suppliers appear in the
          "Incoming labour" Application-for-Payment subcontractor picker.
        </div>
      </div>

      {form.is_labour_supplier && (
        <div style={{ marginTop: 12 }}>
          <label>CIS deduction</label>
          <select value={form.cis_rate} onChange={(e) => setForm({ ...form, cis_rate: e.target.value })}>
            {CIS_RATES.map((r) => (
              <option key={String(r.value)} value={r.value == null ? "" : String(r.value)}>{r.label}</option>
            ))}
          </select>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Applied to the <b>labour element</b> of their certificates (expense lines sit outside CIS)
            and shown as a deduction on the draft bill pushed to Xero. Verify the subbie with HMRC to
            confirm the rate{form.utr.trim() ? "" : " — their UTR is blank above"}.
          </div>
        </div>
      )}

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
          <label>Supplier contact name</label>
          <input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} />
        </div>
        <div>
          <label>Supplier contact email</label>
          <input type="email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} />
        </div>
        <div>
          <label>Supplier contact phone</label>
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
          <label>UTR</label>
          <input value={form.utr} onChange={(e) => setForm({ ...form, utr: e.target.value })} placeholder="CIS Unique Taxpayer Reference" />
        </div>
        <div>
          <label>Credit limit (£)</label>
          <input type="number" step="100" className="num" value={form.credit_limit_gbp} onChange={(e) => setForm({ ...form, credit_limit_gbp: e.target.value })} />
        </div>
      </div>

      <div className="eyebrow" style={{ marginTop: 16, marginBottom: 4 }}>Payment information <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· bank account we pay this supplier into</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 2fr", gap: 12 }}>
        <div>
          <label>Account name</label>
          <input value={form.bank_account_name} onChange={(e) => setForm({ ...form, bank_account_name: e.target.value })} placeholder="Name on the account" />
        </div>
        <div>
          <label>Sort code</label>
          <input value={form.bank_sort_code} onChange={(e) => setForm({ ...form, bank_sort_code: e.target.value })} placeholder="00-00-00" />
        </div>
        <div>
          <label>Account number</label>
          <input value={form.bank_account_number} onChange={(e) => setForm({ ...form, bank_account_number: e.target.value })} placeholder="12345678" />
        </div>
        <div>
          <label>Bank name</label>
          <input value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} placeholder="e.g. Barclays" />
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

  return body;
}

/* ── Per-row quote indicator (jump to pending review only) ─────────────── */

function QuoteActionsCell({ supplier }: { supplier: Supplier }) {
  const navigate = useNavigate();
  const [quotes, setQuotes] = useState<SupplierQuote[]>([]);

  useEffect(() => {
    api.listSupplierQuotes(supplier.id).then(setQuotes).catch(() => setQuotes([]));
  }, [supplier.id]);

  const readyToReview = quotes.find((q) => q.status === "ready");
  if (!readyToReview) return null;

  return (
    <>
      <button
        className="ghost tiny"
        title={`Quote uploaded ${readyToReview.uploaded_at?.slice(0, 10) ?? ""} awaiting review`}
        onClick={() => navigate(`/quotes/${readyToReview.id}`)}
        style={{ color: "var(--warn)" }}
      >
        Review quote
      </button>{" "}
    </>
  );
}

/* ── Supplier-confirmation modal shown after a 422 from auto-detect ──── */

function SupplierConfirmModal({
  detectedName, candidates, extractedCount, suppliers, busy, onConfirm, onCancel,
}: {
  detectedName: string | null;
  candidates: Array<{ id: number; name: string; score: number }>;
  extractedCount: number;
  suppliers: Supplier[];
  busy: boolean;
  onConfirm: (supplierId: number) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<number | null>(candidates[0]?.id ?? null);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  const filteredAll = suppliers
    .filter((s) => !search || s.name.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 50);

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(15,17,48,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
      }}
      onClick={onCancel}
    >
      <div
        className="card"
        style={{ maxWidth: 560, width: "calc(100% - 32px)", maxHeight: "calc(100vh - 64px)", overflow: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-hd"><h3 style={{ flex: 1 }}>Which supplier is this quote from?</h3></div>
        <div className="card-bd">
          <p style={{ marginTop: 0 }}>
            Claude read{" "}
            {detectedName ? <><b>"{detectedName}"</b> off the letterhead</> : <>the letterhead</>}
            {" "}but couldn't confidently match it to a supplier in your register
            ({extractedCount} line item{extractedCount === 1 ? "" : "s"} were extracted).
          </p>

          {candidates.length > 0 && !showAll && (
            <>
              <div className="eyebrow" style={{ marginTop: 12 }}>Best guesses</div>
              <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                {candidates.map((c) => (
                  <label
                    key={c.id}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                      border: `1px solid ${picked === c.id ? "var(--accent)" : "var(--line)"}`,
                      background: picked === c.id ? "var(--accent-soft)" : "transparent",
                      borderRadius: "var(--radius-md)", cursor: "pointer",
                    }}
                  >
                    <input type="radio" name="supplier" checked={picked === c.id} onChange={() => setPicked(c.id)} />
                    <span style={{ flex: 1 }}>{c.name}</span>
                    <span className="muted" style={{ fontSize: 11 }}>{Math.round(c.score * 100)}% match</span>
                  </label>
                ))}
              </div>
              <button className="ghost tiny" onClick={() => setShowAll(true)} style={{ marginTop: 10 }}>
                None of these — show all suppliers
              </button>
            </>
          )}

          {(showAll || candidates.length === 0) && (
            <>
              <div className="eyebrow" style={{ marginTop: 12 }}>Pick from the register</div>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter by name…"
                style={{ width: "100%", marginTop: 6 }}
              />
              <div style={{ maxHeight: 260, overflowY: "auto", marginTop: 8, border: "1px solid var(--line)", borderRadius: "var(--radius-md)" }}>
                {filteredAll.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => setPicked(s.id)}
                    style={{
                      padding: "8px 10px", cursor: "pointer", fontSize: 13,
                      background: picked === s.id ? "var(--accent-soft)" : "transparent",
                      borderBottom: "1px solid var(--line)",
                    }}
                  >
                    {s.name}
                  </div>
                ))}
                {filteredAll.length === 0 && (
                  <div className="muted" style={{ padding: 14, fontSize: 13 }}>No suppliers match.</div>
                )}
              </div>
            </>
          )}

          <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
            Don't see them?{" "}
            <span>Add the supplier to the register first, then upload again.</span>
          </div>
        </div>
        <div className="card-hd" style={{ borderTop: "1px solid var(--line)", borderBottom: "none" }}>
          <div className="grow" />
          <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>{" "}
          <button
            className="accent"
            disabled={busy || picked == null}
            onClick={() => picked != null && onConfirm(picked)}
          >
            {busy ? "Uploading…" : "Confirm supplier"}
          </button>
        </div>
      </div>
    </div>
  );
}
