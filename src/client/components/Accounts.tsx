import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PdfHighlightViewer } from "./PdfHighlightViewer";
import { RegionBoxes, FieldCrop, type DrawnRegion } from "./ReadRegions";
import { looksLikeOurPoNumber } from "../../shared/line-match";
import { GroupedCombobox, type ComboGroup, type ComboOption } from "./GroupedCombobox";
import { api, fmtMoney, type AccountsLabourCert } from "../lib/api";
import { isSpreadsheetFile } from "../../shared/file-kind";
import { isRetryableExtractError } from "../../shared/extract-retry";
import { can } from "../../shared/permissions";
import { Topbar } from "./Shell";
import type { CurrentUser, InboundApplication, Invoice, InvoiceMatch, InvoiceMatchLine, MatchSummary, Project, Supplier } from "../../shared/types";
import { NON_GOODS_LINE_IDS, PAYMENT_SCHEDULE_LINE_ID, SERVICE_CHARGE_LINE_ID } from "../../shared/line-match";
import { poStatusHint, poDeliveryLabel } from "../../shared/po-delivery-status";
import { isAwaitingApproval, isReadyToPush, isCertReadyToPush, isCertInXero } from "../../shared/payment-release";
import { AfpHistory } from "./AfpHistory";

// Amounts render in the invoice's OWN currency — a $ or € invoice shown with a
// £ sign misreports what we owe. Falls back to sterling when unknown.
const money = (n: number | null | undefined, cur?: string | null) => (n == null ? "—" : fmtMoney(n, cur || "GBP"));
/** Symbol for the amount-field labels ("Net €"), so the figures being typed are
 *  unambiguous. Unknown codes show the code itself rather than a wrong symbol. */
const CUR_SYMBOL: Record<string, string> = { GBP: "£", EUR: "€", USD: "$", JPY: "¥", INR: "₹", CHF: "CHF", PLN: "zł" };
const curSymbol = (cur: string | null | undefined) => CUR_SYMBOL[(cur || "GBP").toUpperCase()] ?? (cur || "£");
const qtyFmt = (n: number | null | undefined) =>
  (n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));

/** Does this invoice quote one of OUR order numbers?
 *
 *  Of 231 live invoices, 49 do. 108 quote nothing at all and 74 quote something
 *  that is not ours — POR117594, SOR458448, a sales-order number, a quote
 *  reference, the site name DALLAS ROAD. None of it was ever flagged, so an
 *  invoice naming no order of ours looked exactly like one that did, right up
 *  to the point it was approved and posted.
 *
 *  'none' = nothing quoted; 'theirs' = a reference, but not ours; 'ours' = ours. */
function poRefState(inv: { extracted_po_ref?: string | null }): "ours" | "theirs" | "none" {
  const ref = (inv.extracted_po_ref ?? "").trim();
  if (!ref) return "none";
  return looksLikeOurPoNumber(ref) ? "ours" : "theirs";
}

/** An overhead (subscriptions, utilities, rent) is never bought on a PO, so a
 *  missing reference on one is expected rather than something to chase. */
function wantsOurPoRef(inv: { kind?: string | null; extracted_po_ref?: string | null }): boolean {
  return inv.kind !== "overhead" && poRefState(inv) !== "ours";
}

type Tab = "inbox" | "held" | "ready" | "overheads" | "pushed" | "dismissed";

/** Row status for the inbox dot/chip. The three live states of the flow are
 *  distinct because they belong to different people: awaiting approval is the
 *  approver's, ready to push is Accounts', and pushed is done. */
function rowStatus(inv: Invoice): "matched" | "held" | "ready" | "review" | "none" {
  if (isAwaitingApproval(inv)) return "held";
  if (isReadyToPush(inv)) return "ready";
  if (inv.approved_at || inv.status === "pushed") return "matched";
  if ((inv.kind === "project" && inv.project_id) || (inv.kind === "overhead" && inv.nominal_code)) return "review";
  return "none";
}
const ST_LABEL: Record<"matched" | "held" | "ready" | "review" | "none", string> =
  { matched: "Approved", held: "Awaiting approval", ready: "Ready to push", review: "Review", none: "New" };

/** Red when the billed quantity and the ordered quantity disagree at all, in
 *  either direction — grey (the default for this sub-label) when they match or
 *  when one side has no figure to compare. Note this fires on unit-basis
 *  differences too: a supplier billing 3,000 fasteners against an order for 40
 *  boxes reads as a mismatch here even though the money agrees. The value
 *  columns are where the money is judged; this one just says the counts differ. */
function qtyDiffers(l: InvoiceMatchLine): boolean {
  return l.qty != null && l.po_qty != null && Math.abs(l.qty - l.po_qty) > 0.001;
}

/** The one thing wrong with an unmatched invoice, short enough for a row.
 *  A bare "Unmatched" on a third of the book is a label; a stated reason is a
 *  task, so the badge names the biggest problem and the tooltip lists the rest. */
function matchLabel(m: MatchSummary, cur?: string | null): string {
  // Which JOB the invoice belongs to comes before which order and before any
  // money: the coding, the link and every comparison beneath them assume it.
  const amb = m.issues.find((i) => i.kind === "ambiguous_job");
  if (amb?.kind === "ambiguous_job") {
    return `Ambiguous job \u00b7 ref says ${amb.ref_project}, ship-to says ${amb.address_project}`;
  }
  if (m.state === "no_po") return "No PO matched";
  // Worst first: a link to the wrong order makes the price and quantity detail
  // beneath it meaningless, so it has to be the thing the row says.
  const wrong = m.issues.find((i) => i.kind === "wrong_po");
  if (wrong?.kind === "wrong_po") return `Wrong PO \u00b7 invoice quotes ${wrong.quoted}`;
  // Ranked under wrong_po because that one names the order it should be, and
  // above cross_project because a job mismatch can still be a plausible order
  // while this one cannot be the right order at any job.
  const small = m.issues.find((i) => i.kind === "po_too_small");
  if (small?.kind === "po_too_small") {
    return `Wrong PO \u00b7 ${Math.round(small.invoice_net / small.po_total)}\u00d7 the order's whole value`;
  }
  const xp = m.issues.find((i) => i.kind === "cross_project");
  if (xp?.kind === "cross_project") return `Wrong PO \u00b7 that order is on job ${xp.po_project}`;
  if (m.excess > 0) return `Unmatched \u00b7 ${fmtMoney(m.excess, cur || "GBP")} over order`;
  if (m.issues.some((i) => i.kind === "rate")) return "Unmatched \u00b7 rate differs from PO";
  const n = m.issues.filter((i) => i.kind === "unlinked").length;
  if (n) return `Unmatched \u00b7 ${n} line${n > 1 ? "s" : ""} not on the PO`;
  return "Unmatched";
}

/** Every reason, spelled out. "The total differs" on its own reads as a pricing
 *  query and gets waved through as one, so each line says which figure moved. */
function matchTitle(m: MatchSummary, cur?: string | null): string {
  const money = (n: number) => fmtMoney(n, cur || "GBP");
  const reasons = m.issues.map((i) => {
    if (i.kind === "ambiguous_job") {
      const po = i.quoted_po ? ` (${i.quoted_po})` : "";
      return `This invoice disagrees with itself about the job. The order number it quotes, ${i.quoted}, belongs to job ${i.ref_project}${po} \u2014 but the delivery address printed on it is job ${i.address_project}. Both are literal readings of the document, so one of them is wrong. Check which order the lines actually bill against before coding it.`;
    }
    if (i.kind === "wrong_po") return `The invoice quotes ${i.quoted}, but it's linked to ${i.linked}. Check which order this really bills against \u2014 the price and quantity checks below mean nothing until that's right.`;
    if (i.kind === "cross_project") return `Coded to job ${i.invoice_project}, but ${i.linked} belongs to job ${i.po_project}.`;
    if (i.kind === "po_too_small") return `This bills ${money(i.invoice_net)} against ${i.linked}, an order worth ${money(i.po_total)} in total — ${Math.round(i.invoice_net / i.po_total)}× its whole value. That isn't an overspend to explain, it's almost certainly the wrong order.`;
    if (i.kind === "unlinked") return `"${i.item}" isn't linked to any line on the PO \u2014 mark it as a service charge if that's what it is.`;
    if (i.kind === "rate") return `${i.item}: billed at ${money(i.billed)}, ordered at ${money(i.ordered)}.`;
    const head = `${i.item}: billed ${money(i.billed)} against ${money(i.ordered)} ordered, ${money(i.excess)} over`;
    if (i.why === "qty") return `${head} \u2014 more units at the agreed rate.`;
    if (i.why === "rate") return `${head} \u2014 same units, dearer rate.`;
    return `${head} \u2014 the invoice and the order use a different unit basis.`;
  });
  // An unlinked invoice used to report only that, swallowing anything else known
  // about it — including which job its own reference points at.
  if (m.state === "no_po") reasons.unshift("No purchase order is matched to this invoice.");
  return reasons.join("\n");
}


/**
 * Accounts workpiece — a Dext-style two-pane inbox. Supplier invoices arrive via
 * invoices@ or manual upload, are read by Claude, then coded to a Project or
 * (admin-only) Overheads and pushed to Xero as a draft Bill after a 3-way match.
 */
