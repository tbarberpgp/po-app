import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import type { CabinState, QitpCabinCard, QitpDashboard as Dash } from "../../shared/types";
import type { CurrentUser } from "../../shared/types";
import { QITP_LIFT, fmtLiftDate } from "../../shared/qitp-lift";
import { can } from "../../shared/permissions";
import { downloadCabinRecords, cabinRecordUrl, type BatchProgress } from "../lib/qitp-records";

const STATE_LABEL: Record<CabinState, string> = {
  not_started: "Not started", in_progress: "In progress", held: "Held", failed: "Failed", complete: "Complete",
};
const FLOORS = ["Top", "Middle", "Ground"] as const;
// Rough guides so nobody starts a 140-cabin batch without knowing what it costs.
// ~2.5MB and ~7s a record, measured against Blyth.
const estMb = (n: number) => Math.max(1, Math.round(n * 2.5));
const estMins = (n: number) => { const m = Math.round((n * 7) / 60); return m < 1 ? "under a minute" : `about ${m} minute${m === 1 ? "" : "s"}`; };

/** Supervisor dashboard for a project's cabin QITP: needs-attention triage,
 *  KPI totals, and a progress-ring grid across all cabins. */
export function QitpDashboard({ me, embedded }: { me: CurrentUser | null; embedded?: boolean }) {
  const { id = "" } = useParams<{ id: string }>();
  const [dash, setDash] = useState<Dash | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [floor, setFloor] = useState<string>("All");
  const [status, setStatus] = useState<string>("All");
  const [sort, setSort] = useState<"number" | "day">("number");
  const [day, setDay] = useState<number | null>(null);

  // Client quality-dashboard share link (public, read-only). Viewable by anyone
  // who runs quality (delivery.edit); publishing a new link needs projects.edit.
  const canViewLink = !!me && can(me.role, "delivery.edit");
  const canPublishLink = !!me && can(me.role, "projects.edit");
  const [linkOpen, setLinkOpen] = useState(false);
  const [clientToken, setClientToken] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Batch record download. Scope is whatever the filters currently show, so the
  // existing floor/status/day controls double as the batch picker.
  const [batchOpen, setBatchOpen] = useState(false);
  const [batch, setBatch] = useState<BatchProgress | null>(null);
  const [batchDone, setBatchDone] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const shareUrl = clientToken ? `${window.location.origin}/pub/quality/${clientToken}` : "";

  useEffect(() => {
    api.qitpDashboard(id).then(setDash).catch((e) => setErr(e instanceof Error ? e.message : "Couldn't load QITP"));
  }, [id]);

  useEffect(() => {
    if (canViewLink && id) api.qitpClientLink(id).then((r) => setClientToken(r.token)).catch(() => {});
  }, [id, canViewLink]);

  async function createClientLink() {
    setLinkBusy(true);
    try { const r = await api.qitpCreateClientLink(id); setClientToken(r.token); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't create the link"); }
    finally { setLinkBusy(false); }
  }
  function copyShareUrl() {
    if (!shareUrl) return;
    navigator.clipboard?.writeText(shareUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  }

  async function runBatch(list: QitpCabinCard[]) {
    cancelRef.current = false;
    setBatchDone(null);
    setBatch({ done: 0, total: list.length, current: list[0]?.number ?? "" });
    try {
      const r = await downloadCabinRecords(
        list.map((c) => ({ number: c.number, token: c.token })),
        dash?.project.code ?? "QITP",
        setBatch,
        () => cancelRef.current,
      );
      setBatchDone(
        r.cancelled
          ? `Stopped. ${r.ok} record${r.ok === 1 ? "" : "s"} downloaded.`
          : r.failed.length
            ? `${r.ok} downloaded. ${r.failed.length} could not be generated: ${r.failed.join(", ")}.`
            : `${r.ok} record${r.ok === 1 ? "" : "s"} downloaded.`,
      );
    } catch (e) {
      setBatchDone(e instanceof Error ? e.message : "The download failed.");
    } finally {
      setBatch(null);
    }
  }

  const cabins = dash?.cabins ?? [];
  const days = useMemo(() => [...new Set(cabins.map((c) => c.dismantle_day).filter((d): d is number => d != null))].sort((a, b) => a - b), [cabins]);
  // "Due today" front: default to the earliest day that still has unfinished cabins.
  const focusDay = useMemo(() => {
    if (day != null) return day;
    const open = cabins.filter((c) => c.status !== "complete" && c.dismantle_day != null).map((c) => c.dismantle_day as number);
    return open.length ? Math.min(...open) : (days[0] ?? 1);
  }, [day, cabins, days]);

  const due = cabins.filter((c) => c.dismantle_day === focusDay && c.status !== "complete");
  const held = cabins.filter((c) => c.status === "held");
  const failed = cabins.filter((c) => c.status === "failed");

  const kpi = useMemo(() => ({
    total: cabins.length,
    complete: cabins.filter((c) => c.status === "complete").length,
    inProgress: cabins.filter((c) => c.status === "in_progress" || c.status === "held").length,
    notStarted: cabins.filter((c) => c.status === "not_started").length,
  }), [cabins]);

  const lift = useMemo(() => {
    const per = FLOORS.map((f) => {
      const fc = cabins.filter((c) => c.floor === f);
      return { floor: f as string, total: fc.length, done: fc.filter((c) => c.lifted).length };
    });
    return { per, total: cabins.length, done: cabins.filter((c) => c.lifted).length };
  }, [cabins]);

  const floorRank: Record<string, number> = { Top: 0, Middle: 1, Ground: 2 };
  const byNumber = (a: QitpCabinCard, b: QitpCabinCard) =>
    (floorRank[a.floor] ?? 9) - (floorRank[b.floor] ?? 9) || a.number.localeCompare(b.number, undefined, { numeric: true });
  const filtered = cabins
    .filter((c) => (floor === "All" || c.floor === floor) && (status === "All" || c.status === status))
    .sort((a, b) => sort === "day"
      ? (a.dismantle_day ?? 999) - (b.dismantle_day ?? 999) || byNumber(a, b)
      : byNumber(a, b));

  if (err) return <div style={{ padding: 28 }}><div className="flash error">{err}</div><Link to={`/projects/${id}`}>← Back to project</Link></div>;
  if (!dash) return <div className="empty" style={{ padding: 40 }}>Loading QITP…</div>;

  return (
    <div className={`qitp-wrap${embedded ? " embedded" : ""}`}>
      <div className="qitp-head">
        {!embedded && (
          <div>
            <Link to={`/projects/${id}`} className="muted" style={{ fontSize: 13 }}>← {dash.project.code} {dash.project.name}</Link>
            <h1 style={{ margin: "4px 0 0", fontSize: 22 }}>Cabin QITP</h1>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
          {canViewLink && <button className="btn" onClick={() => setLinkOpen((o) => !o)}>🔗 Client dashboard</button>}
          <button className="btn" onClick={() => setBatchOpen((o) => !o)}>⤓ Download records</button>
          <Link className="btn accent" to={`/projects/${id}/qitp/print`}>🏷️ Print QR labels</Link>
        </div>
      </div>

      {canViewLink && linkOpen && (
        <div className="card" style={{ padding: 14, marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 13 }}>
            <b>Client quality dashboard</b> — a read-only, live QITP summary for the client. Anyone with this link can view it (no login), and it updates automatically as cabin gates are inspected.
          </div>
          {clientToken ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()}
                style={{ flex: 1, minWidth: 240, fontSize: 13, padding: "8px 10px", border: "1px solid var(--line-strong, #c9c4b4)", borderRadius: 8, background: "var(--soft, #f5f2eb)" }} />
              <button className="btn" onClick={copyShareUrl}>{copied ? "Copied ✓" : "Copy link"}</button>
              <a className="btn ghost" href={shareUrl} target="_blank" rel="noreferrer">Open ↗</a>
            </div>
          ) : canPublishLink ? (
            <div><button className="btn accent" disabled={linkBusy} onClick={createClientLink}>{linkBusy ? "Creating…" : "Create client link"}</button></div>
          ) : (
            <span className="muted" style={{ fontSize: 13 }}>No link has been published yet — a project manager can create one.</span>
          )}
        </div>
      )}

      {batchOpen && (
        <div className="card" style={{ padding: 14, marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 13 }}>
            <b>Download quality records</b> — one PDF per cabin, delivered as a ZIP. The batch is whatever
            the filters below are showing, so narrow by floor, state or day first.
          </div>
          {batch ? (
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <progress value={batch.done} max={batch.total} style={{ width: 200 }} />
              <span style={{ fontSize: 13 }}>
                {batch.done} of {batch.total} — cabin {batch.current}
              </span>
              <button className="btn ghost" onClick={() => { cancelRef.current = true; }}>Stop</button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn accent" disabled={filtered.length === 0}
                onClick={() => runBatch(filtered)}>
                Download {filtered.length} record{filtered.length === 1 ? "" : "s"}
              </button>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {filtered.length === 0
                  ? "No cabins match the current filters."
                  : `Roughly ${estMb(filtered.length)} MB, ${estMins(filtered.length)}. Each record is built on demand, so a large batch takes a while — you can stop it part way and keep what has downloaded.`}
              </span>
            </div>
          )}
          {batchDone && <div className="muted" style={{ fontSize: 13 }}>{batchDone}</div>}
        </div>
      )}

      {/* Needs-attention strip — the supervisor's triage, most important, on top. */}
      <div className="qitp-attention">
        <AttnCard tone="due" title={`Due — Day ${focusDay}`} cabins={due}
          control={days.length > 1 ? (
            <span className="qitp-daynav">
              <button className="ghost tiny" onClick={() => setDay(Math.max(days[0], focusDay - 1))} disabled={focusDay <= days[0]}>‹</button>
              <button className="ghost tiny" onClick={() => setDay(Math.min(days[days.length - 1], focusDay + 1))} disabled={focusDay >= days[days.length - 1]}>›</button>
            </span>
          ) : null} />
        <AttnCard tone="held" title="Held at a hold point" cabins={held} />
        <AttnCard tone="failed" title="Has a fail" cabins={failed} />
      </div>

      {/* KPI row */}
      <div className="qitp-kpis">
        <Kpi label="Cabins" value={kpi.total} />
        <Kpi label="Complete" value={kpi.complete} tone="ok" />
        <Kpi label="In progress" value={kpi.inProgress} tone="info" />
        <Kpi label="Not started" value={kpi.notStarted} tone="muted" />
      </div>

      {/* Dismantle lift programme — tracks Section 3 (Wrap, Lift & Transport) */}
      <div className="qitp-lift">
        <div className="qitp-lift-hd">
          <div>
            <div className="qitp-lift-title">Dismantle lift programme</div>
            <div className="muted" style={{ fontSize: 12 }}>Section 3 — Wrap, Lift &amp; Transport signed off</div>
          </div>
          <div className="qitp-lift-dates">
            <div><span className="muted">Lifting starts</span><b>{fmtLiftDate(QITP_LIFT.lift)}</b></div>
            <div><span className="muted">Install</span><b>{fmtLiftDate(QITP_LIFT.install)}</b></div>
          </div>
        </div>
        <div className="qitp-lift-total"><b>{lift.done}</b> / {lift.total} cabins lifted &amp; transported</div>
        <LiftBar done={lift.done} total={lift.total} big />
        <div className="qitp-lift-floors">
          {lift.per.map((p) => (
            <div key={p.floor} className="qitp-lift-floor">
              <div className="qitp-lift-floor-hd"><span className={`qitp-sq ${p.floor.toLowerCase()}`} /> {p.floor} <span className="muted">{p.done}/{p.total}</span></div>
              <LiftBar done={p.done} total={p.total} floor={p.floor} />
            </div>
          ))}
        </div>
      </div>

      {/* Controls — filters on their own row… */}
      <div className="qitp-controls">
        <div className="qitp-seg">
          <span className="qitp-seg-lbl">Floor</span>
          {["All", ...FLOORS].map((f) => <button key={f} className={`qitp-chip${floor === f ? " on" : ""}`} onClick={() => setFloor(f)}>{f}</button>)}
        </div>
        <div className="qitp-seg">
          <span className="qitp-seg-lbl">Status</span>
          {["All", "not_started", "in_progress", "held", "failed", "complete"].map((s) => (
            <button key={s} className={`qitp-chip${status === s ? " on" : ""}`} onClick={() => setStatus(s)}>{s === "All" ? "All" : STATE_LABEL[s as CabinState]}</button>
          ))}
        </div>
        <div className="qitp-seg">
          <span className="qitp-seg-lbl">Sort</span>
          {([["number", "Number"], ["day", "Dismantle day"]] as const).map(([v, label]) => (
            <button key={v} className={`qitp-chip${sort === v ? " on" : ""}`} onClick={() => setSort(v)}>{label}</button>
          ))}
        </div>
      </div>
      {/* …and the legend on its OWN row, so it never collides with the controls. */}
      <div className="qitp-legend">
        {(["complete", "in_progress", "held", "failed", "not_started"] as CabinState[]).map((s) => (
          <span key={s} className="qitp-leg"><i className={`qitp-dot ${s}`} />{STATE_LABEL[s]}</span>
        ))}
      </div>

      <div className="qitp-grid">
        {filtered.map((c) => <CabinCard key={c.id} c={c} />)}
        {filtered.length === 0 && <div className="muted" style={{ padding: 24 }}>No cabins match these filters.</div>}
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return <div className="qitp-kpi"><div className={`qitp-kpi-v ${tone ?? ""}`}>{value}</div><div className="qitp-kpi-l">{label}</div></div>;
}

function LiftBar({ done, total, floor, big }: { done: number; total: number; floor?: string; big?: boolean }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className={`qitp-liftbar${big ? " big" : ""}`}>
      <div className={`qitp-liftbar-fill ${floor ? floor.toLowerCase() : "all"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function AttnCard({ tone, title, cabins, control }: { tone: string; title: string; cabins: QitpCabinCard[]; control?: React.ReactNode }) {
  return (
    <div className={`qitp-attn ${tone}`}>
      <div className="qitp-attn-hd"><span className="qitp-attn-n">{cabins.length}</span><span className="qitp-attn-t">{title}</span>{control}</div>
      <div className="qitp-attn-list">
        {cabins.length === 0 ? <span className="muted" style={{ fontSize: 12 }}>None</span>
          : cabins.slice(0, 40).map((c) => <a key={c.id} className="qitp-attn-pill" href={`/cabin/${c.token}`} target="_blank" rel="noreferrer">{c.number}</a>)}
        {cabins.length > 40 && <span className="muted" style={{ fontSize: 12 }}>+{cabins.length - 40}</span>}
      </div>
    </div>
  );
}

function CabinCard({ c }: { c: QitpCabinCard }) {
  return (
    <div className="qitp-card-wrap">
    <a className="qitp-card-pdf" href={cabinRecordUrl(c.token)}
       title={`Download cabin ${c.number} quality record (PDF)`} aria-label={`Download cabin ${c.number} quality record`}>⤓</a>
    <a className="qitp-card" href={`/cabin/${c.token}`} target="_blank" rel="noreferrer">
      <span className={`qitp-band ${c.floor.toLowerCase()}`} title={c.floor} />
      <Ring done={c.done} total={c.total} status={c.status} number={c.number} />
      <div className="qitp-card-meta">
        <span className={`qitp-dot ${c.status}`} /> {STATE_LABEL[c.status]}
        {c.dismantle_day != null && <span className="qitp-day">Day {c.dismantle_day}</span>}
        {c.reinstall_date && <span className="qitp-day" title={`Reinstall ${fmtLiftDate(c.reinstall_date)}`}>↩ {new Date(c.reinstall_date + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>}
      </div>
    </a>
    </div>
  );
}

/** Progress ring: arc = sections complete / total, colour by cabin state. */
function Ring({ done, total, status, number }: { done: number; total: number; status: CabinState; number: string }) {
  const r = 30, C = 2 * Math.PI * r;
  const pct = total ? done / total : 0;
  return (
    <div className="qitp-ring">
      <svg viewBox="0 0 72 72" width="72" height="72">
        <circle cx="36" cy="36" r={r} className="qitp-ring-bg" fill="none" strokeWidth="6" />
        <circle cx="36" cy="36" r={r} className={`qitp-ring-fg ${status}`} fill="none" strokeWidth="6"
          strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - pct)} transform="rotate(-90 36 36)" />
      </svg>
      <div className="qitp-ring-num">{number}</div>
      <div className="qitp-ring-sub">{done}/{total}</div>
    </div>
  );
}
