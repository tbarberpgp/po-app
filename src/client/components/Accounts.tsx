import { useEffect, useMemo, useRef, useState } from "react";
import { PdfHighlightViewer } from "./PdfHighlightViewer";
import { GroupedCombobox, type ComboGroup, type ComboOption } from "./GroupedCombobox";
import { api, fmtMoney } from "../lib/api";
import { can } from "../../shared/permissions";
import { Topbar } from "./Shell";
import type { CurrentUser, Invoice, InvoiceMatch, InvoiceMatchLine, MatchSummary, Project } from "../../shared/types";

// Amounts render in the invoice's OWN currency — a $ or € invoice shown with a
// £ sign misreports what we owe. Falls back to sterling when unknown.
const money = (n: number | null | undefined, cur?: string | null) => (n == null ? "—" : fmtMoney(n, cur || "GBP"));
/** Symbol for the amount-field labels ("Net €"), so the figures being typed are
 *  unambiguous. Unknown codes show the code itself rather than a wrong symbol. */
const CUR_SYMBOL: Record<string, string> = { GBP: "£", EUR: "€", USD: "$", JPY: "¥", INR: "₹", CHF: "CHF", PLN: "zł" };
const curSymbol = (cur: string | null | undefined) => CUR_SYMBOL[(cur || "GBP").toUpperCase()] ?? (cur || "£");
const qtyFmt = (n: number | null | undefined) =>
  (n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));

type Tab = "inbox" | "overheads" | "pushed" | "dismissed";

/** Row status for the inbox dot/chip: approved-or-pushed → matched (green);
 *  coded but not yet approved → review (amber); uncoded → new (red). */
function rowStatus(inv: Invoice): "matched" | "review" | "none" {
  if (inv.approved_at || inv.status === "pushed") return "matched";
  if ((inv.kind === "project" && inv.project_id) || (inv.kind === "overhead" && inv.nominal_code)) return "review";
  return "none";
}
const ST_LABEL: Record<"matched" | "review" | "none", string> = { matched: "Approved", review: "Review", none: "New" };

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
  if (m.state === "no_po") return "No PO matched";
  // Worst first: a link to the wrong order makes the price and quantity detail
  // beneath it meaningless, so it has to be the thing the row says.
  const wrong = m.issues.find((i) => i.kind === "wrong_po");
  if (wrong?.kind === "wrong_po") return `Wrong PO \u00b7 invoice quotes ${wrong.quoted}`;
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
  if (m.state === "no_po") return "No purchase order is matched to this invoice.";
  const money = (n: number) => fmtMoney(n, cur || "GBP");
  return m.issues.map((i) => {
    if (i.kind === "wrong_po") return `The invoice quotes ${i.quoted}, but it's linked to ${i.linked}. Check which order this really bills against \u2014 the price and quantity checks below mean nothing until that's right.`;
    if (i.kind === "cross_project") return `Coded to job ${i.invoice_project}, but ${i.linked} belongs to job ${i.po_project}.`;
    if (i.kind === "unlinked") return `"${i.item}" isn't linked to any line on the PO \u2014 mark it as a service charge if that's what it is.`;
    if (i.kind === "rate") return `${i.item}: billed at ${money(i.billed)}, ordered at ${money(i.ordered)}.`;
    const head = `${i.item}: billed ${money(i.billed)} against ${money(i.ordered)} ordered, ${money(i.excess)} over`;
    if (i.why === "qty") return `${head} \u2014 more units at the agreed rate.`;
    if (i.why === "rate") return `${head} \u2014 same units, dearer rate.`;
    return `${head} \u2014 the invoice and the order use a different unit basis.`;
  }).join("\n");
}


/**
 * Accounts workpiece — a Dext-style two-pane inbox. Supplier invoices arrive via
 * invoices@ or manual upload, are read by Claude, then coded to a Project or
 * (admin-only) Overheads and pushed to Xero as a draft Bill after a 3-way match.
 */
