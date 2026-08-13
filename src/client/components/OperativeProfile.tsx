import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { SignaturePad } from "./SignaturePad";
import { RamsReadThrough, type GeoStatus, type SignCoords } from "./RamsReadThrough";
import type { RamsDoc } from "../../shared/rams";
import { QUAL_TYPES } from "../lib/quals";
// Bundled (served from the Access-bypassed /assets path) so the logo loads on the
// public profile — a bare /logo.png is blocked by Access for un-signed-in operatives.
import logoUrl from "../logo.png";

type Profile = Awaited<ReturnType<typeof api.pubOperative>>;
type Rams = Profile["rams"][number];

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "");
const fmtMonthYear = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "");
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

function statusPill(s: string) {
  return s === "expired" ? "rejected" : s === "expiring" || s === "pending" ? "warn" : s === "valid" ? "ok" : "neutral";
}

export function OperativeProfile() {
  const { token = "" } = useParams<{ token: string }>();
  const [p, setP] = useState<Profile | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  function load() { api.pubOperative(token).then(setP).catch((e) => setLoadErr(e.message)); }
  useEffect(load, [token]);

  if (loadErr) {
    return (
      <div className="site-signin-page"><div className="site-signin-inner">
        <img className="site-logo" src={logoUrl} alt="PGP" />
        <div className="card" style={{ textAlign: "center" }}>
          <h2 style={{ marginTop: 0 }}>Profile unavailable</h2>
          <p className="muted">{loadErr}</p>
        </div>
      </div></div>
    );
  }
  if (!p) {
    return <div className="site-signin-page"><div className="site-signin-inner"><div className="empty">Loading…</div></div></div>;
  }

  const op = p.operative;
  const pendingRams = p.rams.filter((r) => !r.signed_at);
  const signedRams = p.rams.filter((r) => r.signed_at);
  const hasRams = p.rams.length > 0;
  const talks = p.toolbox_talks ?? [];
  const pendingTalks = talks.filter((t) => !t.acked_at);
  const ackedTalks = talks.filter((t) => t.acked_at);

  // "Get site-ready" onboarding checklist. The RAMS step is a single, truthful
  // line: only "done" once they've actually signed (and none are outstanding) —
  // never green just because nothing's been assigned to them yet.
  const steps = [
    { label: "Details", done: !!(op.phone || op.email) },
    {
      label: pendingRams.length > 0 ? `Sign RAMS (${pendingRams.length})` : hasRams ? "RAMS signed" : "RAMS",
      done: hasRams && pendingRams.length === 0,
    },
    { label: "Induction", done: op.induction_done },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const currentIdx = steps.findIndex((s) => !s.done);

  return (
    <div className="site-signin-page">
      <div className="site-signin-inner">
        <img className="site-logo" src={logoUrl} alt="PGP" />
        <div className="op-head" style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div className="avatar" style={{ width: 60, height: 60, fontSize: 20, marginBottom: 12 }}>{initials(op.name)}</div>
          <div className="site-code" style={{ textAlign: "center" }}>{op.name}</div>
          <div className="site-name" style={{ textAlign: "center" }}>{[op.company, op.trade].filter(Boolean).join(" · ") || "Operative profile"}</div>
        </div>

        {/* Get site-ready progress */}
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <h3 className="serif" style={{ margin: 0, fontSize: 17 }}>Get site-ready</h3>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--accent-2)" }}>{doneCount} of {steps.length} done</span>
          </div>
          <div style={{ height: 6, borderRadius: 99, background: "var(--line)", margin: "10px 0 12px", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(doneCount / steps.length) * 100}%`, background: "var(--accent)", borderRadius: 99, transition: "width 200ms" }} />
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: "6px 16px", fontSize: 13 }}>
            {steps.map((s, i) => (
              <span key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontWeight: i === currentIdx ? 700 : 400, color: s.done ? "var(--success)" : i === currentIdx ? "var(--accent-2)" : "var(--muted)" }}>
                <span aria-hidden>{s.done ? "✓" : i === currentIdx ? "●" : "○"}</span>{s.label}
              </span>
            ))}
          </div>
        </div>

        {/* Action needed — RAMS to read & sign */}
        {pendingRams.length > 0 && (
          <div className="card op-action" style={{ marginBottom: 14, border: "1.5px solid var(--accent)" }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span className="eyebrow" style={{ color: "var(--accent-2)" }}>Action needed</span>
              <span className="pill warn dot">{pendingRams.length} to sign</span>
            </div>
            {pendingRams.map((r) => <RamsReader key={r.id} token={token} rams={r} onSigned={load} />)}
          </div>
        )}

        {/* Action needed — toolbox talks to read & acknowledge. Same gated
            read-through as RAMS; acknowledged, never signed. */}
        {pendingTalks.length > 0 && (
          <div className="card op-action" style={{ marginBottom: 14, border: "1.5px solid var(--accent)" }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span className="eyebrow" style={{ color: "var(--accent-2)" }}>Action needed</span>
              <span className="pill warn dot">{pendingTalks.length} talk{pendingTalks.length === 1 ? "" : "s"} to read</span>
            </div>
            {pendingTalks.map((t) => <TalkReader key={t.id} token={token} talk={t} onAcked={load} />)}
          </div>
        )}

        {/* Company induction — read & self-confirm */}
        <CompanyInductionCard token={token} p={p} onChanged={load} />

        {/* Site induction — for the site they're currently assigned to */}
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 6 }}>Site induction{p.site_induction ? ` · ${p.site_induction.project_code}` : ""}</div>
              {!p.site_induction
                ? <span className="muted" style={{ fontSize: 13 }}>Not on a site yet</span>
                : p.site_induction.inducted_at
                  ? <span className="pill ok dot">Inducted · {fmtDate(p.site_induction.inducted_at)}</span>
                  : <span className="pill warn dot">Not yet inducted</span>}
            </div>
            {p.site_induction && !p.site_induction.inducted_at && <span className="muted" style={{ fontSize: 12.5 }}>your site manager inducts you on site</span>}
          </div>
        </div>

        {/* Qualification cards */}
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div className="eyebrow">Qualification cards</div>
            <span className="muted" style={{ fontSize: 13 }}>{p.quals.length}</span>
          </div>
          {p.quals.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: "0 0 4px" }}>No cards yet — add yours below.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {p.quals.map((q) => (
                <div key={q.id} className="row" style={{ alignItems: "center", gap: 10 }}>
                  <span className="op-card-ic" aria-hidden>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ink-2)" strokeWidth="1.8"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{q.file_url ? <a href={q.file_url} target="_blank" rel="noreferrer">{q.qual_type}</a> : q.qual_type}{q.card_no ? <span className="muted" style={{ fontWeight: 400 }}> · {q.card_no}</span> : ""}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{q.status === "pending" ? "Awaiting verification" : "On file"}</div>
                  </span>
                  <span className={`pill ${statusPill(q.status)}`} style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>
                    {q.status === "pending" ? "pending" : q.status === "expired" ? "expired" : q.expiry_date ? `Expires ${fmtMonthYear(q.expiry_date)}` : "No expiry"}
                  </span>
                </div>
              ))}
            </div>
          )}
          <AddCard token={token} onAdded={load} />
        </div>

        {/* Signed RAMS history */}
        {signedRams.length > 0 && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>Signed RAMS</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {signedRams.map((r) => (
                <div key={r.id} className="row" style={{ alignItems: "center", gap: 8 }}>
                  <span style={{ flex: 1 }}>{r.project_code} · {r.title}</span>
                  <span className="pill ok dot" style={{ whiteSpace: "nowrap" }}>Signed{r.signed_at ? ` · ${fmtDate(r.signed_at)}` : ""}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Acknowledged toolbox talks — their own H&S record */}
        {ackedTalks.length > 0 && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>Toolbox talks read</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {ackedTalks.map((t) => (
                <div key={t.id} className="row" style={{ alignItems: "center", gap: 8 }}>
                  <span style={{ flex: 1 }}>{t.project_code} · {t.title}</span>
                  <span className="pill ok dot" style={{ whiteSpace: "nowrap" }}>
                    Acknowledged{t.acked_at ? ` · ${fmtDate(t.acked_at)}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Your details (read-only) */}
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Your details</div>
          <div className="row" style={{ justifyContent: "space-between", gap: 12, fontSize: 14, padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
            <span className="muted">Mobile</span><span style={{ fontWeight: 600 }}>{op.phone || "—"}</span>
          </div>
          <div className="row" style={{ justifyContent: "space-between", gap: 12, fontSize: 14, padding: "8px 0 4px" }}>
            <span className="muted">Email</span><span style={{ fontWeight: 600, wordBreak: "break-all", textAlign: "right" }}>{op.email || "—"}</span>
          </div>
        </div>

        <div className="site-foot muted">🔒 Secure link · no password needed</div>
        <div className="site-foot muted" style={{ marginTop: 2 }}>PowerGrid Projects · Operative profile</div>
      </div>
    </div>
  );
}

/** Company induction: read the standard induction document then self-confirm,
 *  which marks the operative company-inducted. Mirrors the RAMS read flow. */
function CompanyInductionCard({ token, p, onChanged }: { token: string; p: Profile; onChanged: () => void }) {
  const inducted = p.operative.induction_done;
  const ci = p.company_induction;
  const [open, setOpen] = useState(false);
  const [doc, setDoc] = useState<{ html: string | null; file_url: string | null } | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function openDoc() {
    setOpen(true); setErr(null);
    if (!doc) {
      try { const r = await api.pubCompanyInduction(); setDoc({ html: r.html ?? null, file_url: r.file_url ?? null }); }
      catch (e) { setErr(e instanceof Error ? e.message : "couldn't load the induction"); }
    }
  }
  async function confirm() {
    setBusy(true); setErr(null);
    try { await api.pubConfirmInduction(token); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't confirm"); setBusy(false); }
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>Company induction</div>
      {inducted ? (
        <span className="pill ok dot">Completed{p.operative.induction_at ? ` · ${fmtDate(p.operative.induction_at)}` : ""}</span>
      ) : !ci.available ? (
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <span className="pill warn dot">Not yet completed</span>
          <span className="muted" style={{ fontSize: 12.5 }}>see your site manager</span>
        </div>
      ) : !open ? (
        <>
          <p className="muted" style={{ fontSize: 13, margin: "0 0 10px" }}>Read {ci.filename || "the company induction"}, then confirm you've completed it.</p>
          <button className="primary" onClick={openDoc}>Read company induction</button>
        </>
      ) : (
        <>
          {err && <div className="flash error" style={{ marginBottom: 10 }}>{err}</div>}
          {doc?.html
            ? <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--line)", borderRadius: "var(--radius-md)", padding: 12, marginBottom: 12, fontSize: 14, lineHeight: 1.5 }} dangerouslySetInnerHTML={{ __html: doc.html }} />
            : doc?.file_url
              ? <a className="btn" href={doc.file_url} target="_blank" rel="noreferrer" style={{ display: "inline-flex", marginBottom: 12 }}>Open induction document ↗</a>
              : <div className="muted" style={{ marginBottom: 12 }}>Loading…</div>}
          <label className="row" style={{ alignItems: "center", gap: 8, fontSize: 13.5, marginBottom: 10 }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ width: 16, height: 16 }} />
            I confirm I have read and completed the company induction
          </label>
          <button className="primary" disabled={!ack || busy} onClick={confirm}>{busy ? "Confirming…" : "Confirm induction"}</button>
        </>
      )}
    </div>
  );
}

/** RAMS read-and-sign with scroll gating: the converted document is shown inline
 *  and "Sign & confirm" stays locked until the operative has scrolled to the end. */
function RamsReader({ token, rams, onSigned }: { token: string; rams: Rams; onSigned: () => void }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [html, setHtml] = useState<string | null>(null);
  const [sections, setSections] = useState<RamsDoc | null>(null);
  const [read, setRead] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const readerRef = useRef<HTMLDivElement>(null);

  async function openReader() {
    setOpen(true);
    if (status === "idle") {
      setStatus("loading");
      try {
        const r = await api.pubRamsContent(token, rams.id);
        setHtml(r.html);
        setSections(r.sections ?? null);
        setStatus("ready");
      } catch { setStatus("error"); }
    }
  }

  // A document that fits without scrolling counts as read immediately.
  useEffect(() => {
    if (status === "ready" && html && readerRef.current) {
      const el = readerRef.current;
      if (el.scrollHeight <= el.clientHeight + 8) setRead(true);
    }
  }, [status, html]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 12) setRead(true);
  }

  async function sign() {
    if (!sig || !read) return;
    setBusy(true); setErr(null);
    try {
      await api.pubSignRams(token, { sign_id: rams.id, signature: sig });
      onSigned();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't save"); setBusy(false); }
  }

  return (
    <div className="card" style={{ margin: "8px 0 0", padding: 14 }}>
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <span className="pill" style={{ background: "var(--accent-soft)", color: "var(--accent-2)", fontWeight: 700 }}>RAMS</span>
        <span style={{ fontWeight: 700 }}>{rams.project_code} · {rams.title}</span>
      </div>

      {!rams.has_html ? (
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          This RAMS needs re-uploading as a Word document before it can be signed — ask your site manager.
        </p>
      ) : !open ? (
        <>
          <p style={{ fontSize: 13.5, margin: "8px 0 10px" }}>
            <b style={{ color: "var(--accent-2)" }}>Read the document below</b>, then sign to confirm you understand it.
          </p>
          <button className="primary" style={{ width: "100%" }} onClick={openReader}>Read &amp; sign</button>
        </>
      ) : (
        <>
          {err && <div className="flash error" style={{ marginTop: 8 }}>{err}</div>}
          {status === "loading" && <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>Loading document…</p>}
          {status === "error" && <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>Couldn't load the document. Pull to refresh, or ask your site manager.</p>}
          {/* Structured doc → full-screen gated reader; older HTML-only docs use the inline reader. */}
          {status === "ready" && sections ? (
            <div className="rams-fs">
              <div className="rams-fs-bar">
                <button className="ghost" onClick={() => setOpen(false)}>✕ Close</button>
                <span className="muted" style={{ fontSize: 12 }}>Read &amp; sign</span>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <RamsReadThrough
                  doc={sections}
                  title={rams.title}
                  projectCode={rams.project_code}
                  signedAt={rams.signed_at}
                  onAccept={async (signature) => { await api.pubSignRams(token, { sign_id: rams.id, signature }); onSigned(); }}
                />
              </div>
            </div>
          ) : status === "ready" && html ? (
            <>
              <div
                ref={readerRef}
                className="rams-doc"
                onScroll={onScroll}
                dangerouslySetInnerHTML={{ __html: html }}
              />
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center", margin: "8px 0 4px" }}>
                <span className="muted" style={{ fontSize: 12 }}>{read ? "" : "Scroll to the end to continue"}</span>
                {read ? <span className="pill ok dot">✓ Read</span> : <span className="pill neutral">Keep reading…</span>}
              </div>
              <div className="field" style={{ marginTop: 8, opacity: read ? 1 : 0.5, pointerEvents: read ? "auto" : "none" }}>
                <span>Your signature</span>
                <SignaturePad onChange={setSig} />
              </div>
              <button className="primary" style={{ width: "100%", marginTop: 8 }} onClick={sign} disabled={!read || !sig || busy}>
                {busy ? "Saving…" : "Sign & confirm"}
              </button>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Confirm + finger signature + location for a talk that has no structured
 *  sections to gate (a PDF). Same record as the gated reader produces, so a PDF
 *  talk isn't a weaker piece of evidence than a Word one. */
function TalkSignOff({ onSign }: {
  onSign: (sig: string, geo?: { coords: SignCoords | null; status: GeoStatus }) => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [geo, setGeo] = useState<GeoStatus | "idle" | "locating">("idle");

  function captureLocation(): Promise<{ coords: SignCoords | null; status: GeoStatus }> {
    return new Promise((resolve) => {
      if (!("geolocation" in navigator)) { setGeo("unavailable"); resolve({ coords: null, status: "unavailable" }); return; }
      setGeo("locating");
      navigator.geolocation.getCurrentPosition(
        (p) => { setGeo("ok"); resolve({ coords: { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }, status: "ok" }); },
        (e) => { const s: GeoStatus = e.code === e.PERMISSION_DENIED ? "denied" : "unavailable"; setGeo(s); resolve({ coords: null, status: s }); },
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
      );
    });
  }
  useEffect(() => { void captureLocation(); /* eslint-disable-next-line */ }, []);

  async function go() {
    if (!confirmed || !sig) return;
    setBusy(true); setErr(null);
    try { await onSign(sig, await captureLocation()); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't save your signature"); setBusy(false); }
  }
  return (
    <div className="rams-signoff" style={{ marginTop: 10 }}>
      <div className="rams-signoff-hd">Sign-off</div>
      {err && <div className="flash error" style={{ marginBottom: 8 }}>{err}</div>}
      <label className="rams-confirm">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <span>I have read and understood this toolbox talk and will follow the points it sets out.</span>
      </label>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {geo === "locating" ? "📍 Getting your location…"
          : geo === "ok" ? "📍 Location recorded"
          : geo === "denied" ? "📍 Location is off — you can still sign, but it won't record where you took the talk."
          : geo === "unavailable" ? "📍 No location fix — you can still sign; it'll be recorded without one."
          : null}
      </div>
      <div className="rams-sigwrap">
        <div className="rams-sig-label">Sign above with your finger</div>
        <SignaturePad onChange={setSig} />
      </div>
      <button className="accent rams-accept" disabled={!confirmed || !sig || busy} onClick={() => void go()}>
        {busy ? "Saving…" : "Sign & complete talk"}
      </button>
    </div>
  );
}

/** One toolbox talk awaiting sign-off. Deliberately the RAMS reader — same
 *  section-by-section gating and scroll-to-end — in talk mode: finger signature
 *  plus the location they took it at, which is what makes the record stand up. */
function TalkReader({ token, talk, onAcked }: {
  token: string;
  talk: NonNullable<Profile["toolbox_talks"]>[number];
  onAcked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [doc, setDoc] = useState<RamsDoc | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function openReader() {
    setOpen(true);
    if (status === "ready") return;
    setStatus("loading"); setErr(null);
    try {
      const r = await api.pubToolboxContent(token, talk.id);
      setDoc((r.doc as RamsDoc | null) ?? null);
      setHtml(r.html); setText(r.text);
      setStatus("ready");
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't load"); setStatus("error"); }
  }
  async function ack(signature: string, geo?: { coords: SignCoords | null; status: GeoStatus }) {
    await api.pubAckToolbox(token, talk.id, {
      signature,
      lat: geo?.coords?.lat ?? null,
      lng: geo?.coords?.lng ?? null,
      accuracy: geo?.coords?.accuracy ?? null,
      geo_status: geo?.status ?? null,
    });
    onAcked();
  }

  return (
    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: 10 }}>
      <div style={{ fontWeight: 700, fontSize: 15 }}>{talk.title}</div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        {talk.project_code} · toolbox talk {fmtDate(talk.notice_date)}
      </div>
      {!open ? (
        <>
          <p style={{ fontSize: 13.5, margin: "8px 0 10px" }}>
            <b style={{ color: "var(--accent-2)" }}>Read the talk below</b>, then sign it. Keep location on so it records where you took it.
          </p>
          <button className="primary" style={{ width: "100%" }} onClick={() => void openReader()}>Read &amp; sign</button>
        </>
      ) : (
        <>
          {err && <div className="flash error" style={{ marginTop: 8 }}>{err}</div>}
          {status === "loading" && <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>Loading talk…</p>}
          {status === "error" && <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>Couldn't load the talk. Pull to refresh, or ask your site manager.</p>}
          {/* Structured → the gated reader. Otherwise the text/HTML still reads,
              just as one page, with a plain confirm. */}
          {status === "ready" && doc ? (
            <div className="rams-fs">
              <div className="rams-fs-bar">
                <button className="ghost" onClick={() => setOpen(false)}>✕ Close</button>
                <span className="muted" style={{ fontSize: 12 }}>Read &amp; sign</span>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <RamsReadThrough
                  doc={doc}
                  title={talk.title}
                  projectCode={talk.project_code}
                  signedAt={talk.acked_at}
                  talk
                  onAccept={ack}
                />
              </div>
            </div>
          ) : status === "ready" ? (
            <>
              {html
                ? <div className="rams-doc" dangerouslySetInnerHTML={{ __html: html }} />
                : <div className="rams-doc" style={{ whiteSpace: "pre-wrap" }}>{text || "No details were recorded for this talk."}</div>}
              {/* No structured sections (a PDF talk) so there's no read-gate — but
                  the record still needs the same signature + location. */}
              <TalkSignOff onSign={ack} />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function AddCard({ token, onAdded }: { token: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<string>(QUAL_TYPES[0]);
  // Only a deliberately-picked type overrides what's read off the card photo.
  const [typeTouched, setTypeTouched] = useState(false);
  const [cardNo, setCardNo] = useState("");
  const [expiry, setExpiry] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.set("qual_type", type);
      fd.set("qual_type_manual", typeTouched ? "1" : "0");
      if (cardNo.trim()) fd.set("card_no", cardNo.trim());
      if (expiry) fd.set("expiry_date", expiry);
      if (file) fd.set("file", file);
      await api.pubAddOperativeQual(token, fd);
      setOpen(false); setType(QUAL_TYPES[0]); setTypeTouched(false); setCardNo(""); setExpiry(""); setFile(null);
      setDone(true); setTimeout(() => setDone(false), 4000);
      onAdded();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't upload card"); }
    finally { setBusy(false); }
  }

  if (!open) {
    return (
      <div style={{ marginTop: 12 }}>
        <button className="ghost" style={{ width: "100%", borderStyle: "dashed" }} onClick={() => setOpen(true)}>+ Add a card</button>
        {done && <p className="muted" style={{ fontSize: 12, marginTop: 6, textAlign: "center" }}>Sent — your site manager will verify it.</p>}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      {err && <div className="flash error">{err}</div>}
      <label className="field"><span>Card type (read from the photo if left as-is)</span>
        <select className="input" value={type} onChange={(e) => { setType(e.target.value); setTypeTouched(true); }}>{QUAL_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
      </label>
      <div className="site-2col">
        <label className="field"><span>Card number</span>
          <input className="input" value={cardNo} onChange={(e) => setCardNo(e.target.value)} />
        </label>
        <label className="field"><span>Expiry</span>
          <input className="input" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </label>
      </div>
      <label className="field"><span>Photo of the card</span>
        <input className="input" type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <p className="muted" style={{ fontSize: 12, margin: "2px 0 8px" }}>Uploaded cards are checked by your site manager before they count.</p>
      <button className="primary" style={{ width: "100%" }} onClick={submit} disabled={busy}>{busy ? "Uploading…" : "Upload card"}</button>
      <button className="ghost" style={{ width: "100%", marginTop: 6 }} onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}
