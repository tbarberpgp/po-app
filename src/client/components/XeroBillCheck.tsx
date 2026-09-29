import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { can } from "../../shared/permissions";
import { Topbar } from "./Shell";
import type { ReconcileRow, ReconcileSummary } from "../../shared/bill-reconcile";
import type { CurrentUser } from "../../shared/types";

// A read-only reconciliation. Nothing on this screen changes anything, in Xero
// or here — it reports a difference and leaves deciding what to do about it to
// the person reading it. The buttons are a supplier, a window and a refresh.

const MONTH_CHOICES = [3, 6, 12, 24, 36];
const EMPTY_SUMMARY: ReconcileSummary =
  { matched: 0, xero_only: 0, app_only: 0, amount_mismatches: 0, xero_only_total: 0 };

const money = (n: number | null | undefined, cur?: string | null) =>
  (n == null ? "—" : fmtMoney(n, (cur || "GBP").toUpperCase()));

/** The one-word verdict for a row, and the pill that carries it. */
function stateChip(r: ReconcileRow): { label: string; cls: string; title: string } {
  if (r.state === "xero_only") {
    return { label: "Xero only", cls: "pill danger", title: "In Xero, with no invoice record in the app." };
  }
  if (r.state === "app_only") {
    return { label: "App only", cls: "pill warn", title: "Logged in the app, with no matching bill in Xero." };
  }
  if (r.amount_delta != null) {
    return { label: "Totals differ", cls: "pill warn", title: "Both sides hold this bill, for different money." };
  }
  if (r.notes.length > 0) {
    return { label: "Matched, check", cls: "pill info", title: "Matched, with something worth reading underneath." };
  }
  return { label: "Matched", cls: "pill ok", title: "The same bill on both sides, for the same money." };
}

export function XeroBillCheck({ me }: { me: CurrentUser | null }) {
  const [params, setParams] = useSearchParams();
  const supplierParam = params.get("supplier") ?? "Alumasc";
  const monthsParam = Number(params.get("months")) || 12;

  // The box the person types in, kept apart from the supplier actually fetched
  // so a half-typed name doesn't fire a Xero call on every keystroke.
  const [term, setTerm] = useState(supplierParam);
  const [rows, setRows] = useState<ReconcileRow[]>([]);
  const [summary, setSummary] = useState<ReconcileSummary>(EMPTY_SUMMARY);
  const [contacts, setContacts] = useState<Array<{ id: string; name: string }>>([]);
  const [note, setNote] = useState<string | null>(null);
  const [since, setSince] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [onlyExceptions, setOnlyExceptions] = useState(true);

  useEffect(() => { setTerm(supplierParam); }, [supplierParam]);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    api.xeroBillCheck(supplierParam, monthsParam)
      .then((r) => {
        setRows(r.rows);
        setSummary(r.summary);
        setContacts(r.contacts);
        setNote(r.note ?? null);
        setSince(r.since);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Couldn't read the bills from Xero."))
      .finally(() => setLoading(false));
  }, [supplierParam, monthsParam]);

  useEffect(load, [load]);

  function apply(next: { supplier?: string; months?: number }) {
    const p = new URLSearchParams(params);
    if (next.supplier !== undefined) p.set("supplier", next.supplier.trim() || "Alumasc");
    if (next.months !== undefined) p.set("months", String(next.months));
    setParams(p, { replace: true });
  }

  const visible = useMemo(
    () => (onlyExceptions ? rows.filter((r) => r.state !== "matched" || r.notes.length > 0) : rows),
    [rows, onlyExceptions],
  );
  const exceptions = summary.xero_only + summary.app_only + summary.amount_mismatches;

  if (me && !can(me.role, "commercial.view")) {
    return (
      <>
        <Topbar crumbs="Accounts" title="Bills in Xero" />
        <main><div style={{ padding: 32 }}><div className="empty">You don't have access to this.</div></div></main>
      </>
    );
  }

  return (
    <>
      <Topbar
        crumbs={<Link to="/accounts">Accounts</Link>}
        title="Bills in Xero"
        actions={<button className="ghost" onClick={load} disabled={loading}>{loading ? "Reading…" : "Refresh"}</button>}
      />
      <main>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-hd" style={{ flexWrap: "wrap", gap: 10 }}>
            <h2 style={{ marginRight: 4 }}>Supplier</h2>
            <form
              style={{ display: "flex", alignItems: "center", gap: 8 }}
              onSubmit={(e) => { e.preventDefault(); apply({ supplier: term }); }}
            >
              <input
                className="input"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Supplier name, e.g. Alumasc"
                style={{ width: 240 }}
              />
              <select
                value={monthsParam}
                onChange={(e) => apply({ months: Number(e.target.value) })}
                style={{ width: 160 }}
              >
                {MONTH_CHOICES.map((m) => <option key={m} value={m}>Last {m} months</option>)}
              </select>
              <button className="btn ghost tiny" type="submit" disabled={loading}>Check</button>
            </form>
            <span style={{ flex: 1 }} />
            <label className="muted" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
              <input type="checkbox" checked={onlyExceptions} onChange={(e) => setOnlyExceptions(e.target.checked)} />
              Only show differences
            </label>
          </div>
          <div className="card-bd" style={{ paddingTop: 14 }}>
            <p className="muted" style={{ margin: 0 }}>
              Read-only. This reads bills back out of Xero and lines them up against the invoices logged
              here — it posts nothing and changes nothing on either side.
              {since && <> Bills and invoices dated on or after {fmtDate(since)}.</>}
              {contacts.length > 0 && (
                <> Matching Xero contacts: {contacts.map((ct) => ct.name).join(", ")}.</>
              )}
            </p>
          </div>
        </div>

        {err && <div className="flash error">{err}</div>}
        {note && !err && <div className="flash info">{note}</div>}

        <div className="card">
          <div className="card-hd" style={{ flexWrap: "wrap", gap: 10 }}>
            <h2>{supplierParam}</h2>
            <span className={`pill ${exceptions > 0 ? "warn" : "ok"}`}>
              {exceptions === 0 ? "Nothing to chase" : `${exceptions} to look at`}
            </span>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {summary.matched} matched · {summary.xero_only} in Xero only · {summary.app_only} in the app only
              {summary.amount_mismatches > 0 && ` · ${summary.amount_mismatches} with different totals`}
            </span>
            {summary.xero_only_total > 0 && (
              <span className="pill danger" title="Gross value of live bills in Xero that the app has no record of">
                {fmtMoney(summary.xero_only_total)} unaccounted
              </span>
            )}
          </div>

          {loading ? (
            <div style={{ padding: 32 }}><div className="empty">Reading Xero…</div></div>
          ) : visible.length === 0 ? (
            <div style={{ padding: 32 }}>
              <div className="empty">
                {rows.length === 0
                  ? `No bills or invoices for “${supplierParam}” in this window.`
                  : "Every bill lines up. Untick “Only show differences” to see them all."}
              </div>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ minWidth: 220 }}>Bill</th>
                  <th className="center">Date</th>
                  <th className="num">Xero</th>
                  <th className="num">App</th>
                  <th className="center">Xero status</th>
                  <th className="center">App status</th>
                  <th className="center">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => <Row key={r.key} r={r} />)}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}

