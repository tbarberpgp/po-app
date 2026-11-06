// Delivery arrival tracking — what's coming before it arrives.
//
//  • ArrivalTracker: Overdue / Due today / This week / To collect / No
//    confirmation, on the supplier's promised date where their order
//    acknowledgement (SOR) gave one, otherwise our required-by.
//  • SorInbox: every acknowledgement read from accounts@ › SOR and projects@,
//    matched to its PO or waiting for someone to pick one.
//  • PoDeliveryCard: the same facts on one PO, with the phoned-in date and the
//    "we collect this" switch for suppliers who never send an acknowledgement.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDate, fmtMoney } from "../lib/api";
import {
  bucketArrivals, daysBetween, effectiveDate, UNCONFIRMED_WINDOW_DAYS,
  type AckCheck, type ArrivalRow, type OrderAckView, type PoArrival,
} from "../../shared/order-acks";

const todayIso = () => new Date().toISOString().slice(0, 10);
const dayFmt = (d: string | null | undefined) => (d ? fmtDate(d) : "—");

function SourceTag({ r }: { r: ArrivalRow }) {
  const base = { fontSize: 11, fontWeight: 600, borderRadius: 999, padding: "1px 8px", whiteSpace: "nowrap" as const };
  if (r.promised_date && r.promised_source === "manual") {
    return <span style={{ ...base, background: "var(--navy-soft)", color: "var(--navy)" }} title={r.promised_note ?? undefined}>Promised · by phone</span>;
  }
  if (r.promised_date) {
    return <span style={{ ...base, background: "var(--success-soft)", color: "var(--success)" }}>Promised{r.promised_ref ? ` · ${r.promised_ref}` : ""}</span>;
  }
  if (r.required_date) {
    return <span style={{ ...base, background: "var(--card-2)", color: "var(--muted)", border: "1px solid var(--line)" }}>{r.collect_by_us ? "Collect by (ours)" : "Required by (ours)"}</span>;
  }
  return <span style={{ ...base, background: "var(--card-2)", color: "var(--muted)", border: "1px solid var(--line)" }}>No date</span>;
}

export type ArrivalFocus = "week" | "collect" | "confirm" | "overdue" | "allsor";

