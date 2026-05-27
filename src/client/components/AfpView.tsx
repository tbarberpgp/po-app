// Application for Payment detail screen — edit % complete per BOQ line, add
// variation lines, see live totals, walk the workflow (submit → certify →
// mark paid). Direction is read from the AfP itself; the layout serves both
// outgoing (to client) and incoming labour (from subcontractor).

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import { can } from "../../shared/permissions";
import { generateAfpPdf } from "../lib/afp-pdf";
import { generateAfpXlsx } from "../lib/afp-xlsx";
import type { AfpDetail, AfpLine, AfpStatus, CurrentUser } from "../../shared/types";

export function AfpView({ me }: { me: CurrentUser | null }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const afpId = Number(id);
  const [detail, setDetail] = useState<AfpDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = can(me?.role, "projects.edit");

  function refresh() {
    if (!Number.isFinite(afpId)) return;
    api.getAfp(afpId).then(setDetail).catch((e) => setErr(e.message));
  }
  useEffect(refresh, [afpId]);

  if (!detail) return <main>{err ? <div className="flash error">{err}</div> : <div className="muted">Loading…</div>}</main>;
  const { afp, lines, prior_apps } = detail;
  const isDraft = afp.status === "draft";
  const isOutgoing = afp.direction === "outgoing";

  async function setPct(lineId: number, pct: number) {
    setBusy(true); setErr(null);
    try { await api.updateAfpLine(lineId, { percent_complete: pct }); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "update failed"); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!confirm(`Send AfP #${afp.app_number} for director approval? The totals will be frozen until the director approves or rejects.`)) return;
    setBusy(true);
    try { await api.submitAfp(afp.id); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "submit failed"); }
    finally { setBusy(false); }
  }
  async function approve() {
    setBusy(true); setErr(null);
    try { await api.approveAfp(afp.id); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "approve failed"); }
    finally { setBusy(false); }
  }
  async function reject() {
    const reason = prompt("Reason for rejection (optional, sent back to the requester)") ?? undefined;
    setBusy(true); setErr(null);
    try { await api.rejectAfp(afp.id, reason); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "reject failed"); }
    finally { setBusy(false); }
  }
  async function certify() {
    const input = prompt(`Amount certified by ${isOutgoing ? "the client" : "PowerGrid"} (£). Leave blank to accept amount due ${fmtMoney(afp.amount_due ?? 0)}.`);
    if (input === null) return;
    const amount = input.trim() ? Number(input) : undefined;
    if (input.trim() && !Number.isFinite(amount)) { setErr("Invalid amount"); return; }
    setBusy(true);
    try { await api.certifyAfp(afp.id, amount != null ? { certified_amount: amount } : undefined); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "certify failed"); }
    finally { setBusy(false); }
  }
  async function markPaid() {
    const ref = prompt("Payment reference (optional, e.g. BACS XXX)") ?? undefined;
    setBusy(true);
    try { await api.markAfpPaid(afp.id, ref || undefined); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "mark paid failed"); }
    finally { setBusy(false); }
  }
  async function discard() {
    if (!confirm("Discard this draft AfP?")) return;
    try { await api.deleteAfp(afp.id); navigate(`/projects/${afp.project_id}`); }
    catch (e) { setErr(e instanceof Error ? e.message : "delete failed"); }
  }
  async function forceDelete() {
    if (!confirm(`Force-delete AfP #${afp.app_number} (status: ${afp.status})? This bypasses workflow and removes the AfP + all its lines permanently.`)) return;
    try { await api.deleteAfp(afp.id); navigate(`/projects/${afp.project_id}`); }
    catch (e) { setErr(e instanceof Error ? e.message : "delete failed"); }
  }
  async function downloadPdf() {
    if (!detail) return;
    setBusy(true); setErr(null);
    try {
      const bytes = await generateAfpPdf(detail);
      triggerDownload(bytes, `AfP-${afp.project_code ?? "project"}-${afp.app_number}.pdf`, "application/pdf");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "PDF generation failed");
    } finally { setBusy(false); }
  }
  function downloadXlsx() {
    if (!detail) return;
    try {
      const bytes = generateAfpXlsx(detail);
      triggerDownload(bytes, `AfP-${afp.project_code ?? "project"}-${afp.app_number}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Excel generation failed");
    }
  }

  return (
    <>
      <Topbar
        crumbs={<><Link to="/">Projects</Link> · <Link to={`/projects/${afp.project_id}`}>{afp.project_code}</Link> · AfP #{afp.app_number}</>}
        title={`Application for Payment #${afp.app_number}`}
        status={<span className={`pill ${statusPill(afp.status)}`}>{afp.status}</span>}
        actions={
          <>
            <button className="ghost" onClick={downloadPdf} disabled={busy} title="Download as PDF">↓ PDF</button>
            <button className="ghost" onClick={downloadXlsx} disabled={busy} title="Download as Excel">↓ Excel</button>
            {canEdit && isDraft && (
              <>
                <button className="ghost" onClick={discard} disabled={busy}>Discard</button>
                <button className="accent" onClick={submit} disabled={busy}>Send for approval</button>
              </>
            )}
            {canEdit && afp.status === "pending_approval" && me?.is_approver && me.approver_tiers.includes("director") && (
              <>
                <button className="ghost" onClick={reject} disabled={busy}>Reject</button>
                <button className="accent" onClick={approve} disabled={busy}>Approve & send</button>
              </>
            )}
            {canEdit && afp.status === "submitted" && (
              <button className="accent" onClick={certify} disabled={busy}>Mark certified</button>
            )}
            {canEdit && afp.status === "certified" && (
              <button className="accent" onClick={markPaid} disabled={busy}>Mark paid</button>
            )}
            {me?.role === "superadmin" && afp.status !== "draft" && (
              <button className="danger" onClick={forceDelete} disabled={busy} title="Superadmin force-delete">Delete</button>
            )}
          </>
        }
      />
      <main>
        {err && <div className="flash error">{err}</div>}

        {/* Header card */}
        <div className="card">
          <div className="card-bd" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24 }}>
            <Field label="Project" value={`${afp.project_code} — ${afp.project_name}`} />
            <Field label="Client" value={afp.project_client ?? <span className="muted">—</span>} />
            <Field label="Period ending" value={fmtDate(afp.period_end)} />
            <Field label="Direction" value={isOutgoing ? "Outgoing (to client)" : "Incoming labour"} />
          </div>
        </div>

        {/* Headline totals */}
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-hd"><h2 style={{ flex: 1 }}>This application</h2></div>
          <div className="card-bd" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24 }}>
            <Field label="Contract sum" value={fmtMoney(afp.contract_sum ?? 0)} />
            <Field label="Cumulative value of works" value={fmtMoney(afp.cumulative_value ?? 0)} />
            <Field label="Previously certified" value={fmtMoney(afp.previous_certified ?? 0)} />
            <Field label="This period (net)" value={fmtMoney(afp.this_period_net ?? 0)} />
          </div>
          <div className="card-bd" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24, borderTop: "1px solid var(--line)" }}>
            <Field label={`Retention (${afp.retention_pct}%)`} value={`-${fmtMoney(afp.retention_amount ?? 0)}`} />
            <Field label="Amount due (ex VAT)" value={<b>{fmtMoney(afp.amount_due ?? 0)}</b>} />
            <Field label={`VAT (${afp.vat_pct}%)`} value={fmtMoney(afp.vat_amount ?? 0)} />
            <Field
              label="Total invoice"
              value={<span style={{ fontWeight: 700, color: "var(--accent-2)" }}>{fmtMoney(afp.total_invoice ?? 0)}</span>}
            />
          </div>
          {afp.status === "certified" && afp.certified_amount != null && (
            <div className="card-bd" style={{ borderTop: "1px solid var(--line)", background: "var(--card-2)" }}>
              <div className="muted">
                Certified amount: <b>{fmtMoney(afp.certified_amount)}</b>{" "}
                on {fmtDate(afp.certified_at)} by {afp.certified_by}.
              </div>
            </div>
          )}
          {afp.status === "paid" && (
            <div className="card-bd" style={{ borderTop: "1px solid var(--line)", background: "var(--card-2)" }}>
              <div className="muted">
                Paid on {fmtDate(afp.paid_at)}{afp.payment_reference ? <> · ref <code>{afp.payment_reference}</code></> : null}.
              </div>
            </div>
          )}
        </div>

        {/* Prior applications context */}
        {prior_apps.length > 0 && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-hd"><h3 style={{ flex: 1 }}>Previous applications</h3></div>
            <table>
              <thead>
                <tr>
                  <th className="center">#</th>
                  <th>Period ending</th>
                  <th className="center">Status</th>
                  <th className="num">Cumulative</th>
                  <th className="num">Certified</th>
                  <th className="num">Invoice</th>
                </tr>
              </thead>
              <tbody>
                {prior_apps.map((p) => (
                  <tr key={p.app_number}>
                    <td className="center">{p.app_number}</td>
                    <td>{fmtDate(p.period_end)}</td>
                    <td className="center"><span className={`pill ${statusPill(p.status)}`} style={{ fontSize: 10 }}>{p.status}</span></td>
                    <td className="num">{p.cumulative_value != null ? fmtMoney(p.cumulative_value) : "—"}</td>
                    <td className="num">{p.certified_amount != null ? fmtMoney(p.certified_amount) : "—"}</td>
                    <td className="num">{p.total_invoice != null ? fmtMoney(p.total_invoice) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Line items */}
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-hd">
            <h2 style={{ flex: 1 }}>Works claimed</h2>
            <span className="pill">{lines.length}</span>
            {isDraft && canEdit && <AddAdhocLineButton afpId={afp.id} onAdded={refresh} />}
          </div>
          <LinesTable lines={lines} isDraft={isDraft} canEdit={canEdit} onSetPct={setPct} onRefresh={refresh} />
        </div>

        {/* Notes */}
        {afp.notes && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-hd"><h3>Notes</h3></div>
            <div className="card-bd" style={{ whiteSpace: "pre-wrap" }}>{afp.notes}</div>
          </div>
        )}
      </main>
    </>
  );
}

function statusPill(s: AfpStatus): string {
  switch (s) {
    case "draft": return "draft";
    case "pending_approval": return "pending";
    case "submitted": return "issued";
    case "certified": return "approved";
    case "paid": return "approved";
  }
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div style={{ marginTop: 4, fontSize: 14 }}>{value}</div>
    </div>
  );
}