export function Accounts({ me }: { me: CurrentUser | null }) {
  const isAdmin = can(me, "approvers.manage");
  const canEdit = can(me, "commercial.edit");
  // Not a role check — the release list is by name, because no role draws the
  // line in the right place (see release_approvers / isReleaseApprover).
  const canRelease = me?.can_release_payables === true;
  const [tab, setTab] = useState<Tab>("inbox");
  const [rows, setRows] = useState<Invoice[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  // Labour certificates run the same queues as invoices. Selecting one clears
  // the invoice selection and vice versa.
  const [labour, setLabour] = useState<AccountsLabourCert[]>([]);
  const [selLabourId, setSelLabourId] = useState<number | null>(null);
  // Labour emails the mailbox couldn't put on a project. They wait here, in
  // Accounts' own Inbox, rather than in a tray nobody in Accounts looks at.
  const [tray, setTray] = useState<InboundApplication[]>([]);
  const [selTrayId, setSelTrayId] = useState<number | null>(null);
  // Which of the two lists the queue shows. Overheads and Dismissed are
  // invoice-only, so they always show invoices.
  const [kind, setKind] = useState<"invoices" | "labour">("invoices");
  const [projects, setProjects] = useState<Project[]>([]);
  const [accounts, setAccounts] = useState<Array<{ code: string; name: string; type: string }>>([]);
  // Only needed to name the subcontractor when handing an invoice to labour.
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function load() {
    api.listInvoices().then(setRows).catch((e) => setErr(e.message));
    api.listAccountsLabour().then(setLabour).catch(() => {});
    api.listInboundApplications().then((r) => setTray(r.filter((i) => i.direction === "incoming_labour"))).catch(() => {});
  }

  /** Hand the invoice to the labour pipeline. It becomes a labour certificate,
   *  so the screen follows it to Inbox → Labour certificates with it open —
   *  not to Dismissed, which is for things nobody needs to act on. */
  /** Returns the error, if any, so the modal can show it where it was clicked
   *  — the page's own banner is out of sight above a scrolled detail pane. */
  async function sendToLabour(id: number, input: { project_id: string; counterparty_supplier_id: number | null; period_end: string }): Promise<string | null> {
    setBusy(true); setErr(null); setInfo(null);
    try {
      const r = await api.sendInvoiceToLabour(id, input);
      load();
      setSelId(null);
      setKind("labour"); setTab("inbox"); setSelLabourId(r.afp_id);
      setInfo(r.unmatched_count
        ? `Sent to labour as application ${r.app_number} — ${r.unmatched_count} line(s) need matching there.`
        : `Sent to labour as application ${r.app_number}.`);
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't send this to labour.";
      setErr(msg);
      return msg;
    } finally { setBusy(false); }
  }

  // Deep link from the approvals dashboard (/accounts?invoice=123): open that
  // invoice, and land on the tab it is actually in — arriving on Inbox with
  // nothing selected is what makes a link from an approval queue useless.
  const [params, setParams] = useSearchParams();
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current || !rows.length) return;
    const want = Number(params.get("invoice"));
    if (!want) return;
    const inv = rows.find((r) => r.id === want);
    if (!inv) return;
    deepLinked.current = true;
    setSelId(want);
    setTab(inv.status === "pushed" ? "pushed"
      : inv.status === "dismissed" ? "dismissed"
      : isReadyToPush(inv) ? "ready"
      : isAwaitingApproval(inv) ? "held"
      : inv.kind === "overhead" ? "overheads" : "inbox");
    params.delete("invoice");
    setParams(params, { replace: true });
  }, [rows, params, setParams]);
  // The same for a labour certificate (/accounts?labour=123) — where certifying
  // on the certificate page sends you back to: its tab, the Labour subtab, and
  // the certificate open.
  const labourLinked = useRef(false);
  useEffect(() => {
    if (labourLinked.current || !labour.length) return;
    const want = Number(params.get("labour"));
    if (!want) return;
    const a = labour.find((x) => x.id === want);
    if (!a) return;
    labourLinked.current = true;
    setKind("labour");
    setTab(labourTab(a));
    setSelLabourId(want);
    params.delete("labour");
    setParams(params, { replace: true });
  }, [labour, params, setParams]);
  useEffect(() => {
    load();
    api.listProjects().then((r) => setProjects(r as unknown as Project[])).catch(() => {});
    api.listSuppliers().then(setSuppliers).catch(() => {});
    if (isAdmin) api.xeroAccounts().then((r) => setAccounts(r.accounts ?? [])).catch(() => {});
  }, [isAdmin]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const shown = rows.filter((r) => {
      if (tab === "overheads") { if (!(r.kind === "overhead" && r.status !== "dismissed")) return false; }
      else if (tab === "held") { if (!isAwaitingApproval(r)) return false; }
      else if (tab === "ready") { if (!isReadyToPush(r)) return false; }
      else if (tab === "pushed") { if (r.status !== "pushed") return false; }
      // One sent to labour is stored as dismissed, but it wasn't set aside: it
      // lives on as a labour certificate, and that's where it's shown.
      else if (tab === "dismissed") { if (r.status !== "dismissed" || r.labour_afp_id != null) return false; }
      // Inbox is what still needs coding, matching or approving. A held invoice
      // has had all three done to it and is waiting on someone else, so it
      // moves to Held rather than sitting in the queue looking outstanding.
      else if (!((r.status === "inbox" || r.status === "ready") && !isAwaitingApproval(r) && !isReadyToPush(r))) return false; // inbox
      if (q) {
        const hay = `${r.supplier_name ?? ""} ${r.matched_supplier_name ?? ""} ${r.invoice_number ?? ""} ${r.project_code ?? ""} ${r.supplier_order_ref ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // Everywhere else the order is when it arrived. Dismissed is looked at for
    // what was just set aside, so it goes by when that happened — otherwise
    // something dismissed today sinks below everything received after it.
    if (tab === "dismissed") {
      const when = (r: Invoice) => r.dismissed_at ?? r.received_at ?? "";
      shown.sort((a, b) => when(b).localeCompare(when(a)));
    }
    return shown;
  }, [rows, tab, search]);

  const visibleLabour = useMemo(() => {
    const q = search.trim().toLowerCase();
    return labour.filter((a) => {
      if (labourTab(a) !== tab) return false;
      return !q || `${a.supplier_name ?? ""} ${a.project_code} labour cert #${a.app_number}`.toLowerCase().includes(q);
    });
  }, [labour, tab, search]);
  const visibleTray = useMemo(() => {
    if (tab !== "inbox") return [];
    const q = search.trim().toLowerCase();
    return tray.filter((i) => !q || `${i.supplier_name ?? ""} ${i.sender_email} ${i.subject ?? ""} ${i.filename ?? ""}`.toLowerCase().includes(q));
  }, [tray, tab, search]);
  const labourCount = (t: Tab) => labour.filter((a) => labourTab(a) === t).length + (t === "inbox" ? tray.length : 0);
  const labourShown = visibleTray.length + visibleLabour.length;
  const hasLabourSubtab = tab === "inbox" || tab === "held" || tab === "ready" || tab === "pushed";
  const showLabour = hasLabourSubtab && kind === "labour";
  // Only while it's in the list on screen: a certificate that moved on (or a
  // tab switch) shouldn't leave its detail open beside a list it isn't in.
  const selLabour = showLabour ? labour.find((a) => a.id === selLabourId && labourTab(a) === tab) ?? null : null;
  const selTray = showLabour && tab === "inbox" ? tray.find((i) => i.id === selTrayId) ?? null : null;

  const sel = showLabour ? null : rows.find((r) => r.id === selId) ?? null;
  const inboxCount = rows.filter((r) => (r.status === "inbox" || r.status === "ready") && !isAwaitingApproval(r) && !isReadyToPush(r)).length;
  const heldCount = rows.filter((r) => isAwaitingApproval(r)).length;
  const readyCount = rows.filter((r) => isReadyToPush(r)).length;

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) { e.target.value = ""; } else return;
    setBusy(true); setErr(null); setInfo(null);
    try {
      const r = await api.uploadInvoice(f);
      setInfo(r.extracted ? "Invoice uploaded and read." : "Invoice uploaded — couldn't auto-read it, enter the details manually.");
      load(); setSelId(r.id);
    } catch (e) { setErr(e instanceof Error ? e.message : "upload failed"); }
    finally { setBusy(false); }
  }

  async function patch(id: number, body: Parameters<typeof api.updateInvoice>[1]) {
    setBusy(true); setErr(null);
    try { await api.updateInvoice(id, body); const fresh = await api.getInvoice(id); setRows((rs) => rs.map((r) => r.id === id ? fresh : r)); }
    catch (e) { setErr(e instanceof Error ? e.message : "save failed"); }
    finally { setBusy(false); }
  }

  async function reloadOne(id: number) {
    try { const fresh = await api.getInvoice(id); setRows((rs) => rs.map((r) => r.id === id ? fresh : r)); }
    catch (e) { setErr(e instanceof Error ? e.message : "reload failed"); }
  }

  async function reread(id: number) {
    setBusy(true); setErr(null); setInfo(null);
    try {
      const r = await api.reextractInvoice(id);
      setInfo(r.po_number ? `Re-read the invoice — PO ${r.po_number} found.` : "Re-read the invoice.");
      await reloadOne(id);
    } catch (e) { setErr(e instanceof Error ? e.message : "re-read failed"); }
    finally { setBusy(false); }
  }

  /** Undo a dismissal. Which queue it lands back in depends on its coding, so
   *  the flash names the queue rather than just saying "restored" — the row
   *  leaves this tab either way, and "it's gone" is the wrong impression. */
  async function undismiss(id: number) {
    setBusy(true); setErr(null); setInfo(null);
    try {
      const r = await api.undismissInvoice(id);
      const fresh = await api.getInvoice(id);
      const where = isAwaitingApproval(fresh) ? "Held" : "Inbox";
      // A draft application left behind would quietly claim the same work as
      // the invoice that just came back, so say so rather than tidy silently.
      setInfo(r.orphaned_afp_id
        ? `Restored to ${where}. Draft application #${r.orphaned_afp_id} is still there — delete it under Applications if it isn't wanted.`
        : `Restored to ${where}.`);
      load(); setSelId(null);
    } catch (e) { setErr(e instanceof Error ? e.message : "restore failed"); }
    finally { setBusy(false); }
  }

  /** Tie labour certificates to bills already in Xero. Also runs hourly. */
  async function checkLabourXero() {
    setBusy(true); setErr(null); setInfo(null);
    try {
      const r = await api.linkLabourXero();
      const said = (rows: Array<{ supplier: string; app_number: number; bill: string }>) =>
        rows.map((x) => `${x.supplier} #${x.app_number} (bill ${x.bill})`).join(", ");
      const parts = [
        r.linked_paid.length ? `Paid in Xero: ${said(r.linked_paid)}.` : "",
        r.now_paid.length ? `Now paid: ${said(r.now_paid)}.` : "",
        r.paid_date_fixed.length ? `Paid date corrected from Xero: ${said(r.paid_date_fixed)}.` : "",
        r.linked_owed.length ? `In Xero, owed: ${said(r.linked_owed)}.` : "",
        r.amount_differs.length ? `Same invoice number but a different amount in Xero — check by hand: ${r.amount_differs.map((x) => `${x.supplier} #${x.app_number} (app £${x.value.toFixed(2)}, Xero £${x.xero_value.toFixed(2)})`).join(", ")}.` : "",
        r.no_contact.length ? `Not found in Xero's contacts: ${r.no_contact.join(", ")}.` : "",
      ].filter(Boolean);
      setInfo(parts.length ? parts.join(" ") : "Checked Xero — nothing new to match.");
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't check Xero"); }
    finally { setBusy(false); }
  }

  async function push(id: number) {
    setBusy(true); setErr(null); setInfo(null);
    try {
      const r = await api.pushInvoiceXero(id);
      setInfo(`Pushed to Xero as draft bill ${r.xero_bill_number ?? ""}.`);
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : "Xero push failed"); }
    finally { setBusy(false); }
  }

  /** Approve a committed invoice. The decision only — Accounts pushes it to
   *  Xero afterwards, so the message says where it went rather than implying a
   *  bill now exists. */
  async function release(id: number, note?: string) {
    setBusy(true); setErr(null); setInfo(null);
    try {
      await api.releaseInvoice(id, note);
      setInfo("Approved. It's now in Ready to push for Accounts to send to Xero.");
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : "approval failed"); }
    finally { setBusy(false); }
  }

  const TABS: Array<[Tab, string, number | null]> = [
    ["inbox", "Inbox", inboxCount + labourCount("inbox")],
    // Both queues are counted for everyone. Accounts needs to see what it is
    // waiting on, not just what it can act on — an approval queue that only
    // approvers can see is how something sits in it for a fortnight.
    ["held", canRelease ? "To approve" : "Awaiting approval", heldCount + labourCount("held")],
    // The queue Accounts works from: approved, not yet posted.
    ["ready", "Ready to push", readyCount + labourCount("ready")],
    ...(isAdmin ? [["overheads", "Overheads", null] as [Tab, string, null]] : []),
    ["pushed", "Pushed", null],
    ["dismissed", "Dismissed", null],
  ];
  const tabLabel = TABS.find((t) => t[0] === tab)?.[1] ?? "Inbox";

  return (
    <>
      <Topbar crumbs="Workspace" title="Accounts" />
      <main>
        <div className="acctx">
          <div className="a-tabsrow">
            <div style={{ display: "flex", gap: 26, flexWrap: "wrap" }}>
              {TABS.map(([t, label, n]) => (
                <button key={t} className={`a-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
                  {label}{n != null && <span className="cnt">{n}</span>}
                </button>
              ))}
            </div>
            <span style={{ flex: 1 }} />
            {/* The inbox only knows about invoices that came through it. This is
                the other direction: what the supplier has in Xero, whether or
                not it ever reached us. Read-only, so it sits beside the tabs
                rather than among them. */}
            <Link className="btn ghost tiny" to="/accounts/xero-check" title="Compare a supplier's bills in Xero against the invoices logged here">
              Bills in Xero
            </Link>
            {showLabour && canEdit && (
              <button className="ghost tiny" disabled={busy} onClick={checkLabourXero}
                title="Find labour bills already in Xero: certificates with one move to Pushed, as paid or owed">
                Check labour in Xero
              </button>
            )}
            {canEdit && (
              <>
                <input ref={fileRef} type="file" accept="application/pdf,.pdf,image/*" hidden onChange={upload} />
                <button className="accent" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? "Working…" : "＋ Upload invoice"}</button>
              </>
            )}
          </div>
          {err && <div className="flash error">{err}</div>}
          {info && <div className="flash success">{info}</div>}

          <div className="a-split">
            {/* ── inbox ── */}
            <aside className="inbox">
              <div className="inbox-hd"><h2>{tabLabel}</h2><span className="count">{showLabour ? labourShown : visible.length}</span></div>
              {hasLabourSubtab && (
                <div className="a-subtabs">
                  <button className={kind === "invoices" ? "on" : ""} onClick={() => setKind("invoices")}>
                    Supplier invoices<span className="cnt">{visible.length}</span>
                  </button>
                  <button className={kind === "labour" ? "on" : ""} onClick={() => setKind("labour")}>
                    Labour certificates<span className="cnt">{labourShown}</span>
                  </button>
                </div>
              )}
              <div className="inbox-search">
                <input placeholder={showLabour ? "Search subcontractor, project, cert #…" : "Search supplier, invoice #…"} value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <div className="ilist">
                {showLabour ? (
                  labourShown === 0
                    ? <div className="muted" style={{ padding: "18px 15px", fontSize: 13, lineHeight: 1.5 }}>{LABOUR_EMPTY[tab]}</div>
                    : <>{visibleTray.map((i) => (
                      <button key={`t${i.id}`} className={`irow${selTrayId === i.id ? " on" : ""}`} onClick={() => { setSelTrayId(i.id); setSelLabourId(null); }}>
                        <span className="idot review" />
                        <div style={{ minWidth: 0 }}>
                          <div className="isup">{i.supplier_name || i.sender_email}</div>
                          <div className="imeta">
                            <span>{i.filename ?? "email"} · {(i.received_at ?? "").slice(0, 10)}</span>
                            <span title="received by email">✉</span>
                          </div>
                          <span className="istatus review">Needs project</span>
                        </div>
                        <div className="iamt" />
                      </button>
                    ))}{visibleLabour.map((a) => {
                      const t = labourTab(a);
                      const st = t === "held" ? "held" : t === "ready" ? "ready" : t === "pushed" ? "matched" : "review";
                      return (
                        <button key={`l${a.id}`} className={`irow${selLabourId === a.id ? " on" : ""}`} onClick={() => { setSelLabourId(a.id); setSelTrayId(null); }}>
                          <span className={`idot ${st}`} />
                          <div style={{ minWidth: 0 }}>
                            <div className="isup">{a.supplier_name || "Unassigned subcontractor"}</div>
                            <div className="imeta">
                              <span>Labour cert #{a.app_number} · {(a.certified_at ?? a.submitted_at ?? "").slice(0, 10)}</span>
                              <span className="proj">{a.project_code}</span>
                              {a.cis_rate != null && a.cis_rate > 0 && <span>CIS {a.cis_rate}%</span>}
                              {a.xero_sync_status === "failed" && <span style={{ color: "var(--danger)", fontWeight: 600 }} title={a.xero_sync_error ?? ""}>⚠ push failed</span>}
                            </div>
                            <span className={`istatus ${st}`}>{a.status === "draft" ? "Needs review" : t === "pushed" && a.status === "paid" ? "Paid" : t === "pushed" ? "Pushed" : LABOUR_LABEL[t]}</span>
                          </div>
                          <div className="iamt">{money(billedNet(a))}</div>
                        </button>
                      );
                    })}</>
                ) : visible.length === 0
                  ? <div className="muted" style={{ padding: "18px 15px", fontSize: 13, lineHeight: 1.5 }}>Nothing here. Email an invoice to <b>invoices@pgpprojects.com</b> or upload one.</div>
                  : visible.map((r) => {
                    const st = r.status === "dismissed" ? "none" : rowStatus(r);
                    return (
                      <button key={r.id} className={`irow${selId === r.id ? " on" : ""}`} onClick={() => { setSelId(r.id); setSelLabourId(null); }}>
                        <span className={`idot ${st}`} />
                        <div style={{ minWidth: 0 }}>
                          <div className="isup">{r.supplier_name || r.matched_supplier_name || "Unknown supplier"}</div>
                          <div className="imeta">
                            <span>{r.invoice_number ? `#${r.invoice_number}` : "no #"} · {(r.invoice_date || (r.received_at ?? "")).slice(0, 10)}{r.kind === "overhead" ? " · Overhead" : ""}{r.labour_afp_id != null ? " · Sent to labour" : ""}{tab === "dismissed" && r.dismissed_at ? ` · dismissed ${r.dismissed_at.slice(0, 10)}` : ""}</span>
                            {r.kind !== "overhead" && r.project_code && <span className="proj">{r.project_code}</span>}
                            {r.source === "email" && <span title="received by email">✉</span>}
                            {r.extract_error && <span title="couldn't auto-read">⚠</span>}
                            {/* Said on the row, because this is decided long
                                before anyone opens the invoice. */}
                            {wantsOurPoRef(r) && (
                              <span style={{ color: "var(--danger)", fontWeight: 600 }}
                                title={poRefState(r) === "none"
                                  ? "No PO reference is quoted on this invoice"
                                  : `This invoice quotes "${r.extracted_po_ref}", which is not one of our PO references`}>
                                ⚠ {poRefState(r) === "none" ? "no PO reference" : "PO reference not ours"}
                              </span>
                            )}
                            {r.terms_mismatch && <span style={{ color: "var(--warn)" }} title={`Invoice due ${r.due_date ?? "?"} but the account is ${r.supplier_payment_terms ?? "on other terms"} ⇒ ${r.expected_due_date ?? "?"}`}>⚠ terms</span>}
                            {/* Stays on the row after approval — a mismatch that was
                                approved anyway still needs chasing with the supplier. */}
                            {r.match && r.match.state !== "matched" && (
                              <span style={{ color: "var(--danger)", fontWeight: 600 }} title={matchTitle(r.match, r.currency)}>
                                ⚠ {matchLabel(r.match, r.currency)}
                              </span>
                            )}
                            {/* The matched order's delivery state, at a glance —
                                whether the goods this invoice bills for have
                                actually landed. Only shown once a PO is linked;
                                an unmatched invoice has no order to report on. */}
                            {r.po_delivery && r.po_delivery.state !== "none" && (
                              <span
                                style={{ color: r.po_delivery.state === "full" ? "var(--warn)" : "var(--muted)", fontWeight: r.po_delivery.state === "full" ? 600 : 400 }}
                                title={r.po_delivery.lines_total
                                  ? `${r.po_delivery.lines_started} of ${r.po_delivery.lines_total} lines have had a delivery`
                                  : undefined}
                              >
                                {r.po_delivery.state === "full" ? "✓ " : ""}{poDeliveryLabel(r.po_delivery)}
                              </span>
                            )}
                          </div>
                          <span className={`istatus ${st}`}>{r.status === "pushed" ? "Pushed" : ST_LABEL[st]}</span>
                        </div>
                        <div className="iamt">{money(r.gross_amount, r.currency)}</div>
                      </button>
                    );
                  })}
              </div>
            </aside>

            {/* ── detail ── */}
            <section className="detail">
              {selTray
                ? <LabourEmailDetail key={`t${selTray.id}`} item={selTray} projects={projects} canEdit={canEdit}
                    onDone={(afpId) => { load(); setSelTrayId(null); if (afpId != null) setSelLabourId(afpId); }} />
                : selLabour
                ? <LabourCertDetail key={`l${selLabour.id}`} cert={selLabour} canEdit={canEdit} canRelease={canRelease} onChanged={load} />
                : !sel
                ? <div className="a-card a-pad"><div className="muted" style={{ fontSize: 13 }}>{showLabour ? "Select a labour certificate." : "Select an invoice to review, code and push to Xero."}</div></div>
                : <InvoiceDetail key={sel.id} inv={sel} projects={projects} accounts={accounts} isAdmin={isAdmin} canEdit={canEdit}
                    canRelease={canRelease} busy={busy}
                    onPatch={(b) => patch(sel.id, b)} onPush={() => push(sel.id)} onRelease={(note) => release(sel.id, note)}
                    onReload={() => reloadOne(sel.id)} onReread={() => reread(sel.id)}
                    onDismiss={async () => { await api.dismissInvoice(sel.id); load(); setSelId(null); }}
                    onUndismiss={() => undismiss(sel.id)}
                    suppliers={suppliers} onSendToLabour={(input) => sendToLabour(sel.id, input)} />}
            </section>
          </div>
        </div>
      </main>
    </>
  );
}

