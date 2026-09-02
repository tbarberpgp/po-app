// Deliveries inbox — the delivery-ticket workflow in the same shape as the
// invoice inbox: a two-pane split with the ticket list on the left and the
// selected ticket (scanned photo, extracted fields, PO match, check-in) on the
// right. One component serves both the cross-project Deliveries workspace
// (sidebar → Delivery → Deliveries) and the project Operations → Deliveries tab.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtQty } from "../lib/api";
import type { CheckedInTicket, DeliveryTicketCandidate, CurrentUser, VarianceReport } from "../../shared/types";
import { ConfBar, CandidateCheckIn } from "./Operations";
import { PdfHighlightViewer } from "./PdfHighlightViewer";

type Kpi = { expected_today: number; overdue: number; checked_in_today: number; needs_po: number; variance?: number };
type Chip = "all" | "matched" | "needs" | "mismatch" | "done";

function fmtDate(s: string | null | undefined): string {
  return s ? String(s).slice(0, 10) : "—";
}

/** Match state of a ticket row: matched to a PO, inferred from item codes, or nothing. */
function state(c: DeliveryTicketCandidate): "po" | "line" | "none" {
  return (c.method as "po" | "line" | "none") ?? (c.matched_po_id ? "po" : "none");
}

/** Photo tickets get NO field boxes. The vision pass will emit coordinates on
 *  request, but measured against real tickets they're unreliable — the same
 *  supplier's letterhead came back as a wide band on one scan and a tall strip
 *  on the next, so a box can sit over the wrong text entirely. A box that
 *  points at the wrong number is worse than none: it invites confirming a
 *  delivery against a value nobody actually verified. PDF tickets keep their
 *  highlights (those come from the file's real text layer, not a guess).
 *  The regions are still captured on the scan record, so a proper OCR engine
 *  with word-level coordinates can light this up later. */
function RegionOverlay(_: { cand: DeliveryTicketCandidate }) {
  return null;
}

/** Site photos are routinely shot sideways. The scan records how far clockwise
 *  the ticket must turn to read upright; we apply it on display so nobody has
 *  to tilt their head. A 90/270 turn swaps the box the image must fit inside,
 *  hence the measured port and the swapped max dimensions. */