function LinesTable({
  lines, isDraft, canEdit, onSetPct, onRefresh,
}: {
  lines: AfpLine[];
  isDraft: boolean;
  canEdit: boolean;
  onSetPct: (lineId: number, pct: number) => void;
  onRefresh: () => void;
}) {
  // Group by section so the document mirrors the BOQ structure.
  const grouped = useMemo(() => {
    const groups: Array<{ section: string; lines: AfpLine[] }> = [];
    for (const l of lines) {
      const sec = l.section ?? "—";
      const g = groups[groups.length - 1];
      if (!g || g.section !== sec) groups.push({ section: sec, lines: [l] });
      else g.lines.push(l);
    }
    return groups;
  }, [lines]);

  return (
    <table>
      <thead>
        <tr>
          <th>Item</th>
          <th className="num">Qty</th>
          <th className="center">Unit</th>
          <th className="num">Rate</th>
          <th className="num">Contract value</th>
          <th className="center" style={{ width: 130 }}>% complete</th>
          <th className="num">Cumulative</th>
          {isDraft && canEdit && <th style={{ width: 60 }}></th>}
        </tr>
      </thead>
      <tbody>
        {grouped.map((g, gi) => (
          <Group key={gi} group={g} isDraft={isDraft} canEdit={canEdit} onSetPct={onSetPct} onRefresh={onRefresh} />
        ))}
      </tbody>
    </table>
  );
}