function Row({ r }: { r: ReconcileRow }) {
  const chip = stateChip(r);
  // The supplier's own number is the one a person recognises: on a pushed bill
  // Xero keeps it in Reference, on a hand-keyed one in InvoiceNumber.
  const ref = r.app?.invoice_number || r.xero?.reference || r.xero?.number || "—";
  const date = r.xero?.date ?? r.app?.invoice_date ?? null;

  return (
    <tr>
      <td>
        <div style={{ fontWeight: 600 }}>{ref}</div>
        <div className="muted" style={{ fontSize: 12 }}>
          {r.xero?.contact_name || r.app?.supplier_name || ""}
          {r.app?.project_code && ` · ${r.app.project_code}`}
          {r.xero?.number && r.xero.number !== ref && ` · Xero ${r.xero.number}`}
        </div>
        {r.notes.map((n, i) => (
          <div key={i} className="muted" style={{ fontSize: 12, marginTop: 4 }}>{n}</div>
        ))}
      </td>
      <td className="center" style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{fmtDate(date) || "—"}</td>
      <td className="num" style={{ whiteSpace: "nowrap" }}>{money(r.xero?.total, r.xero?.currency)}</td>
      <td className="num" style={{ whiteSpace: "nowrap" }}>{money(r.app?.gross_amount, r.app?.currency)}</td>
      <td className="center">
        {r.xero ? <span className="pill neutral" style={{ fontSize: 10 }}>{(r.xero.status ?? "").toLowerCase() || "—"}</span> : <span className="muted">—</span>}
      </td>
      <td className="center">
        {r.app
          ? (
            // Straight through to the invoice in the Accounts workspace, which
            // is where anything about it actually gets done.
            <Link className="pill neutral" style={{ fontSize: 10 }} to={`/accounts?invoice=${r.app.id}`}>
              {r.app.status ?? "—"}
            </Link>
          )
          : r.po_number
            ? <span className="pill info" style={{ fontSize: 10 }} title="No invoice logged, but the bill quotes this order">{r.po_number}</span>
            : <span className="muted">—</span>}
      </td>
      <td className="center"><span className={chip.cls} style={{ fontSize: 10 }} title={chip.title}>{chip.label}</span></td>
    </tr>
  );
}