function useRotatedFit(rot: number, portRef: React.RefObject<HTMLDivElement | null>) {
  const [port, setPort] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = portRef.current;
    if (!el) return;
    const measure = () => setPort({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [portRef]);
  const quarter = rot === 90 || rot === 270;
  // Rotation happens about the centre, so a quarter-turned image must be sized
  // against the OPPOSITE axis of the port to stay inside it.
  const style: React.CSSProperties = quarter && port
    ? { maxHeight: port.w, maxWidth: port.h, transform: `rotate(${rot}deg)` }
    : { maxHeight: "100%", maxWidth: "100%", transform: rot ? `rotate(${rot}deg)` : undefined };
  return style;
}

function KpiCard({ label, value, sub, tone }: { label: string; value: number | string; sub: string; tone: "info" | "warn" | "good" }) {
  const bar = tone === "warn" ? "var(--warn)" : tone === "good" ? "var(--success)" : "var(--navy)";
  return (
    <div className="a-card" style={{ padding: "15px 17px", borderLeft: `3px solid ${bar}` }}>
      <div className="eyebrow" style={{ margin: 0 }}>{label}</div>
      <div style={{ fontFamily: "Cambria, 'Source Serif Pro', Georgia, serif", fontSize: 30, lineHeight: 1.15 }}>{value}</div>
      <div className="muted" style={{ fontSize: 11.5 }}>{sub}</div>
    </div>
  );
}

/** What ARRIVED against what was ordered.
 *
 *  The "Matched" pill beside this speaks for one thing: the order number printed
 *  on the ticket resolves to a PO we hold. It compares no quantities and no
 *  goods, and it was being read as though it did — Fixfast's DN 704875 sat under
 *  a green "Matched · PO-26003-0038" with 5,000 fasteners on the paper against
 *  an order for 50. Checking that in closes the line as fully delivered without
 *  a word, because the check-in path uses quantities only to choose part vs
 *  complete. This is the panel that looks at the goods.
 *
 *  Silent unless something needs a person — a part delivery, a rounding
 *  difference and an exact drop all render nothing. */
function VarianceNotice({ v }: { v?: VarianceReport }) {
  if (!v || v.ok || !v.issues.length) return null;
  const num = (n: number | null, unit: string | null) =>
    n == null ? "—" : `${Number.isInteger(n) ? n.toLocaleString("en-GB") : Math.round(n * 100) / 100}${unit ? ` ${unit}` : ""}`;
  return (
    <div style={{
      marginTop: 12, padding: "11px 13px", borderRadius: 8,
      background: "var(--warn-soft)", border: "1px solid var(--warn)",
    }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className="eyebrow" style={{ margin: 0, color: "var(--warn)" }}>Doesn't match the order</span>
      </div>
      <div style={{ fontSize: 13, marginTop: 3, color: "var(--warn)" }}>{v.headline}</div>
      <div style={{ display: "grid", gap: 6, marginTop: 9 }}>
        {v.issues.map((is, i) => (
          <div key={i} style={{ fontSize: 12.5, display: "grid", gap: 2 }}>
            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{is.item}</div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              <span>On the ticket <span className="num" style={{ color: "var(--warn)" }}>{num(is.ticket_qty, is.ticket_unit)}</span></span>
              <span className="muted">Ordered <span className="num">{num(is.ordered, is.ordered_unit)}</span></span>
              {is.outstanding != null && is.ordered != null && is.outstanding < is.ordered
                && <span className="muted">Outstanding <span className="num">{num(is.outstanding, is.ordered_unit)}</span></span>}
              {is.factor && <span className="muted">exactly {is.factor}x in the same unit — check whether the order should be per pack</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        Checking in as read will close the line as fully delivered. Correct the quantity below, or fix the order first.
      </div>
    </div>
  );
}

/** Right pane — the selected ticket: photo, extracted fields, match, check-in. */
function TicketDetail({ cand, projects, onActioned }: {
  cand: DeliveryTicketCandidate;
  projects: Awaited<ReturnType<typeof api.listProjects>>;
  onActioned: () => void;
}) {
  const projectId = cand.project_id ?? cand.matched_project_id ?? "";
  const [checkingIn, setCheckingIn] = useState(false);
  const [lb, setLb] = useState(false);
  const [lbZoom, setLbZoom] = useState(false);
  const [z, setZ] = useState(1);
  const portRef = useRef<HTMLDivElement>(null);
  const rot = cand.rotation_degrees ?? 0;
  const rotFit = useRotatedFit(rot, portRef);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setCheckingIn(false); setErr(null); setZ(1); setLbZoom(false); }, [cand.id]);

  // Delivery history for whichever line(s) this ticket's own items land on —
  // "60 outstanding" on its own doesn't say what's already arrived or which
  // paperwork proves it. Fetched eagerly (not just inside "whole order
  // delivered") so it's visible before anyone commits to a check-in.
  const [recon, setRecon] = useState<Awaited<ReturnType<typeof api.opsReconcileTicket>> | null>(null);
  useEffect(() => {
    setRecon(null);
    const poId = cand.matched_po_id || cand.guess_po_id;
    if (!poId || !projectId) return;
    let live = true;
    api.opsReconcileTicket(projectId, cand.id, poId).then((r) => { if (live) setRecon(r); }).catch(() => {});
    return () => { live = false; };
  }, [cand.id, projectId, cand.matched_po_id, cand.guess_po_id]);
  // Only the lines THIS ticket's items actually matched to — the PO behind a
  // framework call-off can run to a hundred lines, and dumping all of them
  // here would bury the two or three anyone actually came to check.
  const relevantLineIds = new Set((recon?.items ?? []).map((it) => it.po_line_id).filter((x): x is number => x != null));
  const historyLines = (recon?.po_lines ?? []).filter((pl) => relevantLineIds.has(pl.id) && pl.prior.length > 0);
  useEffect(() => {
    if (!lb) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLb(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lb]);
  const st = state(cand);

  // The ticket asserts the WHOLE order arrived (common: the paper covers the
  // load but the reader only caught one item). One delivery row per PO line at
  // its remaining quantity — every line completes, the invoice's delivered leg
  // clears.
  async function checkInWholeOrder() {
    const poId = cand.matched_po_id || cand.guess_po_id;
    const poNum = cand.matched_po_number || cand.guess_po_number || "the order";
    if (!poId || !projectId) return;
    // The ticket already disagrees with the order — closing every line on it is
    // the one click that hides that for good, so the numbers go in the prompt.
    const vw = cand.variance && !cand.variance.ok
      ? `\n\nThis ticket does NOT match the order:\n${cand.variance.issues.map((i) => `• ${i.headline}`).join("\n")}\n`
      : "";
    if (!window.confirm(`Mark every outstanding line on ${poNum} as fully delivered against this ticket?${vw}`)) return;
    setBusy(true); setErr(null);
    try {
      const recon = await api.opsReconcileTicket(projectId, cand.id, poId);
      const lines = (recon.po_lines || [])
        .filter((pl) => (pl.remaining ?? 0) > 0.0001)
        .map((pl) => ({ po_line_id: String(pl.id), po_line_desc: pl.desc, received_qty: String(Math.round(pl.remaining * 100) / 100), received_unit: pl.unit || "" }));
      if (!lines.length) { setErr("Every line on that PO is already fully received — nothing left to check in."); setBusy(false); return; }
      const poProjectId = cand.matched_project_id
        || (cand.guess_project_code ? projects.find((pr) => pr.code === cand.guess_project_code)?.id ?? null : null);
      await api.opsCheckInTicketCandidate(projectId, cand.id, {
        ...(poProjectId ? { target_project_id: poProjectId } : {}),
        po_id: poId,
        po_number: cand.matched_po_number || cand.guess_po_number || "",
        supplier: cand.supplier_name || "",
        lines,
      });
      onActioned();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't check in"); }
    finally { setBusy(false); }
  }

  async function dismiss() {
    if (!projectId) { setErr("This ticket isn't attached to a project."); return; }
    setBusy(true); setErr(null);
    try { await api.opsDismissTicketCandidate(projectId, cand.id); onActioned(); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't dismiss"); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="a-card a-pad">
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
          <h2 style={{ margin: 0, flex: 1, fontSize: 20 }}>{cand.supplier_name || "Unknown supplier"}</h2>
          {st === "po" && <span className="pill approved">Matched · {cand.matched_po_number}</span>}
          {st === "line" && <span className="pill" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>Inferred · {cand.guess_po_number}</span>}
          {st === "none" && <span className="pill" style={{ background: "transparent", border: "1px solid var(--warn)", color: "var(--warn)" }}>Needs a PO</span>}
          {(cand.project_code || cand.matched_project_code) && <span className="pill" style={{ background: "var(--navy-soft)", color: "var(--navy)" }}>{cand.project_code ?? cand.matched_project_code}</span>}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 340px) 1fr", gap: 16, alignItems: "start" }}>
          {/* scanned ticket — same inline viewer as the invoice inbox */}
          <div className="col-view">
            <div className="vtoolbar">
              <span className="vbtn" style={{ cursor: "default", color: "#fff", opacity: 0.85 }}>{cand.delivery_note_number ? `DN ${cand.delivery_note_number}` : "Delivery ticket"}</span>
              <span className="vspacer" />
              <button className="vbtn" title="Zoom out" onClick={() => setZ((v) => Math.max(0.5, +(v - 0.15).toFixed(2)))}>−</button>
              <button className="vbtn" title="Zoom in" onClick={() => setZ((v) => Math.min(3, +(v + 0.15).toFixed(2)))}>＋</button>
              <a className="vbtn" href={cand.ticket_url} target="_blank" rel="noreferrer" title="Open in a new tab">Open</a>
              <button className="vbtn" onClick={() => setLb(true)} title="Expand to full screen">⤢ Expand</button>
            </div>
            <div className="vport" style={{ height: 380 }} ref={portRef}>
              {/\.pdf(\?|$)/i.test(cand.ticket_url) ? (
                // PDF tickets carry a text layer — same coloured pickup overlay
                // as invoices (photos have no text layer, so they stay plain).
                <PdfHighlightViewer url={cand.ticket_url} targets={[
                  ...(cand.delivery_note_number ? [{ value: cand.delivery_note_number, color: "#ee5d2b", label: "Delivery note" }] : []),
                  ...(cand.po_number ? [{ value: cand.po_number, color: "#4353b0", label: "PO reference" }] : []),
                  ...(cand.delivery_date ? [{ value: cand.delivery_date, color: "#b06a0e", label: "Delivery date" }] : []),
                  ...(cand.supplier_name ? [{ value: cand.supplier_name, color: "#2f6f4f", label: "Supplier" }] : []),
                ]} />
              ) : (
                /* Ticket photos are tall phone shots — fit to the port by height
                   so the whole note is visible; click or the toolbar zooms. The
                   wrapper is sized by the img so the read-region boxes track it. */
                <span style={{ position: "relative", display: "inline-block", transform: `scale(${z})`, transformOrigin: "top center" }}>
                  <img alt="Delivery ticket" className="vimg" src={cand.ticket_url}
                    onClick={() => setLb(true)}
                    title={rot ? "Photo taken sideways — turned upright. Click to expand" : "Click to expand"}
                    style={{ ...rotFit, width: "auto", height: "auto", cursor: "zoom-in", display: "block" }} />
                  <RegionOverlay cand={cand} />
                </span>
              )}
            </div>
          </div>

          {/* extracted fields */}
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div><div className="eyebrow" style={{ margin: 0 }}>Delivery note</div><div className="num">{cand.delivery_note_number || "—"}</div></div>
              <div><div className="eyebrow" style={{ margin: 0 }}>Date</div><div className="num">{fmtDate(cand.delivery_date || cand.occurred_at)}</div></div>
              <div><div className="eyebrow" style={{ margin: 0 }}>PO on ticket</div><div className="num">{cand.po_number || "not legible"}</div></div>
              <div><div className="eyebrow" style={{ margin: 0 }}>Quantity read</div><div className="num">{cand.scanned_qty != null ? `${cand.scanned_qty}${cand.scanned_unit ? ` ${cand.scanned_unit}` : ""}` : "—"}</div></div>
            </div>
            {cand.summary && <div className="muted" style={{ fontSize: 12.5 }}>{cand.summary}</div>}
            <div style={{ maxWidth: 260 }}>
              {st === "po" && <ConfBar pct={cand.conf ?? 90} tone="ok" label={`${cand.conf ?? 90}% · ${cand.matched_by === "supplier" ? "supplier match" : "PO read off the ticket"}`} />}
              {st === "line" && <ConfBar pct={cand.conf ?? 50} tone="warn" label={`${cand.conf ?? 50}% · inferred from line items`} />}
            </div>
            {(cand.items?.length ?? 0) > 0 && (
              <div>
                <div className="eyebrow" style={{ marginBottom: 4 }}>{cand.items!.length} line item{cand.items!.length === 1 ? "" : "s"} read</div>
                <div style={{ display: "grid", gap: 3 }}>
                  {cand.items!.slice(0, 6).map((it, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, fontSize: 12.5 }}>
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.description}</span>
                      {it.qty != null && <span className="num muted">{it.qty}{it.unit ? ` ${it.unit}` : ""}</span>}
                    </div>
                  ))}
                  {cand.items!.length > 6 && <div className="muted" style={{ fontSize: 11.5 }}>+{cand.items!.length - 6} more…</div>}
                </div>
              </div>
            )}
          </div>
        </div>

        <VarianceNotice v={cand.variance} />

        {historyLines.length > 0 && (
          <div style={{ marginTop: 12, padding: "10px 13px", borderRadius: 8, background: "var(--card-2)", border: "1px solid var(--line)" }}>
            <div className="eyebrow" style={{ margin: 0 }}>Already received on this line</div>
            <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
              {historyLines.map((pl) => (
                <div key={pl.id}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                    {pl.desc} <span className="muted" style={{ fontWeight: 400 }}>— {fmtQty(pl.received)} of {fmtQty(pl.ordered)} {pl.unit}</span>
                  </div>
                  <div style={{ display: "grid", gap: 2, marginTop: 3 }}>
                    {pl.prior.map((p, i) => (
                      <div key={i} className="muted" style={{ fontSize: 11.5, display: "flex", gap: 8 }}>
                        <span style={{ minWidth: 90 }}>{p.dn ? `DN ${p.dn}` : "Manual check-in"}</span>
                        <span className="num">{fmtQty(p.qty)}</span>
                        <span>{fmtDate(p.date)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {err && <div className="flash error" style={{ marginTop: 12, fontSize: 12.5 }}>{err}</div>}

        {/* actions / check-in */}
        <div style={{ marginTop: 16, borderTop: "1px dashed var(--line)", paddingTop: 12 }}>
          {checkingIn ? (
            <>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              {cand.matched_po_id || cand.guess_po_id
                ? "Site and PO pre-set from the recognised order — change either in the form if that's not right."
                : "Project pre-set from the WhatsApp group this ticket arrived in — change it in the form if the delivery belongs elsewhere."}
            </div>
            <CandidateCheckIn
              projectId={projectId}
              cand={cand}
              projects={projects}
              onCancel={() => setCheckingIn(false)}
              onDone={() => { setCheckingIn(false); onActioned(); }}
            />
            </>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="accent" onClick={() => setCheckingIn(true)} disabled={busy || !projectId}>
                Check in against {st === "po" ? cand.matched_po_number : st === "line" ? cand.guess_po_number : "a PO"}
              </button>
              {st !== "none" && (
                <button className="ghost" onClick={checkInWholeOrder} disabled={busy || !projectId}
                  title="The ticket covers the whole order — log every outstanding PO line as fully delivered, even items the reader didn't catch">
                  Whole order delivered
                </button>
              )}
              <button className="ghost" onClick={dismiss} disabled={busy}>Dismiss — not a delivery</button>
            </div>
          )}
        </div>
      </div>

      {lb && (
        <div className="acctx-lb" onClick={(e) => { if (e.target === e.currentTarget) setLb(false); }}>
          <div className="lb-bar">
            <div className="ti">{cand.supplier_name || "Delivery ticket"} <span style={{ opacity: 0.6, fontWeight: 400, marginLeft: 8 }}>{cand.delivery_note_number ? `DN ${cand.delivery_note_number}` : ""}</span></div>
            <span className="sp" />
            <a className="lb-vbtn" href={cand.ticket_url} target="_blank" rel="noreferrer">Open ↗</a>
            <button className="lb-vbtn" onClick={() => setLb(false)}>Close ✕</button>
          </div>
          <div className="lb-stage" onClick={(e) => { if (e.target === e.currentTarget) setLb(false); }}>
            <span style={{ position: "relative", display: "inline-block" }}>
              <img alt="Delivery ticket" className="lb-img" src={cand.ticket_url}
                onClick={() => setLbZoom((v) => !v)}
                title={lbZoom ? "Click to fit the screen" : "Click to zoom to full size"}
                style={lbZoom
                  ? { maxHeight: "none", maxWidth: "none", width: "auto", cursor: "zoom-out", display: "block", transform: rot ? `rotate(${rot}deg)` : undefined }
                  : { maxHeight: rot === 90 || rot === 270 ? "calc(100vw - 220px)" : "calc(100vh - 110px)", maxWidth: rot === 90 || rot === 270 ? "calc(100vh - 110px)" : "100%", width: "auto", objectFit: "contain", cursor: "zoom-in", display: "block", transform: rot ? `rotate(${rot}deg)` : undefined }} />
              <RegionOverlay cand={cand} />
            </span>
          </div>
        </div>
      )}
    </>
  );
}

/** Read-only pane for an actioned ticket: the photo plus where every line went. */
function CheckedInDetail({ ticket }: { ticket: CheckedInTicket }) {
  const [lb, setLb] = useState(false);
  const isPdf = /\.pdf(\?|$)/i.test(ticket.ticket_url);
  return (
    <div className="a-card a-pad">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>{ticket.supplier_name || "Delivery ticket"}</h2>
        <span className="pill ok">Checked in</span>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {ticket.delivery_note_number ? `DN ${ticket.delivery_note_number} · ` : ""}{fmtDate(ticket.delivery_date || ticket.occurred_at)}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 300px) 1fr", gap: 16, alignItems: "start" }}>
        <div>
          {isPdf
            ? <a className="ghost tiny" href={ticket.ticket_url} target="_blank" rel="noreferrer">Open ticket (PDF) ↗</a>
            : <img src={ticket.ticket_url} alt="Delivery ticket" style={{ maxWidth: "100%", borderRadius: 8, cursor: "zoom-in" }} onClick={() => setLb(true)} />}
        </div>
        <div>
          <div className="eyebrow" style={{ marginBottom: 6 }}>{ticket.deliveries.length ? `Logged as ${ticket.deliveries.length} delivery line${ticket.deliveries.length === 1 ? "" : "s"}` : "Delivery records"}</div>
          {ticket.deliveries.length === 0
            ? <div className="muted" style={{ fontSize: 13 }}>The delivery records for this ticket have since been deleted or moved.</div>
            : (
              <div style={{ display: "grid", gap: 6 }}>
                {ticket.deliveries.map((d) => (
                  <div key={d.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
                    <span style={{ flex: 1, minWidth: 160 }}>{d.description || d.po_line_desc || "Delivery"}</span>
                    {d.received_qty != null && <span className="num" style={{ fontWeight: 600 }}>{d.received_qty}{d.received_unit ? ` ${d.received_unit}` : ""}</span>}
                    {d.po_number && (d.po_id
                      ? <Link className="pill neutral" style={{ fontSize: 11, textDecoration: "none" }} to={`/pos/${d.po_id}`}>{d.po_number}</Link>
                      : <span className="pill neutral" style={{ fontSize: 11 }}>{d.po_number}</span>)}
                    {(d.contract_code || d.project_code) && <span className="proj">{d.contract_code || d.project_code}</span>}
                  </div>
                ))}
              </div>
            )}
          {ticket.deliveries[0] && (
            <div style={{ marginTop: 12 }}>
              <Link className="ghost tiny" to={`/projects/${ticket.deliveries[0].project_id}`}>Open project deliveries →</Link>
            </div>
          )}
        </div>
      </div>
      {lb && !isPdf && (
        <div className="acctx-lb" onClick={(e) => { if (e.target === e.currentTarget) setLb(false); }}>
          <div className="lb-bar">
            <div className="ti">{ticket.supplier_name || "Delivery ticket"}</div>
            <span className="sp" />
            <a className="lb-vbtn" href={ticket.ticket_url} target="_blank" rel="noreferrer">Open ↗</a>
            <button className="lb-vbtn" onClick={() => setLb(false)}>Close ✕</button>
          </div>
          <div className="lb-stage" onClick={(e) => { if (e.target === e.currentTarget) setLb(false); }}>
            <img className="lb-img" src={ticket.ticket_url} alt="Delivery ticket" />
          </div>
        </div>
      )}
    </div>
  );
}

/** The shared two-pane split: ticket inbox left, selected ticket right. */
function TicketSplit({ rows, projects, onReload, emptyHint, checkedIn = [] }: {
  rows: DeliveryTicketCandidate[];
  projects: Awaited<ReturnType<typeof api.listProjects>>;
  onReload: () => void;
  emptyHint: string;
  checkedIn?: CheckedInTicket[];
}) {
  const [chip, setChip] = useState<Chip>("all");
  const [search, setSearch] = useState("");
  const [selId, setSelId] = useState<number | null>(null);
  const [doneSelId, setDoneSelId] = useState<number | null>(null);

  // Every term has to hit somewhere, so "alumasc tape" narrows rather than
  // widens — the same rule as the PO line-item search and the POs list.
  const terms = useMemo(() => search.trim().toLowerCase().split(/\s+/).filter(Boolean), [search]);
  const searching = terms.length > 0;

  const visible = useMemo(() => {
    return rows.filter((r) => {
      const st = state(r);
      if (chip === "matched" && st === "none") return false;
      if (chip === "mismatch" && (r.variance?.ok ?? true)) return false;
      if (chip === "needs" && st !== "none") return false;
      if (!searching) return true;
      // The materials the reader saw on the ticket are in here too, so you can
      // find a drop by what arrived and not just by who sent it.
      const hay = [
        r.supplier_name, r.summary, r.delivery_note_number, r.po_number, r.matched_po_number,
        r.guess_po_number, r.project_code, r.project_name,
        ...(r.items ?? []).map((it) => it.description),
      ].map((v) => v ?? "").join(" ").toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [rows, chip, terms, searching]);

  const sel = visible.find((r) => r.id === selId) ?? visible[0] ?? null;
  const matchedCount = rows.filter((r) => state(r) !== "none").length;
  const mismatchCount = rows.filter((r) => r.variance && !r.variance.ok).length;
  const doneVisible = useMemo(() => {
    if (!searching) return checkedIn;
    return checkedIn.filter((r) => {
      const hay = [
        r.supplier_name, r.summary, r.delivery_note_number, r.project_code,
        ...r.deliveries.flatMap((d) => [d.description, d.po_line_desc, d.po_number, d.project_code]),
      ].map((v) => v ?? "").join(" ").toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [checkedIn, terms, searching]);
  const doneSel = doneVisible.find((r) => r.id === doneSelId) ?? doneVisible[0] ?? null;
  // Header count follows the list you're actually looking at, and says what it
  // is out of while a search is narrowing it.
  const shownCount = chip === "done" ? doneVisible.length : visible.length;
  const chipTotal = chip === "done" ? checkedIn.length
    : chip === "matched" ? matchedCount
    : chip === "mismatch" ? mismatchCount
    : chip === "needs" ? rows.length - matchedCount
    : rows.length;

  return (
    <div className="a-split">
      <aside className="inbox">
        <div className="inbox-hd"><h2>Ticket inbox</h2><span className="count">{searching ? `${shownCount} of ${chipTotal}` : shownCount}</span></div>
        <div style={{ display: "flex", gap: 6, padding: "0 12px 8px", flexWrap: "wrap" }}>
          {([["all", `All ${rows.length}`], ["matched", `Matched ${matchedCount}`], ["needs", `Needs a PO ${rows.length - matchedCount}`],
            ...(mismatchCount ? [["mismatch", `Doesn't match ${mismatchCount}`]] : []),
            ...(checkedIn.length ? [["done", `Checked in ${checkedIn.length}`]] : [])] as Array<[Chip, string]>).map(([k, label]) => (
            <button key={k} className={chip === k ? "primary tiny" : "ghost tiny"} onClick={() => setChip(k)}>{label}</button>
          ))}
        </div>
        <div className="inbox-search" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            placeholder="Search supplier, DN, PO or material…"
            aria-label="Search delivery tickets"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && <button className="ghost tiny" onClick={() => setSearch("")}>Clear</button>}
        </div>
        <div className="ilist">
          {chip === "done" ? (doneVisible.length === 0
            ? <div className="muted" style={{ padding: "18px 15px", fontSize: 13, lineHeight: 1.5 }}>
                {searching
                  ? <>Nothing checked in matches “{search.trim()}”. <button className="ghost tiny" onClick={() => setSearch("")}>Clear</button></>
                  : "Nothing checked in yet."}
              </div>
            : doneVisible.map((r) => (
              <button key={r.id} className={`irow${doneSel?.id === r.id ? " on" : ""}`} onClick={() => setDoneSelId(r.id)}>
                <span className="idot matched" />
                <div style={{ minWidth: 0 }}>
                  <div className="isup">{r.supplier_name || "Unknown supplier"}</div>
                  <div className="imeta">
                    <span>{r.delivery_note_number ? `DN ${r.delivery_note_number}` : "no DN"} · {fmtDate(r.delivery_date || r.occurred_at)}{r.deliveries.length ? ` · ${r.deliveries.length} line${r.deliveries.length === 1 ? "" : "s"}` : ""}</span>
                    {(r.deliveries[0]?.project_code || r.project_code) && <span className="proj">{r.deliveries[0]?.project_code || r.project_code}</span>}
                  </div>
                  <span className="istatus matched">{r.deliveries[0]?.po_number ? `Checked in · ${r.deliveries[0].po_number}` : "Checked in"}</span>
                </div>
              </button>
            ))
          ) : visible.length === 0
            ? <div className="muted" style={{ padding: "18px 15px", fontSize: 13, lineHeight: 1.5 }}>
                {searching
                  ? <>No ticket matches “{search.trim()}”. <button className="ghost tiny" onClick={() => setSearch("")}>Clear</button></>
                  : emptyHint}
              </div>
            : visible.map((r) => {
              const st = state(r);
              const dot = st === "po" ? "matched" : st === "line" ? "review" : "none";
              return (
                <button key={r.id} className={`irow${sel?.id === r.id ? " on" : ""}`} onClick={() => setSelId(r.id)}>
                  <span className={`idot ${dot}`} />
                  <div style={{ minWidth: 0 }}>
                    <div className="isup">{r.supplier_name || "Unknown supplier"}</div>
                    <div className="imeta">
                      <span>{r.delivery_note_number ? `DN ${r.delivery_note_number}` : "no DN"} · {fmtDate(r.delivery_date || r.occurred_at)}{r.items?.length ? ` · ${r.items.length} lines` : ""}</span>
                      {r.project_code && <span className="proj">{r.project_code}</span>}
                    </div>
                    <span className={`istatus ${dot}`}>{st === "po" ? `Matched · ${r.matched_po_number}` : st === "line" ? `Inferred · ${r.guess_po_number}` : "Needs a PO"}</span>
                    {r.variance && !r.variance.ok && (
                      <span className="istatus" style={{ background: "var(--warn-soft)", color: "var(--warn)", marginLeft: 6 }}
                        title={r.variance.headline ?? ""}>
                        {r.variance.issues.some((i) => i.kind === "over") ? "Qty ≠ order" : "No qty read"}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
        </div>
      </aside>

      <section className="detail">
        {chip === "done"
          ? (doneSel
            ? <CheckedInDetail ticket={doneSel} />
            : <div className="a-card a-pad"><div className="muted" style={{ fontSize: 13 }}>Select a checked-in ticket to see where it went.</div></div>)
          : !sel
            ? <div className="a-card a-pad"><div className="muted" style={{ fontSize: 13 }}>Select a ticket to review and check in against its purchase order.</div></div>
            : <TicketDetail cand={sel} projects={projects} onActioned={onReload} />}
      </section>
    </div>
  );
}

/** Cross-project Deliveries workspace (sidebar → Delivery → Deliveries). */
export function DeliveriesWorkspace(_props: { me: CurrentUser | null }) {
  const [kpi, setKpi] = useState<Kpi | null>(null);
  const [rows, setRows] = useState<DeliveryTicketCandidate[]>([]);
  const [done, setDone] = useState<CheckedInTicket[]>([]);
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof api.listProjects>>>([]);
  const [loading, setLoading] = useState(true);

  async function reload() {
    try {
      const r = await api.opsDeliveriesInbox();
      setKpi(r.kpi); setRows(r.candidates); setDone(r.checked_in ?? []);
    } catch { /* keep whatever we have */ }
    finally { setLoading(false); }
  }
  useEffect(() => { reload(); api.listProjects().then(setProjects).catch(() => {}); }, []);

  return (
    <div className="acctx">
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Deliveries</h1>
        <span className="muted" style={{ fontSize: 13.5 }}>Delivery tickets scanned from WhatsApp &amp; email across every live site — confirm each against its purchase order.</span>
      </div>

      {kpi && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, marginBottom: 16 }}>
          <KpiCard label="Expected today" value={kpi.expected_today} sub="from open POs" tone="info" />
          <KpiCard label="Overdue" value={kpi.overdue} sub={kpi.overdue ? "past delivery date, nothing received" : "none outstanding"} tone={kpi.overdue ? "warn" : "good"} />
          <KpiCard label="Checked in today" value={kpi.checked_in_today} sub="against a PO" tone="good" />
          <KpiCard label="Needs a PO" value={kpi.needs_po} sub={kpi.needs_po ? "tickets with no order matched" : "all tickets matched"} tone={kpi.needs_po ? "warn" : "good"} />
          <KpiCard label="Doesn't match the PO" value={kpi.variance ?? 0}
            sub={kpi.variance ? "order number right, goods don't agree" : "quantities agree where checkable"}
            tone={kpi.variance ? "warn" : "good"} />
        </div>
      )}

      {loading
        ? <div className="muted" style={{ fontSize: 13 }}>Loading the ticket inbox…</div>
        : <TicketSplit rows={rows} projects={projects} onReload={reload} checkedIn={done} emptyHint="No pending tickets anywhere — new WhatsApp delivery photos appear here after each scan." />}
    </div>
  );
}

/** Project-scoped ticket inbox — the same split, embedded in Operations → Deliveries. */
export function ProjectTicketInbox({ projectId, onCheckedIn }: { projectId: string; onCheckedIn: () => void }) {
  const [rows, setRows] = useState<DeliveryTicketCandidate[]>([]);
  const [unscanned, setUnscanned] = useState(0);
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof api.listProjects>>>([]);
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(true);

  async function reload() {
    try {
      const r = await api.opsTicketCandidates(projectId);
      // Rows from the per-project endpoint carry no project fields — stamp them
      // so the shared detail pane can drive the per-project actions.
      setRows((r.candidates as DeliveryTicketCandidate[]).map((c) => ({ ...c, project_id: c.project_id ?? projectId })));
      setUnscanned(r.unscanned ?? 0);
    } catch { /* keep */ }
    finally { setLoading(false); }
  }
  useEffect(() => { setLoading(true); reload(); api.listProjects().then(setProjects).catch(() => {}); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function scanMore() {
    setScanning(true);
    try { await api.opsScanWhatsappTickets(projectId); await reload(); }
    catch { /* surfaced by empty result */ }
    finally { setScanning(false); }
  }

  return (
    <div className="acctx" style={{ marginTop: 8 }}>
      {unscanned > 0 && (
        <div className="a-card" style={{ padding: "10px 14px", marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}><b>{unscanned}</b> WhatsApp photo{unscanned === 1 ? "" : "s"} waiting to be scanned for delivery tickets.</span>
          <button className="ghost tiny" onClick={scanMore} disabled={scanning}>{scanning ? "Scanning…" : "Scan now"}</button>
        </div>
      )}
      {loading
        ? <div className="muted" style={{ fontSize: 13 }}>Loading the ticket inbox…</div>
        : <TicketSplit rows={rows} projects={projects} onReload={() => { reload(); onCheckedIn(); }} emptyHint="No pending tickets on this site — WhatsApp delivery photos appear here after each scan." />}
    </div>
  );
}