function Group({
  group, isDraft, canEdit, onSetPct, onRefresh,
}: {
  group: { section: string; lines: AfpLine[] };
  isDraft: boolean;
  canEdit: boolean;
  onSetPct: (lineId: number, pct: number) => void;
  onRefresh: () => void;
}) {
  const sectionTotal = group.lines.reduce((s, l) => s + l.contract_value, 0);
  const sectionCum = group.lines.reduce((s, l) => s + l.cumulative_value, 0);
  return (
    <>
      <tr style={{ background: "var(--card-2)" }}>
        <td colSpan={isDraft && canEdit ? 8 : 7} style={{ fontWeight: 600, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {group.section}
          {group.lines.some((l) => l.is_adhoc) && (
            <span className="badge unpriced" style={{ marginLeft: 8 }}>variation</span>
          )}
        </td>
      </tr>
      {group.lines.map((l) => (
        <LineRow key={l.id} line={l} isDraft={isDraft} canEdit={canEdit} onSetPct={onSetPct} onRefresh={onRefresh} />
      ))}
      <tr>
        <td colSpan={4} style={{ fontWeight: 600, textAlign: "right" }}>Section subtotal</td>
        <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(sectionTotal)}</td>
        <td className="center muted" style={{ fontSize: 11 }}>
          {sectionTotal > 0 ? `${((sectionCum / sectionTotal) * 100).toFixed(0)}%` : "—"}
        </td>
        <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(sectionCum)}</td>
        {isDraft && canEdit && <td></td>}
      </tr>
    </>
  );
}