export function Accounts({ me }: { me: CurrentUser | null }) {
  const isAdmin = can(me?.role, "approvers.manage");
  const canEdit = can(me?.role, "commercial.edit");
  const [tab, setTab] = useState<Tab>("inbox");
  const [rows, setRows] = useState<Invoice[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [accounts, setAccounts] = useState<Array<{ code: string; name: string; type: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function load() {
    api.listInvoices().then(setRows).catch((e) => setErr(e.message));
  }
  useEffect(() => {
    load();
    api.listProjects().then((r) => setProjects(r as unknown as Project[])).catch(() => {});
    if (isAdmin) api.xeroAccounts().then((r) => setAccounts(r.accounts ?? [])).catch(() => {});
  }, [isAdmin]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab === "overheads") { if (!(r.kind === "overhead" && r.status !== "dismissed")) return false; }
      else if (tab === "pushed") { if (r.status !== "pushed") return false; }
      else if (tab === "dismissed") { if (r.status !== "dismissed") return false; }
      else if (!(r.status === "inbox" || r.status === "ready")) return false; // inbox
      if (q) {
        const hay = `${r.supplier_name ?? ""} ${r.matched_supplier_name ?? ""} ${r.invoice_number ?? ""} ${r.project_code ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, tab, search]);

  const sel = rows.find((r) => r.id === selId) ?? null;
  const inboxCount = rows.filter((r) => r.status === "inbox" || r.status === "ready").length;

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

  async function push(id: number) {
    setBusy(true); setErr(null); setInfo(null);
    try {
      const r = await api.pushInvoiceXero(id);
      setInfo(`Pushed to Xero as draft bill ${r.xero_bill_number ?? ""}.`);
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : "Xero push failed"); }
    finally { setBusy(false); }
  }

  const TABS: Array<[Tab, string, number | null]> = [
    ["inbox", "Inbox", inboxCount],
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
              <div className="inbox-hd"><h2>{tabLabel}</h2><span className="count">{visible.length}</span></div>
              <div className="inbox-search">
                <input placeholder="Search supplier, invoice #…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <div className="ilist">
                {visible.length === 0
                  ? <div className="muted" style={{ padding: "18px 15px", fontSize: 13, lineHeight: 1.5 }}>Nothing here. Email an invoice to <b>invoices@pgpprojects.com</b> or upload one.</div>
                  : visible.map((r) => {
                    const st = r.status === "dismissed" ? "none" : rowStatus(r);
                    return (
                      <button key={r.id} className={`irow${selId === r.id ? " on" : ""}`} onClick={() => setSelId(r.id)}>
                        <span className={`idot ${st}`} />
                        <div style={{ minWidth: 0 }}>
                          <div className="isup">{r.supplier_name || r.matched_supplier_name || "Unknown supplier"}</div>
                          <div className="imeta">
                            <span>{r.invoice_number ? `#${r.invoice_number}` : "no #"} · {(r.invoice_date || (r.received_at ?? "")).slice(0, 10)}{r.kind === "overhead" ? " · Overhead" : ""}</span>
                            {r.kind !== "overhead" && r.project_code && <span className="proj">{r.project_code}</span>}
                            {r.source === "email" && <span title="received by email">✉</span>}
                            {r.extract_error && <span title="couldn't auto-read">⚠</span>}
                            {r.terms_mismatch && <span style={{ color: "var(--warn)" }} title={`Invoice due ${r.due_date ?? "?"} but the account is ${r.supplier_payment_terms ?? "on other terms"} ⇒ ${r.expected_due_date ?? "?"}`}>⚠ terms</span>}
                            {/* Stays on the row after approval — a mismatch that was
                                approved anyway still needs chasing with the supplier. */}
                            {r.match && r.match.state !== "matched" && (
                              <span style={{ color: "var(--danger)", fontWeight: 600 }} title={matchTitle(r.match, r.currency)}>
                                ⚠ {matchLabel(r.match, r.currency)}
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
              {!sel
                ? <div className="a-card a-pad"><div className="muted" style={{ fontSize: 13 }}>Select an invoice to review, code and push to Xero.</div></div>
                : <InvoiceDetail key={sel.id} inv={sel} projects={projects} accounts={accounts} isAdmin={isAdmin} canEdit={canEdit} busy={busy}
                    onPatch={(b) => patch(sel.id, b)} onPush={() => push(sel.id)} onReload={() => reloadOne(sel.id)} onReread={() => reread(sel.id)}
                    onDismiss={async () => { await api.dismissInvoice(sel.id); load(); setSelId(null); }} />}
            </section>
          </div>
        </div>
      </main>
    </>
  );
}

/** The invoice document — a framed viewer (PDF in an iframe, images as a scalable
 *  img) with an Expand → fullscreen lightbox, plus Open / Download links. */
function InvoiceViewer({ inv }: { inv: Invoice }) {
  const isPdf = (inv.file_type ?? "").includes("pdf") || (inv.file_name ?? "").toLowerCase().endsWith(".pdf");
  const fileUrl = api.invoiceFileUrl(inv.id);
  const [z, setZ] = useState(1);
  const [lb, setLb] = useState(false);
  const [lbZoom, setLbZoom] = useState(false);
  const [hl, setHl] = useState(true);
  // The picked-up fields, colour-coded — drawn over wherever they appear on the
  // document so the extraction is visibly grounded in the paper.
  const targets = [
    ...(inv.invoice_number ? [{ value: inv.invoice_number, color: "#ee5d2b", label: "Invoice number" }] : []),
    ...(inv.extracted_po_ref ? [{ value: inv.extracted_po_ref, color: "#4353b0", label: "PO reference" }] : []),
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
  const label = inv.file_name ? (inv.file_name.length > 24 ? inv.file_name.slice(0, 24) + "…" : inv.file_name) : (isPdf ? "PDF" : "Image");
  return (
    <div className="col-view">
      <div className="vtoolbar">
        <span className="vbtn" style={{ cursor: "default", color: "#fff", opacity: 0.85 }}>{label}</span>
        <span className="vspacer" />
        {!isPdf && (
          <>
            <button className="vbtn" title="Zoom out" onClick={() => setZ((v) => Math.max(0.5, +(v - 0.15).toFixed(2)))}>−</button>
            <button className="vbtn" title="Zoom in" onClick={() => setZ((v) => Math.min(3, +(v + 0.15).toFixed(2)))}>＋</button>
          </>
        )}
        {isPdf && (
          <button className="vbtn" onClick={() => setHl((v) => !v)}
            title="Show where each picked-up field sits on the document"
            style={hl ? { background: "rgba(238,93,43,.45)" } : undefined}>◈ Highlights</button>
        )}
        <a className="vbtn" href={fileUrl} target="_blank" rel="noreferrer" title="Open in a new tab">Open</a>
        <a className="vbtn" href={`${fileUrl}?download=1`} title={inv.file_name ? `Download ${inv.file_name}` : "Download"}>Download</a>
        <button className="vbtn" onClick={() => setLb(true)} title="Expand to full screen">⤢ Expand</button>
      </div>
      <div className="vport">
        {isPdf
          ? <div onClick={() => setLb(true)} title="Click to expand" style={{ cursor: "zoom-in", width: "100%" }}>
              <PdfHighlightViewer url={fileUrl} targets={targets} showHighlights={hl} />
            </div>
          : <img alt="invoice" className="vimg" src={fileUrl} onClick={() => setLb(true)} title="Click to expand"
              style={{ cursor: "zoom-in", transform: `scale(${z})`, transformOrigin: "top center" }} />}
      </div>
      {inv.extract_error && <div className="flash" style={{ margin: "10px 12px", background: "var(--warn-soft)", color: "var(--warn)", fontSize: 12 }}>Couldn't auto-read this one — enter the figures by hand.</div>}

      {lb && (
        <div className="acctx-lb" onClick={(e) => { if (e.target === e.currentTarget) setLb(false); }}>
          <div className="lb-bar">
            <div className="ti">{inv.supplier_name || "Invoice"} <span style={{ opacity: 0.6, fontWeight: 400, marginLeft: 8 }}>{inv.invoice_number ?? ""}</span></div>
            <span className="sp" />
            <a className="lb-vbtn" href={fileUrl} target="_blank" rel="noreferrer">Open ↗</a>
            <button className="lb-vbtn" onClick={() => setLb(false)}>Close ✕</button>
          </div>
          <div className="lb-stage" onClick={(e) => { if (e.target === e.currentTarget) setLb(false); }}>
            {isPdf
              ? <iframe title="invoice-full" className="lb-frame" src={fileUrl} />
              : <img alt="invoice-full" className="lb-img" src={fileUrl}
                  onClick={() => setLbZoom((v) => !v)}
                  title={lbZoom ? "Click to fit the screen" : "Click to zoom to full size"}
                  style={lbZoom
                    ? { maxHeight: "none", maxWidth: "none", width: "auto", cursor: "zoom-out" }
                    : { maxHeight: "calc(100vh - 110px)", width: "auto", objectFit: "contain", cursor: "zoom-in" }} />}
          </div>
        </div>
      )}
    </div>
  );
}

function InvoiceDetail({ inv, projects, accounts, isAdmin, canEdit, busy, onPatch, onPush, onReload, onReread, onDismiss }: {
  inv: Invoice; projects: Project[]; accounts: Array<{ code: string; name: string; type: string }>;
  isAdmin: boolean; canEdit: boolean; busy: boolean;
  onPatch: (b: Parameters<typeof api.updateInvoice>[1]) => void; onPush: () => void; onReload: () => void | Promise<void>; onReread: () => void; onDismiss: () => void;
}) {
  const [f, setF] = useState({
    supplier_name: inv.supplier_name ?? "", invoice_number: inv.invoice_number ?? "",
    invoice_date: inv.invoice_date ?? "", due_date: inv.due_date ?? "",
    net_amount: inv.net_amount?.toString() ?? "", vat_amount: inv.vat_amount?.toString() ?? "", gross_amount: inv.gross_amount?.toString() ?? "",
  });
  const lines: Array<{ description: string; amount: number | null }> = (() => { try { return inv.lines_json ? JSON.parse(inv.lines_json) : []; } catch { return []; } })();
  const purchaseAccounts = accounts.filter((a) => /EXPENSE|OVERHEAD|DIRECTCOSTS|CURRLIAB/i.test(a.type) || a.type === "");
  const pushed = inv.status === "pushed";
  const isProject = inv.kind === "project";
  const pushBlockedForApproval = isProject && !inv.approved_at;
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
              <div className="field"><label>Order ref / PO</label><div className="ro">{inv.extracted_po_ref || "—"}</div></div>
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
                {/* Project invoices go to Xero automatically when approved — the
                    push button only remains as the overheads path and as the
                    retry for an approval whose auto-push failed. */}
                {inv.kind === "overhead" && (
                  <button className="accent" disabled={busy} onClick={onPush}>Push to Xero (draft bill)</button>
                )}
                {inv.kind !== "overhead" && !!inv.approved_at && (
                  <button className="accent" disabled={busy} onClick={onPush} title="The approval didn't reach Xero — send it again">Retry Xero push</button>
                )}
                <button className="ghost" disabled={busy} onClick={onReread} title="Re-read the invoice document (e.g. to pick up the PO number it quotes)">Re-read</button>
                <button className="ghost" disabled={busy} onClick={onDismiss}>Dismiss</button>
              </div>
            )}
            {!pushed && canEdit && pushBlockedForApproval &&
              <p className="muted" style={{ fontSize: 11.5, marginTop: 9, lineHeight: 1.5 }}>Approving for payment below sends this invoice to Xero as a draft bill automatically.</p>}
          </div>
        </div>
      </div>

      {/* 3-way match (project) or extracted-lines fallback */}
      {isProject && inv.project_id
        ? <MatchPanel inv={inv} canEdit={canEdit} onReload={onReload} />
        : lines.length > 0 && (
          <div className="a-card a-pad">
            <div className="eyebrow" style={{ marginBottom: 8 }}>Extracted lines ({lines.length})</div>
            <table><tbody>
              {lines.map((l, i) => (<tr key={i}><td>{l.description}</td><td className="num">{money(l.amount)}</td></tr>))}
            </tbody></table>
          </div>
        )}
    </>
  );
}

/** Sentinel po_line_id for "explicitly a service/misc charge, not a product
 *  line" — mirrors SERVICE_CHARGE_LINE_ID in worker/routes/invoices.ts. */
const SERVICE_CHARGE_LINE_ID = -1;

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
function MatchPanel({ inv, canEdit, onReload }: { inv: Invoice; canEdit: boolean; onReload: () => void | Promise<void> }) {
  const [m, setM] = useState<InvoiceMatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState(inv.approval_note ?? "");
  const [ticketLb, setTicketLb] = useState<string | null>(null);
  const [ticketLbZoom, setTicketLbZoom] = useState(false);
  const [saving, setSaving] = useState(false);

  const pushed = inv.status === "pushed";
  const approved = !!inv.approved_at;
  const locked = pushed || approved || !canEdit;

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    api.invoiceMatch(inv.id)
      .then((r) => { if (alive) setM(r); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "match failed"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [inv.id, inv.matched_po_id]);

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
    const toOpt = (s: (typeof sug)[number]): ComboOption => ({
      value: s.id,
      label: label(s.po_number, s.supplier),
      hint: [s.project_code, s.hits ? `${s.hits} item${s.hits > 1 ? "s" : ""} match` : ""].filter(Boolean).join(" · "),
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
      const options = sug.filter((s) => (s.group ?? "other") === g).map(toOpt);
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
      const r = await api.approveInvoice(inv.id, note);
      if (r.pushed === false && r.xero_error) setErr(`Approved — but the Xero push failed: ${r.xero_error}. Fix and use "Push to Xero" to retry.`);
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
    (i) => i.kind === "wrong_po" || i.kind === "cross_project",
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
          : <span className="pill" style={{ fontSize: 10, background: "transparent", border: "1px solid var(--warn)", color: "var(--warn)" }} title="This PO number is printed on the invoice but isn't a live order — it may have been deleted or never raised.">quotes {m.po_ref.quoted} · not a live order</span>)}
      </div>

      {loading ? <div className="muted" style={{ fontSize: 12 }}>Checking the PO and deliveries…</div> : !m ? null : (
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
                return (
                  <div className="rs" style={overPo ? { color: "var(--danger)", fontWeight: 600 } : undefined}>
                    {m.matched_po ? `${m.matched_po.po_number} · ${money(billedToDate)} billed to date${overPo ? " — over PO" : ""}` : "—"}
                  </div>
                );
              })()}
            </div>
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
          ) : null)}

          {/* matched PO */}
          <div style={{ display: "flex", gap: 10, alignItems: "center", margin: "14px 0 4px", flexWrap: "wrap" }}>
            {poGroups.length > 0
              ? <div style={{ flex: 1, minWidth: 240 }}>
                  <GroupedCombobox
                    groups={poGroups}
                    value={m.matched_po?.id ?? ""}
                    onChange={choosePo}
                    disabled={locked || saving}
                    ariaLabel="Purchase order for this invoice"
                    placeholder="— select a purchase order —"
                    searchPlaceholder={`Search ${poCount} PO${poCount === 1 ? "" : "s"} by number, supplier or project…`}
                  />
                </div>
              : <span className="muted" style={{ fontSize: 12 }}>No purchase orders available</span>}
            {/* Provenance, not a verdict. This pill used to read "Matched" in green
                whenever a human had saved the link — which says nothing about
                whether the link is RIGHT, and sat green on invoices pointed at an
                order they don't even quote. Both neutral states now say only how
                the link was made; a suspect order gets its own red state. */}
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
                    {locked ? (
                      l.po_line_item
                        ? <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>→ {l.po_line_item}</div>
                        : <div style={{ fontSize: 11, color: "var(--warn)", marginTop: 3 }}>→ not matched to a PO line</div>
                    ) : (m.po_lines && m.po_lines.length) ? (
                      <div className="lsel">
                        <select value={l.po_line_id ?? ""} disabled={saving} onChange={(e) => setLinePo(i, e.target.value ? Number(e.target.value) : null)} title="Which PO line this invoice line is billing against">
                          <option value="">— not matched —</option>
                          <option value={SERVICE_CHARGE_LINE_ID}>Service charge (no PO line)</option>
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
                    {l.po_line_id && l.po_line_id !== SERVICE_CHARGE_LINE_ID
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
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="pill approved">Approved for payment</span>
                  <span className="muted" style={{ fontSize: 12 }}>by {inv.approved_by ?? "—"} on {(inv.approved_at ?? "").slice(0, 10)}{inv.approval_note ? ` — “${inv.approval_note}”` : ""}</span>
                  {canEdit && <button className="ghost tiny" disabled={saving} onClick={unapprove} style={{ marginLeft: "auto" }}>Un-approve</button>}
                </div>
              ) : canEdit ? (
                <div style={{ display: "grid", gap: 8 }}>
                  <label className="eyebrow" style={{ margin: 0 }}>{noteRequired ? "Reason for approving despite the flags (required)" : "Note (optional)"}</label>
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                    placeholder={noteRequired ? "e.g. part-delivery agreed with supplier; balance to follow. Price uplift approved by QS." : "Optional note"}
                    style={{ width: "100%", resize: "vertical" }} />
                  <button className="accent" style={{ justifySelf: "start", padding: "10px 20px" }} disabled={saving || (noteRequired && !note.trim())}
                    onClick={approve} title={noteRequired && !note.trim() ? "Add a reason to approve a flagged invoice" : "Approves the invoice and sends it to Xero as a draft bill"}>Approve &amp; send to Xero</button>
                </div>
              ) : <div className="muted" style={{ fontSize: 12 }}>Approval needs commercial edit rights.</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