const flag = (bg: string, fg: string) => ({ fontSize: 10.5, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase" as const, borderRadius: 5, padding: "1px 6px", background: bg, color: fg, whiteSpace: "nowrap" as const });

function OrderRow({ r, today }: { r: ArrivalRow; today: string }) {
  const d = effectiveDate(r);
  const late = d ? daysBetween(d, today) : 0;
  const notSent = r.status === "pending_approval" ? "awaiting approval" : null;
  const slip = r.promised_date && r.required_date ? daysBetween(r.required_date, r.promised_date) : 0;
  const when = !d ? "no date"
    : late > 0 ? `${late} day${late === 1 ? "" : "s"} ${r.collect_by_us ? "overdue" : "late"}`
    : late === 0 ? (r.collect_by_us ? "collect today" : "today")
    : `in ${-late} day${late === -1 ? "" : "s"}`;
  return (
    <Link className="dl-due-row" to={`/pos/${r.id}`}>
      <div style={{ minWidth: 0 }}>
        <div className="isup" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {d === today && <span style={flag("var(--accent-soft)", "var(--accent-2)")}>Today</span>}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{r.supplier}</span> <SourceTag r={r} />
        </div>
        <div className="imeta">
          <span className="num">{r.po_number}</span>
          <span className="proj">{r.project_code}</span>
          {r.collect_by_us && r.collector ? <span>· {r.collector} collecting</span> : null}
          {notSent && <span>· {notSent}</span>}
          {slip > 0 && <span style={{ color: "var(--warn)", fontWeight: 600 }}>· {slip} day{slip === 1 ? "" : "s"} after our required-by</span>}
          {r.promised_note && r.promised_source !== "manual" && <span>· {r.promised_note}</span>}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div className={`dl-due-when${late > 0 && !notSent ? " late" : ""}`}>{when}</div>
        <div className="imeta" style={{ justifyContent: "flex-end" }}>
          <span>{dayFmt(d)}</span>
          <span>· {fmtMoney(r.total_value)}</span>
        </div>
      </div>
    </Link>
  );
}

/** The four lists, in the order people work them: what's coming this week,
 *  what we fetch ourselves, what still needs a date from the supplier, and
 *  what's late. */
export function ArrivalTracker({ rows, focus, onFocus, onSorChanged }: {
  rows: ArrivalRow[]; focus: ArrivalFocus; onFocus: (f: ArrivalFocus) => void; onSorChanged?: () => void;
}) {
  const today = todayIso();
  const b = useMemo(() => bucketArrivals(rows, today), [rows, today]);
  const week = useMemo(() => [...b.today, ...b.week], [b]);
  const [pendingSors, setPendingSors] = useState<OrderAckView[]>([]);
  const [openSor, setOpenSor] = useState<number | null>(null);
  const [layout, setLayoutState] = useState<"list" | "board" | "week">(() => {
    try { const v = localStorage.getItem("arrival.layout"); return v === "board" || v === "week" ? v : "list"; } catch { return "list"; }
  });
  const setLayout = (l: "list" | "board" | "week") => { setLayoutState(l); try { localStorage.setItem("arrival.layout", l); } catch { /* private mode */ } };
  const loadSors = () => api.opsOrderAcks("pending").then((r) => setPendingSors(r.acks)).catch(() => {});
  useEffect(() => { loadSors(); }, []);
  const sorChanged = () => { setOpenSor(null); loadSors(); onSorChanged?.(); };

  const groups = useMemo(() => {
    const m = new Map<string, ArrivalRow[]>();
    for (const r of b.unconfirmed) m.set(r.supplier, [...(m.get(r.supplier) ?? []), r]);
    return [...m.entries()].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]));
  }, [b.unconfirmed]);
  const toConfirm = pendingSors.length + b.unconfirmed.length;

  const chip = (f: ArrivalFocus, label: string, count: number, warn = false) => (
    <button className={focus === f ? "on" : ""} onClick={() => onFocus(f)}>
      {label}<span className="cnt" style={warn && count && focus !== f ? { color: "var(--warn)", opacity: 1 } : undefined}>{count}</span>
    </button>
  );
  const empty = (text: string) => <div className="muted" style={{ padding: "18px 18px 20px", fontSize: 13 }}>{text}</div>;
  const section = (title: string, sub: string) => (
    <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)", background: "var(--card-2)" }}>
      <div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div>
      <div className="muted" style={{ fontSize: 12 }}>{sub}</div>
    </div>
  );

  const layoutSwitch = (
    <div className="dl-chips" title="How to lay the tracker out">
      {(["list", "board", "week"] as const).map((l) => (
        <button key={l} className={layout === l ? "on" : ""} onClick={() => setLayout(l)} style={{ padding: "4px 9px" }}>
          {l === "list" ? "☰ List" : l === "board" ? "▥ Board" : "▦ Calendar"}
        </button>
      ))}
    </div>
  );
  const openConfirm = (sorId?: number) => { setLayout("list"); onFocus("confirm"); if (sorId) setOpenSor(sorId); };

  if (layout !== "list") {
    return (
      <div className="a-card dl-due">
        <div className="dl-due-hd">
          <h2>Waiting on delivery</h2>
          {layoutSwitch}
        </div>
        {layout === "board"
          ? <ArrivalBoard today={today} week={week} b={b} pendingSors={pendingSors} groups={groups} onConfirm={openConfirm} />
          : <ArrivalCalendar today={today} rows={rows} b={b} toConfirm={toConfirm} onFocusList={(f) => { setLayout("list"); onFocus(f); }} />}
      </div>
    );
  }

  return (
    <div className="a-card dl-due">
      <div className="dl-due-hd">
        <h2>Waiting on delivery</h2>
        <div className="dl-chips">
          {chip("week", "Due this week", week.length)}
          {chip("collect", "To collect", b.collect.length)}
          {chip("confirm", "To confirm", toConfirm, true)}
          {chip("overdue", "Overdue", b.overdue.length, true)}
        </div>
        {layoutSwitch}
      </div>

      {focus === "week" && (week.length ? <div className="dl-due-list">{week.map((r) => <OrderRow key={r.id} r={r} today={today} />)}</div>
        : empty("Nothing due in the next seven days."))}
      {focus === "collect" && (b.collect.length ? <div className="dl-due-list">{b.collect.map((r) => <OrderRow key={r.id} r={r} today={today} />)}</div>
        : empty("No orders are marked for us to collect. Tick \"We'll collect it\" when raising the PO, or on its PO page."))}
      {focus === "overdue" && (b.overdue.length ? <div className="dl-due-list">{b.overdue.map((r) => <OrderRow key={r.id} r={r} today={today} />)}</div>
        : empty("Nothing overdue — every order past its date has had something received."))}
      {focus === "allsor" && (
        <div style={{ padding: 16 }}>
          <button className="btn ghost sm" style={{ marginBottom: 10 }} onClick={() => onFocus("confirm")}>← Back to To confirm</button>
          <SorInbox onChanged={sorChanged} />
        </div>
      )}

      {focus === "confirm" && (
        <div className="dl-due-list">
          {section(
            `SOR received — match it to its order (${pendingSors.length})`,
            "The supplier confirmed, but didn't print one of our PO numbers. Pick the order and its date goes on the tracker.",
          )}
          {pendingSors.length === 0 && empty("None — every SOR read so far matched its PO.")}
          {pendingSors.map((a) => (
            <div key={a.id}>
              <button className="dl-due-row" style={{ width: "100%", border: 0, borderBottom: "1px solid var(--line)", background: openSor === a.id ? "var(--accent-soft)" : "transparent", textAlign: "left", cursor: "pointer", font: "inherit" }}
                onClick={() => setOpenSor(openSor === a.id ? null : a.id)}>
                <div style={{ minWidth: 0 }}>
                  <div className="isup" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={flag("var(--success-soft)", "var(--success)")}>SOR received</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{a.supplier_name || a.sender || "Unknown supplier"}</span>
                  </div>
                  <div className="imeta">
                    <span className="num">{a.supplier_order_ref || "no ref"}</span>
                    <span>· their ref “{a.our_po_ref || "—"}”</span>
                    {a.suggested_po_number && <span style={{ color: "var(--ink-2)", fontWeight: 600 }}>· looks like {a.suggested_po_number}</span>}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="dl-due-when">{a.promised_date ? `due ${fmtDate(a.promised_date)}` : "no date"}</div>
                  <div className="imeta" style={{ justifyContent: "flex-end" }}><span>received {fmtDate(a.received_at)}</span></div>
                </div>
              </button>
              {openSor === a.id && <div style={{ padding: 14, borderBottom: "1px solid var(--line)", background: "var(--card-2)" }}><SorDetail ack={a} onChanged={sorChanged} /></div>}
            </div>
          ))}

          {section(
            `Nothing from the supplier yet (${b.unconfirmed.length})`,
            `Sent in the last ${UNCONFIRMED_WINDOW_DAYS} days with no SOR and no date phoned in. Grouped by supplier, so one call covers several — then use "Set promised date" on the PO.`,
          )}
          {groups.length === 0 && empty("Every order sent in the last few weeks has a date from its supplier.")}
          {groups.map(([supplier, rs]) => {
            const total = rs.reduce((t, r) => t + (r.total_value || 0), 0);
            return (
              <details key={supplier}>
                <summary className="dl-due-row" style={{ cursor: "pointer", listStyle: "none" }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="isup" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={flag("var(--card-2)", "var(--muted)")}>No SOR</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{supplier}</span>
                    </div>
                    <div className="imeta">
                      <span>{rs.length} order{rs.length === 1 ? "" : "s"}</span>
                      <span className="proj">{[...new Set(rs.map((r) => r.project_code))].join(" · ")}</span>
                      <span>· {rs.slice(0, 3).map((r) => r.po_number).join(", ")}{rs.length > 3 ? "…" : ""}</span>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="dl-due-when late">{daysBetween(rs[0].created_at, today)} days waiting</div>
                    <div className="imeta" style={{ justifyContent: "flex-end" }}><span>{fmtMoney(total)}</span></div>
                  </div>
                </summary>
                {rs.map((r) => (
                  <Link key={r.id} className="dl-due-row" to={`/pos/${r.id}`} style={{ paddingLeft: 32, background: "var(--card-2)" }}>
                    <div className="imeta" style={{ marginTop: 0 }}>
                      <span className="num">{r.po_number}</span><span className="proj">{r.project_code}</span>
                      <span>· raised {fmtDate(r.created_at)}</span>
                      {r.required_date && <span>· required {fmtDate(r.required_date)}</span>}
                    </div>
                    <div className="imeta" style={{ justifyContent: "flex-end", marginTop: 0 }}><span>{fmtMoney(r.total_value)}</span></div>
                  </Link>
                ))}
              </details>
            );
          })}
          <div style={{ padding: "12px 16px" }}>
            <button className="btn ghost sm" onClick={() => onFocus("allsor")}>See every SOR read (matched and set aside) →</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Checks({ checks }: { checks: AckCheck[] }) {
  if (!checks.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {checks.map((c, i) => (
        <div key={i} style={{ display: "flex", gap: 8, fontSize: 13, alignItems: "baseline" }}>
          <span style={{ color: c.tone === "warn" ? "var(--warn)" : "var(--success)", fontWeight: 700, width: 14, flex: "none" }}>{c.tone === "warn" ? "!" : "✓"}</span>
          <span>{c.text}</span>
        </div>
      ))}
    </div>
  );
}

function AckLines({ lines }: { lines: OrderAckView["lines"] }) {
  if (!lines.length) return null;
  const th = { padding: "6px 8px", borderBottom: "1px solid var(--line)", textAlign: "left" as const };
  const td = { padding: "7px 8px", borderBottom: "1px solid var(--line)" };
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead><tr className="muted" style={{ fontSize: 11.5 }}>
        <th style={th}>Line read</th><th style={th}>Qty</th><th style={th}>Price</th><th style={th}>Amount</th><th style={th}>Date</th>
      </tr></thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i}>
            <td style={td}>{l.code ? <b>{l.code} </b> : null}{l.description}</td>
            <td style={{ ...td, whiteSpace: "nowrap" }}>{l.quantity ?? "—"}{l.unit ? ` ${l.unit}` : ""}</td>
            <td style={{ ...td, whiteSpace: "nowrap" }}>{l.unit_price ?? "—"}</td>
            <td style={{ ...td, whiteSpace: "nowrap" }}>{l.amount != null ? fmtMoney(l.amount) : "—"}</td>
            <td style={{ ...td, whiteSpace: "nowrap" }}>{dayFmt(l.line_date)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SOURCE_LABEL: Record<OrderAckView["source"], string> = {
  sor_folder: "accounts@ › SOR",
  projects_email: "projects@",
  manual: "entered by hand",
};

function ackState(a: OrderAckView): { cls: string; label: string } {
  if (a.status === "matched") return { cls: "matched", label: `Matched · ${a.po_number ?? "PO"}` };
  if (a.status === "dismissed") return { cls: "", label: a.dismiss_reason?.startsWith("Same as") ? "Duplicate" : "Set aside" };
  return { cls: "review", label: a.suggested_po_number ? "Check the PO" : "Needs a PO" };
}

export function SorInbox({ onChanged }: { onChanged?: () => void }) {
  const [acks, setAcks] = useState<OrderAckView[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [chip, setChip] = useState<"open" | "matched" | "set_aside" | "all">("open");
  const [sel, setSel] = useState<number | null>(null);
  const [q, setQ] = useState("");

  async function reload() {
    try {
      const r = await api.opsOrderAcks("recent");
      setAcks(r.acks); setErr(r.error ?? null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { reload(); }, []);

  const counts = {
    open: acks.filter((a) => a.status === "pending").length,
    matched: acks.filter((a) => a.status === "matched").length,
    set_aside: acks.filter((a) => a.status === "dismissed").length,
    all: acks.length,
  };
  const list = acks
    .filter((a) => chip === "all" || (chip === "open" ? a.status === "pending" : chip === "matched" ? a.status === "matched" : a.status === "dismissed"))
    .filter((a) => !q.trim() || `${a.supplier_name} ${a.supplier_order_ref} ${a.our_po_ref} ${a.po_number} ${a.subject}`.toLowerCase().includes(q.trim().toLowerCase()));
  const current = list.find((a) => a.id === sel) ?? list[0] ?? null;

  return (
    <div className="a-split">
      <div className="inbox">
        <div className="inbox-hd">
          <h2>Order confirmations</h2>
          <span className="count">{counts.open}</span>
        </div>
        <div className="muted" style={{ padding: "8px 16px", fontSize: 12, borderBottom: "1px solid var(--line)", background: "var(--card-2)" }}>
          Read every hour from <b>accounts@ › SOR</b>, and from supplier replies that reach <b>projects@</b>.
        </div>
        <div className="dl-chips" style={{ padding: "10px 14px 0" }}>
          <button className={chip === "open" ? "on" : ""} onClick={() => setChip("open")}>Needs checking<span className="cnt">{counts.open}</span></button>
          <button className={chip === "matched" ? "on" : ""} onClick={() => setChip("matched")}>Matched<span className="cnt">{counts.matched}</span></button>
          <button className={chip === "set_aside" ? "on" : ""} onClick={() => setChip("set_aside")}>Set aside<span className="cnt">{counts.set_aside}</span></button>
          <button className={chip === "all" ? "on" : ""} onClick={() => setChip("all")}>All<span className="cnt">{counts.all}</span></button>
        </div>
        <div className="inbox-search"><input placeholder="Search supplier, SOR or PO…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="ilist">
          {loading ? <div className="muted" style={{ padding: 16, fontSize: 13 }}>Loading…</div>
            : err && !acks.length ? <div className="muted" style={{ padding: 16, fontSize: 13 }}>Couldn't load order confirmations: {err}</div>
            : list.length === 0 ? <div className="muted" style={{ padding: 16, fontSize: 13 }}>{chip === "open" ? "Nothing waiting — every confirmation read so far matched its PO." : "None here."}</div>
            : list.map((a) => {
              const st = ackState(a);
              return (
                <button key={a.id} className={`irow${current?.id === a.id ? " on" : ""}`} onClick={() => setSel(a.id)}>
                  <span className={`idot ${a.status === "matched" ? "matched" : a.status === "pending" ? "review" : ""}`} />
                  <div style={{ minWidth: 0 }}>
                    <div className="isup">{a.supplier_name || a.sender || "Unknown supplier"}</div>
                    <div className="imeta">
                      <span>{a.supplier_order_ref || "no ref"}</span>
                      <span>· {fmtDate(a.received_at)}</span>
                      {a.project_code && <span className="proj">{a.project_code}</span>}
                    </div>
                    <span className={`istatus ${st.cls}`}>{st.label}</span>
                  </div>
                  <div className="iamt" style={{ fontSize: 12.5 }}>{a.promised_date ? `due ${fmtDate(a.promised_date)}` : "—"}</div>
                </button>
              );
            })}
        </div>
      </div>
      {current ? <SorDetail key={current.id} ack={current} onChanged={() => { reload(); onChanged?.(); }} /> : (
        <div className="a-card a-pad muted" style={{ fontSize: 13 }}>
          Order acknowledgements appear here as they're read. Drag one into the SOR folder in accounts@ (or let the rule file it) and it shows up within the hour.
        </div>
      )}
    </div>
  );
}

function SorDetail({ ack, onChanged }: { ack: OrderAckView; onChanged: () => void }) {
  const [picking, setPicking] = useState(false);
  const [pos, setPos] = useState<Array<{ id: string; po_number: string; supplier: string; project_code: string; total_value: number; status: string }>>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const st = ackState(ack);

  useEffect(() => {
    if (!picking || pos.length) return;
    api.listPOs().then((all) => setPos(all
      .filter((p) => ["pending_approval", "approved", "issued"].includes(p.status))
      .map((p) => ({ id: p.id, po_number: p.po_number, supplier: p.supplier, project_code: p.project_code, total_value: p.total_value, status: p.status })))).catch(() => {});
  }, [picking, pos.length]);

  const sameSupplier = (p: { supplier: string }) => {
    const a = (ack.supplier_name ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !["ltd", "limited", "plc", "the"].includes(w));
    return a.some((w) => p.supplier.toLowerCase().includes(w));
  };
  const options = [...pos].sort((x, y) => Number(sameSupplier(y)) - Number(sameSupplier(x)) || y.po_number.localeCompare(x.po_number));

  async function attach(poId: string) {
    setBusy(true); setErr(null);
    try { await api.opsAttachOrderAck(ack.id, poId); setPicking(false); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function dismiss() {
    setBusy(true); setErr(null);
    try { await api.opsDismissOrderAck(ack.id); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const field = (label: string, value: string | null | undefined, strong?: boolean) => (
    <div style={{ marginBottom: 14, minWidth: 0 }}>
      <div className="eyebrow" style={{ margin: 0 }}>{label}</div>
      <div style={{ fontSize: 14, marginTop: 3, fontWeight: strong ? 600 : 500, overflowWrap: "anywhere" }}>{value || "—"}</div>
    </div>
  );

  return (
    <div className="a-card a-pad" style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 20, flex: 1, minWidth: 0 }}>{ack.supplier_name || "Unknown supplier"}</h2>
        <span className={`istatus ${st.cls}`} style={{ fontSize: 11, marginTop: 0 }}>{st.label}</span>
        {ack.project_code && <span className="pill neutral">{ack.project_code}</span>}
      </div>

      <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "10px 14px", background: "var(--card-2)", fontSize: 13 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span className="muted">From</span><b>{ack.sender || "—"}</b>
          <span style={{ flex: 1 }} />
          <span className="muted">{SOURCE_LABEL[ack.source]} · {fmtDate(ack.received_at)}</span>
        </div>
        <div style={{ marginTop: 4, fontWeight: 600 }}>{ack.subject || "(no subject)"}</div>
        {ack.file_url && <div style={{ marginTop: 6 }}><a className="pill neutral" href={ack.file_url} target="_blank" rel="noreferrer">📎 {ack.file_name || "acknowledgement"}</a></div>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0 24px" }}>
        {field("Supplier order no. (SOR)", ack.supplier_order_ref, true)}
        {field("Their reference for our PO", ack.our_po_ref, true)}
        {field("Promised delivery", ack.promised_date ? `${fmtDate(ack.promised_date)}${ack.promised_note ? ` · ${ack.promised_note}` : ""}` : (ack.promised_note || "—"), true)}
        {field("Acknowledged", ack.ack_date ? fmtDate(ack.ack_date) : null)}
        {field("Deliver to", ack.delivery_address)}
        {field("Value (ex VAT)", ack.total_ex_vat != null ? fmtMoney(ack.total_ex_vat) : ack.goods_total != null ? fmtMoney(ack.goods_total) : null)}
      </div>
      {ack.delivery_instructions && <div className="muted" style={{ fontSize: 12.5, marginTop: -8 }}>Delivery instructions: {ack.delivery_instructions}</div>}

      <AckLines lines={ack.lines} />
      <Checks checks={ack.checks} />
      {ack.status === "pending" && (
        <Checks checks={[{ tone: "warn", text: ack.our_po_ref ? `“${ack.our_po_ref}” isn't one of our PO numbers — pick the order it belongs to.` : "No PO number of ours on it — pick the order it belongs to." }]} />
      )}
      {ack.status === "dismissed" && ack.dismiss_reason && <div className="muted" style={{ fontSize: 13 }}>Set aside: {ack.dismiss_reason}{ack.actioned_by ? ` · ${ack.actioned_by}` : ""}</div>}

      <div style={{ borderTop: "1px dashed var(--line-strong)", paddingTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {ack.status === "matched" && (
          <span style={{ fontSize: 13, color: "var(--success)", fontWeight: 600 }}>
            ✓ On <Link to={`/pos/${ack.po_id}`}>{ack.po_number}</Link>{ack.matched_by === "manual" ? ` — attached by ${ack.actioned_by ?? "hand"}` : " automatically"}
          </span>
        )}
        {ack.status === "pending" && ack.suggested_po_id && (
          <button className="btn accent" disabled={busy} onClick={() => attach(ack.suggested_po_id!)}>Attach to {ack.suggested_po_number}</button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" disabled={busy} onClick={() => setPicking((v) => !v)}>
          {ack.status === "matched" ? "Wrong PO? Change…" : ack.status === "dismissed" ? "It is one — pick a PO…" : "Pick a PO…"}
        </button>
        {ack.status !== "dismissed" && <button className="btn ghost sm" disabled={busy} onClick={dismiss}>Not an order confirmation</button>}
      </div>
      {ack.status === "pending" && ack.suggest_reason && (
        <div className="muted" style={{ fontSize: 12, marginTop: -8 }}>Suggested because: {ack.suggest_reason}.</div>
      )}
      {picking && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: 1, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--line-strong)", font: "inherit", fontSize: 13 }}>
            <option value="">{pos.length ? "Choose an open order…" : "Loading orders…"}</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>{p.po_number} · {p.supplier} · {fmtMoney(p.total_value)}{p.status === "pending_approval" ? " · awaiting approval" : ""}</option>
            ))}
          </select>
          <button className="btn primary sm" disabled={!pick || busy} onClick={() => attach(pick)}>Attach</button>
        </div>
      )}
      {err && <div style={{ color: "var(--danger)", fontSize: 13 }}>{err}</div>}
    </div>
  );
}

/** The PO page's Delivery card. */
export function PoDeliveryCard({ poId, canEdit }: { poId: string; canEdit: boolean }) {
  const [d, setD] = useState<PoArrival | null>(null);
  const [editing, setEditing] = useState<null | "promised" | "collect">(null);
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [collector, setCollector] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.opsPoArrival(poId).then(setD).catch(() => setD(null));
  useEffect(() => { load(); }, [poId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;

  const today = todayIso();
  const eff = d.promised_date || d.required_date;
  const state = d.received_count > 0
    ? { text: `Arrived — first booked ${fmtDate(d.received_first)}${d.promised_date && d.received_first ? (daysBetween(d.promised_date, d.received_first) > 0 ? ` (${daysBetween(d.promised_date, d.received_first)}d after promised)` : " (on time)") : ""}`, tone: "ok" as const }
    : !eff ? { text: d.collect_by_us ? "To collect — no date set" : "No date from the supplier yet", tone: "warn" as const }
    : daysBetween(eff, today) > 0 ? { text: `${daysBetween(eff, today)} day${daysBetween(eff, today) === 1 ? "" : "s"} late — nothing received`, tone: "warn" as const }
    : eff === today ? { text: d.collect_by_us ? "Collect today" : "Due today", tone: "ok" as const }
    : { text: `Due in ${daysBetween(today, eff)} day${daysBetween(today, eff) === 1 ? "" : "s"}`, tone: "ok" as const };

  async function save(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); setEditing(null); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const p = d.promised;
  const promisedSub = p
    ? p.source === "manual"
      ? `By phone · entered by ${p.actioned_by ?? "—"} ${fmtDate(p.received_at)}${p.promised_note ? ` · ${p.promised_note}` : ""}`
      : `${p.supplier_order_ref ? `${p.supplier_order_ref} · ` : ""}${p.kind === "delivery_notice" ? "delivery notice" : "acknowledged"} ${fmtDate(p.ack_date || p.received_at)} · via ${SOURCE_LABEL[p.source]}${p.promised_note ? ` · ${p.promised_note}` : ""}`
    : d.collect_by_us ? "We're collecting this one" : "No SOR read for this order yet";

  return (
    <div className="card">
      <div className="card-bd">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
          <div className="eyebrow" style={{ margin: 0 }}>Delivery</div>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: state.tone === "warn" ? "var(--warn)" : "var(--success)" }}>{state.text}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.7fr auto", gap: 24, alignItems: "start" }}>
          <div>
            <div className="eyebrow">How it arrives</div>
            <div style={{ fontSize: 15, marginTop: 6, fontWeight: 500 }}>{d.collect_by_us ? "We collect" : "Supplier delivers"}</div>
            {d.collect_by_us && d.collector && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{d.collector}</div>}
          </div>
          <div>
            <div className="eyebrow">Required by · ours</div>
            <div style={{ fontSize: 15, marginTop: 6, fontWeight: 500 }}>{dayFmt(d.required_date)}</div>
            {!d.required_date && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>not set on the PO</div>}
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="eyebrow">Promised · supplier</div>
            <div style={{ fontSize: 15, marginTop: 6, fontWeight: 500 }}>{dayFmt(d.promised_date)}</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{promisedSub}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
            {p?.file_url && <a className="btn sm" href={p.file_url} target="_blank" rel="noreferrer">View acknowledgement</a>}
            {canEdit && <button className="btn ghost sm" onClick={() => { setEditing(editing === "promised" ? null : "promised"); setDate(d.promised_date ?? ""); setNote(""); }}>Set promised date</button>}
            {canEdit && <button className="btn ghost sm" onClick={() => { setEditing(editing === "collect" ? null : "collect"); setCollector(d.collector ?? ""); }}>{d.collect_by_us ? "Collection…" : "We'll collect it"}</button>}
          </div>
        </div>

        {editing === "promised" && (
          <div style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid var(--line-strong)", font: "inherit" }} />
            <input placeholder="Who told you? e.g. phoned Barwell, spoke to Dave" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 220, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line-strong)", font: "inherit" }} />
            <button className="btn primary sm" disabled={!date || busy} onClick={() => save(() => api.opsSetPromised(poId, date, note))}>Save date</button>
          </div>
        )}
        {editing === "collect" && (
          <div style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input placeholder="Who's collecting? (optional)" value={collector} onChange={(e) => setCollector(e.target.value)} style={{ flex: 1, minWidth: 220, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line-strong)", font: "inherit" }} />
            <button className="btn primary sm" disabled={busy} onClick={() => save(() => api.opsSetCollect(poId, true, collector))}>We'll collect it</button>
            {d.collect_by_us && <button className="btn ghost sm" disabled={busy} onClick={() => save(() => api.opsSetCollect(poId, false))}>Supplier delivers instead</button>}
          </div>
        )}
        {err && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{err}</div>}

        {p && p.source !== "manual" && (p.checks.length > 0 || p.lines.length > 0) && (
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 12 }}>
            <Checks checks={p.checks} />
            <AckLines lines={p.lines} />
          </div>
        )}
        {d.acks.length > 1 && (
          <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>
            Earlier dates: {d.acks.slice(1).map((a) => `${dayFmt(a.promised_date)} (${a.source === "manual" ? "by phone" : a.supplier_order_ref ?? "SOR"}, ${fmtDate(a.received_at)})`).join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Alternative layouts ─────────────────────────────────────────────────── */

type Buckets = ReturnType<typeof bucketArrivals>;

function MiniCard({ r, today, tone }: { r: ArrivalRow; today: string; tone?: "warn" | "today" }) {
  const d = effectiveDate(r);
  const late = d ? daysBetween(d, today) : 0;
  return (
    <Link to={`/pos/${r.id}`} style={{
      display: "block", textDecoration: "none", color: "inherit", background: "var(--card)", border: "1px solid var(--line)",
      borderLeft: `3px solid ${tone === "warn" ? "var(--warn)" : tone === "today" ? "var(--accent)" : r.promised_date ? "var(--success)" : "var(--line-strong)"}`,
      borderRadius: 8, padding: "8px 10px",
    }}>
      <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.supplier}</div>
      <div className="imeta" style={{ marginTop: 2 }}>
        <span className="num">{r.po_number}</span><span className="proj">{r.project_code}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6, gap: 6 }}>
        <SourceTag r={r} />
        <span style={{ fontSize: 12, fontWeight: 600, color: late > 0 ? "var(--warn)" : "var(--ink-2)", whiteSpace: "nowrap" }}>
          {!d ? "no date" : late > 0 ? `${late}d late` : late === 0 ? "today" : fmtDate(d).replace(/ \d{4}$/, "")}
        </span>
      </div>
    </Link>
  );
}

/** Four columns side by side — the whole picture without clicking a tab. */
function ArrivalBoard({ today, week, b, pendingSors, groups, onConfirm }: {
  today: string; week: ArrivalRow[]; b: Buckets; pendingSors: OrderAckView[]; groups: Array<[string, ArrivalRow[]]>;
  onConfirm: (sorId?: number) => void;
}) {
  const col = (title: string, count: number, body: React.ReactNode, warn = false) => (
    <div style={{ background: "var(--card-2)", border: "1px solid var(--line)", borderRadius: 12, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "10px 12px", display: "flex", alignItems: "baseline", gap: 8, borderBottom: "1px solid var(--line)" }}>
        <b style={{ fontSize: 13.5 }}>{title}</b>
        <span style={{ fontSize: 12, fontWeight: 700, color: warn && count ? "var(--warn)" : "var(--muted)" }}>{count}</span>
      </div>
      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8, maxHeight: "calc(100vh - 300px)", overflow: "auto" }}>
        {body}
      </div>
    </div>
  );
  const none = (t: string) => <div className="muted" style={{ fontSize: 12.5, padding: 4 }}>{t}</div>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, padding: 14 }}>
      {col("Due this week", week.length, week.length ? week.map((r) => <MiniCard key={r.id} r={r} today={today} tone={effectiveDate(r) === today ? "today" : undefined} />) : none("Nothing due in the next 7 days."))}
      {col("To collect", b.collect.length, b.collect.length ? b.collect.map((r) => <MiniCard key={r.id} r={r} today={today} />) : none("Nothing to collect."))}
      {col("To confirm", pendingSors.length + b.unconfirmed.length, <>
        {pendingSors.map((a) => (
          <button key={a.id} onClick={() => onConfirm(a.id)} style={{ display: "block", width: "100%", textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer", background: "var(--card)", border: "1px solid var(--line)", borderLeft: "3px solid var(--success)", borderRadius: 8, padding: "8px 10px" }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{a.supplier_name || "Unknown supplier"}</div>
            <div className="imeta" style={{ marginTop: 2 }}><span className="num">{a.supplier_order_ref}</span><span>· their ref “{a.our_po_ref || "—"}”</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
              <span style={flag("var(--success-soft)", "var(--success)")}>SOR · pick PO</span>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{a.promised_date ? fmtDate(a.promised_date).replace(/ \d{4}$/, "") : "—"}</span>
            </div>
          </button>
        ))}
        {groups.map(([supplier, rs]) => (
          <button key={supplier} onClick={() => onConfirm()} style={{ display: "block", width: "100%", textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer", background: "var(--card)", border: "1px solid var(--line)", borderLeft: "3px solid var(--line-strong)", borderRadius: 8, padding: "8px 10px" }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{supplier}</div>
            <div className="imeta" style={{ marginTop: 2 }}><span>{rs.length} order{rs.length === 1 ? "" : "s"}</span><span className="proj">{[...new Set(rs.map((r) => r.project_code))].join(" · ")}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
              <span style={flag("var(--card-2)", "var(--muted)")}>No SOR</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--warn)" }}>{daysBetween(rs[0].created_at, today)}d waiting</span>
            </div>
          </button>
        ))}
        {!pendingSors.length && !groups.length && none("Every recent order has a date.")}
      </>, true)}
      {col("Overdue", b.overdue.length, b.overdue.length ? b.overdue.map((r) => <MiniCard key={r.id} r={r} today={today} tone="warn" />) : none("Nothing overdue."), true)}
    </div>
  );
}

/** Two weeks as a calendar, Monday first — what lands on which day. Overdue
 *  and To confirm sit above it as counts, since they have no day to go on. */
function ArrivalCalendar({ today, rows, b, toConfirm, onFocusList }: {
  today: string; rows: ArrivalRow[]; b: Buckets; toConfirm: number; onFocusList: (f: ArrivalFocus) => void;
}) {
  const t = new Date(today + "T00:00:00Z");
  const monday = new Date(t); monday.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(monday); d.setUTCDate(monday.getUTCDate() + i); return d.toISOString().slice(0, 10); })
    .filter((d) => { const wd = new Date(d + "T00:00:00Z").getUTCDay(); return wd !== 0 && wd !== 6; });
  const byDay = new Map<string, ArrivalRow[]>();
  for (const r of rows) {
    const d = effectiveDate(r);
    if (d && d >= days[0] && d <= days[days.length - 1]) byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }
  const weekend = rows.filter((r) => { const d = effectiveDate(r); if (!d || d < days[0] || d > days[days.length - 1]) return false; const wd = new Date(d + "T00:00:00Z").getUTCDay(); return wd === 0 || wd === 6; });
  const stat = (label: string, n: number, f: ArrivalFocus, warn: boolean) => (
    <button onClick={() => onFocusList(f)} style={{ font: "inherit", cursor: "pointer", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "8px 14px", display: "flex", alignItems: "baseline", gap: 8 }}>
      <span style={{ fontSize: 20, fontWeight: 700, color: warn && n ? "var(--warn)" : "var(--ink)" }}>{n}</span>
      <span className="muted" style={{ fontSize: 12.5 }}>{label} →</span>
    </button>
  );
  return (
    <div style={{ padding: 14 }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        {stat("overdue", b.overdue.length, "overdue", true)}
        {stat("to confirm", toConfirm, "confirm", true)}
        {stat("to collect", b.collect.length, "collect", false)}
        {weekend.length > 0 && <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>+{weekend.length} dated on a weekend</span>}
      </div>
      {[days.slice(0, 5), days.slice(5, 10)].map((wk, wi) => (
        <div key={wi} style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 8, marginBottom: 10 }}>
          {wk.map((d) => {
            const items = byDay.get(d) ?? [];
            const isToday = d === today, past = d < today;
            return (
              <div key={d} style={{ border: `1px solid ${isToday ? "var(--accent)" : "var(--line)"}`, borderRadius: 10, background: past ? "var(--card-2)" : "var(--card)", minHeight: 120, minWidth: 0 }}>
                <div style={{ padding: "6px 10px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 600, color: isToday ? "var(--accent-2)" : past ? "var(--muted)" : "var(--ink-2)" }}>
                  <span>{new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}</span>
                  {isToday && <span>TODAY</span>}
                </div>
                <div style={{ padding: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                  {items.map((r) => <MiniCard key={r.id} r={r} today={today} tone={past ? "warn" : isToday ? "today" : undefined} />)}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