/** Which Accounts tab a labour certificate sits in. Submitted (in from the
 *  mailbox, not yet certified) → certified, awaiting approval → approved, ready
 *  to push → pushed. Certifying IS the first signature here: there is no
 *  separate commit step between it and the approver. */
/** What the subbie billed: the certificate's figure plus anything still on
 *  lines that matched nothing. A draft otherwise reads £0 against a real bill. */
function billedNet(a: AccountsLabourCert): number {
  return (a.certified_amount ?? a.amount_due ?? 0) + (a.unmatched_value ?? 0);
}

function labourTab(a: AccountsLabourCert): Tab {
  if (isCertInXero(a)) return "pushed";
  if (isCertReadyToPush(a)) return "ready";
  if (a.status === "certified" || a.status === "paid") return "held";
  return "inbox";
}
const LABOUR_LABEL: Record<Tab, string> = {
  inbox: "Submitted", held: "Certified", ready: "Ready to push",
  pushed: "Pushed", overheads: "", dismissed: "",
};
const LABOUR_EMPTY: Record<Tab, string> = {
  inbox: "No labour invoices waiting. They arrive here from the subcontractors' Labour folders in the Accounts mailbox.",
  held: "No certified labour waiting for approval.",
  ready: "No approved labour waiting to go to Xero.",
  pushed: "No labour certificates pushed to Xero yet.",
  overheads: "", dismissed: "",
};

/** A labour email the mailbox couldn't place: no project named, and the subbie
 *  works (or has worked lately) on more than one. Picking the project here
 *  creates the certificate from what was already read off the document. */
function LabourEmailDetail({ item, projects, canEdit, onDone }: {
  item: InboundApplication; projects: Project[]; canEdit: boolean; onDone: (afpId: number | null) => void;
}) {
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function assign() {
    if (!projectId) { setErr("Pick the project this invoice is for."); return; }
    setBusy(true); setErr(null);
    try { const r = await api.resolveInboundApplication(item.id, { project_id: projectId }); onDone(r.id); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't create the certificate"); }
    finally { setBusy(false); }
  }
  async function dismiss() {
    if (!confirm(`Set aside ${item.filename ?? "this email"} from ${item.sender_email}? It won't become a labour certificate.`)) return;
    setBusy(true); setErr(null);
    try { await api.dismissInboundApplication(item.id); onDone(null); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't set it aside"); }
    finally { setBusy(false); }
  }
  const row = (k: string, v: React.ReactNode) => (
    <div className="row" style={{ gap: 12, fontSize: 13, padding: "4px 0" }}>
      <span className="muted" style={{ width: 150 }}>{k}</span><span>{v}</span>
    </div>
  );
  return (
    <div className="a-card a-pad" style={{ display: "grid", gap: 14 }}>
      <div>
        <div className="eyebrow">Labour invoice · by email</div>
        <h2 style={{ margin: "2px 0 0" }}>{item.supplier_name || "Subcontractor not recognised"}</h2>
      </div>
      {err && <div className="flash error">{err}</div>}
      <div>
        {row("From", item.sender_email)}
        {row("Received", (item.received_at ?? "").slice(0, 16).replace("T", " "))}
        {item.subject && row("Subject", item.subject)}
        {row("File", item.filename ?? "—")}
        {row("Lines read", String(item.line_count))}
        {item.note && row("Why it's here", item.note)}
      </div>
      {canEdit && (
        <div style={{ display: "grid", gap: 8, maxWidth: 520 }}>
          <label style={{ fontSize: 12, margin: 0 }}>Which project is this invoice for?</label>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Pick a project…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
          </select>
          <div className="row" style={{ gap: 8 }}>
            <button className="accent" disabled={busy || !projectId} onClick={assign}>Create labour certificate</button>
            <button className="ghost tiny" disabled={busy} onClick={dismiss}>Not a labour invoice</button>
          </div>
        </div>
      )}
      <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
        The email didn't name a project and {item.supplier_name ?? "the sender"} has invoiced more than one lately
        (or none), so it couldn't be placed automatically.
      </div>
    </div>
  );
}

/** A labour certificate in the Accounts detail pane. Certification stays with
 *  the QS on the certificate itself (the days check, time split and budget
 *  sign-off live there); from here an approver approves it and Accounts pushes
 *  the draft bill to Xero. */
function LabourCertDetail({ cert: a, canEdit, canRelease, onChanged }: {
  cert: AccountsLabourCert; canEdit: boolean; canRelease: boolean; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const stage = labourTab(a);
  const net = a.certified_amount ?? a.amount_due ?? 0;
  const noBudget = (a.labour_budget ?? 0) <= 0;
  const keyedByHand = isCertInXero(a) && !a.xero_po_id;
  /** A bill typed straight into Xero before labour ran through here. Recording
   *  it takes the certificate out of the queues so it can't be pushed twice. */
  function alreadyInXero() {
    const bill = prompt("This certificate's bill was keyed into Xero by hand. What is the bill's number in Xero?");
    if (bill === null) return;
    if (!bill.trim()) { setErr("Give the bill's number as it appears in Xero."); return; }
    run(() => api.markAfpInXeroByHand(a.id, bill.trim()));
  }
  /** Back to the Inbox as submitted, to be certified again. */
  function uncertify() {
    const reason = prompt(`Uncertify ${a.supplier_name ?? "this"} #${a.app_number}? It goes back to submitted in the Inbox and its approval is withdrawn.\n\nWhy?`);
    if (reason === null) return;
    if (!reason.trim()) { setErr("Say why it's being uncertified."); return; }
    run(() => api.uncertifyAfp(a.id, reason.trim()));
  }
  /** Certify at what was claimed, approve and push, in one click — by you. */
  function fastTrack() {
    if (!confirm(`Fast-track certify ${a.supplier_name ?? "this claim"} #${a.app_number}?\n\nIt's certified and approved by you at ${money(net)} (what was claimed), skipping the days, budget and rate checks, then pushed to Xero as a draft bill.`)) return;
    run(() => api.xeroFastTrackAfp(a.id));
  }
  async function run(f: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await f(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "That didn't work"); }
    finally { setBusy(false); }
  }
  const row = (k: string, v: React.ReactNode) => (
    <div className="row" style={{ gap: 12, fontSize: 13, padding: "4px 0" }}>
      <span className="muted" style={{ width: 150 }}>{k}</span><span>{v}</span>
    </div>
  );
  return (
    <div className="a-card a-pad" style={{ display: "grid", gap: 14 }}>
      <div className="row" style={{ alignItems: "center", gap: 10 }}>
        <div>
          <div className="eyebrow">Labour certificate · {a.project_code}</div>
          <h2 style={{ margin: "2px 0 0" }}>{a.supplier_name || "Unassigned subcontractor"} — #{a.app_number}</h2>
        </div>
        <span style={{ flex: 1 }} />
        <Link className="btn ghost tiny" to={`/applications/${a.id}?from=accounts`}>Open certificate</Link>
      </div>
      {err && <div className="flash error">{err}</div>}
      <div>
        {row("Project", `${a.project_code} ${a.project_name}`)}
        {row("Period ending", a.period_end ?? "—")}
        {row(a.certified_at ? "Certified (net)" : "Claimed (net)", <>
          <b>{money(billedNet(a))}</b>
          {a.unmatched_value > 0 && <span className="muted"> — {money(a.unmatched_value)} of it not on a line yet</span>}
        </>)}
        {noBudget && row("Note", `${a.project_code} ${a.project_name} has no labour budget — the bill's lines are carried at what they billed.`)}
        {a.cis_rate != null && a.cis_rate > 0 && row("CIS", `${a.cis_rate}% — for information; Xero takes the deduction`)}
        {a.submitted_at && row("Submitted", a.submitted_at.slice(0, 10))}
        {a.certified_at && row("Certified", a.certified_by === "xero"
          ? `matched to its Xero bill on ${a.certified_at.slice(0, 10)}`
          : `${a.certified_by ?? "—"} on ${a.certified_at.slice(0, 10)}`)}
        {/* An approval from Accounts fills in the commit with the same stamp;
            only a separate, earlier commit is worth a line of its own. */}
        {a.pay_approved_at && a.pay_approved_at !== a.pay_released_at && row("Committed", `${a.pay_approved_by ?? "—"} on ${a.pay_approved_at.slice(0, 10)}${a.pay_approval_note ? ` — "${a.pay_approval_note}"` : ""}`)}
        {a.pay_released_at && row("Approved", `${a.pay_released_by ?? "—"} on ${a.pay_released_at.slice(0, 10)}`)}
        {isCertInXero(a) && row("Xero", `Bill ${a.xero_po_number ?? ""}${a.status === "paid" ? " — paid" : " — owed"}${keyedByHand || a.certified_by === "xero" ? " (keyed in by hand)" : ""}`)}
        {a.source_file_name && row("Invoice", a.source_file_name)}
      </div>
      {stage === "inbox" && a.status === "draft" && (
        <div style={{ display: "grid", gap: 8 }}>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            Some of its lines didn't match the labour budget, or it has no subcontractor yet. Sort them on the
            certificate — it's sent for certifying as soon as the last one is done.
          </div>
          {canEdit && (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {noBudget && a.unmatched_value > 0 && (
                <button className="accent" disabled={busy} onClick={() => run(() => api.carryAfpAsBilled(a.id))}
                  title="Put every line on at what the bill says — this job has no labour budget to match them to">
                  Carry as billed ({money(a.unmatched_value)})
                </button>
              )}
              <Link className={`btn ${noBudget && a.unmatched_value > 0 ? "ghost" : "accent"}`} to={`/applications/${a.id}?from=accounts`}>Open to review</Link>
            </div>
          )}
        </div>
      )}
      {stage === "inbox" && a.status !== "draft" && (
        <div style={{ display: "grid", gap: 8 }}>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            Waiting to be certified. Certify it on the certificate — it then moves to Awaiting approval.
          </div>
          {canEdit && (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <Link className="btn accent" to={`/applications/${a.id}?from=accounts`}>Open to certify</Link>
              <button className="ghost" disabled={busy} onClick={fastTrack}
                title="Certify at the claimed value, approve and push to Xero in one go">Fast-track certify</button>
            </div>
          )}
        </div>
      )}
      {stage === "held" && (canRelease
        ? <div style={{ display: "grid", gap: 8, maxWidth: 520 }}>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
            <button className="accent" style={{ justifySelf: "start" }} disabled={busy}
              onClick={() => run(() => api.releaseAfpPayment(a.id, note))}>Approve</button>
          </div>
        : <div className="muted" style={{ fontSize: 12 }}>Waiting on an approver. Once approved it moves to Ready to push.</div>)}
      {stage === "ready" && canEdit && (
        <button className="accent" style={{ justifySelf: "start" }} disabled={busy}
          onClick={() => run(() => api.xeroPushAfp(a.id))}>
          {a.xero_sync_status === "failed" ? "Retry Xero push" : "Push to Xero"}
        </button>
      )}
      {(stage === "held" || stage === "ready") && a.status === "certified" && canEdit && (
        <button className="ghost tiny" style={{ justifySelf: "start" }} disabled={busy} onClick={uncertify}
          title="Take it back to submitted so it can be certified again">
          Uncertify
        </button>
      )}
      {(stage === "held" || stage === "ready") && canEdit && (
        <button className="ghost tiny" style={{ justifySelf: "start" }} disabled={busy} onClick={alreadyInXero}
          title="It was keyed into Xero by hand — record that instead of pushing a second bill">
          Already in Xero
        </button>
      )}
      <AfpHistory afpId={a.id} version={`${a.status}|${a.certified_at}|${a.pay_released_at}|${a.xero_po_id}`} />
      <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
        Pushes as a draft bill at the full value with the subcontractor's invoice attached; Xero takes any CIS deduction.
        Don't key labour bills into Xero by hand — they'd be paid twice. The push refuses an invoice
        number the subcontractor already has a bill for.
      </div>
    </div>
  );
}

/** The values flagged on an invoice, in the colours they are flagged in.
 *
 *  Invoice number and PO number lead, and keep the two strongest colours:
 *  together they are what decides whether this bill belongs to the order it is
 *  about to be paid against. The supplier's own reference sits with them
 *  because on drop-shipped goods it is the only reference either document
 *  shares. */
const INVOICE_FIELDS = [
  { key: "invoice_number", label: "Invoice number", color: "#ee5d2b" },
  { key: "po_number", label: "PO reference", color: "#4353b0" },
  { key: "supplier_order_ref", label: "Supplier ref (SIR)", color: "#7a4bb8" },
  { key: "invoice_date", label: "Invoice date", color: "#b06a0e" },
  { key: "due_date", label: "Due date", color: "#b06a0e" },
  { key: "net_amount", label: "Net", color: "#2f6f4f" },
  { key: "vat_amount", label: "VAT", color: "#2f6f4f" },
  { key: "gross_amount", label: "Gross", color: "#2f6f4f" },
] as const;

function invoiceFieldValue(inv: Invoice, key: (typeof INVOICE_FIELDS)[number]["key"]): string | null {
  const v = key === "invoice_number" ? inv.invoice_number
    : key === "po_number" ? inv.extracted_po_ref
    : key === "supplier_order_ref" ? inv.supplier_order_ref
    : key === "invoice_date" ? inv.invoice_date
    : key === "due_date" ? inv.due_date
    : key === "net_amount" ? inv.net_amount
    : key === "vat_amount" ? inv.vat_amount
    : inv.gross_amount;
  return v == null || v === "" ? null : String(v);
}

/** The corroborated boxes for this invoice, ready to draw. */
function invoiceDrawnRegions(inv: Invoice): DrawnRegion[] {
  return INVOICE_FIELDS.flatMap((f) => {
    const box = inv.regions?.[f.key];
    const value = invoiceFieldValue(inv, f.key);
    return box && value ? [{ key: f.key, label: f.label, color: f.color, value, box }] : [];
  });
}

/** Where the two references that decide this invoice's fate were read from.
 *
 *  A PDF with a text layer gets its highlights drawn straight onto the document
 *  and needs nothing here. A photograph or a scan has no text layer, and used
 *  to get nothing at all — the figures appeared beside a picture with no way to
 *  tell where they came from. These are the patches of paper behind the two
 *  numbers that matter, so the reading can be checked against the document
 *  rather than taken on trust. */
function InvoicePickups({ inv, dims }: { inv: Invoice; dims: { w: number; h: number } | null }) {
  const url = api.invoiceFileUrl(inv.id);
  const shown = INVOICE_FIELDS.filter((f) => f.key === "invoice_number" || f.key === "po_number" || f.key === "supplier_order_ref");
  const rows = shown.map((f) => ({ ...f, value: invoiceFieldValue(inv, f.key), box: inv.regions?.[f.key] ?? null }));
  if (!rows.some((r) => r.value)) return null;
  return (
    <div style={{ display: "grid", gap: 7, padding: "10px 12px", borderTop: "1px solid var(--line)" }}>
      {rows.map((r) => (
        <div key={r.key} style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="eyebrow" style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, flex: "0 0 auto" }} />
              {r.label}
            </div>
            <div className="num" style={!r.value ? { color: "var(--muted)" } : undefined}>
              {r.value ?? (r.key === "po_number" ? "none quoted" : "—")}
            </div>
            {r.value && !r.box && (
              <div className="muted" style={{ fontSize: 11 }}>couldn&rsquo;t be pinpointed on the document — check it against the invoice</div>
            )}
          </div>
          {r.value && r.box && <FieldCrop url={url} box={r.box} dims={dims} />}
        </div>
      ))}
    </div>
  );
}

