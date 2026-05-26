// Supplier quote review screen: shows what Claude extracted from the PDF,
// the suggested product match for each line, and the price delta vs the
// supplier's current price. The PM tweaks matches, then applies — at which
// point the quoted prices land on product_suppliers rows.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import { can } from "../../shared/permissions";
import type { CurrentUser, SupplierQuote, SupplierQuoteLine } from "../../shared/types";

type ProductHit = Awaited<ReturnType<typeof api.searchProductsForQuote>>[number];

export function QuoteReview({ me }: { me: CurrentUser | null }) {
  const { quoteId } = useParams<{ quoteId: string }>();
  const navigate = useNavigate();
  const id = Number(quoteId);

  const [quote, setQuote] = useState<SupplierQuote | null>(null);
  const [lines, setLines] = useState<SupplierQuoteLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<Awaited<ReturnType<typeof api.applyQuote>> | null>(null);

  const canManage = can(me?.role, "suppliers.manage");

  function refresh() {
    if (!Number.isFinite(id)) return;
    api.getQuote(id).then((r) => {
      setQuote(r.quote);
      setLines(r.lines);
    }).catch((e) => setErr(e.message));
  }
  useEffect(refresh, [id]);

  async function remit(lineId: number, productId: number | null) {
    await api.rematchQuoteLine(lineId, productId);
    refresh();
  }
  async function skip(lineId: number) {
    await api.skipQuoteLine(lineId, "skipped by reviewer");
    refresh();
  }
  async function unskip(lineId: number) {
    // Re-match to null (clears match + reason). User can then pick a product.
    await api.rematchQuoteLine(lineId, null);
    refresh();
  }
  async function applyAll() {
    if (!quote || !canManage) return;
    const willApply = lines.filter((l) => {
      if (l.skip_reason || l.unit_price == null) return false;
      return isProjectQuote ? l.matched_material_id != null : l.matched_product_id != null;
    }).length;
    if (willApply === 0) {
      setErr(
        isProjectQuote
          ? "No lines matched to BOQ materials. Skip lines that don't match, or upload a BOQ first."
          : "No lines selected to apply. Match at least one line first.",
      );
      return;
    }
    const confirmMsg = isProjectQuote
      ? `Apply ${willApply} line${willApply === 1 ? "" : "s"} from ${quote.supplier_name}? Lines cheaper than BOQ will save immediately; pricier lines will go for approval.`
      : `Apply ${willApply} line${willApply === 1 ? "" : "s"} to ${quote.supplier_name}? This updates their unit costs in the product catalogue.`;
    if (!confirm(confirmMsg)) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.applyQuote(quote.id);
      setApplyResult(r);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "apply failed");
    } finally { setBusy(false); }
  }

  const isProjectQuote = quote?.project_id != null;

  // Aggregate delta preview before applying.
  //   Catalogue quotes: compare against supplier_current_cost / product primary cost.
  //   Project quotes:   compare against the BOQ baseline (boq_unit_cost) and split by
  //                     whether the line is cheaper (will apply) or over-budget
  //                     (will go pending approval).
  const preview = useMemo(() => {
    let willApply = 0;
    let willPending = 0;
    let newValue = 0;
    let oldValue = 0;
    let savings = 0;
    let pendingOverspend = 0;
    let unmatched = 0;
    let skipped = 0;
    for (const l of lines) {
      if (l.skip_reason) { skipped++; continue; }
      const matched = isProjectQuote ? l.matched_material_id : l.matched_product_id;
      if (!matched) { unmatched++; continue; }
      if (l.unit_price == null) continue;
      const qty = l.raw_qty ?? 0;
      const newLine = qty * l.unit_price;
      const old = isProjectQuote
        ? (l.boq_unit_cost ?? 0) * qty
        : (l.supplier_current_cost ?? l.product_primary_cost ?? 0) * qty;
      newValue += newLine;
      oldValue += old;
      if (isProjectQuote) {
        const delta = newLine - old;
        if (delta > 0) {
          willPending++;
          pendingOverspend += delta;
        } else {
          willApply++;
          savings += -delta;
        }
      } else {
        willApply++;
      }
    }
    return {
      willApply, willPending, newValue, oldValue, savings, pendingOverspend,
      delta: newValue - oldValue, unmatched, skipped,
    };
  }, [lines, isProjectQuote]);

  if (!quote) {
    return (
      <main>{err ? <div className="flash error">{err}</div> : <div className="muted">Loading…</div>}</main>
    );
  }

  const isApplied = quote.status === "applied";
  const finalDelta = applyResult ? applyResult.delta_value : (quote.total_applied_value != null && quote.total_old_value != null ? quote.total_applied_value - quote.total_old_value : null);
  const finalApplied = applyResult ? applyResult.total_applied_value : quote.total_applied_value;
  const finalOld = applyResult ? applyResult.total_old_value : quote.total_old_value;

  return (
    <>
      <Topbar
        crumbs={<><Link to="/suppliers">Approved suppliers</Link> · Quote review</>}
        title={`Quote from ${quote.supplier_name ?? "—"}`}
        actions={
          !isApplied && canManage ? (
            <>
              <button className="ghost" onClick={() => { if (confirm("Discard this quote?")) api.discardQuote(quote.id).then(() => navigate("/suppliers")); }}>Discard</button>
              <button
                className="accent"
                onClick={applyAll}
                disabled={busy || (preview.willApply + preview.willPending) === 0}
              >
                {busy
                  ? "Applying…"
                  : isProjectQuote
                    ? `Apply ${preview.willApply + preview.willPending} line${(preview.willApply + preview.willPending) === 1 ? "" : "s"}`
                    : `Apply ${preview.willApply} line${preview.willApply === 1 ? "" : "s"}`}
              </button>
            </>
          ) : null
        }
      />
      <main>
        {err && <div className="flash error">{err}</div>}

        {/* Header / context card */}
        <div className="card">
          <div className="card-bd" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24 }}>
            <Field label="File" value={quote.filename} />
            <Field label="Uploaded" value={`${fmtDate(quote.uploaded_at)} · ${quote.uploaded_by}`} />
            <Field label="Status" value={<span className={`pill ${statusPill(quote.status)}`}>{quote.status}</span>} />
            <Field label="Notes" value={quote.notes ?? <span className="muted">—</span>} />
          </div>
        </div>

        {/* Delta summary card */}
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-hd">
            <h2 style={{ flex: 1 }}>
              {isApplied ? "Applied" : "Preview"}
              {isProjectQuote && (
                <span className="muted" style={{ marginLeft: 10, fontWeight: 400, fontSize: 13, fontFamily: "var(--font-sans)" }}>
                  vs. BOQ baseline
                </span>
              )}
            </h2>
            {!isApplied && <span className="muted" style={{ fontSize: 12 }}>Updates if you apply now</span>}
          </div>
          {isProjectQuote ? (
            <div className="card-bd" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24 }}>
              <Field
                label="Will auto-apply"
                value={`${preview.willApply} line${preview.willApply === 1 ? "" : "s"} (cheaper / equal)`}
              />
              <Field
                label="Will need approval"
                value={
                  preview.willPending > 0 ? (
                    <span style={{ color: "var(--warn)" }}>
                      {preview.willPending} line{preview.willPending === 1 ? "" : "s"} over BOQ
                    </span>
                  ) : <span className="muted">None</span>
                }
              />
              <Field
                label="Savings to lock in"
                value={
                  preview.savings > 0
                    ? <span style={{ color: "var(--success)", fontWeight: 600 }}>↓ {fmtMoney(preview.savings)}</span>
                    : <span className="muted">£0.00</span>
                }
              />
              <Field
                label="Overspend pending approval"
                value={
                  preview.pendingOverspend > 0
                    ? <span style={{ color: "var(--danger)", fontWeight: 600 }}>↑ {fmtMoney(preview.pendingOverspend)}</span>
                    : <span className="muted">£0.00</span>
                }
              />
            </div>
          ) : (
            <div className="card-bd" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24 }}>
              <Field
                label="Lines to apply"
                value={isApplied ? `${quote.applied_count ?? "—"} of ${quote.line_count ?? lines.length}` : `${preview.willApply} matched · ${preview.unmatched} unmatched · ${preview.skipped} skipped`}
              />
              <Field
                label="New value (qty × new price)"
                value={fmtMoney(isApplied ? (finalApplied ?? 0) : preview.newValue)}
              />
              <Field
                label="Was (qty × current price)"
                value={fmtMoney(isApplied ? (finalOld ?? 0) : preview.oldValue)}
              />
              <Field
                label={isApplied ? "Net result" : "Net change if applied"}
                value={<DeltaPill delta={isApplied ? (finalDelta ?? 0) : preview.delta} />}
              />
            </div>
          )}
          {applyResult && (
            <div className="card-bd" style={{ borderTop: "1px solid var(--line)" }}>
              <div className="flash success">
                {applyResult.scope === "project" ? (
                  <>
                    Applied {applyResult.applied} line{applyResult.applied === 1 ? "" : "s"} to {quote.supplier_name}.
                    {(applyResult.savings ?? 0) > 0 && <> Locked in <b>{fmtMoney(applyResult.savings ?? 0)}</b> in savings vs BOQ.</>}
                    {(applyResult.pending_approval ?? 0) > 0 && <> {applyResult.pending_approval} line{applyResult.pending_approval === 1 ? "" : "s"} sent for approval (<b>{fmtMoney(applyResult.pending_overspend ?? 0)}</b> overspend).</>}
                  </>
                ) : (
                  <>
                    Applied {applyResult.applied} line{applyResult.applied === 1 ? "" : "s"} to {quote.supplier_name}.
                    {applyResult.delta_value < 0 ? <> Saved <b>{fmtMoney(Math.abs(applyResult.delta_value))}</b> across this quote.</> :
                     applyResult.delta_value > 0 ? <> Costs increased by <b>{fmtMoney(applyResult.delta_value)}</b> across this quote.</> :
                     <> No net change in value.</>}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Per-line review table */}
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-hd">
            <h2 style={{ flex: 1 }}>Line items</h2>
            <span className="pill">{lines.length}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ width: 28 }}>#</th>
                <th>Extracted</th>
                <th>{isProjectQuote ? "Matched BOQ line" : "Matched product"}</th>
                <th className="num">Qty</th>
                <th className="num">New price</th>
                <th className="num">{isProjectQuote ? "BOQ" : "Was"}</th>
                <th className="center">Δ</th>
                <th style={{ width: 130 }}></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <QuoteLineRow
                  key={l.id}
                  line={l}
                  isProjectQuote={isProjectQuote}
                  readonly={isApplied || !canManage}
                  onMatch={(pid) => remit(l.id, pid)}
                  onSkip={() => skip(l.id)}
                  onUnskip={() => unskip(l.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}

function statusPill(s: SupplierQuote["status"]): string {
  switch (s) {
    case "applied": return "approved";
    case "ready": return "pending";
    case "extracting": return "draft";
    case "failed": return "rejected";
    case "discarded": return "deleted";
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

function DeltaPill({ delta }: { delta: number }) {
  if (Math.abs(delta) < 0.005) return <span className="pill draft" style={{ minWidth: 100, justifyContent: "center" }}>No change</span>;
  if (delta < 0) return <span className="pill approved" style={{ minWidth: 100, justifyContent: "center" }}>↓ {fmtMoney(Math.abs(delta))}</span>;
  return <span className="pill rejected" style={{ minWidth: 100, justifyContent: "center" }}>↑ {fmtMoney(delta)}</span>;
}

function QuoteLineRow({
  line, isProjectQuote, readonly, onMatch, onSkip, onUnskip,
}: {
  line: SupplierQuoteLine;
  isProjectQuote: boolean;
  readonly: boolean;
  onMatch: (pid: number | null) => void;
  onSkip: () => void;
  onUnskip: () => void;
}) {
  const old = isProjectQuote
    ? line.boq_unit_cost ?? null
    : (line.supplier_current_cost ?? line.product_primary_cost ?? null);
  const newP = line.unit_price;
  const delta = old != null && newP != null ? (line.raw_qty ?? 0) * (newP - old) : null;
  const skipped = !!line.skip_reason;
  const matched = isProjectQuote ? line.matched_material_id : line.matched_product_id;

  return (
    <tr style={skipped ? { opacity: 0.5 } : undefined}>
      <td className="muted">{line.line_no}</td>
      <td>
        <div>{line.raw_description}</div>
        {(line.raw_sku || line.raw_unit) && (
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            {line.raw_sku && <>SKU: {line.raw_sku}</>}
            {line.raw_sku && line.raw_unit && " · "}
            {line.raw_unit && <>unit: {line.raw_unit}</>}
          </div>
        )}
      </td>
      <td>
        {matched ? (
          <div>
            {isProjectQuote ? (
              <>
                <div>{line.material_item}</div>
                {line.material_element_code && (
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    Element {line.material_element_code}
                  </div>
                )}
              </>
            ) : (
              <div>
                <span className="badge" style={{ fontFamily: "ui-monospace, monospace", marginRight: 6 }}>{line.product_code}</span>
                {line.product_description}
              </div>
            )}
            {line.match_confidence != null && line.match_confidence < 0.6 && (
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                Low confidence ({(line.match_confidence * 100).toFixed(0)}%)
              </div>
            )}
          </div>
        ) : skipped ? (
          <span className="muted">Skipped — {line.skip_reason}</span>
        ) : isProjectQuote ? (
          <span className="muted">No BOQ match — skip or upload a BOQ first</span>
        ) : (
          <ProductPicker readonly={readonly} onPick={(id) => onMatch(id)} />
        )}
      </td>
      <td className="num">{line.raw_qty ?? <span className="muted">—</span>}</td>
      <td className="num">{newP != null ? fmtMoney(newP) : <span className="muted">—</span>}</td>
      <td className="num">{old != null ? fmtMoney(old) : <span className="muted">—</span>}</td>
      <td className="center">
        {delta == null ? <span className="muted">—</span> :
         Math.abs(delta) < 0.005 ? <span className="muted">—</span> :
         delta < 0 ? <span className="pill approved" style={{ fontSize: 10 }}>↓ {fmtMoney(Math.abs(delta))}</span> :
                     <span className="pill rejected" style={{ fontSize: 10 }} title="Over BOQ — needs approval">
                       ↑ {fmtMoney(delta)}
                     </span>}
      </td>
      <td>
        {!readonly && (
          skipped ? (
            <button className="ghost tiny" onClick={onUnskip}>Restore</button>
          ) : (
            <>
              {matched && !isProjectQuote && (
                <button className="ghost tiny" onClick={() => onMatch(null)} title="Change match">Change</button>
              )}{" "}
              <button className="ghost tiny" onClick={onSkip}>Skip</button>
            </>
          )
        )}
      </td>
    </tr>
  );
}

/** Search-as-you-type picker for assigning a product manually. */
function ProductPicker({ readonly, onPick }: { readonly: boolean; onPick: (productId: number) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => {
      api.searchProductsForQuote(q).then(setHits).catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (readonly) return <span className="muted">Unmatched</span>;
  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <input
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        placeholder="Search products…"
        style={{ width: 280 }}
      />
      {open && hits.length > 0 && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 30, background: "var(--card)", border: "1px solid var(--line-strong)", borderRadius: "var(--radius-md)", boxShadow: "0 8px 24px rgba(15,17,48,0.12)", maxHeight: 280, overflowY: "auto" }}>
          {hits.map((h) => (
            <div
              key={h.id}
              onClick={() => { onPick(h.id); setOpen(false); setQ(""); }}
              style={{ padding: "8px 10px", cursor: "pointer", borderBottom: "1px solid var(--line)", fontSize: 13 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-soft)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <div>
                <span className="badge" style={{ fontFamily: "ui-monospace, monospace", marginRight: 6 }}>{h.product_code}</span>
                {h.description}
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                {h.manufacturer ?? "—"} · {h.unit ?? "—"} · {h.unit_cost != null ? fmtMoney(h.unit_cost) : "no price"}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