function LineRow({
  line, isDraft, canEdit, onSetPct, onRefresh,
}: {
  line: AfpLine;
  isDraft: boolean;
  canEdit: boolean;
  onSetPct: (lineId: number, pct: number) => void;
  onRefresh: () => void;
}) {
  const [pct, setPct] = useState(line.percent_complete);
  useEffect(() => setPct(line.percent_complete), [line.percent_complete]);

  function commit(newPct: number) {
    const clamped = Math.max(0, Math.min(100, newPct));
    setPct(clamped);
    if (Math.abs(clamped - line.percent_complete) > 0.001) onSetPct(line.id, clamped);
  }

  async function deleteAdhoc() {
    if (!confirm(`Delete variation line "${line.description}"?`)) return;
    await api.deleteAfpLine(line.id);
    onRefresh();
  }

  return (
    <tr>
      <td>
        {line.description}
        {line.is_adhoc ? <span className="badge unpriced" style={{ marginLeft: 6, fontSize: 10 }}>variation</span> : null}
      </td>
      <td className="num">{line.qty?.toLocaleString() ?? "—"}</td>
      <td className="center">{line.unit ?? "—"}</td>
      <td className="num">{fmtMoney(line.rate)}</td>
      <td className="num">{fmtMoney(line.contract_value)}</td>
      <td className="center">
        {isDraft && canEdit ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <input
              type="number"
              min={0}
              max={100}
              step="any"
              value={pct}
              onChange={(e) => setPct(Number(e.target.value))}
              onBlur={() => commit(pct)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              style={{ width: 60, textAlign: "right" }}
            />
            <span className="muted" style={{ fontSize: 12 }}>%</span>
          </span>
        ) : (
          <span>{line.percent_complete.toFixed(1)}%</span>
        )}
      </td>
      <td className="num" style={{ fontWeight: line.cumulative_value > 0 ? 600 : 400 }}>
        {fmtMoney(line.cumulative_value)}
      </td>
      {isDraft && canEdit && (
        <td>
          {line.is_adhoc ? (
            <button className="ghost tiny" onClick={deleteAdhoc} title="Delete variation">×</button>
          ) : null}
        </td>
      )}
    </tr>
  );
}

function AddAdhocLineButton({ afpId, onAdded }: { afpId: number; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ description: "", qty: "", unit: "", rate: "", section: "Variations" });
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!form.description.trim() || !form.qty || !form.rate) return;
    setBusy(true);
    try {
      await api.addAfpLine(afpId, {
        description: form.description.trim(),
        qty: Number(form.qty),
        unit: form.unit || undefined,
        rate: Number(form.rate),
        section: form.section || "Variations",
      });
      setForm({ description: "", qty: "", unit: "", rate: "", section: "Variations" });
      setOpen(false);
      onAdded();
    } finally { setBusy(false); }
  }

  if (!open) {
    return <button className="ghost tiny" onClick={() => setOpen(true)}>+ Add variation</button>;
  }
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <input placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ width: 220 }} />
      <input placeholder="Qty" type="number" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} style={{ width: 70 }} />
      <input placeholder="Unit" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} style={{ width: 60 }} />
      <input placeholder="Rate £" type="number" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} style={{ width: 90 }} />
      <button className="primary tiny" onClick={save} disabled={busy}>{busy ? "…" : "Add"}</button>
      <button className="ghost tiny" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}

/** Trigger a browser download for an in-memory file. */
function triggerDownload(bytes: Uint8Array, filename: string, mime: string) {
  // Copy into a fresh ArrayBuffer so the Blob type-checks against the browser's
  // strict BlobPart definition (Uint8Array with a SharedArrayBuffer backing
  // store can otherwise fail in newer TS lib defs).
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const blob = new Blob([buf], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