/** The invoice document — a framed viewer (PDF in an iframe, images as a scalable
 *  img) with an Expand → fullscreen lightbox, plus Open / Download links. */
function InvoiceViewer({ inv }: { inv: Invoice }) {
  const isPdf = (inv.file_type ?? "").includes("pdf") || (inv.file_name ?? "").toLowerCase().endsWith(".pdf");
  // A workbook can't be shown inline — it gets a card pointing at Open/Download.
  const isSheet = !isPdf && isSpreadsheetFile(inv.file_name, inv.file_type);
  const fileUrl = api.invoiceFileUrl(inv.id);
  const [z, setZ] = useState(1);
  const [lb, setLb] = useState(false);
  const [lbZoom, setLbZoom] = useState(false);
  const [hl, setHl] = useState(true);
  // Natural pixel size of the document image, so each crop keeps its own
  // proportions instead of stretching the text it is showing.
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);
  // Boxes the reader could corroborate on a file with no text layer.
  const drawn = invoiceDrawnRegions(inv);
  // The picked-up fields, colour-coded — drawn over wherever they appear on the
  // document so the extraction is visibly grounded in the paper.
  const targets = [
    ...(inv.invoice_number ? [{ value: inv.invoice_number, color: "#ee5d2b", label: "Invoice number" }] : []),
    ...(inv.extracted_po_ref ? [{ value: inv.extracted_po_ref, color: "#4353b0", label: "PO reference" }] : []),
    ...(inv.supplier_order_ref ? [{ value: inv.supplier_order_ref, color: "#7a4bb8", label: "Supplier ref (SIR)" }] : []),
    ...(inv.invoice_date ? [{ value: inv.invoice_date, color: "#b06a0e", label: "Invoice date" }] : []),
    ...(inv.due_date ? [{ value: inv.due_date, color: "#b06a0e", label: "Due date" }] : []),
    ...(inv.net_amount != null ? [{ value: String(inv.net_amount), color: "#2f6f4f", label: "Net" }] : []),
    ...(inv.vat_amount != null ? [{ value: String(inv.vat_amount), color: "#2f6f4f", label: "VAT" }] : []),
    ...(inv.gross_amount != null ? [{ value: String(inv.gross_amount), color: "#2f6f4f", label: "Gross" }] : []),
  ];
  useEffect(() => {
    if (!lb) return;
    setLbZoom(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLb(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lb]);
  const label = inv.file_name ? (inv.file_name.length > 24 ? inv.file_name.slice(0, 24) + "…" : inv.file_name) : (isPdf ? "PDF" : isSheet ? "Spreadsheet" : "Image");
  return (
    <div className="col-view">
      <div className="vtoolbar">
        <span className="vbtn" style={{ cursor: "default", color: "#fff", opacity: 0.85 }}>{label}</span>
        <span className="vspacer" />
        {!isPdf && !isSheet && (
          <>
            <button className="vbtn" title="Zoom out" onClick={() => setZ((v) => Math.max(0.5, +(v - 0.15).toFixed(2)))}>−</button>
            <button className="vbtn" title="Zoom in" onClick={() => setZ((v) => Math.min(3, +(v + 0.15).toFixed(2)))}>＋</button>
          </>
        )}
        {(isPdf || drawn.length > 0) && (
          <button className="vbtn" onClick={() => setHl((v) => !v)}
            title="Show where each picked-up field sits on the document"
            style={hl ? { background: "rgba(238,93,43,.45)" } : undefined}>◈ Highlights</button>
        )}
        <a className="vbtn" href={fileUrl} target="_blank" rel="noreferrer" title="Open in a new tab">Open</a>
        <a className="vbtn" href={`${fileUrl}?download=1`} title={inv.file_name ? `Download ${inv.file_name}` : "Download"}>Download</a>
        {!isSheet && <button className="vbtn" onClick={() => setLb(true)} title="Expand to full screen">⤢ Expand</button>}
      </div>
      <div className="vport">
        {isSheet
          ? <div style={{ padding: "34px 20px", textAlign: "center", color: "var(--muted)", fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ fontSize: 15, color: "var(--fg)", marginBottom: 6 }}>{inv.file_name ?? "Spreadsheet"}</div>
              <div>A spreadsheet can't be shown here — use <strong>Open</strong> or <strong>Download</strong> to see the workbook.
                The figures alongside were read from it.</div>
            </div>
          : isPdf
          ? <div onClick={() => setLb(true)} title="Click to expand" style={{ cursor: "zoom-in", width: "100%" }}>
              <PdfHighlightViewer url={fileUrl} targets={targets} showHighlights={hl} />
            </div>
          : <span style={{ position: "relative", display: "inline-block", transform: `scale(${z})`, transformOrigin: "top center" }}>
              <img alt="invoice" className="vimg" src={fileUrl} onClick={() => setLb(true)} title="Click to expand"
                onLoad={(e) => setImgDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                style={{ cursor: "zoom-in", display: "block" }} />
              {hl && <RegionBoxes regions={drawn} />}
            </span>}
      </div>
      {/* A text-layer PDF already shows where everything came from, drawn on
          the document itself. A photo or a scan can't, so the two references
          that decide where this invoice belongs get shown against the paper
          they were read from. */}
      {!isPdf && !isSheet && <InvoicePickups inv={inv} dims={imgDims} />}
      {inv.extract_error && <div className="flash" style={{ margin: "10px 12px", background: "var(--warn-soft)", color: "var(--warn)", fontSize: 12 }}>
        {isRetryableExtractError(inv.extract_error)
          ? "The AI couldn't read this one — the reader was refused or busy, not the document. The app tries again every hour; Re-read tries now, or enter the figures by hand."
          : "Couldn't auto-read this one — enter the figures by hand."}
      </div>}

      {lb && (
        <div className="acctx-lb" onClick={(e) => { if (e.target === e.currentTarget) setLb(false); }}>
          <div className="lb-bar">
            <div className="ti">{inv.supplier_name || "Invoice"} <span style={{ opacity: 0.6, fontWeight: 400, marginLeft: 8 }}>{inv.invoice_number ?? ""}</span></div>
            <span className="sp" />
            <a className="lb-vbtn" href={fileUrl} target="_blank" rel="noreferrer">Open ↗</a>
            <button className="lb-vbtn" onClick={() => setLb(false)}>Close ✕</button>
          </div>
          <div className="lb-stage" onClick={(e) => { if (e.target === e.currentTarget) setLb(false); }}>
            {/* Expanding used to drop the highlights: the inline view drew them
                and the full-screen view, which is where anybody actually reads
                the small print, went back to a plain frame. Both draw them. */}
            {isPdf
              ? <div className="lb-frame" style={{ overflow: "auto", background: "var(--card-2)" }}>
                  <PdfHighlightViewer url={fileUrl} targets={targets} showHighlights={hl} />
                </div>
              : <span style={{ position: "relative", display: "inline-block" }}>
                <img alt="invoice-full" className="lb-img" src={fileUrl}
                  onClick={() => setLbZoom((v) => !v)}
                  title={lbZoom ? "Click to fit the screen" : "Click to zoom to full size"}
                  style={lbZoom
                    ? { maxHeight: "none", maxWidth: "none", width: "auto", cursor: "zoom-out", display: "block" }
                    : { maxHeight: "calc(100vh - 110px)", width: "auto", objectFit: "contain", cursor: "zoom-in", display: "block" }} />
                {hl && <RegionBoxes regions={drawn} />}
              </span>}
          </div>
        </div>
      )}
    </div>
  );
}

function InvoiceDetail({ inv, projects, accounts, isAdmin, canEdit, canRelease, busy, onPatch, onPush, onRelease, onReload, onReread, onDismiss, onUndismiss, suppliers, onSendToLabour }: {
  inv: Invoice; projects: Project[]; accounts: Array<{ code: string; name: string; type: string }>;
  isAdmin: boolean; canEdit: boolean; canRelease: boolean; busy: boolean;
  onPatch: (b: Parameters<typeof api.updateInvoice>[1]) => void; onPush: () => void; onRelease: (note?: string) => void;
  onReload: () => void | Promise<void>; onReread: () => void; onDismiss: () => void; onUndismiss: () => void;
  suppliers: Supplier[];
  onSendToLabour: (input: { project_id: string; counterparty_supplier_id: number | null; period_end: string }) => Promise<string | null>;
}) {
  const [f, setF] = useState({
    supplier_name: inv.supplier_name ?? "", invoice_number: inv.invoice_number ?? "",
    invoice_date: inv.invoice_date ?? "", due_date: inv.due_date ?? "",
    net_amount: inv.net_amount?.toString() ?? "", vat_amount: inv.vat_amount?.toString() ?? "", gross_amount: inv.gross_amount?.toString() ?? "",
  });
  const lines: Array<{ description: string; amount: number | null }> = (() => { try { return inv.lines_json ? JSON.parse(inv.lines_json) : []; } catch { return []; } })();
  const purchaseAccounts = accounts.filter((a) => /EXPENSE|OVERHEAD|DIRECTCOSTS|CURRLIAB/i.test(a.type) || a.type === "");
  const pushed = inv.status === "pushed";
  const dismissed = inv.status === "dismissed";
  const [labourOpen, setLabourOpen] = useState(false);
  // Kept apart from `f` on purpose: neither of these shapes the Xero bill, so
  // both survive the push lock below and get their own Save.
  const [ref, setRef] = useState(inv.supplier_order_ref ?? "");
  const [localNotes, setLocalNotes] = useState(inv.notes ?? "");
  const isProject = inv.kind === "project";
  const pushBlockedForApproval = isProject && !inv.approved_at;
  const held = isAwaitingApproval(inv);
  const released = !!inv.released_at;
  const disabled = pushed || !canEdit;
  const initial = (inv.supplier_name || inv.matched_supplier_name || "?").trim().charAt(0) || "?";

  function saveHeader() {
    onPatch({
      supplier_name: f.supplier_name.trim() || null, invoice_number: f.invoice_number.trim() || null,
      invoice_date: f.invoice_date || null, due_date: f.due_date || null,
      net_amount: f.net_amount === "" ? null : Number(f.net_amount),
      vat_amount: f.vat_amount === "" ? null : Number(f.vat_amount),
      gross_amount: f.gross_amount === "" ? null : Number(f.gross_amount),
    });
  }

  return (
    <>
      {/* invoice card */}
      <div className="a-card">
        <div className="a-pad" style={{ paddingBottom: 14 }}>
          <div className="dhead">
            <div className="avatar">{initial}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1>{inv.supplier_name || "Invoice"}</h1>
              <div className="sub">
                {inv.invoice_number ? `Invoice ${inv.invoice_number} · ` : ""}
                {inv.source === "email" ? `received ${(inv.received_at ?? "").slice(0, 10)}${inv.sender_email ? ` · from ${inv.sender_email}` : ""}` : "uploaded"}
              </div>
            </div>
            {!inv.extract_error && <span className="aichip">✦ Read by AI</span>}
            {pushed && <span className="pill approved">Pushed → Xero {inv.xero_bill_number ?? ""}</span>}
            {inv.kind === "overhead" && <span className="pill">Overhead</span>}
          </div>
        </div>

        <div className="dsplit">
          <InvoiceViewer inv={inv} />

          <div className="col-fields">
            {/* A foreign-currency invoice must be SEEN as such before it's
                approved: the figures aren't sterling, and the Xero bill will be
                raised in this currency. Sterling needs no announcement. */}
            {/* Nothing on this invoice names an order of ours. Said here, at the
                top, because everything below it — the coding, the match, the
                approval — rests on knowing which order the money belongs to,
                and 182 of 231 invoices got all the way through without it. */}
            {wantsOurPoRef(inv) && (
              <div className="flash" style={{ background: "var(--danger-soft, var(--warn-soft))", color: "var(--danger)", marginBottom: 10, fontSize: 12.5, lineHeight: 1.45 }}>
                <b>{poRefState(inv) === "none" ? "No PO reference on this invoice." : `“${inv.extracted_po_ref}” is not one of our PO references.`}</b>{" "}
                Ours look like <b>PO-26003-0040</b>.{" "}
                {inv.supplier_order_ref
                  ? <>That reference is the supplier&rsquo;s own ({inv.supplier_order_ref}) — quote it when requesting that ours appears on the next invoice.</>
                  : <>Ask the supplier to quote our PO reference, and check the order below is really the one these goods belong to.</>}
              </div>
            )}
            {inv.currency && inv.currency.toUpperCase() !== "GBP" && (
              <div className="flash" style={{ background: "var(--warn-soft)", color: "var(--warn)", marginBottom: 10, fontSize: 12.5, lineHeight: 1.4 }}>
                <b>{inv.currency.toUpperCase()} invoice</b> — the amounts below are in {inv.currency.toUpperCase()}, not sterling, and it will go to Xero as a {inv.currency.toUpperCase()} bill.
                Check the currency printed on the document matches before approving.
              </div>
            )}
            <div className="fgrid">
              <div className="field full"><label>Supplier</label><input value={f.supplier_name} disabled={disabled} onChange={(e) => setF({ ...f, supplier_name: e.target.value })} />
                {!inv.supplier_id && !!(f.supplier_name || "").trim() && !disabled && (
                  <button className="ghost tiny" style={{ marginTop: 4, justifySelf: "start" }}
                    title="Adds this supplier to the approved register — with the address, VAT number, payment terms, contact and bank details read off the invoice — and links it here"
                    onClick={async () => {
                      try { const s = await api.createSupplierFromInvoice(inv.id, f.supplier_name.trim()); await onPatch({ supplier_id: s.id }); }
                      catch (e) { alert(e instanceof Error ? e.message : "couldn't add the supplier"); }
                    }}>+ Add to approved suppliers</button>
                )}</div>
              <div className="field"><label>Invoice #</label><input value={f.invoice_number} disabled={disabled} onChange={(e) => setF({ ...f, invoice_number: e.target.value })} /></div>
              <div className="field"><label>Order ref / PO</label>
                <div className="ro" style={poRefState(inv) === "theirs" ? { color: "var(--danger)" } : undefined}>{inv.extracted_po_ref || "—"}</div>
                {poRefState(inv) === "theirs" && <span className="muted" style={{ fontSize: 11, color: "var(--danger)" }}>not one of our PO references</span>}
              </div>
              <div className="field"><label>Invoice date</label><input type="date" value={f.invoice_date} disabled={disabled} onChange={(e) => setF({ ...f, invoice_date: e.target.value })} /></div>
              <div className="field"><label>Due date</label><input type="date" value={f.due_date} disabled={disabled} onChange={(e) => setF({ ...f, due_date: e.target.value })} />
                {inv.terms_mismatch && (
                  <div style={{ fontSize: 11.5, color: "var(--warn)", marginTop: 3, lineHeight: 1.35 }}
                    title="The account terms outrank the date printed on the invoice — the cash flow uses the account-terms date">
                    ⚠ Account is <b>{inv.supplier_payment_terms}</b> ⇒ due {inv.expected_due_date} — the invoice says {inv.due_date?.slice(0, 10)}. Query it with the supplier.
                  </div>
                )}</div>
              <div className="field money"><label>Net {curSymbol(inv.currency)}</label><input type="number" step="0.01" value={f.net_amount} disabled={disabled} onChange={(e) => setF({ ...f, net_amount: e.target.value })} /></div>
              <div className="field money"><label>VAT {curSymbol(inv.currency)}</label><input type="number" step="0.01" value={f.vat_amount} disabled={disabled} onChange={(e) => setF({ ...f, vat_amount: e.target.value })} /></div>
              <div className="field money full"><label>Gross {curSymbol(inv.currency)}</label><input type="number" step="0.01" value={f.gross_amount} disabled={disabled} onChange={(e) => setF({ ...f, gross_amount: e.target.value })} /></div>
            </div>
            {!disabled && <div style={{ marginTop: 10 }}><span onClick={saveHeader} style={{ fontSize: 12.5, fontWeight: 600, color: "var(--accent)", cursor: busy ? "default" : "pointer" }}>Save details</span></div>}

            {/* The supplier's own reference and our internal notes. Neither
                reaches Xero and neither is printed anywhere the supplier sees,
                so both stay editable after the bill has gone across — which is
                when they are usually filled in. Where a delivery note never
                turned up, the supplier's order number is often the only thing
                tying the invoice to the order it belongs to. */}
            <div style={{ height: 1, background: "var(--line)", margin: "14px 0" }} />
            <div className="fgrid">
              <div className="field full">
                <label title="The supplier's own sales-order number, as printed on their paperwork — Alumasc call theirs an SOR">
                  Supplier order ref
                </label>
                <input value={ref} disabled={!canEdit} placeholder="e.g. SOR 456694"
                  onChange={(e) => setRef(e.target.value)} />
              </div>
              <div className="field full">
                <label title="Ours. Never pushed to Xero, never shown to the supplier">
                  Internal notes <span className="pill neutral" style={{ fontSize: 9.5, marginLeft: 4, verticalAlign: "middle" }}>not on the bill</span>
                </label>
                <textarea rows={3} value={localNotes} disabled={!canEdit}
                  placeholder="Why this is coded the way it is, who confirmed it, what is still outstanding…"
                  onChange={(e) => setLocalNotes(e.target.value)} />
              </div>
            </div>
            {canEdit && (ref !== (inv.supplier_order_ref ?? "") || localNotes !== (inv.notes ?? "")) && (
              <div style={{ marginTop: 10 }}>
                <span onClick={() => onPatch({ supplier_order_ref: ref.trim() || null, notes: localNotes.trim() || null })}
                  style={{ fontSize: 12.5, fontWeight: 600, color: "var(--accent)", cursor: busy ? "default" : "pointer" }}>
                  Save reference &amp; notes
                </span>
              </div>
            )}

            <div style={{ height: 1, background: "var(--line)", margin: "14px 0" }} />

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
              <span className="eyebrow" style={{ margin: 0 }}>Code to</span>
              <div className="seg">
                <button className={`seg-btn${inv.kind === "project" ? " active" : ""}`} disabled={disabled} onClick={() => onPatch({ kind: "project" })}>Project</button>
                <button className={`seg-btn${inv.kind === "overhead" ? " active" : ""}`} disabled={disabled || !isAdmin} onClick={() => onPatch({ kind: "overhead" })} title={isAdmin ? "" : "Overheads are admin-only"}>Overhead</button>
              </div>
            </div>
            {inv.kind === "project" && (
              <select className="a-sel" value={inv.project_id ?? ""} disabled={disabled} onChange={(e) => onPatch({ project_id: e.target.value || null })}>
                <option value="">— pick project —</option>
                {projects.filter((p) => !p.is_sandbox).map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
              </select>
            )}
            {inv.kind === "overhead" && isAdmin && (
              <select className="a-sel" value={inv.nominal_code ?? ""} disabled={pushed} onChange={(e) => onPatch({ nominal_code: e.target.value || null })}>
                <option value="">— pick nominal / account —</option>
                {purchaseAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
              </select>
            )}

            {inv.xero_sync_error && <div className="flash error" style={{ fontSize: 12, marginTop: 8 }}>Last Xero push failed: {inv.xero_sync_error}</div>}
            {!pushed && canEdit && (
              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                {/* Approved: posting the bill is Accounts' job, and this is
                    where they do it. The worker refuses an unapproved push, so
                    the button only exists once the decision has been made. */}
                {released && (
                  <button className="accent" disabled={busy} onClick={onPush}
                    title={inv.xero_sync_error ? `Last attempt failed: ${inv.xero_sync_error}` : "Send this approved invoice to Xero as a draft bill"}>
                    {inv.xero_sync_status === "failed" ? "Retry Xero push" : "Push to Xero"}
                  </button>
                )}
                {/* Overheads are approved here: they render no match panel, so
                    the button project invoices get alongside their match has
                    nowhere else to live. */}
                {!released && held && canRelease && inv.kind === "overhead" && (
                  <button className="accent" disabled={busy} onClick={() => onRelease()}
                    title="Approves this overhead. Accounts then pushes it to Xero.">Approve</button>
                )}
                <button className="ghost" disabled={busy} onClick={onReread} title="Re-read the invoice document (e.g. to pick up the PO number it quotes)">Re-read</button>
                {/* One or the other: offering "Dismiss" on something already
                    dismissed is what made the tab look like a dead end. */}
                {/* A subbie's own application arrives here looking like a
                    supplier bill. Only the labour side deducts CIS, so it has
                    to be handed over rather than coded and pushed. */}
                {!dismissed && inv.labour_afp_id == null && (
                  <button className="ghost" disabled={busy} onClick={() => setLabourOpen(true)}
                    title="This is a subcontractor's application, not a supplier bill — send it to the labour pipeline, which deducts CIS">
                    Send to labour
                  </button>
                )}
                {dismissed
                  ? <>
                      <button className="ghost" disabled={busy} onClick={onUndismiss}
                        title={inv.labour_afp_id != null
                          ? "Bring this back into the review queue. Refused while its application is still live."
                          : "Undo the dismissal and put this back in the review queue"}>Restore</button>
                      {inv.labour_afp_id != null &&
                        <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>Sent to labour as application #{inv.labour_afp_id}.</span>}
                    </>
                  : <button className="ghost" disabled={busy} onClick={onDismiss}>Dismiss</button>}
              </div>
            )}
            {!pushed && canEdit && pushBlockedForApproval &&
              <p className="muted" style={{ fontSize: 11.5, marginTop: 9, lineHeight: 1.5 }}>Committing this invoice below sends it for approval. It doesn’t go to Xero until an approver has approved it and Accounts pushes it.</p>}
            {!pushed && held && !canRelease &&
              <p className="muted" style={{ fontSize: 11.5, marginTop: 9, lineHeight: 1.5 }}>Waiting on approval. Once approved it moves to <b>Ready to push</b> and can be sent to Xero from here.</p>}
          </div>
        </div>
      </div>

      {/* 3-way match (project) or extracted-lines fallback */}
      {isProject && inv.project_id
        ? <MatchPanel inv={inv} canEdit={canEdit} canRelease={canRelease} busy={busy} onRelease={onRelease} onReload={onReload} />
        : lines.length > 0 && (
          <div className="a-card a-pad">
            <div className="eyebrow" style={{ marginBottom: 8 }}>Extracted lines ({lines.length})</div>
            <table><tbody>
              {lines.map((l, i) => (<tr key={i}><td>{l.description}</td><td className="num">{money(l.amount)}</td></tr>))}
            </tbody></table>
          </div>
        )}

      {labourOpen && (
        <SendToLabourModal inv={inv} projects={projects} suppliers={suppliers} busy={busy}
          onCancel={() => setLabourOpen(false)}
          onConfirm={async (input) => {
            // Stays open on a refusal, so the reason is read where it was asked.
            const failed = await onSendToLabour(input);
            if (!failed) setLabourOpen(false);
            return failed;
          }} />
      )}
    </>
  );
}

/** Confirming a hand-over to labour. The AfP needs three things the invoice
 *  can nearly always answer for itself — which project, which subcontractor and
 *  which period it covers — so this prefills all three and asks for a nod
 *  rather than presenting an empty form. */
function SendToLabourModal({ inv, projects, suppliers, busy, onCancel, onConfirm }: {
  inv: Invoice; projects: Project[]; suppliers: Supplier[]; busy: boolean;
  onCancel: () => void;
  onConfirm: (input: { project_id: string; counterparty_supplier_id: number | null; period_end: string }) => Promise<string | null>;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [projectId, setProjectId] = useState(inv.project_id ?? "");
  const [supplierId, setSupplierId] = useState<string>(inv.supplier_id != null ? String(inv.supplier_id) : "");
  // The period this labour covers. The invoice date is the closest thing the
  // document gives us — the works rows themselves aren't parsed until the
  // labour side reads the file.
  const [periodEnd, setPeriodEnd] = useState(inv.invoice_date ?? "");
  const supplier = suppliers.find((x) => String(x.id) === supplierId);
  const cisLabel = !supplier ? null
    : supplier.cis_rate == null ? "no CIS rate set on this supplier"
    : supplier.cis_rate === 0 ? "CIS 0% (gross payment status)"
    : `CIS ${supplier.cis_rate}%`;
  const ready = !!projectId && /^\d{4}-\d{2}-\d{2}$/.test(periodEnd);
  return (
    <div className="rd-pick-scrim" onClick={() => !busy && onCancel()}>
      <div className="a-labour-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rd-pick-hd">
          <div>
            <strong>Send to labour</strong>
            <div className="muted" style={{ fontSize: 12 }}>
              {inv.supplier_name || "This invoice"}{inv.invoice_number ? ` · ${inv.invoice_number}` : ""} · {money(inv.gross_amount, inv.currency)}
            </div>
          </div>
        </div>
        <div style={{ padding: "14px 18px", display: "grid", gap: 12 }}>
          <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: 0 }}>
            The stored document is read again by the labour pipeline and becomes a draft application for payment.
            This invoice leaves the Accounts queue — it isn't deleted, and nothing is pushed to Xero from here.
          </p>
          <div className="field">
            <label htmlFor="stl-project">Project</label>
            <select id="stl-project" className="a-sel" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">— pick the project —</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="stl-supplier">Subcontractor</label>
            <select id="stl-supplier" className="a-sel" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">— not set —</option>
              {suppliers.map((x) => <option key={x.id} value={String(x.id)}>{x.name}</option>)}
            </select>
            {/* The deduction is only as right as this record: a subbie with no
                rate set is paid gross, which is the wrong answer quietly. */}
            {cisLabel && <span className="muted" style={{ fontSize: 11.5 }}>{cisLabel}</span>}
          </div>
          <div className="field">
            <label htmlFor="stl-period">Period end</label>
            <input id="stl-period" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </div>
          {err && <div className="flash error" style={{ margin: 0 }}>{err}</div>}
        </div>
        <div className="rd-pick-hd" style={{ borderBottom: 0, borderTop: "1px solid var(--line)", justifyContent: "flex-end" }}>
          <button className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="accent" disabled={busy || !ready}
            title={ready ? "" : "Pick a project and a period end first"}
            onClick={async () => { setErr(null); setErr(await onConfirm({ project_id: projectId, counterparty_supplier_id: supplierId ? Number(supplierId) : null, period_end: periodEnd })); }}>
            Send to labour
          </button>
        </div>
      </div>
    </div>
  );
}

/** Flag metadata: friendly label + tone for the 3-way match variances. */
const MATCH_FLAG: Record<string, { label: string; danger?: boolean }> = {
  no_po_line:     { label: "No PO line" },
  not_delivered:  { label: "Not yet delivered", danger: true },
  price_variance: { label: "Price differs" },
  total_variance: { label: "Total differs" },
  over_qty:       { label: "Over ordered qty" },
};
function flagChip(f: string) {
  const meta = MATCH_FLAG[f] ?? { label: f };
  const color = meta.danger ? "var(--danger)" : "var(--warn)";
  return <span key={f} className="pill" style={{ fontSize: 10, background: "transparent", border: `1px solid ${color}`, color, marginRight: 4 }}>{meta.label}</span>;
}

/**
 * 3-way match panel — reconciles a project invoice against its PO and the
 * deliveries logged for it, with a value reconciliation summary + confidence.
 * Variances are flagged but don't block: approving despite a flag needs a
 * written reason (stored on the invoice and shown on the pushed bill's audit).
 */
function MatchPanel({ inv, canEdit, canRelease, busy, onRelease, onReload }: {
  inv: Invoice; canEdit: boolean; canRelease: boolean; busy: boolean;
  onRelease: (note?: string) => void; onReload: () => void | Promise<void>;
}) {
  const [m, setM] = useState<InvoiceMatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState(inv.approval_note ?? "");
  const [ticketLb, setTicketLb] = useState<string | null>(null);
  const [ticketLbZoom, setTicketLbZoom] = useState(false);
  const [saving, setSaving] = useState(false);
  // Off by default: an order received and billed in full drops out of the
  // picker (it's kept for the invoice's OWN quoted ref and its current match
  // regardless — see computeInvoiceMatch). A credit note or a late carriage
  // charge against a finished order is rare enough to be one click away
  // rather than clutter the other 90% of invoices that are matching a
  // perfectly ordinary open order.
  const [includeClosed, setIncludeClosed] = useState(false);
  // Bumped by the retry in the failed-match state, to re-run the fetch below.
  const [reloadKey, setReloadKey] = useState(0);

  const pushed = inv.status === "pushed";
  const approved = !!inv.approved_at;
  const held = isAwaitingApproval(inv);
  const [releaseNote, setReleaseNote] = useState("");
  const locked = pushed || approved || !canEdit;
  /**
   * Which PO an invoice bills against is a different question from whether the
   * bill has gone to Xero, and `locked` was answering both.
   *
   * A wrong PO link is almost always found AFTER the push — the 24 Sep Alumasc
   * audit on Dallas Road found a dozen invoices sitting on the wrong order, and
   * every one of them was pushed and approved, so the app offered no way to
   * correct a single one. The link is ours: it drives committed cost and the
   * delivery burn-down, and the Xero bill carries the coding, not this. Moving
   * it diverges nothing, and `/match` has never refused it server-side — only
   * this panel did.
   *
   * Scope is the match and nothing else. Logging a receipt stays behind
   * `locked`: manufacturing delivery evidence on a booked invoice is the exact
   * thing the audit was unpicking, and no amount of "it's only a correction"
   * makes that the same kind of act.
   */
  const matchLocked = !canEdit;

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    api.invoiceMatch(inv.id, { includeClosed })
      .then((r) => { if (alive) setM(r); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "match failed"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [inv.id, inv.matched_po_id, includeClosed, reloadKey]);

  const status = m?.match_status ?? "unmatched";
  const noteRequired = status !== "ok";
  const matchedCount = m ? m.lines.filter((l) => l.po_line_id).length : 0;
  const total = m ? m.lines.length : 0;

  // Every live PO is pickable, bucketed best-guess-first (see computeInvoiceMatch).
  // Grouped + type-to-filter rather than a flat select: the right PO is often on a
  // sibling job to the one the invoice is coded to, so the list is long by design
  // and has to be searchable by PO number, supplier or project code.
  const poGroups = useMemo<ComboGroup[]>(() => {
    if (!m) return [];
    const sug = m.suggested ?? [];
    const label = (po_number: string, supplier: string | null) => `${po_number}${supplier ? ` · ${supplier}` : ""}`;
    // Where the order stands rides on the option itself. An order can take
    // several delivery notes and several invoices, so "PO-26003-0038 · Fixfast"
    // on its own gave the reader no way to tell an order that still has
    // everything outstanding from one that has been received and paid for.
    const toOpt = (s: (typeof sug)[number]): ComboOption => ({
      value: s.id,
      label: label(s.po_number, s.supplier),
      hint: [
        s.project_code,
        s.hits ? `${s.hits} item${s.hits > 1 ? "s" : ""} match` : "",
        s.delivery
          ? poStatusHint(
            { state: s.delivery, lines_delivered: s.lines_delivered ?? 0, lines_started: s.lines_started ?? 0, lines_total: s.lines_total ?? 0, drops: s.drops ?? 0 },
            s.billed,
          )
          : "",
      ].filter(Boolean).join(" · "),
    });
    const out: ComboGroup[] = [];
    // Belt-and-braces: a stored match always stays visible even if it somehow
    // falls outside the candidate pool (e.g. its project was since archived).
    if (m.matched_po && !sug.some((s) => s.id === m.matched_po!.id)) {
      out.push({ label: "Current match", options: [{ value: m.matched_po.id, label: label(m.matched_po.po_number, m.matched_po.supplier), hint: m.matched_po.project_code }] });
    }
    const buckets = [
      ["quoted", "Quoted on the invoice"],
      ["likely", "Likely matches"],
      ["project", "On this invoice's project"],
      ["other", "All other purchase orders"],
    ] as const;
    for (const [g, heading] of buckets) {
      const inBucket = sug.filter((s) => (s.group ?? "other") === g);
      // The catch-all bucket is the whole book, and it is where "all of the POs
      // are shown" actually bites. Finished orders already sort last inside it
      // server-side; giving them their own heading turns that invisible
      // boundary into something you can see and scroll past. The ranked buckets
      // above keep their own order — a finished order can still be the right
      // answer for a credit, and there the status hint is enough.
      if (g === "other") {
        const live = inBucket.filter((s) => !s.closed).map(toOpt);
        const done = inBucket.filter((s) => s.closed).map(toOpt);
        if (live.length) out.push({ label: heading, options: live });
        if (done.length) out.push({ label: "Finished — received and billed in full", options: done });
        continue;
      }
      const options = inBucket.map(toOpt);
      if (options.length) out.push({ label: heading, options });
    }
    if (out.length) out.push({ label: "Clear", options: [{ value: "", label: "— No PO —" }] });
    return out;
  }, [m]);
  const poCount = (m?.suggested ?? []).length;

  async function choosePo(poId: string) {
    setSaving(true); setErr(null);
    try {
      await api.saveInvoiceMatch(inv.id, { po_id: poId || null, line_po_ids: [] });
      await onReload();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't change PO"); }
    finally { setSaving(false); }
  }

  async function setLinePo(idx: number, poLineId: number | null) {
    if (!m?.matched_po) return;
    const ids = m.lines.map((l) => l.po_line_id);
    ids[idx] = poLineId;
    setSaving(true); setErr(null);
    try {
      await api.saveInvoiceMatch(inv.id, { po_id: m.matched_po.id, line_po_ids: ids });
      setM(await api.invoiceMatch(inv.id));
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't set the PO line"); }
    finally { setSaving(false); }
  }

  async function approve() {
    setSaving(true); setErr(null);
    try {
      if (m?.matched_po) await api.saveInvoiceMatch(inv.id, { po_id: m.matched_po.id, line_po_ids: m.lines.map((l) => l.po_line_id) });
      await api.approveInvoice(inv.id, note);
      await onReload();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't approve"); }
    finally { setSaving(false); }
  }

  /** Point an orphaned receipt at a line that exists, or leave it be. No suggested
   *  target: a receipt reading "19 packs of Kingspan Therma TT44" and a line called
   *  "CTF/SCHEME/1 Tapered Insulation Scheme" may or may not be the same material,
   *  and only whoever took the delivery knows. The app shows the evidence. */
  async function repointReceipt(deliveryId: number, poLineId: string) {
    setSaving(true); setErr(null);
    try {
      await api.opsReassignDelivery(deliveryId, { po_line_id: poLineId });
      setM(await api.invoiceMatch(inv.id));
      await onReload();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't re-point the receipt"); }
    finally { setSaving(false); }
  }

  async function unapprove() {
    setSaving(true); setErr(null);
    try { await api.unapproveInvoice(inv.id); await onReload(); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't unapprove"); }
    finally { setSaving(false); }
  }

  // Identity problems with the linked order itself: it isn't the one the invoice
  // prints, or it belongs to another job. Held separately because they outrank
  // the line detail — lines reconciling against the wrong order proves nothing,
  // so this must not be allowed to read "Matched ✓".
  const poIdentityIssues = (inv.match?.issues ?? []).filter(
    (i) => i.kind === "wrong_po" || i.kind === "cross_project" || i.kind === "po_too_small",
  );

  // "No PO match" strictly means NO purchase order could be associated; once a
  // PO is in play but lines/flags need attention, it's a review state.
  const statusPill = poIdentityIssues.length
    ? <span className="pill" style={{ background: "transparent", border: "1px solid var(--danger)", color: "var(--danger)" }}>Wrong PO?</span>
    : status === "ok"
    ? <span className="pill approved">Matched ✓</span>
    : <span className="pill" style={{ background: "transparent", border: "1px solid var(--warn)", color: "var(--warn)" }}>
        {status === "no_po" || status === "unmatched" ? "No PO match" : status === "partial" ? "Needs review — lines unlinked" : "Needs review"}
      </span>;

  // Value reconciliation + confidence (value-weighted share of the invoice that's
  // linked to a PO line). Delivered/ordered value drive the "not yet received".
  const invNet = inv.net_amount ?? (m ? m.lines.reduce((s, l) => s + (l.amount ?? 0), 0) : 0);
  const orderedVal = m ? m.lines.reduce((s, l) => s + (l.po_line_id ? (l.po_qty ?? 0) * (l.po_unit_cost ?? 0) : 0), 0) : 0;
  const deliveredVal = m ? m.lines.reduce((s, l) => s + (l.po_line_id ? (l.delivered_qty ?? 0) * (l.po_unit_cost ?? 0) : 0), 0) : 0;
  const notReceived = Math.max(0, orderedVal - deliveredVal);
  const billedTotal = m ? (m.lines.reduce((s, l) => s + (l.amount ?? 0), 0) || invNet) : 0;
  // Confidence used to measure only whether each line found SOME PO line, so an
  // invoice pointed at the wrong order with rate and quantity flags all over it
  // read 100%. Linkage is the weakest of the three things that have to be true.
  //
  // It now counts a line only when it links AND agrees on price and quantity.
  // Delivery flags are excluded deliberately: the Delivered (GRN) cell reports
  // that leg on its own, and with most orders carrying no site receipt at all,
  // folding it in would peg every invoice near zero and say nothing.
  const PRICE_QTY_FLAGS = ["no_po_line", "price_variance", "total_variance", "over_qty"];
  const lineReconciles = (l: InvoiceMatchLine) => !!l.po_line_id && !l.flags.some((f) => PRICE_QTY_FLAGS.includes(f));
  const reconcilingCount = m ? m.lines.filter(lineReconciles).length : 0;
  const flaggedCount = matchedCount - reconcilingCount;
  const reconcilingTotal = m ? m.lines.reduce((s, l) => s + (lineReconciles(l) ? (l.amount ?? 0) : 0), 0) : 0;

  // A link to the wrong order is not a percentage — every figure underneath is
  // measured against the wrong document, so there is no partial credit to give.
  const conf = poIdentityIssues.length ? 0
    : billedTotal > 0 ? Math.round((100 * reconcilingTotal) / billedTotal)
    : 0;
  const okFrac = poIdentityIssues.length ? 0 : total ? Math.round((100 * reconcilingCount) / total) : 0;

  return (
    <div className="a-card a-pad">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <span className="eyebrow" style={{ margin: 0 }}>3-way match — PO &amp; deliveries</span>
        {!loading && statusPill}
        {m?.po_ref && (m.po_ref.matched
          ? <span className="pill approved" style={{ fontSize: 10 }} title="Associated via the PO number printed on the invoice">via PO {m.po_ref.quoted}</span>
          : m.po_ref.framework
          // A framework IS live — you just bill against a call-off or a job order,
          // never the framework itself. Calling it "not a live order" sent people
          // looking for a deleted PO that was never missing.
          ? <span className="pill" style={{ fontSize: 10, background: "var(--navy-soft)", color: "var(--navy)" }} title={`${m.po_ref.quoted} is a framework agreement on job ${m.po_ref.framework_project ?? "?"} — invoices bill against a call-off or an order on that job, not the framework. Orders on that job are listed first below.`}>quotes framework {m.po_ref.quoted}</span>
          : m.po_ref.superseded && m.po_ref.successor
          // The number IS ours, it was just replaced — usually the same
          // afternoon, when a framework got re-priced. "Not a live order" made
          // people hunt for something that was never missing; the replacement
          // is what the reference is really pointing at.
          ? <span className="pill" style={{ fontSize: 10, background: "var(--navy-soft)", color: "var(--navy)" }} title={`${m.po_ref.quoted} was deleted${m.po_ref.superseded_at ? ` on ${new Date(m.po_ref.superseded_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""} and replaced by ${m.po_ref.successor}${m.po_ref.successor_type === "framework" ? ", a framework — bill against a call-off raised under it, not the framework itself" : ""}.`}>
              {m.po_ref.quoted} → superseded by {m.po_ref.successor}
            </span>
          : m.po_ref.superseded
          ? <span className="pill" style={{ fontSize: 10, background: "transparent", border: "1px solid var(--warn)", color: "var(--warn)" }} title={`${m.po_ref.quoted} is one of our numbers but was deleted, and nothing was raised to replace it. Pick the order this really bills against.`}>quotes {m.po_ref.quoted} · deleted, no replacement</span>
          : <span className="pill" style={{ fontSize: 10, background: "transparent", border: "1px solid var(--warn)", color: "var(--warn)" }} title="This reference is printed on the invoice but is not one of our PO references — it may never have been raised.">quotes {m.po_ref.quoted} · not one of our PO references</span>)}
      </div>

      {/* A match that fails to load used to render as nothing: the error state
          sat inside the `m` branch below, so the card kept its heading and lost
          its whole body — picker, line table and the button that raises a
          missing PO — with no hint that anything had gone wrong. That is how a
          D1 parameter overflow in computeInvoiceMatch read as "the Create PO
          button was removed" rather than as a broken screen. Say it plainly and
          offer the retry. */}
      {loading ? <div className="muted" style={{ fontSize: 12 }}>Checking the PO and deliveries…</div> : !m ? (
        <div className="flash error" style={{ fontSize: 12, lineHeight: 1.5 }}>
          Couldn't check this invoice against the order book{err ? <> — {err}</> : "."} The purchase-order
          picker and the rest of the match are unavailable until it loads, so nothing here can be approved yet.
          {" "}<button className="ghost tiny" onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>Try again</button>
        </div>
      ) : (
        <>
          {err && <div className="flash error" style={{ fontSize: 12, marginBottom: 10 }}>{err}</div>}

          {/* reconciliation summary */}
          <div className="recon">
            <div className="rcell"><div className="rl">Invoice net</div><div className="rv">{money(invNet)}</div><div className="rs">{total} line{total === 1 ? "" : "s"} billed</div></div>
            <div className="rcell"><div className="rl">PO value</div><div className="rv">{m.matched_po ? money(m.matched_po.total) : "—"}</div>
              {(() => {
                // Whole-order check: this invoice + everything already billed to
                // the PO, against the PO's total value (catches over-billing that
                // per-line checks miss on schemes).
                const billedToDate = (m.po_billed_other ?? 0) + invNet;
                const overPo = m.matched_po?.total != null && billedToDate > m.matched_po.total + 0.5;
                // A deposit invoice bills a fraction of the order and says so on
                // its face. "50% confidence" tells you nothing about that; what's
                // still to come does — another invoice for it is on its way.
                const toCome = m.matched_po?.total != null ? m.matched_po.total - billedToDate : 0;
                return (
                  <div className="rs" style={overPo ? { color: "var(--danger)", fontWeight: 600 } : undefined}>
                    {m.matched_po
                      ? `${m.matched_po.po_number} · ${money(billedToDate)} billed${
                          overPo ? " — over PO" : toCome > 0.5 ? ` · ${money(toCome)} still to come` : ""}`
                      : "—"}
                  </div>
                );
              })()}
            </div>
            {/* The supplier's own reference, followed into the delivery
                paperwork. For most invoices this is the only thread there is:
                they quote no order number of ours, so "did these goods arrive"
                has had no answer anywhere on this screen. Evidence, not a link
                — nothing here matches or approves anything, because the same
                reference has turned up under two different suppliers. */}
            {m.supplier_ref && (
              <div className="rcell">
                <div className="rl">Supplier ref</div>
                <div className="rv" style={{ fontSize: 15 }}>{m.supplier_ref.ref}</div>
                <div className="rs" style={m.supplier_ref.matches.length ? { color: "var(--success)", fontWeight: 600 } : { color: "var(--warn)", fontWeight: 600 }}>
                  {m.supplier_ref.matches.length
                    ? `on ${m.supplier_ref.matches.length} delivery ${m.supplier_ref.matches.length === 1 ? "record" : "records"}`
                    : "no delivery paperwork quotes it"}
                </div>
                {m.supplier_ref.matches.slice(0, 3).map((h) => (
                  <div key={`${h.kind}-${h.id}`} className="muted" style={{ fontSize: 11 }}>
                    {h.label}{h.date ? ` · ${h.date.slice(0, 10)}` : ""}
                  </div>
                ))}
                {m.supplier_ref.other_supplier_matches > 0 && (
                  <div style={{ fontSize: 11, color: "var(--warn)" }}
                    title="The same reference appears on another supplier's paperwork, so it is probably a delivery-address or account code rather than an order number">
                    also on {m.supplier_ref.other_supplier_matches} other supplier&rsquo;s record{m.supplier_ref.other_supplier_matches === 1 ? "" : "s"} — treat with care
                  </div>
                )}
              </div>
            )}
            <div className="rcell"><div className="rl">Delivered (GRN)</div><div className="rv">{money(deliveredVal)}</div>
              <div className="rs" style={notReceived > 0.5 ? { color: "var(--warn)", fontWeight: 600 } : undefined}>{notReceived > 0.5 ? `${money(notReceived)} not yet received` : "all received"}</div></div>
            <div className="rcell match"><div className="rl">Match confidence</div>
              <div className="conf">
                <div className="confbar"><i style={{ width: `${conf}%`, background: conf >= 80 ? "var(--success)" : conf >= 50 ? "var(--warn)" : "var(--danger)" }} /></div>
                <span className="pct" style={poIdentityIssues.length ? { color: "var(--danger)" } : undefined}>{conf}%</span>
              </div>
              <div className="rs" style={poIdentityIssues.length ? { color: "var(--danger)", fontWeight: 600 } : undefined}>
                {poIdentityIssues.length
                  ? "measured against the wrong order"
                  : <>{reconcilingCount} of {total} lines reconcile{flaggedCount > 0 ? ` · ${flaggedCount} flagged` : ""}</>}
              </div></div>
          </div>

          {/* The invoice list flags a wrong-PO link, but this is the screen with the
              picker that fixes it — a warning shown only where you can't act on it
              is half a warning. Sits directly above the selector. */}
          {inv.match?.issues.map((i, n) => i.kind === "wrong_po" ? (
            <div key={n} className="flash error" style={{ fontSize: 12, margin: "14px 0 0", lineHeight: 1.5 }}>
              This invoice prints <b>{i.quoted}</b>, but it's linked to <b>{i.linked}</b>. Check which order it
              really bills against — the line checks below mean nothing until that's right.
            </div>
          ) : i.kind === "cross_project" ? (
            <div key={n} className="flash error" style={{ fontSize: 12, margin: "14px 0 0", lineHeight: 1.5 }}>
              Coded to job <b>{i.invoice_project}</b>, but <b>{i.linked}</b> belongs to job <b>{i.po_project}</b>.
              Check the PO link — orders on this job are listed first.
            </div>
          ) : i.kind === "po_too_small" ? (
            <div key={n} className="flash error" style={{ fontSize: 12, margin: "14px 0 0", lineHeight: 1.5 }}>
              This invoice bills <b>{money(i.invoice_net)}</b> against <b>{i.linked}</b>, an order worth{" "}
              <b>{money(i.po_total)}</b> in total — {Math.round(i.invoice_net / i.po_total)}× its whole value.
              That isn't an overspend to explain, it's almost certainly the wrong order. Check what this
              really bills against before approving.
            </div>
          ) : null)}

          {/* matched PO */}
          <div style={{ display: "flex", gap: 10, alignItems: "center", margin: "14px 0 4px", flexWrap: "wrap" }}>
            {poGroups.length > 0
              ? <div style={{ flex: 1, minWidth: 240 }}>
                  <GroupedCombobox
                    groups={poGroups}
                    value={m.matched_po?.id ?? ""}
                    onChange={choosePo}
                    disabled={matchLocked || saving}
                    ariaLabel="Purchase order for this invoice"
                    placeholder="— select a purchase order —"
                    searchPlaceholder={`Search ${poCount} PO${poCount === 1 ? "" : "s"} by number, supplier or project…`}
                  />
                </div>
              : <span className="muted" style={{ fontSize: 12 }}>No purchase orders available</span>}
            {/* Say plainly that this stays open on a booked invoice, and why.
                Silence here would read as the push lock having been forgotten. */}
            {canEdit && locked && !matchLocked && (
              <span className="muted" style={{ fontSize: 11.5, flexBasis: "100%" }}
                title="The Xero bill carries the coding and the amounts; it does not carry this link">
                Still changeable after approval and push — the order link is ours, and moving it
                doesn't touch the bill in Xero. The change is recorded against the invoice.
              </span>
            )}
            {/* Provenance, not a verdict. This pill used to read "Matched" in green
                whenever a human had saved the link — which says nothing about
                whether the link is RIGHT, and sat green on invoices pointed at an
                order they don't even quote. Both neutral states now say only how
                the link was made; a suspect order gets its own red state. */}
            {(m.closed_omitted > 0 || includeClosed) && (
              <label className="muted" style={{ fontSize: 11.5, display: "flex", alignItems: "center", gap: 5, cursor: "pointer", whiteSpace: "nowrap" }}
                title="Orders received and billed in full are left out of the list above by default — this invoice's own quoted PO and its current match always stay reachable either way.">
                <input type="checkbox" checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)} />
                {includeClosed ? "Showing orders delivered & billed in full" : `${m.closed_omitted} order${m.closed_omitted === 1 ? "" : "s"} hidden — delivered & billed in full`}
              </label>
            )}
            {m.matched_po && (poIdentityIssues.length
              ? <span className="pill" style={{ fontSize: 10.5, background: "transparent", border: "1px solid var(--danger)", color: "var(--danger)" }}
                      title="The linked order isn't the one this invoice quotes, or belongs to another job">Check this order</span>
              : <span className="pill" style={{ fontSize: 10.5, background: "var(--navy-soft)", color: "var(--navy)" }}
                      title={m.matched_po.is_stored ? "Someone chose this order — not a statement that it reconciles" : "The app guessed this order from the invoice; nobody has confirmed it"}>
                  {m.matched_po.is_stored ? "Linked by hand" : "Auto-linked"}
                </span>)}
            {/* Available even when a PO is already matched: the match is often to
                the wrong order (a sibling job's PO, or the one the supplier
                quoted) and the covering PO was never raised. Replacing needs a
                confirm — it unlinks the current PO from this invoice. */}
            {canEdit && !locked && (
              <button className="ghost tiny" disabled={saving}
                title={m.matched_po
                  ? `Raise a new PO from this invoice's lines and match it here instead of ${m.matched_po.po_number}`
                  : "Raise a PO retrospectively from this invoice's lines (goes through the normal PO approval) so the 3-way match can complete"}
                onClick={async () => {
                  const replace = !!m.matched_po;
                  if (replace && !window.confirm(`Raise a new PO from this invoice's lines?\n\n${m.matched_po!.po_number} will be unlinked from this invoice (the order itself is left as it is).`)) return;
                  setSaving(true); setErr(null);
                  try { const r = await api.createPoFromInvoice(inv.id, { replace }); setErr(null); await onReload(); alert(`Raised ${r.po_number} (pending approval) and matched it to this invoice.`); }
                  catch (e) { setErr(e instanceof Error ? e.message : "couldn't create the PO"); }
                  finally { setSaving(false); }
                }}>{m.matched_po ? "+ Create PO from this invoice instead" : "+ Create PO from this invoice"}</button>
            )}
          </div>
          {m.matched_po && !m.matched_po.is_stored && (
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 11.5 }}>
              {/* Only claim the order ref produced this link when it actually
                  resolved to it. Printing "ref X → PO Y" for a ref that resolved
                  to nothing states a derivation that never happened, and reads as
                  corroboration precisely where there is none. */}
              {inv.extracted_po_ref && m.po_ref?.matched
                ? <>Matched on our order ref <b>{inv.extracted_po_ref}</b> → {m.matched_po.po_number}. Approve to lock in.</>
                : inv.extracted_po_ref
                ? <>Guessed from the supplier and item codes — <b>not</b> from the ref <b>{inv.extracted_po_ref}</b> printed on the invoice. Check it before approving.</>
                : "Guessed from the supplier and item codes — nobody has confirmed it. Check it before approving."}
            </p>
          )}

          {/* progress */}
          <div className="lineprog">
            <div className="track"><i className="ok" style={{ width: `${okFrac}%` }} /><i className="bad" style={{ width: `${100 - okFrac}%` }} /></div>
            {/* "matched" meant "found a PO line", which read as agreement. Say what
                actually holds: how many reconcile on price and quantity. */}
            <span className="lab">
              {poIdentityIssues.length
                ? `${total} line${total === 1 ? "" : "s"} — check the order first`
                : `${reconcilingCount} of ${total} lines reconcile`}
            </span>
          </div>

          {/* line table */}
          <div className="ltable">
            <div className="lrow-hd"><div>Invoice line</div><div className="r">Qty · billed / PO</div><div className="r">Rate · billed / PO</div><div className="r">Value · billed / PO</div><div className="r">Difference</div><div className="r">Del.</div><div className="r">Status</div></div>
            {m.lines.map((l, i) => {
              const shortDeliver = l.qty != null && (l.delivered_qty ?? 0) + 0.001 < l.qty;
              const rowCls = l.po_line_id ? (l.flags.length ? "warn" : "ok") : "none";
              return (
                <div className={`lrow ${rowCls}`} key={i}>
                  <div className="lname-cell">
                    <div className="lname">{l.description || "—"}</div>
                    {matchLocked ? (
                      l.po_line_item
                        ? <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>→ {l.po_line_item}</div>
                        : <div style={{ fontSize: 11, color: "var(--warn)", marginTop: 3 }}>→ not matched to a PO line</div>
                    ) : (m.po_lines && m.po_lines.length) ? (
                      <div className="lsel">
                        <select value={l.po_line_id ?? ""} disabled={saving} onChange={(e) => setLinePo(i, e.target.value ? Number(e.target.value) : null)} title="Which PO line this invoice line is billing against">
                          <option value="">— not matched —</option>
                          <option value={SERVICE_CHARGE_LINE_ID}>Service charge (no PO line)</option>
                          {/* Deposit invoices state the whole purchase then break the money
                              into instalments, and extraction reads that table as goods.
                              A payment term has nothing on the order to reconcile against. */}
                          <option value={PAYMENT_SCHEDULE_LINE_ID}>Payment schedule — deposit / balance</option>
                          {m.po_lines.map((pl) => (
                            <option key={pl.id} value={pl.id}>{pl.item.length > 44 ? pl.item.slice(0, 44) + "…" : pl.item}{pl.qty != null ? ` (${qtyFmt(pl.qty)}${pl.unit ? ` ${pl.unit}` : ""})` : ""}</option>
                          ))}
                        </select>
                      </div>
                    ) : l.po_line_item ? <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>→ {l.po_line_item}</div> : null}
                  </div>
                  {/* Both quantities, always — including once the invoice locks.
                      Showing money alone is what made an over-billing unreadable:
                      a matching rate, a value out by 20%, and no quantity either side. */}
                  <div className="r">
                    <span className="lval">{l.qty != null ? qtyFmt(l.qty) : "—"}</span>
                    <span className="lval sm" style={qtyDiffers(l) ? { color: "var(--danger)" } : undefined}
                          title={qtyDiffers(l) ? `Billed ${qtyFmt(l.qty)} against ${qtyFmt(l.po_qty)} ordered` : undefined}>
                      {l.po_qty != null ? `PO ${qtyFmt(l.po_qty)}${l.po_unit ? ` ${l.po_unit}` : ""}` : "no PO"}
                    </span>
                  </div>
                  <div className="r">
                    <span className="lval">{l.unit_price != null ? money(l.unit_price) : "—"}</span>
                    <span className="lval sm" style={l.flags.includes("price_variance") ? { color: "var(--warn)" } : undefined}>
                      {l.po_unit_cost != null ? `PO ${money(l.po_unit_cost)}` : "no PO"}
                    </span>
                  </div>
                  <div className="r">
                    <span className="lval">{l.invoice_line_total != null ? money(l.invoice_line_total) : l.amount != null ? money(l.amount) : "—"}</span>
                    <span className="lval sm" style={l.flags.includes("total_variance") ? { color: "var(--warn)" } : undefined}>
                      {l.po_line_total != null ? `PO ${money(l.po_line_total)}` : "no PO"}
                    </span>
                  </div>
                  <div className="r">
                    {(() => {
                      const bt = l.invoice_line_total ?? l.amount ?? null;
                      if (bt == null || l.po_line_total == null) return <span className="lval dim">—</span>;
                      const d = bt - l.po_line_total;
                      if (Math.abs(d) <= Math.max(1, l.po_line_total * 0.01)) return <span className="lval" style={{ color: "var(--success)" }}>±£0</span>;
                      const pct = l.po_line_total ? (d / l.po_line_total) * 100 : 0;
                      return (
                        <span className="lval" style={{ color: d > 0 ? "var(--danger)" : "var(--success)" }}
                          title={`Billed ${money(bt)} vs PO ${money(l.po_line_total)} (${d > 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%)`}>
                          {d > 0 ? "+" : "−"}{money(Math.abs(d))}
                        </span>
                      );
                    })()}
                  </div>
                  <div className="r">
                    {l.po_line_id && !NON_GOODS_LINE_IDS.includes(l.po_line_id)
                      ? <span className="lval" style={shortDeliver ? { color: "var(--danger)", cursor: "help" } : { color: "var(--success)", cursor: "help" }}
                          title={(m.deliveries ?? []).filter((dd) => dd.po_line_id === l.po_line_id)
                            .map((dd) => `${dd.received_qty ?? "?"}${dd.received_unit ? ` ${dd.received_unit}` : ""} received ${(dd.delivered_at ?? "").slice(0, 10)}`)
                            .join("\n") || "No deliveries logged against this line yet"}>
                          {qtyFmt(l.delivered_qty ?? 0)}
                        </span>
                      : <span className="lval dim">—</span>}
                  </div>
                  <div className="r">
                    {l.flags.length ? l.flags.map(flagChip) : <span className="pill" style={{ fontSize: 10.5, background: "var(--success-soft)", color: "var(--success)" }}>ok</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
            <span className="muted" style={{ fontSize: 11 }}>
              {matchedCount} of {total} line{total === 1 ? "" : "s"} linked to a PO line
              {flaggedCount > 0 ? `, ${flaggedCount} with price or quantity flags` : ""}.
            </span>
            {canEdit && !locked && m.matched_po && m.lines.some((l) => l.flags.includes("not_delivered")) && (
              <button className="ghost tiny" disabled={saving}
                title="No delivery ticket exists because the goods were collected from the supplier — logs a receipt against the PO's outstanding lines so the match can complete"
                onClick={async () => {
                  if (!window.confirm(`Log the outstanding goods on ${m.matched_po?.po_number} as collected/received?`)) return;
                  setSaving(true); setErr(null);
                  try { await api.markInvoiceCollected(inv.id); await onReload(); }
                  catch (e) { setErr(e instanceof Error ? e.message : "couldn't mark as collected"); }
                  finally { setSaving(false); }
                }}>Goods were collected — mark as received</button>
            )}
          </div>

          {/* the tickets behind the delivered leg */}
          {ticketLb && (
            <div className="acctx-lb" onClick={(e) => { if (e.target === e.currentTarget) setTicketLb(null); }}>
              <div className="lb-bar">
                <div className="ti">Delivery ticket <span style={{ opacity: 0.6, fontWeight: 400, marginLeft: 8 }}>{m.matched_po?.po_number ?? ""}</span></div>
                <span className="sp" />
                <a className="lb-vbtn" href={ticketLb} target="_blank" rel="noreferrer">Open ↗</a>
                <button className="lb-vbtn" onClick={() => setTicketLb(null)}>Close ✕</button>
              </div>
              <div className="lb-stage" onClick={(e) => { if (e.target === e.currentTarget) setTicketLb(null); }}>
                {/\.pdf(\?|$)/i.test(ticketLb)
                  ? <iframe title="delivery-ticket" className="lb-frame" src={ticketLb} />
                  : <img alt="delivery-ticket" className="lb-img" src={ticketLb}
                      onClick={() => setTicketLbZoom((v) => !v)}
                      title={ticketLbZoom ? "Click to fit the screen" : "Click to zoom to full size"}
                      style={ticketLbZoom
                        ? { maxHeight: "none", maxWidth: "none", width: "auto", cursor: "zoom-out" }
                        : { maxHeight: "calc(100vh - 110px)", width: "auto", objectFit: "contain", cursor: "zoom-in" }} />}
              </div>
            </div>
          )}
          {/* Receipts naming a line that no longer exists. They count toward nothing,
              which is how an invoice reads "not delivered" with signed tickets
              listed right below it. Shown with everything a person needs to decide
              — description, quantity, date, ticket — and nothing they don't. */}
          {(() => {
            const orphans = (m.deliveries ?? []).filter((d) => d.orphaned);
            if (!orphans.length) return null;
            const totalQty = orphans.reduce((t, d) => t + (d.received_qty ?? 0), 0);
            return (
              <div style={{ marginTop: 12, border: "1px solid var(--danger)", borderRadius: 10, padding: "10px 14px", background: "var(--card)" }}>
                <div className="eyebrow" style={{ marginBottom: 4, fontSize: 10.5, color: "var(--danger)" }}>
                  {orphans.length} receipt{orphans.length === 1 ? "" : "s"} not attached to a line on this order
                </div>
                <p className="muted" style={{ margin: "0 0 8px", fontSize: 11.5, lineHeight: 1.5 }}>
                  These were checked in on site — {totalQty ? `${qtyFmt(totalQty)} units in total, ` : ""}tickets and all — but the order line
                  each one named has since been replaced, so nothing counts them as delivered. Say which
                  current line each belongs to, if any. Leave it alone if the same goods were logged again later.
                </p>
                <div style={{ display: "grid", gap: 7 }}>
                  {orphans.map((d) => (
                    <div key={d.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5 }}>
                      <span className="muted" style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{(d.delivered_at ?? "").slice(0, 10)}</span>
                      <span style={{ flex: 1, minWidth: 170 }}>{d.description || "Delivery"}</span>
                      <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                        {d.received_qty != null ? `${qtyFmt(d.received_qty)}${d.received_unit ? ` ${d.received_unit}` : ""}` : "no qty recorded"}
                      </span>
                      {d.ticket_url && (
                        <button className="muted" style={{ fontSize: 12, whiteSpace: "nowrap", background: "none", border: "none", padding: 0, cursor: "pointer" }}
                          onClick={() => { setTicketLb(d.ticket_url); setTicketLbZoom(false); }} title="View the delivery ticket">📎 Ticket</button>
                      )}
                      {canEdit && !locked && (m.po_lines?.length ?? 0) > 0 && (
                        <select className="input" style={{ fontSize: 11.5, padding: "5px 8px", maxWidth: 260 }}
                          defaultValue="" disabled={saving}
                          onChange={(e) => { if (e.target.value) void repointReceipt(d.id, e.target.value); }}>
                          <option value="">— attach to a line… —</option>
                          {m.po_lines!.map((pl) => (
                            <option key={pl.id} value={String(pl.id)}>
                              {pl.item.length > 44 ? pl.item.slice(0, 44) + "…" : pl.item}
                              {pl.qty != null ? ` (${qtyFmt(pl.qty)}${pl.unit ? ` ${pl.unit}` : ""} ordered)` : ""}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {(m.deliveries ?? []).length > 0 && (
            <div style={{ marginTop: 12, border: "1px solid var(--line)", borderRadius: 10, padding: "10px 14px" }}>
              <div className="eyebrow" style={{ marginBottom: 6, fontSize: 10.5 }}>Deliveries on {m.matched_po?.po_number ?? "this order"}</div>
              <div style={{ display: "grid", gap: 5 }}>
                {(() => {
                  const groups = new Map<string, NonNullable<typeof m.deliveries>>();
                  for (const d of m.deliveries ?? []) {
                    const k = d.ticket_key || `row-${d.id}`;
                    if (!groups.has(k)) groups.set(k, []);
                    groups.get(k)!.push(d);
                  }
                  return [...groups.values()].map((g) => {
                    const d = g[0];
                    return (
                      <div key={d.id} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", fontSize: 12.5 }}>
                        <span className="muted" style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{(d.delivered_at ?? "").slice(0, 10)}</span>
                        <span style={{ flex: 1, minWidth: 180 }}>
                          {g.length > 1
                            ? <>{g.length} lines checked in together<span className="muted"> — {g.map((x) => [x.received_qty, x.received_unit].filter((v) => v != null && v !== "").join(" ")).filter(Boolean).join(", ")}</span></>
                            : (d.description || "Delivery")}
                        </span>
                        {g.length === 1 && d.received_qty != null && (
                          <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{d.received_qty}{d.received_unit ? ` ${d.received_unit}` : ""}</span>
                        )}
                        {d.ticket_url && (
                          <button className="muted" style={{ fontSize: 12, whiteSpace: "nowrap", background: "none", border: "none", padding: 0, cursor: "pointer" }}
                            onClick={() => { setTicketLb(d.ticket_url); setTicketLbZoom(false); }} title="View the delivery ticket">📎 View ticket</button>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          )}

          {/* approve */}
          {!pushed && (
            <div style={{ marginTop: 16, borderTop: "1px dashed var(--line)", paddingTop: 12 }}>
              {approved ? (
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span className={`pill ${held ? "navy" : "approved"}`}>{held ? "Awaiting approval" : "Approved"}</span>
                    <span className="muted" style={{ fontSize: 12 }}>committed by {inv.approved_by ?? "—"} on {(inv.approved_at ?? "").slice(0, 10)}{inv.approval_note ? ` — “${inv.approval_note}”` : ""}</span>
                    {canEdit && <button className="ghost tiny" disabled={saving} onClick={unapprove} style={{ marginLeft: "auto" }}
                      title={held ? "Pull this back out of the approval queue" : "Withdraw the commit and the approval it carries"}>
                      {held ? "Withdraw" : "Un-approve"}
                    </button>}
                  </div>
                  {/* Stage two. Shown only to a release approver — everyone else
                      sees the held pill above and has nothing to do here. */}
                  {held && canRelease && (
                    <div style={{ display: "grid", gap: 8, borderTop: "1px dashed var(--line)", paddingTop: 10 }}>
                      <label className="eyebrow" style={{ margin: 0 }}>Approve this invoice for payment</label>
                      <textarea value={releaseNote} onChange={(e) => setReleaseNote(e.target.value)} rows={2}
                        placeholder="Note (optional)" style={{ width: "100%", resize: "vertical" }} />
                      <button className="accent" style={{ justifySelf: "start", padding: "10px 20px" }} disabled={busy || saving}
                        onClick={() => onRelease(releaseNote)}
                        title="Approves the invoice. Accounts then pushes it to Xero.">Approve</button>
                      <p className="muted" style={{ fontSize: 11.5, margin: 0, lineHeight: 1.5 }}>
                        Approving is the decision, not the posting. Accounts sends it to Xero afterwards.
                      </p>
                    </div>
                  )}
                  {inv.released_at && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      Approved by {inv.released_by ?? "—"} on {(inv.released_at ?? "").slice(0, 10)}
                      {inv.release_note ? ` — “${inv.release_note}”` : ""}
                      {!pushed && " — ready for Accounts to push to Xero."}
                    </div>
                  )}
                </div>
              ) : canEdit ? (
                <div style={{ display: "grid", gap: 8 }}>
                  <label className="eyebrow" style={{ margin: 0 }}>{noteRequired ? "Reason for approving despite the flags (required)" : "Note (optional)"}</label>
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                    placeholder={noteRequired ? "e.g. part-delivery agreed with supplier; balance to follow. Price uplift approved by QS." : "Optional note"}
                    style={{ width: "100%", resize: "vertical" }} />
                  <button className="accent" style={{ justifySelf: "start", padding: "10px 20px" }} disabled={saving || (noteRequired && !note.trim())}
                    onClick={approve} title={noteRequired && !note.trim() ? "Add a reason to commit a flagged invoice" : "Sends this invoice for approval — it does not go to Xero yet"}>Commit for approval</button>
                  <p className="muted" style={{ fontSize: 11.5, margin: 0, lineHeight: 1.5 }}>
                    Committing confirms the match and the money and sends the invoice for approval. It doesn’t go to Xero — once an approver has approved it, it appears in <b>Ready to push</b> to be sent.
                  </p>
                </div>
              ) : <div className="muted" style={{ fontSize: 12 }}>Approval needs commercial edit rights.</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
