// Application for Payment detail screen — edit % complete per BOQ line, add
// variation lines, see live totals, walk the workflow (submit → certify →
// mark paid). Direction is read from the AfP itself; the layout serves both
// outgoing (to client) and incoming labour (from subcontractor).

import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fmtDate, fmtMoney, fmtQty } from "../lib/api";
import { Topbar } from "./Shell";
import { can } from "../../shared/permissions";
import { generateAfpPdf } from "../lib/afp-pdf";
import { generateAfpXlsx } from "../lib/afp-xlsx";
import { afpDocLabel } from "../../shared/types";
import { parseMoney, parsePositiveMoney } from "../../shared/money";
import type { AfpDetail, AfpLine, AfpStatus, CurrentUser, ApplicationForPayment } from "../../shared/types";

export function AfpView({ me }: { me: CurrentUser | null }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const afpId = Number(id);
  const [detail, setDetail] = useState<AfpDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The certify decision panel (replaces a window.prompt that couldn't show the
  // figures behind the number it was asking for, or parse "1,250.00").
  const [certifyOpen, setCertifyOpen] = useState(false);
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
  // Applications received by email arrive with the applied % already filled in
  // — that's the claim, locked. Only manually-built drafts let you edit it.
  const appliedEditable = !(afp.created_by ?? "").startsWith("email:");

  // Applied (what we claimed) vs certified (what's been agreed). Once a
  // certificate is applied, each line's cumulative_value holds the certified
  // figure; the applied figure is contract × applied %. Surface the delta so
  // you can see at a glance what the client (or PG) adjusted.
  const appliedWorks = lines.reduce((s, l) => s + l.contract_value * (l.percent_complete ?? 0) / 100, 0);
  // A certificate has actually been applied only when the app is certified/paid or
  // a line carries an explicit certified %. Until then NOTHING is certified — the
  // certified figures must never mirror the applied claim.
  const isCertStatus = afp.status === "certified" || afp.status === "paid";
  // Before Mark certified, cumulative_value is still the CLAIM — the certified
  // position lives only in each line's certified %. Zeros (typed or defaulted)
  // are not a certificate, so the panel stays hidden until something real is
  // certified or the certificate is applied.
  const hasCertified = isCertStatus || lines.some((l) => (l.certified_percent ?? 0) > 0);
  // Certified cumulative works. Two certification models feed this and only the
  // HEADER cumulative_value is the certified figure in both:
  //  • client (outgoing): the QS sets per-line certified %; on certify the
  //    header cumulative_value is stamped to the certified total (and a manual
  //    revision may leave line cumulative_value still holding the applied claim).
  //  • labour (incoming): certified by £-allocation into cumulative_value, with
  //    certified_percent left 0 — so a per-line contract×cert% read gives £0.
  // Summing line cumulative_value (old) mirrored the claim; contract×cert%
  // (previous fix) zeroed labour. The header is right for both. Pre-certify,
  // the certified position lives only in each line's certified %.
  const certifiedWorks = isCertStatus
    ? (afp.cumulative_value ?? 0)
    : lines.reduce((s, l) => s + l.contract_value * (l.certified_percent ?? 0) / 100, 0);

  /** Certified £ for ONE line, in whichever model this application uses — the
   *  single source the line rows AND the section/category subtotals share, so
   *  they can't contradict each other (they used to: subtotals summed
   *  cumulative_value = right for labour/wrong for client; rows read
   *  contract×cert% = right for client/wrong for labour, showing £0). Summed
   *  over every line this equals the header cumulative_value in both models. */
  const certOf = (l: typeof lines[number]) => isOutgoing
    ? l.contract_value * (l.certified_percent ?? (isCertStatus ? (l.percent_complete ?? 0) : 0)) / 100
    : (l.cumulative_value ?? 0);
  const certDelta = certifiedWorks - appliedWorks;

  // Over-budget gate (labour only): the claim has exceeded the budgeted labour
  // (the BOQ lines, excluding variations). Such an application is held until a
  // director signs it off (recorded as approved_at) before it can be certified.
  const labourBudget = lines.filter((l) => !l.is_adhoc).reduce((s, l) => s + (l.contract_value ?? 0), 0);
  // The over-budget gate judges the CLAIM (cumulative), not the certified
  // position — a submitted over-budget claim must be held even before any
  // certification exists.
  const labourClaimed = lines.reduce((s, l) => s + (l.cumulative_value ?? 0), 0);
  const overBudget = !isOutgoing && labourClaimed > labourBudget + 0.01;
  const overBy = labourClaimed - labourBudget;
  const signedOff = !!afp.approved_at;
  const isDirector = !!(me?.is_approver && me.approver_tiers.includes("director"));

  // Rate-variance gate (labour only): lines valued at a rate that differs from
  // the agreed live rate (flagged server-side). Held from certification until
  // the lines are re-rated or a director signs off the variance.
  const rateFlaggedLines = lines.filter((l) => l.rate_flagged);
  const hasRateFlag = rateFlaggedLines.length > 0;
  const rateOverridden = !!afp.rate_override_at;
  const rateBlocked = hasRateFlag && !rateOverridden;

  async function setApplied(lineId: number, pct: number) {
    setBusy(true); setErr(null);
    try { await api.updateAfpLine(lineId, { percent_complete: pct }); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "update failed"); }
    finally { setBusy(false); }
  }
  async function setCertified(lineId: number, pct: number) {
    setBusy(true); setErr(null);
    try { await api.updateAfpLine(lineId, { certified_percent: pct }); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "update failed"); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (afp.direction === "incoming_labour" && afp.counterparty_supplier_id == null) {
      setErr("Assign the subcontractor before sending this labour application.");
      return;
    }
    if (!confirm(`Mark ${afpDocLabel(afp.direction, afp.status)} #${afp.app_number} as sent? This freezes the figures.`)) return;
    setBusy(true);
    try { await api.submitAfp(afp.id); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "submit failed"); }
    finally { setBusy(false); }
  }
  async function rereadSource() {
    if (!confirm("Re-read the stored file with the current reader? The claimed figures on this application are recalculated from the document.")) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.rereadAfpSource(afp.id);
      refresh();
      setErr(r.matched === 0
        ? `Read ${r.extracted} line${r.extracted === 1 ? "" : "s"} but none matched a bill item — see the review list.`
        : null);
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't re-read the file"); }
    finally { setBusy(false); }
  }
  async function unsubmit() {
    if (!confirm(`Reopen ${afpDocLabel(afp.direction, afp.status)} #${afp.app_number} as a draft? Figures unfreeze and review-line resolutions can be undone.`)) return;
    setBusy(true); setErr(null);
    try { await api.unsubmitAfp(afp.id); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't reopen"); }
    finally { setBusy(false); }
  }
  // Director sign-off for an over-budget labour application (the only remaining
  // approval gate — see the "over budget" banner).
  async function signOff() {
    if (!confirm(`Sign off this labour application as ${fmtMoney(overBy)} over the budgeted labour? It can then be certified.`)) return;
    setBusy(true); setErr(null);
    try { await api.approveAfp(afp.id); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "sign-off failed"); }
    finally { setBusy(false); }
  }
  // Re-rate flagged labour line(s) to the agreed live/BOQ rate. Omit lineId to
  // fix every flagged line.
  async function applyLiveRate(lineId?: number) {
    setBusy(true); setErr(null);
    try { await api.rerateAfp(afp.id, lineId); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "re-rate failed"); }
    finally { setBusy(false); }
  }
  // Director sign-off of the rate variance (reason required).
  async function signOffRate() {
    const reason = prompt("Reason for signing off the rate variance (e.g. rate agreed ad-hoc with the subcontractor):");
    if (reason === null) return;
    if (!reason.trim()) { setErr("A reason is required to sign off the rate variance."); return; }
    setBusy(true); setErr(null);
    try { await api.rateOverrideAfp(afp.id, reason.trim()); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "sign-off failed"); }
    finally { setBusy(false); }
  }
  /** Commit the certified figure. The amount is always explicit now — the panel
   *  pre-fills it with the claimed amount due, which is what the server used to
   *  default to when the old prompt was left blank. */
  async function certify(amount: number) {
    setBusy(true); setErr(null);
    try {
      await api.certifyAfp(afp.id, { certified_amount: amount });
      setCertifyOpen(false);
      refresh();
    }
    catch (e) { setErr(e instanceof Error ? e.message : "certify failed"); }
    finally { setBusy(false); }
  }
  async function pushXero() {
    setBusy(true); setErr(null);
    try { await api.xeroPushAfp(afp.id); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Xero push failed"); }
    finally { setBusy(false); }
  }
  async function createInvoice() {
    if (!confirm(`Create a live sales invoice in Xero for ${fmtMoney(afp.certified_amount ?? afp.amount_due ?? 0)} (ex VAT) and tag it to project ${afp.project_code}?`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.xeroPushInvoice(afp.id);
      if (!r.tracked) setErr(`Invoice ${r.xero_invoice_number} created, but no Xero tracking option matched "${afp.project_code}" — tag it to the project manually in Xero.`);
      refresh();
    }
    catch (e) { setErr(e instanceof Error ? e.message : "Invoice creation failed"); }
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
  const filePrefix = afpDocLabel(afp.direction, afp.status) === "Payment Certificate" ? "Certificate" : "AfP";
  async function downloadPdf() {
    if (!detail) return;
    setBusy(true); setErr(null);
    try {
      const bytes = await generateAfpPdf(detail);
      triggerDownload(bytes, `${filePrefix}-${afp.project_code ?? "project"}-${afp.app_number}.pdf`, "application/pdf");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "PDF generation failed");
    } finally { setBusy(false); }
  }
  function downloadXlsx() {
    if (!detail) return;
    try {
      const bytes = generateAfpXlsx(detail);
      triggerDownload(bytes, `${filePrefix}-${afp.project_code ?? "project"}-${afp.app_number}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Excel generation failed");
    }
  }

  return (
    <>
      <Topbar
        crumbs={<><Link to="/">Projects</Link> · <Link to={`/projects/${afp.project_id}`}>{afp.project_code}</Link> · #{afp.app_number}</>}
        title={`${afpDocLabel(afp.direction, afp.status)} #${afp.app_number}`}
        status={<span className={`pill ${statusPill(afp.status)}`}>{afp.status}</span>}
        actions={
          <>
            <button className="ghost" onClick={downloadPdf} disabled={busy} title="Download as PDF">↓ PDF</button>
            <button className="ghost" onClick={downloadXlsx} disabled={busy} title="Download as Excel">↓ Excel</button>
            {canEdit && afp.source_file_name && afp.status !== "certified" && afp.status !== "paid" && (
              <button className="ghost" onClick={rereadSource} disabled={busy}
                title="Re-read the attached document with the current reader and recalculate the claimed figures">Re-read file</button>
            )}
            {canEdit && isDraft && (
              <>
                <button className="ghost" onClick={discard} disabled={busy}>Discard</button>
                <button className="accent" onClick={submit} disabled={busy}>Mark as sent</button>
              </>
            )}
            {canEdit && afp.status === "submitted" && !afp.certified_at && !afp.xero_invoice_id && !afp.xero_po_id && (
              <button className="ghost" onClick={unsubmit} disabled={busy}
                title="Reopen as a draft — un-freezes the figures and the review-line undo list. Nothing has been certified or invoiced yet.">
                Back to draft
              </button>
            )}
            {canEdit && afp.status === "submitted" && (
              (overBudget && !signedOff) || rateBlocked ? (
                <>
                  {overBudget && !signedOff && isDirector && (
                    <button className="accent" onClick={signOff} disabled={busy} title={`Sign off ${fmtMoney(overBy)} over the budgeted labour`}>
                      Sign off over-budget
                    </button>
                  )}
                  <button
                    className="ghost"
                    disabled
                    title={
                      overBudget && !signedOff
                        ? "A director must sign off the over-budget amount before this can be certified"
                        : "Re-rate the off-rate lines to the agreed rate, or have a director sign off the rate variance, before certifying"
                    }
                  >
                    Mark certified
                  </button>
                </>
              ) : (
                <button className="accent" onClick={() => setCertifyOpen(true)} disabled={busy || certifyOpen}>Mark certified</button>
              )
            )}
            {/* Labour certificates push to Xero as a live bill (ACCPAY) to the subbie. */}
            {canEdit && afp.direction === "incoming_labour" && (afp.status === "certified" || afp.status === "paid") && (
              afp.xero_sync_status === "synced"
                ? <span className="pill approved" title={`Xero bill ${afp.xero_po_number ?? ""}`} style={{ alignSelf: "center" }}>Xero bill {afp.xero_po_number}</span>
                : <button className="ghost" onClick={pushXero} disabled={busy || !afp.pay_approved_at}
                    title={!afp.pay_approved_at ? "Approve this certificate for payment first (below)" : (afp.xero_sync_error ?? "Push to Xero as a draft bill to pay")}>
                    {afp.xero_sync_status === "failed" ? "Retry Xero push" : "Push to Xero"}
                  </button>
            )}
            {/* Certified client applications raise a live ACCREC invoice in Xero. */}
            {canEdit && afp.direction === "outgoing" && (afp.status === "certified" || afp.status === "paid") && (
              afp.xero_invoice_status === "synced"
                ? (
                  <>
                    <span className="pill approved" title={`Xero invoice ${afp.xero_invoice_number ?? ""}`} style={{ alignSelf: "center" }}>Xero invoice {afp.xero_invoice_number}</span>
                    <button className="ghost" disabled={busy}
                      title="Create a replacement invoice at the current certified amount — VOID the old invoice in Xero first, or you'll double-count"
                      onClick={() => {
                        if (!confirm(
                          `Reissue this invoice?\n\nThis creates a NEW Xero invoice at the current certified amount.\n\n` +
                          `IMPORTANT: void ${afp.xero_invoice_number ?? "the existing invoice"} in Xero FIRST (open it in Xero → Invoice Options → Void) — ` +
                          `otherwise both invoices will sit on the ledger and you'll double-count.\n\nHave you voided it?`,
                        )) return;
                        void createInvoice();
                      }}>
                      Reissue invoice…
                    </button>
                  </>
                )
                : <button className="accent" onClick={createInvoice} disabled={busy} title={afp.xero_invoice_error ?? "Create a live sales invoice in Xero"}>
                    {afp.xero_invoice_status === "failed" ? "Retry invoice" : "Create invoice"}
                  </button>
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

        {/* Assign-subcontractor banner — shown when an incoming-labour draft
            arrived (typically via a forwarded email) without a supplier. */}
        {isDraft && afp.direction === "incoming_labour" && afp.counterparty_supplier_id == null && (
          <AssignSupplierBanner afpId={afp.id} canEdit={canEdit} onAssigned={refresh}
            prefillName={(() => { try { return (JSON.parse(afp.extracted_meta_json ?? "{}") as { supplier_name?: string | null }).supplier_name ?? null; } catch { return null; } })()} />
        )}

        {/* PM-time and similar subcontract staff costs are PRELIMS, not measured
            labour — tag the application so it expends the Prelims budget. */}
        {!isOutgoing && canEdit && (
          <PrelimTagControl afp={afp} onChanged={refresh} />
        )}

        {/* The document that actually arrived — open by default while the
            subbie is unknown, so it can be identified from the paper. */}
        {afp.source_file_key && (
          <SourceDocCard afpId={afp.id} name={afp.source_file_name ?? null} type={afp.source_file_type ?? null}
            defaultOpen={!afp.counterparty_supplier_id && afp.direction === "incoming_labour"} />
        )}

        {/* The returned payment certificate — the paper behind the locked
            certified figures. */}
        {afp.cert_file_key && (
          <SourceDocCard afpId={afp.id} name={afp.cert_file_name ?? null} type={afp.cert_file_type ?? null}
            defaultOpen={false} endpoint="cert-file"
            title={isOutgoing ? "Client payment certificate" : "Payment certificate"} />
        )}

        {/* Over-budget labour: held for director sign-off before certification. */}
        {overBudget && (
          <div className="card" style={{ marginTop: 16, borderLeft: `4px solid ${signedOff ? "#16a34a" : "#f59e0b"}` }}>
            <div className="card-bd">
              {signedOff ? (
                <div>
                  <b>Over the budgeted labour by {fmtMoney(overBy)}</b> — signed off by {afp.approved_by} on {fmtDate(afp.approved_at ?? null)}.
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                    Claimed {fmtMoney(labourClaimed)} vs budget {fmtMoney(labourBudget)}. Cleared for certification.
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <b style={{ color: "#b45309" }}>This labour application is {fmtMoney(overBy)} over the budgeted labour.</b>
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                      Claimed {fmtMoney(labourClaimed)} vs budget {fmtMoney(labourBudget)} — variations/extra beyond the priced labour.
                      {afp.status === "submitted"
                        ? " A director must sign it off before it can be certified."
                        : " It will need a director sign-off before it can be certified."}
                    </div>
                  </div>
                  {isDirector && afp.status === "submitted" && (
                    <button className="accent" onClick={signOff} disabled={busy}>Sign off over-budget</button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Rate variance: labour lines valued off the agreed live rate. Held
            from certification until re-rated or signed off by a director. */}
        {(hasRateFlag || rateOverridden) && !isOutgoing && (
          <RateVarianceBanner
            afp={afp}
            flaggedLines={rateFlaggedLines}
            canEdit={canEdit}
            isDirector={isDirector}
            busy={busy}
            onApply={(lineId) => applyLiveRate(lineId)}
            onApplyAll={() => applyLiveRate()}
            onSignOff={signOffRate}
          />
        )}

        {/* Labour: approve the certified certificate for payment before it can
            push to Xero as a draft bill (mirrors the supplier-invoice gate). */}
        {!isOutgoing && (afp.status === "certified" || afp.status === "paid") && (
          <LabourPayApproval
            afp={afp}
            cis={detail.cis}
            certified={afp.certified_amount ?? 0}
            claimed={labourClaimed}
            budget={labourBudget}
            canEdit={canEdit}
            locked={afp.xero_sync_status === "synced"}
            onChanged={refresh}
          />
        )}

        {/* Certify decision — the figures that produce the claim, the amount
            being certified, and what follows from it, all on screen together. */}
        {certifyOpen && canEdit && afp.status === "submitted" && (
          <CertifyPanel
            afp={afp}
            isOutgoing={isOutgoing}
            certifiedWorks={certifiedWorks}
            hasPerLineCertified={lines.some((l) => (l.certified_percent ?? 0) > 0)}
            cisRate={detail.cis?.rate ?? null}
            busy={busy}
            onCancel={() => setCertifyOpen(false)}
            onCertify={certify}
          />
        )}

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

        {/* Applied vs certified — the delta between what was claimed and what
            the client (outgoing) / PowerGrid (labour) has certified. */}
        {hasCertified && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-hd"><h3 style={{ flex: 1 }}>Applied vs certified</h3></div>
            <div className="card-bd" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24 }}>
              <Field label="Applied for (works value)" value={fmtMoney(appliedWorks)} />
              <Field label="Certified (works value)" value={<b>{fmtMoney(certifiedWorks)}</b>} />
              <Field
                label="Difference"
                value={
                  Math.abs(certDelta) < 0.005 ? (
                    <span className="muted">— no change</span>
                  ) : (
                    <span style={{ fontWeight: 700, color: certDelta < 0 ? "#b91c1c" : "var(--accent-2)" }}>
                      {certDelta < 0 ? "−" : "+"}{fmtMoney(Math.abs(certDelta))}
                      {appliedWorks > 0 ? ` (${certDelta < 0 ? "−" : "+"}${Math.abs(certDelta / appliedWorks * 100).toFixed(1)}%)` : ""}
                    </span>
                  )
                }
              />
            </div>
          </div>
        )}

        {/* Unmatched-line review banner (only shown on drafts populated from an upload) */}
        {isDraft && (afp.unmatched_lines_json || afp.resolved_lines_json) && (
          <UnmatchedLinesBanner
            afpId={afp.id}
            direction={afp.direction}
            unmatchedJson={afp.unmatched_lines_json ?? null}
            resolvedJson={afp.resolved_lines_json ?? null}
            seededLines={lines}
            canEdit={canEdit}
            onResolved={refresh}
          />
        )}

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

        {afp.direction === "incoming_labour" && (
          <LabourAllocationsPanel projectId={afp.project_id} canEdit={!!canEdit} />
        )}

        {/* Line items */}
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-hd">
            <h2 style={{ flex: 1 }}>Works claimed</h2>
            <span className="pill">{lines.length}</span>
            {isDraft && canEdit && <AddAdhocLineButton afpId={afp.id} onAdded={refresh} />}
          </div>
          <LinesTable lines={lines} isDraft={isDraft} canEdit={canEdit} certifiable={(isDraft || afp.status === "submitted") && canEdit} appliedEditable={appliedEditable} hasCertified={hasCertified} certOf={certOf} onSetApplied={setApplied} onSetCertified={setCertified} onRefresh={refresh} />
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

/** An ad-hoc line in a "Materials on Site" section is delivered materials, not
 *  a variation — so it shouldn't get the "variation" badge. */
/**
 * Approve-for-payment panel for a certified labour certificate. Shows the
 * reconciliation (certified vs claimed vs budget) and the financial go-ahead —
 * separate from certification — that a labour bill needs before it pushes to
 * Xero as a draft. Over-budget approval requires a written reason.
 */
function LabourPayApproval({ afp, cis, certified, claimed, budget, canEdit, locked, onChanged }: {
  afp: AfpDetail["afp"]; cis: AfpDetail["cis"]; certified: number; claimed: number; budget: number;
  canEdit: boolean; locked: boolean; onChanged: () => void;
}) {
  const [note, setNote] = useState(afp.pay_approval_note ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const approved = !!afp.pay_approved_at;
  const overBudget = budget > 0 && certified > budget + 0.01;
  const noteRequired = overBudget;

  async function approve() {
    setBusy(true); setErr(null);
    try { await api.approveAfpPayment(afp.id, note); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't approve"); }
    finally { setBusy(false); }
  }
  async function unapprove() {
    setBusy(true); setErr(null);
    try { await api.unapproveAfpPayment(afp.id); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't un-approve"); }
    finally { setBusy(false); }
  }

  const metric = (label: string, value: string, tone?: string) => (
    <div style={{ minWidth: 120 }}>
      <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.03em" }}>{label}</div>
      <div style={{ fontWeight: 600, ...(tone ? { color: tone } : {}) }}>{value}</div>
    </div>
  );

  return (
    <div className="card" style={{ marginTop: 16, borderLeft: `4px solid ${approved ? "#16a34a" : "var(--accent)"}` }}>
      <div className="card-bd">
        <div className="eyebrow" style={{ marginBottom: 8 }}>Approve for payment</div>
        <div className="row" style={{ gap: 24, flexWrap: "wrap", marginBottom: 12 }}>
          {metric("Certified (to pay)", cis ? fmtMoney(cis.net_payable) : fmtMoney(certified))}
          {cis && metric(`CIS @ ${cis.rate}%`, `− ${fmtMoney(cis.deduction)}`, "#b45309")}
          {metric("Claimed", fmtMoney(claimed))}
          {metric("Budget", fmtMoney(budget), overBudget ? "#b45309" : undefined)}
        </div>
        {cis && (
          <div className="muted" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.6 }}>
            {cis.supplier_name} is on a <b>{cis.rate}% CIS</b> rate. Certified {fmtMoney(cis.certified_net)}
            {cis.labour_base < cis.certified_net - 0.005 && <> · labour element {fmtMoney(cis.labour_base)} (expenses of {fmtMoney(cis.certified_net - cis.labour_base)} sit outside CIS)</>}
            {" "}· deduction {fmtMoney(cis.deduction)} · <b>{fmtMoney(cis.net_payable)} payable</b>. The draft bill carries the
            deduction as a separate line; VAT (if any) is still calculated on the full labour value.
          </div>
        )}
        {err && <div className="flash error" style={{ marginBottom: 8 }}>{err}</div>}
        {approved ? (
          <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className="pill approved">Approved for payment</span>
            <span className="muted" style={{ fontSize: 12 }}>
              by {afp.pay_approved_by ?? "—"} on {fmtDate(afp.pay_approved_at ?? null)}{afp.pay_approval_note ? ` — "${afp.pay_approval_note}"` : ""}
            </span>
            {canEdit && !locked && <button className="ghost tiny" onClick={unapprove} disabled={busy} style={{ marginLeft: "auto" }}>Un-approve</button>}
          </div>
        ) : canEdit ? (
          <div style={{ display: "grid", gap: 8, maxWidth: 560 }}>
            <label style={{ fontSize: 12, margin: 0 }}>{noteRequired ? "Reason for paying over the budgeted labour (required)" : "Note (optional)"}</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
              placeholder={noteRequired ? "e.g. approved variation labour agreed with the subcontractor" : "Optional note"}
              style={{ width: "100%", resize: "vertical" }} />
            <button className="accent" style={{ justifySelf: "start" }} disabled={busy || (noteRequired && !note.trim())} onClick={approve}>Approve for payment</button>
            <div className="muted" style={{ fontSize: 11 }}>Approving lets this push to Xero as a draft bill — it won't pay automatically.</div>
          </div>
        ) : <div className="muted" style={{ fontSize: 12 }}>Approval needs commercial edit rights.</div>}
      </div>
    </div>
  );
}

function isMosSection(s: string | null | undefined): boolean {
  return /material/i.test(s ?? "") && /site/i.test(s ?? "");
}
function isExpenseSection(s: string | null | undefined): boolean {
  return /expense/i.test(s ?? "");
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

/**
 * The certify decision. Replaces a `window.prompt` that asked for the single
 * most consequential figure in the commercial workflow while showing none of
 * the numbers that produce it — and that rejected "1,250.00" and "£1250",
 * because it parsed with `Number()`.
 *
 * Three things it now does that the prompt could not: show the claim it is
 * being measured against, offer the figure the per-line certified percentages
 * already imply, and show the VAT and invoice total that follow from whatever
 * is typed, before it is committed.
 *
 * `certified_amount` sits at the same level as `amount_due` — this period,
 * after retention, before VAT. It becomes the ex-VAT line on the Xero
 * invoice/bill, so the arithmetic here mirrors recalcTotals server-side.
 */
function CertifyPanel({
  afp, isOutgoing, certifiedWorks, hasPerLineCertified, cisRate, busy, onCancel, onCertify,
}: {
  afp: ApplicationForPayment;
  isOutgoing: boolean;
  certifiedWorks: number;
  hasPerLineCertified: boolean;
  cisRate: number | null;
  busy: boolean;
  onCancel: () => void;
  onCertify: (amount: number) => void;
}) {
  const claimed = afp.amount_due ?? 0;
  const retPct = afp.retention_pct ?? 0;
  const vatPct = afp.vat_pct ?? 0;
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const [raw, setRaw] = useState(claimed.toFixed(2));
  const [touched, setTouched] = useState(false);

  const amount = parsePositiveMoney(raw);
  // Tell "not a number" apart from "a negative number" so the message can say
  // which — a minus sign is a different mistake from a typo.
  const negative = amount == null && (parseMoney(raw) ?? 0) < 0;
  const blank = !raw.trim();
  const valid = amount != null;

  const vat = valid ? r2(amount * (vatPct / 100)) : 0;
  const total = valid ? r2(amount + vat) : 0;
  const delta = valid ? r2(amount - claimed) : 0;

  // What the per-line certified percentages already add up to, expressed at the
  // same level as the figure being typed. Offered, never imposed: the header
  // figure is the one that gets frozen, and the two are allowed to differ.
  //
  // Rounded in the same three steps as recalcTotals, not as one multiply by
  // (1 − retention). The two disagree by a penny on about 2.6% of figures, and
  // this one is offered as a button that fills the field someone then certifies
  // — so it has to land on the value the server's own chain would produce, or
  // the app and Xero reconcile a penny apart.
  const perLineNet = r2(Math.max(0, certifiedWorks - (afp.previous_certified ?? 0)));
  const perLineDue = r2(perLineNet - r2(perLineNet * (retPct / 100)));
  const offerPerLine = hasPerLineCertified && Math.abs(perLineDue - claimed) >= 0.01 && Math.abs(perLineDue - (amount ?? -1)) >= 0.01;

  const who = isOutgoing ? "the client" : "PowerGrid";
  const label = afpDocLabel(afp.direction, afp.status);

  function commit() {
    if (valid && !busy) onCertify(amount);
  }

  return (
    <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent-2)" }}>
      <div className="card-hd">
        <div className="eyebrow" style={{ marginBottom: 0 }}>Your decision</div>
        <h2 style={{ flex: 1, margin: 0, fontSize: 17 }}>Certify {label} #{afp.app_number}</h2>
      </div>

      {/* The claim being measured against — the same chain the server used. */}
      <div className="card-bd" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24 }}>
        <Field label="This period (net)" value={fmtMoney(afp.this_period_net ?? 0)} />
        <Field label={`Retention (${retPct}%)`} value={`-${fmtMoney(afp.retention_amount ?? 0)}`} />
        <Field label="Claimed, ex VAT" value={<b>{fmtMoney(claimed)}</b>} />
      </div>

      <div className="card-bd" style={{ borderTop: "1px solid var(--line)" }}>
        <label htmlFor="cert-amount">Amount certified by {who} — this period, ex VAT</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            id="cert-amount"
            className="num"
            autoFocus
            inputMode="decimal"
            value={raw}
            onChange={(e) => { setRaw(e.target.value); setTouched(true); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commit(); }
              if (e.key === "Escape") { e.preventDefault(); onCancel(); }
            }}
            style={{ width: 180, fontSize: 16 }}
            aria-invalid={touched && !valid}
            aria-describedby="cert-hint"
          />
          {valid && Math.abs(delta) >= 0.01 && (
            <span className={`pill ${delta < 0 ? "rejected" : "issued"}`}>
              {delta < 0 ? "−" : "+"}{fmtMoney(Math.abs(delta))} vs claimed
            </span>
          )}
          {valid && Math.abs(delta) < 0.01 && <span className="pill approved">certifies the claim in full</span>}
        </div>
        <div id="cert-hint" className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
          {touched && blank
            ? "Enter the amount certified."
            : touched && negative
              ? "A certified amount can't be negative."
              : touched && !valid
                ? "That isn't an amount — try 1,250.00"
                : <>Pounds and commas are fine — <code>1,250.00</code> and <code>£1,250</code> both read as {fmtMoney(1250)}.</>}
        </div>

        {offerPerLine && (
          <div className="flash info" style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ flex: 1, minWidth: 240 }}>
              The certified percentages set on the lines below come to{" "}
              <b>{fmtMoney(certifiedWorks)}</b> of works — <b>{fmtMoney(perLineDue)}</b> for this period after retention.
            </span>
            <button type="button" className="ghost tiny" onClick={() => { setRaw(perLineDue.toFixed(2)); setTouched(true); }}>
              Use {fmtMoney(perLineDue)}
            </button>
          </div>
        )}

        {valid && amount > claimed + 0.01 && (
          <div className="flash info" style={{ marginTop: 12 }}>
            That certifies <b>{fmtMoney(amount - claimed)}</b> more than was claimed. Allowed, but worth a second look.
          </div>
        )}
      </div>

      {/* What follows from the figure, before it is committed. */}
      <div className="card-bd" style={{ borderTop: "1px solid var(--line)", background: "var(--card-2)", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24 }}>
        <Field label="Certified, ex VAT" value={valid ? <b>{fmtMoney(amount)}</b> : <span className="muted">—</span>} />
        <Field label={`VAT (${vatPct}%)`} value={valid ? fmtMoney(vat) : <span className="muted">—</span>} />
        <Field
          label={isOutgoing ? "Total to invoice" : "Total on the bill"}
          value={valid ? <span style={{ fontWeight: 700, color: "var(--accent-2)" }}>{fmtMoney(total)}</span> : <span className="muted">—</span>}
        />
      </div>

      {cisRate != null && cisRate > 0 && (
        <div className="card-bd" style={{ borderTop: "1px solid var(--line)" }}>
          <div className="muted" style={{ fontSize: 12.5 }}>
            A <b>{cisRate}%</b> CIS deduction applies to the labour element of this certificate. The exact
            deduction and net payable are shown once it's certified — expenses sit outside CIS, so the base
            is worked out server-side rather than guessed at here.
          </div>
        </div>
      )}

      <div className="card-bd" style={{ borderTop: "1px solid var(--line)", display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="accent" onClick={commit} disabled={busy || !valid}>
          {busy ? "Certifying…" : valid ? `Certify ${fmtMoney(amount)}` : "Certify"}
        </button>
        <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
          This freezes the certified figure and emails whoever sent the application.
        </span>
      </div>
    </div>
  );
}

/** Certified − applied £ delta for a line/section/total. Red for a reduction,
 *  accent for an increase, em-dash when unchanged. */
function deltaText(d: number, weight = 400): React.ReactNode {
  if (Math.abs(d) < 0.005) return <span className="muted">—</span>;
  return (
    <span style={{ fontWeight: weight, color: d < 0 ? "#b91c1c" : "var(--accent-2)" }}>
      {d < 0 ? "−" : "+"}{fmtMoney(Math.abs(d))}
    </span>
  );
}

function LinesTable({
  lines, isDraft, canEdit, certifiable, appliedEditable, hasCertified, certOf, onSetApplied, onSetCertified, onRefresh,
}: {
  lines: AfpLine[];
  isDraft: boolean;
  canEdit: boolean;
  appliedEditable: boolean;
  hasCertified: boolean;
  /** Certified £ for one line — owned by AfpView so rows, section subtotals
   *  and the header panel all read the same number. */
  certOf: (l: AfpLine) => number;
  onSetApplied: (lineId: number, pct: number) => void;
  certifiable: boolean;
  onSetCertified: (lineId: number, pct: number) => void;
  onRefresh: () => void;
}) {
  // Two-level grouping: category (Prelims / Measured / Ancil / Variations),
  // then section within each — mirroring the cost-sheet structure.
  const categories = useMemo(() => {
    const CAT_ORDER = ["prelims", "measured", "ancil", "variations", "expenses", "materials_on_site"] as const;
    const CAT_LABEL: Record<string, string> = {
      prelims: "Preliminaries", measured: "Measured works", ancil: "Ancil Items",
      variations: "Variations", expenses: "Expenses", materials_on_site: "Materials on Site",
    };
    const byCat = new Map<string, AfpLine[]>();
    for (const l of lines) {
      // Ad-hoc lines split by section: Expenses / Materials on Site / Variations;
      // legacy null category → Measured works.
      const key = l.is_adhoc
        ? (isMosSection(l.section) ? "materials_on_site" : isExpenseSection(l.section) ? "expenses" : "variations")
        : (l.category ?? "measured");
      (byCat.get(key) ?? byCat.set(key, []).get(key)!).push(l);
    }
    const result: Array<{ key: string; label: string; sections: Array<{ section: string; lines: AfpLine[] }> }> = [];
    for (const key of CAT_ORDER) {
      const catLines = byCat.get(key);
      if (!catLines || catLines.length === 0) continue;
      const sections: Array<{ section: string; lines: AfpLine[] }> = [];
      for (const l of catLines) {
        const sec = l.section ?? "—";
        const g = sections[sections.length - 1];
        if (!g || g.section !== sec) sections.push({ section: sec, lines: [l] });
        else g.lines.push(l);
      }
      result.push({ key, label: CAT_LABEL[key] ?? key, sections });
    }
    return result;
  }, [lines]);

  const colCount = isDraft && canEdit ? 11 : 10;
  // Only show category banners when there's more than one (a labour AfP is all
  // measured works — no need for a single redundant "Measured works" banner).
  const showCategoryBanners = categories.length > 1;

  return (
    <table className="afp-lines">
      <thead>
        <tr>
          <th>Item</th>
          <th className="num" style={{ width: 52 }}>Qty</th>
          <th className="center" style={{ width: 46 }}>Unit</th>
          <th className="num" style={{ width: 78 }}>Rate</th>
          <th className="num" style={{ width: 96 }}>Contract value</th>
          <th className="center" style={{ width: 66 }}>Applied %</th>
          <th className="num" style={{ width: 96 }}>Applied value</th>
          <th className="center" style={{ width: 72 }}>Certified %</th>
          <th className="num" style={{ width: 96 }}>Certified value</th>
          <th className="num" style={{ width: 92 }}>Delta</th>
          {isDraft && canEdit && <th style={{ width: 44 }}></th>}
        </tr>
      </thead>
      <tbody>
        {categories.map((cat) => {
          const catTotal = cat.sections.reduce((s, sec) => s + sec.lines.reduce((t, l) => t + l.contract_value, 0), 0);
          const catApplied = cat.sections.reduce((s, sec) => s + sec.lines.reduce((t, l) => t + l.contract_value * (l.percent_complete ?? 0) / 100, 0), 0);
          const catCum = cat.sections.reduce((s, sec) => s + sec.lines.reduce((t, l) => t + certOf(l), 0), 0);
          return (
            <Fragment key={cat.key}>
              {showCategoryBanners && (
                <tr style={{ background: "var(--accent-soft)" }}>
                  <td colSpan={colCount} style={{ fontWeight: 700, fontSize: 13, letterSpacing: "0.04em", color: "var(--accent-2)" }}>
                    {cat.label}
                  </td>
                </tr>
              )}
              {cat.sections.map((g, gi) => (
                <Group key={gi} group={g} isDraft={isDraft} canEdit={canEdit} certifiable={certifiable} appliedEditable={appliedEditable} hasCertified={hasCertified} certOf={certOf} onSetApplied={onSetApplied} onSetCertified={onSetCertified} onRefresh={onRefresh} />
              ))}
              {showCategoryBanners && (
                <tr>
                  <td colSpan={4} style={{ fontWeight: 700, textAlign: "right" }}>{cat.label} total</td>
                  <td className="num" style={{ fontWeight: 700 }}>{fmtMoney(catTotal)}</td>
                  <td className="center muted" style={{ fontSize: 11 }}>
                    {catTotal > 0 ? `${((catApplied / catTotal) * 100).toFixed(0)}%` : "—"}
                  </td>
                  <td className="num" style={{ fontWeight: 700 }}>{fmtMoney(catApplied)}</td>
                  <td className="center muted" style={{ fontSize: 11 }}>
                    {hasCertified && catTotal > 0 ? `${((catCum / catTotal) * 100).toFixed(0)}%` : "—"}
                  </td>
                  <td className="num" style={{ fontWeight: 700 }}>{hasCertified ? fmtMoney(catCum) : "—"}</td>
                  <td className="num">{hasCertified ? deltaText(catCum - catApplied, 700) : "—"}</td>
                  {isDraft && canEdit && <td></td>}
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function Group({
  group, isDraft, canEdit, certifiable, appliedEditable, hasCertified, certOf, onSetApplied, onSetCertified, onRefresh,
}: {
  group: { section: string; lines: AfpLine[] };
  isDraft: boolean;
  canEdit: boolean;
  appliedEditable: boolean;
  hasCertified: boolean;
  certOf: (l: AfpLine) => number;
  onSetApplied: (lineId: number, pct: number) => void;
  certifiable: boolean;
  onSetCertified: (lineId: number, pct: number) => void;
  onRefresh: () => void;
}) {
  const sectionTotal = group.lines.reduce((s, l) => s + l.contract_value, 0);
  const sectionApplied = group.lines.reduce((s, l) => s + l.contract_value * (l.percent_complete ?? 0) / 100, 0);
  const sectionCum = group.lines.reduce((s, l) => s + certOf(l), 0);
  const cols = isDraft && canEdit ? 11 : 10;
  return (
    <>
      <tr style={{ background: "var(--card-2)" }}>
        <td colSpan={cols} style={{ fontWeight: 600, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {group.section}
          {group.lines.some((l) => l.is_adhoc) && !isMosSection(group.section) && !isExpenseSection(group.section) && (
            <span className="badge unpriced" style={{ marginLeft: 8 }}>variation</span>
          )}
        </td>
      </tr>
      {group.lines.map((l) => (
        <LineRow key={l.id} line={l} isDraft={isDraft} canEdit={canEdit} certifiable={certifiable} appliedEditable={appliedEditable} hasCertified={hasCertified} certOf={certOf} onSetApplied={onSetApplied} onSetCertified={onSetCertified} onRefresh={onRefresh} />
      ))}
      <tr>
        <td colSpan={4} style={{ fontWeight: 600, textAlign: "right" }}>Section subtotal</td>
        <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(sectionTotal)}</td>
        <td className="center muted" style={{ fontSize: 11 }}>
          {sectionTotal > 0 ? `${((sectionApplied / sectionTotal) * 100).toFixed(0)}%` : "—"}
        </td>
        <td className="num" style={{ fontWeight: 600 }}>{fmtMoney(sectionApplied)}</td>
        <td className="center muted" style={{ fontSize: 11 }}>
          {hasCertified && sectionTotal > 0 ? `${((sectionCum / sectionTotal) * 100).toFixed(0)}%` : "—"}
        </td>
        <td className="num" style={{ fontWeight: 600 }}>{hasCertified ? fmtMoney(sectionCum) : "—"}</td>
        <td className="num">{hasCertified ? deltaText(sectionCum - sectionApplied, 600) : "—"}</td>
        {isDraft && canEdit && <td></td>}
      </tr>
    </>
  );
}

function LineRow({
  line, isDraft, canEdit, certifiable, appliedEditable, hasCertified, certOf, onSetApplied, onSetCertified, onRefresh,
}: {
  line: AfpLine;
  isDraft: boolean;
  canEdit: boolean;
  appliedEditable: boolean;
  hasCertified: boolean;
  certOf: (l: AfpLine) => number;
  onSetApplied: (lineId: number, pct: number) => void;
  certifiable: boolean;
  onSetCertified: (lineId: number, pct: number) => void;
  onRefresh: () => void;
}) {
  // When certifying, a line with no explicit certified % is taken as certified at
  // the applied %. But the certified columns only SHOW once a certificate has
  // actually been applied (hasCertified) — until then they read "—", never the
  // applied figure.
  const effectiveCertified = line.certified_percent ?? line.percent_complete;
  const appliedValue = line.contract_value * (line.percent_complete ?? 0) / 100;
  // Certified £ comes from the shared helper (model-aware), and the % shown is
  // derived back off it — so a row can never disagree with its own subtotal.
  const certifiedValue = certOf(line);
  const certifiedShownPct = line.contract_value > 0 ? (certifiedValue / line.contract_value) * 100 : 0;
  const hasLineDelta = hasCertified && Math.abs(certifiedValue - appliedValue) > 0.01;
  const [applied, setApplied] = useState(line.percent_complete);
  const [certified, setCertified] = useState(effectiveCertified);
  useEffect(() => setApplied(line.percent_complete), [line.percent_complete]);
  useEffect(() => setCertified(line.certified_percent ?? 0), [line.certified_percent]);

  function commitApplied(v: number) {
    const clamped = Math.max(0, Math.min(100, v));
    setApplied(clamped);
    if (Math.abs(clamped - line.percent_complete) > 0.001) onSetApplied(line.id, clamped);
  }
  function commitCertified(v: number) {
    const clamped = Math.max(0, Math.min(100, v));
    setCertified(clamped);
    if (Math.abs(clamped - effectiveCertified) > 0.001) onSetCertified(line.id, clamped);
  }

  async function deleteAdhoc() {
    if (!confirm(`Delete variation line "${line.description}"?`)) return;
    await api.deleteAfpLine(line.id);
    onRefresh();
  }

  const canEditApplied = isDraft && canEdit && appliedEditable;
  // Certification happens after submission — the claim is locked, the certified
  // figures stay editable until the certificate is marked certified/pushed.
  const canEditCertified = certifiable;

  return (
    <tr>
      <td>
        {line.description}
        {line.is_adhoc && !isMosSection(line.section) ? <span className="badge unpriced" style={{ marginLeft: 6, fontSize: 10 }}>{isExpenseSection(line.section) ? "expense" : "variation"}</span> : null}
      </td>
      <td className="num">{fmtQty(line.qty)}</td>
      <td className="center">{line.unit ?? "—"}</td>
      <td
        className="num"
        style={line.rate_flagged ? { color: "#b45309", fontWeight: 600 } : undefined}
        title={
          line.rate_flagged && line.expected_rate != null
            ? `Off-rate: agreed ${line.rate_source === "boq" ? "BOQ" : "live"} rate is ${fmtMoney(line.expected_rate)}`
            : undefined
        }
      >
        {line.rate_flagged ? "⚠ " : ""}{fmtMoney(line.rate)}
      </td>
      <td className="num">{fmtMoney(line.contract_value)}</td>
      {/* Applied % — the claim. Read-only for email-received apps. */}
      <td className="center">
        {canEditApplied ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <input
              type="number" min={0} max={100} step="any" value={applied}
              onChange={(e) => setApplied(Number(e.target.value))}
              onBlur={() => commitApplied(applied)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              style={{ width: 56, textAlign: "right" }}
            />
            <span className="muted" style={{ fontSize: 12 }}>%</span>
            {!line.is_adhoc && (
              <button className="ghost tiny" style={{ padding: "1px 6px" }}
                title={`Reset this line to its previous position (${line.contract_value > 0 ? `${(((line.previously_certified ?? 0) / line.contract_value) * 100).toFixed(1)}%` : "0%"}) — undoes a wrong assignment or typo`}
                onClick={() => {
                  const prevPct = line.contract_value > 0 ? Math.round((((line.previously_certified ?? 0) / line.contract_value) * 100) * 100) / 100 : 0;
                  if (!confirm(`Reset "${line.description}" back to ${prevPct.toFixed(1)}% (its previously-certified position)?`)) return;
                  commitApplied(prevPct);
                }}>↩</button>
            )}
          </span>
        ) : (
          <span className="muted">{line.percent_complete.toFixed(1)}%</span>
        )}
      </td>
      {/* Applied value — contract × applied %. Prev-certified shown beneath so
          this period reads against what was already certified on earlier apps. */}
      <td className="num">
        {fmtMoney(appliedValue)}
        {(line.previously_certified ?? 0) > 0.005 && (
          <div className="muted" style={{ fontSize: 10, whiteSpace: "nowrap" }}
            title={`${fmtMoney(line.previously_certified ?? 0)} certified on earlier applications · ${fmtMoney(Math.max(0, (line.contract_value ?? 0) - (line.previously_certified ?? 0)))} of the line's value left to claim`}>
            used {fmtMoney(line.previously_certified ?? 0)} · {fmtMoney(Math.max(0, (line.contract_value ?? 0) - (line.previously_certified ?? 0)))} left
          </div>
        )}
      </td>
      {/* Certified % — what we'll pay. Editable while draft. */}
      <td className="center">
        {canEditCertified ? (
          <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <input
                type="number" min={0} max={100} step="any" value={certified}
                onChange={(e) => setCertified(Number(e.target.value))}
                onBlur={() => commitCertified(certified)}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                style={{ width: 56, textAlign: "right", borderColor: "var(--accent)" }}
              />
              <span className="muted" style={{ fontSize: 12 }}>%</span>
            </span>
            {/* Non-cumulative entry: a £ certified THIS period converts onto the
                cumulative % using what earlier applications already certified. */}
            {line.contract_value > 0 && (
              <input
                type="number" step="any" placeholder="£ this period"
                title={`£ certified this period — added to the ${fmtMoney(line.previously_certified ?? 0)} previously certified and converted to a cumulative %`}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (!v) return;
                  const n = Number(v);
                  if (!Number.isFinite(n)) return;
                  const pct = Math.max(0, Math.min(100, (((line.previously_certified ?? 0) + n) / line.contract_value) * 100));
                  e.target.value = "";
                  commitCertified(Math.round(pct * 100) / 100);
                }}
                style={{ width: 88, textAlign: "right", fontSize: 11 }}
              />
            )}
          </span>
        ) : (
          <span className={hasCertified ? undefined : "muted"}>{hasCertified ? `${certifiedShownPct.toFixed(1)}%` : "—"}</span>
        )}
      </td>
      {/* Certified value — contract × certified %. Accent-coloured when it differs from applied. */}
      <td className="num" style={{ color: hasLineDelta ? "var(--accent-2)" : undefined }}>
        {hasCertified ? fmtMoney(certifiedValue) : <span className="muted">—</span>}
      </td>
      {/* Delta — certified − applied (blank until a certificate is applied). */}
      <td className="num">{hasCertified ? deltaText(certifiedValue - appliedValue, 600) : <span className="muted">—</span>}</td>
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

/**
 * Banner shown on an incoming-labour draft that has no subcontractor assigned
 * — typically because a PowerGrid PM forwarded the application and we couldn't
 * auto-detect the subbie. Lets them pick a labour supplier and saves it.
 */
/** Tag an incoming labour application as PRELIMS spend under a heading —
 *  it then carries a single claimed £ (no line matching: management/PM time
 *  never matches BOQ lines) that becomes its value and draws the heading's
 *  allowance down. Tagging works at any status (a recategorisation); the
 *  claimed amount is draft-only because it sets the payable value. */
function PrelimTagControl({ afp, onChanged }: { afp: ApplicationForPayment; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof api.prelimsSummary>> | null>(null);
  const [pick, setPick] = useState(afp.prelim_heading ?? "");
  const [claim, setClaim] = useState(afp.claimed_amount != null ? String(afp.claimed_amount) : "");
  const [busy, setBusy] = useState(false);
  const isDraft = afp.status === "draft";
  const headings = summary?.headings ?? [];
  useEffect(() => {
    if (!editing && !afp.prelim_heading) return;
    api.prelimsSummary(afp.project_id)
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [editing, afp.prelim_heading, afp.project_id]);
  async function save(body: { prelim_heading?: string | null; claimed_amount?: number | null }) {
    setBusy(true);
    try { await api.updateAfp(afp.id, body); setEditing(false); onChanged(); }
    catch { /* surfaced by refresh */ }
    finally { setBusy(false); }
  }
  // Allowance position for the tagged heading — falling back to the whole
  // Prelims allowance when the heading has no budget row of its own (projects
  // whose cost sheet carries one Preliminaries line rather than itemised
  // headings). A draft's claim isn't in the drawn figure yet (drawdown counts
  // submitted+), so project it on top; a submitted/certified claim is already
  // included.
  const heading = headings.find((h) => h.name === (afp.prelim_heading ?? pick));
  const claimNum = Number(claim);
  const pending = isDraft && Number.isFinite(claimNum) ? claimNum : 0;
  const position = heading
    ? { label: afp.prelim_heading ?? pick, budget: heading.budget, drawn: heading.committed }
    : summary && summary.budget > 0
      ? { label: "Prelims", budget: summary.budget, drawn: summary.po_committed + (summary.labour_committed ?? 0) + summary.plant_accrued }
      : null;
  const remainingAfter = position ? position.budget - position.drawn - pending : null;
  const overBy = remainingAfter != null && remainingAfter < -0.005 ? -remainingAfter : 0;

  const allowanceChips = position && (
    <span className="muted" style={{ fontSize: 12 }}>
      {position.label} allowance {fmtMoney(position.budget)} · drawn {fmtMoney(position.drawn + pending)} · remaining {fmtMoney(remainingAfter ?? 0)}
    </span>
  );
  const overFlag = overBy > 0 && (
    <span className="pill" style={{ background: "var(--amber-soft, #fdf3d7)", color: "var(--amber, #8a6d1a)" }}
      title="Flagged for visibility — an over-allowance drawdown is not blocked">
      Exceeds allowance by {fmtMoney(overBy)}
    </span>
  );

  if (!editing) {
    return (
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "10px 0" }}>
        {afp.prelim_heading
          ? <>
              <span className="pill" style={{ background: "var(--navy-soft)", color: "var(--navy)" }}>Prelims · {afp.prelim_heading}</span>
              {isDraft
                ? <>
                    <label className="muted" style={{ fontSize: 12.5 }}>Claimed £
                      <input type="number" step="0.01" value={claim} placeholder="0.00"
                        onChange={(e) => setClaim(e.target.value)}
                        style={{ width: 110, marginLeft: 6 }} />
                    </label>
                    <button className="primary tiny" disabled={busy || claim === "" || !Number.isFinite(claimNum)}
                      onClick={() => save({ claimed_amount: claimNum })}>
                      Save claim
                    </button>
                  </>
                : <span className="muted" style={{ fontSize: 12 }}>
                    Claimed {fmtMoney(afp.claimed_amount ?? 0)}{afp.claimed_amount == null ? " — reopen as draft to set the claimed amount" : ""}
                  </span>}
              {allowanceChips}
              {overFlag}
              <button className="ghost tiny" onClick={() => { setPick(afp.prelim_heading ?? ""); setEditing(true); }}>Change</button>
              <button className="ghost tiny" disabled={busy} onClick={() => save({ prelim_heading: null })}>Untag</button>
            </>
          : <button className="ghost tiny" onClick={() => setEditing(true)}
              title="Staff-time applications (e.g. a subcontract project manager) are preliminaries — tag it so the spend counts against the Prelims budget">
              Assign to prelims…
            </button>}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "10px 0" }}>
      <span className="muted" style={{ fontSize: 12.5 }}>Prelim heading:</span>
      <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ minWidth: 200 }}>
        <option value="">— pick a heading —</option>
        {headings.map((h) => <option key={h.name} value={h.name}>{h.name}</option>)}
        <option value="Site management">Site management (general)</option>
      </select>
      <button className="primary tiny" disabled={busy || !pick} onClick={() => save({ prelim_heading: pick })}>Tag as prelims</button>
      <button className="ghost tiny" onClick={() => setEditing(false)}>Cancel</button>
    </div>
  );
}

/** Viewer for the application's stored source file — opens in a slide drawer
 *  (matching the rest of the app). PDFs and images render in the panel;
 *  spreadsheets/Word docs offer open/download (browsers can't render them). */
function SourceDocCard({ afpId, name, type, endpoint = "source-file", title = "Source document" }: {
  afpId: number; name: string | null; type: string | null; defaultOpen?: boolean;
  /** Which stored document to show: the application ("source-file") or the returned certificate ("cert-file"). */
  endpoint?: "source-file" | "cert-file"; title?: string;
}) {
  const [open, setOpen] = useState(false);
  const url = `/api/applications/${afpId}/${endpoint}`;
  const lower = (name ?? "").toLowerCase();
  const isPdf = (type ?? "").includes("pdf") || lower.endsWith(".pdf");
  const isImg = (type ?? "").startsWith("image/") || /\.(png|jpe?g|webp|gif)$/.test(lower);
  const isSheet = /\.(xlsx|xlsm|xls|csv)$/.test(lower) || (type ?? "").includes("spreadsheet") || (type ?? "").includes("ms-excel");
  const isDocx = lower.endsWith(".docx") || (type ?? "").includes("wordprocessingml");
  return (
    <>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-hd" style={{ cursor: "pointer" }} onClick={() => setOpen(true)} title="View in a side panel">
          <span style={{ marginRight: 10, fontSize: 16, lineHeight: 1, width: 16, display: "inline-block" }}>▸</span>
          <h3 style={{ flex: 1, fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 500 }}>{title}{name ? <span className="muted" style={{ fontWeight: 400 }}> · {name}</span> : null}</h3>
          <button className="ghost tiny" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>Open →</button>
        </div>
      </div>
      {/* Always mounted, class-toggled — the drawer CSS parks it off-screen
          (translateX(100%)) until .open lands, so conditional mounting without
          the class left it permanently invisible. Content only renders while
          open so sheet parsing doesn't run up-front. */}
      <div className={`drill-scrim${open ? " show" : ""}`} aria-hidden onClick={() => setOpen(false)} />
      <aside className={`od-drawer report-drawer${open ? " open" : ""}`} role="dialog" aria-label={title} aria-hidden={!open}>
        {open && (
          <>
            <div className="card-hd" style={{ position: "sticky", top: 0, background: "inherit", zIndex: 1 }}>
              <h3 style={{ flex: 1, fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600 }}>
                {title}{name ? <span className="muted" style={{ fontWeight: 400 }}> · {name}</span> : null}
              </h3>
              <a className="ghost tiny" href={url} target="_blank" rel="noreferrer" title="Open the original file in a new tab">New tab ↗</a>{" "}
              <button className="ghost tiny" onClick={() => setOpen(false)} aria-label="Close">✕</button>
            </div>
            <div style={{ padding: 12, height: "calc(100% - 56px)", overflow: "auto" }}>
              {isPdf ? (
                <iframe title="application-source" src={url} style={{ width: "100%", height: "100%", border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }} />
              ) : isImg ? (
                <img alt="application source" src={url} style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8 }} />
              ) : isSheet ? (
                <SheetPreview url={url} />
              ) : isDocx ? (
                <DocxPreview url={url} />
              ) : (
                <div className="muted" style={{ fontSize: 13 }}>
                  This file type can't preview in the browser — <a href={url} target="_blank" rel="noreferrer">open or download it</a> to read the sender's details.
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

/** Spreadsheet preview inside the source-document drawer: values-only render
 *  of each sheet (SheetJS is already in the bundle for the export builders).
 *  Full fidelity stays one click away via "New tab ↗". */
function SheetPreview({ url }: { url: string }) {
  const [sheets, setSheets] = useState<Array<{ name: string; rows: string[][] }> | null>(null);
  const [active, setActive] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [buf, XLSX] = await Promise.all([
          fetch(url).then((r) => { if (!r.ok) throw new Error(`couldn't load the file (${r.status})`); return r.arrayBuffer(); }),
          import("xlsx"),
        ]);
        const wb = XLSX.read(buf, { type: "array", cellDates: true });
        const out = wb.SheetNames.map((n) => {
          // raw:false gives the DISPLAYED value (dates and currency as the
          // sheet formats them) rather than serial numbers.
          const grid = XLSX.utils.sheet_to_json<Array<unknown>>(wb.Sheets[n], { header: 1, raw: false, defval: null, blankrows: false });
          const cell = (v: unknown) => (v == null ? "" : String(v).trim());
          const rows = grid.map((r) => (Array.isArray(r) ? r.map(cell) : []));
          // A spreadsheet's used range is mostly padding — drop columns and
          // rows that are entirely empty so the preview shows the document,
          // not an acre of empty grid.
          const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
          const keep: number[] = [];
          for (let c = 0; c < width; c++) if (rows.some((r) => (r[c] ?? "") !== "")) keep.push(c);
          const trimmed = rows
            .map((r) => keep.map((c) => r[c] ?? ""))
            .filter((r) => r.some((v) => v !== ""));
          return { name: n, rows: trimmed };
        }).filter((s2) => s2.rows.length > 0);
        if (!dead) setSheets(out);
      } catch (e) {
        if (!dead) setErr(e instanceof Error ? e.message : "couldn't read the spreadsheet");
      }
    })();
    return () => { dead = true; };
  }, [url]);
  if (err) return <div className="muted" style={{ fontSize: 13 }}>Preview failed ({err}) — <a href={url} target="_blank" rel="noreferrer">open the file</a> instead.</div>;
  if (!sheets) return <div className="muted" style={{ fontSize: 13 }}>Reading the spreadsheet…</div>;
  if (sheets.length === 0) return <div className="muted" style={{ fontSize: 13 }}>This spreadsheet has no filled cells to preview — <a href={url} target="_blank" rel="noreferrer">open the file</a>.</div>;
  const rows = sheets[active]?.rows ?? [];
  // Money / quantity cells right-align; everything else reads left.
  const isNum = (v: string) => /^[-(]?[£$€]?\s?[\d,]+(\.\d+)?\)?%?$/.test(v.trim()) && /\d/.test(v);
  return (
    <div>
      {sheets.length > 1 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {sheets.map((s2, i) => (
            <button key={s2.name} className={i === active ? "btn tiny" : "ghost tiny"} onClick={() => setActive(i)}>{s2.name}</button>
          ))}
        </div>
      )}
      <div className="sheet-preview">
        <table>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((v, ci) => (
                  <td key={ci} className={isNum(v) ? "num" : undefined} style={v === "" ? { background: "transparent", borderColor: "transparent" } : undefined}>{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>Values-only preview — empty rows and columns are hidden; formatting and formulas show in the original file.</div>
    </div>
  );
}

/** Word-document preview (mammoth → HTML), same pattern as the TBT reader. */
function DocxPreview({ url }: { url: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const buf = await fetch(url).then((r) => { if (!r.ok) throw new Error(`couldn't load the file (${r.status})`); return r.arrayBuffer(); });
        const mod = await import("mammoth");
        const convert = (mod as { convertToHtml?: typeof import("mammoth").convertToHtml }).convertToHtml
          ?? (mod as unknown as { default: typeof import("mammoth") }).default.convertToHtml;
        const res = await convert({ arrayBuffer: buf });
        if (!dead) setHtml(res.value);
      } catch (e) {
        if (!dead) setErr(e instanceof Error ? e.message : "couldn't read the document");
      }
    })();
    return () => { dead = true; };
  }, [url]);
  if (err) return <div className="muted" style={{ fontSize: 13 }}>Preview failed ({err}) — <a href={url} target="_blank" rel="noreferrer">open the file</a> instead.</div>;
  if (html == null) return <div className="muted" style={{ fontSize: 13 }}>Reading the document…</div>;
  return <div className="sheet-preview doc-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

function AssignSupplierBanner({
  afpId, canEdit, onAssigned, prefillName,
}: {
  afpId: number;
  canEdit: boolean;
  onAssigned: () => void;
  prefillName?: string | null;
}) {
  const [suppliers, setSuppliers] = useState<Array<{ id: number; name: string; is_labour_supplier: boolean }>>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState(prefillName ?? "");

  useEffect(() => {
    api.listSuppliers().then((rows) => setSuppliers(rows)).catch(() => setSuppliers([]));
  }, []);

  const labour = suppliers.filter((s) => s.is_labour_supplier);

  // The subbie isn't on the register yet — read their name off the source
  // document, create them as a labour supplier and assign in one step.
  async function addAndAssign() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true); setErr(null);
    try {
      // Creates the register entry WITH the details read off the document
      // (address, VAT, UTR, terms, bank) and assigns in one step; links an
      // existing supplier instead of duplicating.
      await api.createSupplierFromAfp(afpId, name);
      onAssigned();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "couldn't add the subcontractor");
    } finally {
      setBusy(false);
    }
  }

  async function assign() {
    if (!picked) return;
    setBusy(true); setErr(null);
    try {
      await api.updateAfp(afpId, { counterparty_supplier_id: picked });
      onAssigned();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "assign failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ background: "var(--warn-soft, #fff7ed)", borderLeft: "4px solid var(--warn, #ea580c)" }}>
      <div className="card-bd" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <strong>⚠ No subcontractor assigned</strong>
          <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
            This application was forwarded in but we couldn't tell which subbie it's from. Pick them before submitting.
          </div>
          {err && <div className="flash error" style={{ marginTop: 8 }}>{err}</div>}
        </div>
        {canEdit && (
          <>
            {!adding ? (
              <>
                <select value={picked ?? ""} onChange={(e) => setPicked(e.target.value ? Number(e.target.value) : null)} style={{ minWidth: 220 }}>
                  <option value="">— select subcontractor —</option>
                  {labour.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <button className="primary" onClick={assign} disabled={busy || !picked}>{busy ? "Saving…" : "Assign"}</button>
                <button className="ghost" onClick={() => setAdding(true)} title="They're not on the register yet — add them from the document">＋ New subcontractor</button>
              </>
            ) : (
              <>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Subcontractor name (as on the document)" style={{ minWidth: 240 }} />
                <button className="primary" onClick={addAndAssign} disabled={busy || !newName.trim()}>{busy ? "Saving…" : "Add & assign"}</button>
                <button className="ghost" onClick={() => { setAdding(false); setNewName(""); }}>Cancel</button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Banner for a labour AfP whose line(s) are valued at a rate that differs from
 * the agreed live rate (or BOQ rate). Lists each off-rate line with its applied
 * vs agreed rate and the value impact, and lets you re-rate a line (or all) to
 * the agreed rate — or, for a director, sign off the variance with a reason so
 * it can be certified as-is. Once signed off, shows the sign-off note instead.
 */
function RateVarianceBanner({
  afp, flaggedLines, canEdit, isDirector, busy, onApply, onApplyAll, onSignOff,
}: {
  afp: AfpDetail["afp"];
  flaggedLines: AfpLine[];
  canEdit: boolean;
  isDirector: boolean;
  busy: boolean;
  onApply: (lineId: number) => void;
  onApplyAll: () => void;
  onSignOff: () => void;
}) {
  const overridden = !!afp.rate_override_at;
  const canFix = canEdit && (afp.status === "draft" || afp.status === "submitted");
  // Net value impact of moving every flagged line to its expected rate.
  const impact = flaggedLines.reduce((s, l) => {
    if (l.expected_rate == null) return s;
    return s + (l.qty ?? 0) * (l.expected_rate - l.rate);
  }, 0);
  const n = flaggedLines.length;

  if (overridden) {
    return (
      <div className="card" style={{ marginTop: 16, borderLeft: "4px solid #16a34a" }}>
        <div className="card-bd">
          <b>Rate variance signed off</b> by {afp.rate_override_by} on {fmtDate(afp.rate_override_at ?? null)}.
          {afp.rate_override_reason && (
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>Reason: {afp.rate_override_reason}</div>
          )}
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {n} line{n === 1 ? "" : "s"} valued off the agreed rate — cleared for certification.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: 16, background: "var(--warn-soft, #fff7ed)", borderLeft: "4px solid var(--warn, #ea580c)" }}>
      <div className="card-hd">
        <h2 style={{ flex: 1 }}>⚠ Rate variance — {n} line{n === 1 ? "" : "s"} off the agreed rate</h2>
        {canFix && (
          <button className="accent" onClick={onApplyAll} disabled={busy} title="Set every flagged line to its agreed live/BOQ rate">
            Apply live rate to all
          </button>
        )}
        {canFix && isDirector && (
          <button className="ghost" onClick={onSignOff} disabled={busy} title="Sign off the rate variance with a reason">
            Sign off variance
          </button>
        )}
      </div>
      <div className="muted" style={{ margin: "0 20px 8px", fontSize: 13 }}>
        This labour application is valued at rates that differ from the agreed live rates. It can't be certified until the rates are corrected (apply the live rate) or a director signs off the variance.
        {Math.abs(impact) > 0.005 && (
          <> Re-rating would {impact < 0 ? "reduce" : "increase"} the claim by <b>{fmtMoney(Math.abs(impact))}</b>.</>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>Line</th>
            <th className="num">Qty</th>
            <th className="num">Applied rate</th>
            <th className="num">Agreed rate</th>
            <th className="num">Δ value</th>
            {canFix && <th></th>}
          </tr>
        </thead>
        <tbody>
          {flaggedLines.map((l) => {
            const exp = l.expected_rate ?? 0;
            const dv = (l.qty ?? 0) * (exp - l.rate);
            return (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td className="num">{fmtQty(l.qty)}</td>
                <td className="num" style={{ color: "#b45309", fontWeight: 600 }}>{fmtMoney(l.rate)}</td>
                <td className="num">
                  {fmtMoney(exp)}
                  <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>{l.rate_source === "boq" ? "BOQ" : "live"}</span>
                </td>
                <td className="num">{deltaText(dv, 600)}</td>
                {canFix && (
                  <td>
                    <button className="ghost tiny" onClick={() => onApply(l.id)} disabled={busy} title={`Set rate to ${fmtMoney(exp)}`}>
                      Use {fmtMoney(exp)}
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Banner shown on a draft AfP that was populated from an upload, listing every
 * extracted line that didn't auto-match to a contract_item. Each row offers:
 *   • Assign to BOQ line — apply the % / value to the picked contract item
 *   • Add as variation   — create an ad-hoc line on this AfP at the value
 *   • Dismiss            — drop the line without changing anything
 * Resolving any row removes it from the JSON and refreshes the AfP totals.
 */
function UnmatchedLinesBanner({
  afpId, direction, unmatchedJson, resolvedJson, seededLines, canEdit, onResolved,
}: {
  afpId: number;
  direction: "outgoing" | "incoming_labour";
  unmatchedJson: string | null;
  resolvedJson: string | null;
  seededLines: AfpLine[];
  canEdit: boolean;
  onResolved: () => void;
}) {
  type Unmatched = {
    raw_line_no: number;
    description: string;
    qty: number | null;
    unit: string | null;
    cumulative_value: number | null;
    cumulative_pct: number | null;
    this_period_value: number | null;
    resolution?: { action: string } | null;
  };
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  let parsed: Unmatched[] = [];
  try { parsed = unmatchedJson ? JSON.parse(unmatchedJson) as Unmatched[] : []; } catch { parsed = []; }
  let resolved: Unmatched[] = [];
  try { resolved = resolvedJson ? JSON.parse(resolvedJson) as Unmatched[] : []; } catch { resolved = []; }
  if (parsed.length === 0 && resolved.length === 0) return null;

  // Only show BOQ-derived seeded lines as assign candidates (variations would be a re-entry)
  const candidates = seededLines.filter((l) => l.contract_item_id != null && !l.is_adhoc);

  async function act(rawLineNo: number, action: "assign" | "dismiss" | "add_as_variation" | "add_as_expense" | "add_as_adjustment", contractItemId?: number) {
    setBusy(true); setErr(null);
    try {
      await api.resolveUnmatchedLine(afpId, rawLineNo, {
        action, contract_item_id: contractItemId,
        mode: addOnTop[rawLineNo] === false ? "set" : "add",
      });
      onResolved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "resolve failed");
    } finally {
      setBusy(false);
    }
  }
  // Per-row: is the figure a separate/period amount to STACK on the line
  // (default), or the item's cumulative-to-date which must REPLACE it?
  const [addOnTop, setAddOnTop] = useState<Record<number, boolean>>({});

  // Split editor: portion one line's cost over several BOQ lines.
  const [splitFor, setSplitFor] = useState<number | null>(null);
  const [splitParts, setSplitParts] = useState<Array<{ lineId: string; value: string }>>([]);
  function openSplit(rawLineNo: number) {
    setSplitFor(rawLineNo);
    setSplitParts([{ lineId: "", value: "" }, { lineId: "", value: "" }]);
  }
  async function applySplit(u: Unmatched) {
    const parts = splitParts
      .map((p) => {
        const cand = candidates.find((cd) => cd.id === Number(p.lineId));
        return { contract_item_id: cand?.contract_item_id ?? 0, value: Number(p.value) };
      })
      .filter((p) => p.contract_item_id > 0 && Number.isFinite(p.value) && p.value > 0);
    if (!parts.length) { setErr("Add at least one split row with a BOQ line and a £ value."); return; }
    setBusy(true); setErr(null);
    try {
      await api.resolveUnmatchedLine(afpId, u.raw_line_no, {
        action: "assign_split", parts, mode: addOnTop[u.raw_line_no] === false ? "set" : "add",
      });
      setSplitFor(null);
      onResolved();
    } catch (e) { setErr(e instanceof Error ? e.message : "split failed"); }
    finally { setBusy(false); }
  }

  async function undo(rawLineNo: number) {
    setBusy(true); setErr(null);
    try { await api.undoResolvedLine(afpId, rawLineNo); onResolved(); }
    catch (e) { setErr(e instanceof Error ? e.message : "undo failed"); }
    finally { setBusy(false); }
  }
  const RES_LABEL: Record<string, string> = {
    assign: "→ assigned to a BOQ line", assign_split: "→ split over BOQ lines",
    add_as_variation: "→ added as a variation",
    add_as_expense: "→ added as an expense", add_as_adjustment: "→ added as a contract adjustment", dismiss: "→ dismissed",
  };

  return (
    <div
      className="card"
      style={{ marginTop: 16, background: "var(--warn-soft, #fff7ed)", borderLeft: "4px solid var(--warn, #ea580c)" }}
    >
      <div className="card-hd">
        <h2 style={{ flex: 1 }}>⚠ Lines need review ({parsed.length})</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          extracted from the upload but couldn't be matched to a BOQ line
        </span>
      </div>
      {err && <div className="flash error" style={{ margin: "0 20px" }}>{err}</div>}
      {parsed.length > 0 && (
        <table>
          <thead>
            <tr>
              {/* Outgoing = OUR application up to the client; incoming = a subbie's to us. */}
              <th>{direction === "outgoing" ? "Application line" : "Subbie's description"}</th>
              <th className="num">Qty</th>
              <th className="center">Unit</th>
              <th className="num">Cumulative £</th>
              <th className="num">Cumulative %</th>
              <th className="num">This period £</th>
              {canEdit && <th>Resolve</th>}
            </tr>
          </thead>
          <tbody>
            {parsed.map((u) => (
              <tr key={u.raw_line_no}>
                <td>{u.description}</td>
                <td className="num">{u.qty != null ? u.qty : <span className="muted">—</span>}</td>
                <td className="center">{u.unit ?? <span className="muted">—</span>}</td>
                <td className="num">{u.cumulative_value != null ? fmtMoney(u.cumulative_value) : <span className="muted">—</span>}</td>
                <td className="num">{u.cumulative_pct != null ? `${u.cumulative_pct.toFixed(1)}%` : <span className="muted">—</span>}</td>
                <td className="num">{u.this_period_value != null ? fmtMoney(u.this_period_value) : <span className="muted">—</span>}</td>
                {canEdit && (
                  <td>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <select
                        defaultValue=""
                        disabled={busy}
                        onChange={(e) => {
                          const id = Number(e.target.value);
                          if (Number.isFinite(id) && id > 0) {
                            const ci = candidates.find((c) => c.id === id);
                            if (ci?.contract_item_id) act(u.raw_line_no, "assign", ci.contract_item_id);
                            e.currentTarget.selectedIndex = 0;
                          }
                        }}
                        style={{ minWidth: 240 }}
                      >
                        <option value="">— assign to BOQ line —</option>
                        {candidates.map((c) => (
                          <option key={c.id} value={c.id}>{c.section ? `${c.section} · ` : ""}{c.description}</option>
                        ))}
                      </select>
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, whiteSpace: "nowrap", cursor: "pointer" }}
                        title="Ticked: the figure is this period only / a separate piece of work — it stacks on top of the line's claim. Untick when the figure is the item's cumulative total to date, so it replaces the claim instead of double-counting.">
                        <input type="checkbox" checked={addOnTop[u.raw_line_no] !== false}
                          onChange={(e) => setAddOnTop((p2) => ({ ...p2, [u.raw_line_no]: e.target.checked }))} />
                        Not cumulative — add on top
                      </label>
                      <button className="ghost tiny" onClick={() => openSplit(u.raw_line_no)} disabled={busy}
                        title="Portion this cost over several BOQ lines — e.g. one daywork figure covering two items">Split…</button>
                      {direction === "outgoing" && (
                        <button className="ghost tiny" onClick={() => act(u.raw_line_no, "add_as_adjustment")} disabled={busy} title="Add as its own CONTRACT line at its full value (e.g. a Directors Adjustment) — the contract sum foots to the agreed figure; % claimed follows the workbook">+ Adjustment</button>
                      )}
                      <button className="ghost tiny" onClick={() => act(u.raw_line_no, "add_as_variation")} disabled={busy}>+ Variation</button>
                      <button className="ghost tiny" onClick={() => act(u.raw_line_no, "add_as_expense")} disabled={busy} title="Add as a claimed expense (own bucket, outside the measured labour budget)">+ Expense</button>
                      <button className="ghost tiny" onClick={() => act(u.raw_line_no, "dismiss")} disabled={busy}>Dismiss</button>
                    </div>
                    {splitFor === u.raw_line_no && (
                      <div style={{ marginTop: 8, padding: 10, border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg, #fff)" }}>
                        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                          Split {fmtMoney(u.cumulative_value ?? u.this_period_value ?? 0)} over BOQ lines
                          {(() => {
                            const sum = splitParts.reduce((s2, p) => s2 + (Number(p.value) || 0), 0);
                            return sum > 0 ? <> — entered {fmtMoney(sum)}</> : null;
                          })()}
                        </div>
                        {splitParts.map((p, i) => (
                          <div key={i} className="row" style={{ gap: 6, marginBottom: 6 }}>
                            <select value={p.lineId} disabled={busy} style={{ minWidth: 220 }}
                              onChange={(e) => setSplitParts((prev) => prev.map((x, j) => j === i ? { ...x, lineId: e.target.value } : x))}>
                              <option value="">— BOQ line —</option>
                              {candidates.map((cd) => (
                                <option key={cd.id} value={cd.id}>{cd.section ? `${cd.section} · ` : ""}{cd.description}</option>
                              ))}
                            </select>
                            <input inputMode="decimal" placeholder="£" value={p.value} disabled={busy} style={{ width: 100, textAlign: "right" }}
                              onChange={(e) => setSplitParts((prev) => prev.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
                            {splitParts.length > 1 && (
                              <button className="ghost tiny" disabled={busy} onClick={() => setSplitParts((prev) => prev.filter((_, j) => j !== i))}>✕</button>
                            )}
                          </div>
                        ))}
                        <div className="row" style={{ gap: 8 }}>
                          <button className="ghost tiny" disabled={busy} onClick={() => setSplitParts((prev) => [...prev, { lineId: "", value: "" }])}>+ part</button>
                          <span className="grow" />
                          <button className="ghost tiny" disabled={busy} onClick={() => setSplitFor(null)}>Cancel</button>
                          <button className="accent tiny" disabled={busy} onClick={() => void applySplit(u)}>Apply split</button>
                        </div>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {resolved.length > 0 && (
        <div style={{ padding: "10px 20px", borderTop: parsed.length > 0 ? "1px solid var(--line)" : undefined }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Resolved ({resolved.length}) — undo if one went to the wrong place:</div>
          <div style={{ display: "grid", gap: 4 }}>
            {resolved.map((u) => (
              <div key={u.raw_line_no} className="row" style={{ gap: 8, alignItems: "center", fontSize: 12.5 }}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.description}</span>
                <span className="muted" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{RES_LABEL[u.resolution?.action ?? ""] ?? "→ resolved"}</span>
                {canEdit && <button className="ghost tiny" onClick={() => undo(u.raw_line_no)} disabled={busy}>Undo</button>}
              </div>
            ))}
          </div>
        </div>
      )}
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

/** Assign labour subcontractors to specific bill items (project-wide), so a new
 *  application for that subbie only seeds their items — split one item across
 *  suppliers by entering a £ slice. */
function LabourAllocationsPanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [allocs, setAllocs] = useState<Awaited<ReturnType<typeof api.labourAllocations>>>([]);
  const [items, setItems] = useState<Array<{ id: number; item_no: number; description: string; labour_total: number | null }>>([]);
  const [suppliers, setSuppliers] = useState<Array<{ id: number; name: string; is_labour_supplier?: boolean }>>([]);
  const [itemId, setItemId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function load() { api.labourAllocations(projectId).then(setAllocs).catch(() => {}); }
  useEffect(() => {
    load();
    api.listContractItems(projectId).then((r) => setItems((r as unknown as Array<{ id: number; item_no: number; description: string; labour_total: number | null }>).filter((i) => (i.labour_total ?? 0) > 0))).catch(() => {});
    api.listSuppliers().then((r) => setSuppliers((r as Array<{ id: number; name: string; is_labour_supplier?: boolean }>).filter((s) => s.is_labour_supplier))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function add() {
    if (!itemId || !supplierId) return;
    setBusy(true); setErr(null);
    try {
      await api.addLabourAllocation(projectId, { contract_item_id: Number(itemId), supplier_id: Number(supplierId), allocated_value: value === "" ? null : Number(value) });
      setItemId(""); setSupplierId(""); setValue(""); load();
    } catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(false); }
  }
  async function remove(id: number) { await api.deleteLabourAllocation(id); load(); }

  return (
    <details className="card" style={{ marginTop: 16 }}>
      <summary className="card-hd" style={{ cursor: "pointer" }}>
        <h2 style={{ flex: 1 }}>Bill-item allocations <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>— which subbie applies for which items</span></h2>
        <span className="pill">{allocs.length}</span>
      </summary>
      <div className="card-bd">
        {err && <div className="flash error">{err}</div>}
        <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>Assign a labour supplier to a bill item so a new application for that subbie only seeds their items. Split one item across suppliers by entering a £ slice (blank = whole line).</p>
        {allocs.length > 0 && (
          <table><thead><tr><th>Bill item</th><th>Supplier</th><th className="num">Allocated</th><th className="num">Line labour</th>{canEdit && <th></th>}</tr></thead>
            <tbody>{allocs.map((a) => (
              <tr key={a.id}>
                <td>{a.item_no}. {a.description}</td>
                <td>{a.supplier_name}</td>
                <td className="num">{a.allocated_value != null ? fmtMoney(a.allocated_value) : "whole line"}</td>
                <td className="num muted">{a.labour_total != null ? fmtMoney(a.labour_total) : "—"}</td>
                {canEdit && <td className="num"><button className="ghost tiny" onClick={() => remove(a.id)}>✕</button></td>}
              </tr>
            ))}</tbody>
          </table>
        )}
        {canEdit && (
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div className="grow" style={{ minWidth: 220 }}><label>Bill item</label>
              <select value={itemId} onChange={(e) => setItemId(e.target.value)} style={{ width: "100%" }}>
                <option value="">— pick item —</option>
                {items.map((i) => <option key={i.id} value={i.id}>{i.item_no}. {i.description}{i.labour_total != null ? ` (${fmtMoney(i.labour_total)})` : ""}</option>)}
              </select>
            </div>
            <div style={{ minWidth: 180 }}><label>Supplier</label>
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} style={{ width: "100%" }}>
                <option value="">— pick supplier —</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div style={{ width: 120 }}><label>£ slice (opt.)</label><input type="number" step="0.01" className="num" value={value} onChange={(e) => setValue(e.target.value)} placeholder="whole line" /></div>
            <button className="accent" disabled={busy || !itemId || !supplierId} onClick={add}>Assign</button>
          </div>
        )}
      </div>
    </details>
  );
}
