import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SignaturePad } from "./SignaturePad";
import type { RamsBlock, RamsDoc, RamsSection, RiskRow, RiskScore } from "../../shared/rams";

/**
 * Operative-facing RAMS read-through + sign-off. Renders a structured RamsDoc one
 * section at a time, in order: a top stepper and bottom pills show progress; each
 * section's Next button stays locked until the reader has scrolled to that
 * section's end; the final section reveals the confirm-tick + finger-signature
 * accept panel. The legal audit trail: read (every section, in order) → confirm →
 * sign. Upcoming sections can't be opened early.
 */
/** Where the operative was when they signed. Null = no fix; `status` says why. */
export type SignCoords = { lat: number; lng: number; accuracy: number };
export type GeoStatus = "ok" | "denied" | "unavailable";

export function RamsReadThrough({
  doc, title, projectCode, signedAt, onAccept, freeNav, talk,
}: {
  doc: RamsDoc;
  title: string;
  projectCode?: string;
  signedAt?: string | null;
  onAccept?: (signatureDataUrl: string, geo?: { coords: SignCoords | null; status: GeoStatus }) => Promise<void> | void;
  /** Free navigation — every section open from the start. Set for an
   *  already-signed RAMS being re-read (no need to re-gate). */
  freeNav?: boolean;
  /** Toolbox-talk mode: identical read-gating and finger signature, but the
   *  wording says "talk", and the sign-off also records where they were. A talk
   *  is delivered on site, so location is part of proving they took it; RAMS is
   *  signed before ever coming to site, where a location would prove nothing. */
  talk?: boolean;
}) {
  const sections = doc.sections;
  const last = sections.length - 1;
  const allOpen = freeNav || !!signedAt;
  const [idx, setIdx] = useState(0);
  const [furthest, setFurthest] = useState(allOpen ? last : 0); // highest section unlocked (reached via Next)
  const [read, setRead] = useState(false);          // scrolled current section to its end
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const onLast = idx === last;

  /** Has the section's CONTENT been read to its end? Measured off the marker
   *  that sits directly after the content — NOT off the scroll container's full
   *  height, because on the last section the sign-off panel (tick, signature pad,
   *  accept button) is inside that same scroll. Measuring the container made the
   *  tick box stay disabled until you'd scrolled past the signature pad, so it
   *  looked like you had to sign before you could tick. You read the talk; the
   *  sign-off is not part of the talk. */
  function contentRead(): boolean {
    const el = scrollRef.current, end = endRef.current;
    if (!el || !end) return false;
    // The marker has reached the bottom edge or risen above it. It's zero-height
    // and last in the content, so at full scroll its top lands EXACTLY on the
    // container's bottom — the slack must be positive or the gate never opens.
    return end.getBoundingClientRect().top <= el.getBoundingClientRect().bottom + 4;
  }
  // Re-evaluate on entering a section: content that fits without scrolling is
  // read immediately; otherwise wait until the end marker comes into view.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
    setRead(contentRead());
  }, [idx]);

  function onScroll() {
    if (read) return;
    if (contentRead()) setRead(true);
  }

  function go(to: number) {
    if (to < 0 || to > furthest) return;            // can't open locked sections
    setIdx(to);
  }
  function next() {
    if (!read) return;
    if (idx === furthest && idx < last) setFurthest(idx + 1);
    if (idx < last) setIdx(idx + 1);
  }

  const allRead = furthest >= last && read;          // reached + read the final section

  return (
    <div className="rams-rt">
      {/* Masthead + top stepper */}
      <div className="rams-rt-head">
        <div className="rams-rt-title">
          {projectCode && <span className="rams-rt-proj">{projectCode}</span>}
          <span>{title}</span>
        </div>
        <Stepper sections={sections} idx={idx} furthest={furthest} onPick={go} />
      </div>

      {/* The one current section, scrollable */}
      <div className="rams-rt-scroll" ref={scrollRef} onScroll={onScroll}>
        <SectionView section={sections[idx]} />
        {/* End of the CONTENT — must stay above the sign-off panel. Below it, the
            read-gate would only open once you'd scrolled past the signature pad. */}
        <div ref={endRef} className="rams-rt-end" aria-hidden />
        {onLast && (
          <SignOffPanel signedAt={signedAt} canSign={allRead} onAccept={onAccept}
            talk={talk} docLabel={talk ? "Talk" : "RAMS"} />
        )}
      </div>

      {/* Footer: Back + scroll-gate/Next; bottom pills */}
      {!(onLast && signedAt) && (
        <div className="rams-rt-foot">
          <button className="ghost" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>‹ Back</button>
          {!onLast ? (
            <button className="accent grow" disabled={!read} onClick={next}>
              {read ? `Next: ${shortTitle(sections[idx + 1])} →` : "Scroll to the end to continue"}
            </button>
          ) : (
            <div className="muted" style={{ flex: 1, textAlign: "right", fontSize: 12 }}>
              {allRead ? "Confirm & sign below" : "Scroll to the end to continue"}
            </div>
          )}
        </div>
      )}
      <Pills sections={sections} idx={idx} furthest={furthest} onPick={go} />
    </div>
  );
}

function shortTitle(s: RamsSection | undefined): string {
  if (!s) return "";
  return s.title.replace(/^(\d+|[A-Z])\.\s*/, "").replace(/^Appendix\s+[A-Z]\s*[–-]\s*/i, "").slice(0, 22);
}

/* ── Stepper (top) + Pills (bottom): both auto-scroll the active item into view
 *    using scrollIntoView (relative to the real scroll container — never offsetLeft). */
function Stepper({ sections, idx, furthest, onPick }: StepProps) {
  const ref = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); }, [idx]);
  return (
    <div className="rams-steps" ref={ref}>
      {sections.map((s, i) => {
        const state = i < furthest ? "done" : i === idx ? "current" : i <= furthest ? "done" : "locked";
        return (
          <button key={s.id} ref={i === idx ? activeRef : undefined}
            className={`rams-step ${state}`} disabled={i > furthest} onClick={() => onPick(i)}>
            <span className="rams-step-n">{i < furthest ? "✓" : i > furthest ? "🔒" : (s.number ?? i + 1)}</span>
            <span className="rams-step-l">{shortTitle(s) || s.title}</span>
          </button>
        );
      })}
    </div>
  );
}
function Pills({ sections, idx, furthest, onPick }: StepProps) {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); }, [idx]);
  return (
    <div className="rams-pills">
      {sections.map((s, i) => {
        const state = i === idx ? "current" : i < furthest ? "done" : i <= furthest ? "done" : "locked";
        return (
          <button key={s.id} ref={i === idx ? activeRef : undefined}
            className={`rams-pill ${state}`} disabled={i > furthest} onClick={() => onPick(i)} title={s.title}>
            {i < furthest ? "✓ " : i > furthest ? "🔒 " : ""}{s.number ?? i + 1}
          </button>
        );
      })}
    </div>
  );
}
type StepProps = { sections: RamsSection[]; idx: number; furthest: number; onPick: (i: number) => void };

/* ── A single section's blocks ─────────────────────────────────────────────── */
function SectionView({ section }: { section: RamsSection }) {
  const [zoom, setZoom] = useState<string | null>(null);
  // Appendices carry their letter inside the title ("Appendix F – …"), so don't
  // also show the number badge; numbered sections show "N" + the de-numbered title.
  const isAppendix = /^appendix/i.test(section.title);
  const heading = isAppendix ? section.title : section.title.replace(/^\d+[.)]\s*/, "");
  const showNum = !!section.number && !isAppendix;
  return (
    <div className="rams-section">
      <h1 className="rams-h1">{showNum ? <span className="rams-num">{section.number}</span> : null}{heading}</h1>
      {section.blocks.map((b, i) => <BlockView key={i} block={b} onZoom={setZoom} />)}
      {zoom && (
        <div className="rams-lightbox" onClick={() => setZoom(null)}>
          <img src={zoom} alt="" /><button className="rams-lightbox-x" onClick={() => setZoom(null)}>✕</button>
        </div>
      )}
    </div>
  );
}

function BlockView({ block, onZoom }: { block: RamsBlock; onZoom: (src: string) => void }) {
  switch (block.type) {
    case "paragraph":
      return <p className={block.bold ? "rams-sub" : "rams-p"}>{block.text}</p>;
    case "list":
      return block.ordered
        ? <ol className="rams-ol">{block.items.map((it, i) => <li key={i}>{it}</li>)}</ol>
        : <ul className="rams-ul">{block.items.map((it, i) => <li key={i}>{it}</li>)}</ul>;
    case "keyvalue":
      return <div className="rams-kv">{block.rows.map((r, i) => <div key={i} className="rams-kv-row"><span className="rams-kv-k">{r.label}</span><span className="rams-kv-v">{r.value}</span></div>)}</div>;
    case "callout":
      return <div className="rams-callout">{block.text}</div>;
    case "riskRegister":
      return <div className="rams-risks">{block.rows.map((r, i) => <RiskCard key={i} row={r} />)}</div>;
    case "table":
      return (
        <div className="rams-table-wrap"><table className="rams-table">
          <thead><tr>{block.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>{block.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
        </table></div>
      );
    case "image":
      return <RamsImage src={block.src} alt={block.alt} w={block.w} onZoom={onZoom} />;
    case "rawPage":
      return <div className="rams-raw"><div className="rams-raw-note">Shown as-is (couldn't auto-format)</div>{block.blocks.map((b, i) => <BlockView key={i} block={b} onZoom={onZoom} />)}</div>;
    default:
      return null;
  }
}

/** A RAMS image that never upscales (caps to its natural width). Defensive for
 *  older stored docs whose decorative tick/checkbox marks were saved as full
 *  image blocks: anything that loads at ≤40px in both dimensions is hidden. */
function RamsImage({ src, alt, w, onZoom }: { src: string; alt?: string; w?: number; onZoom: (src: string) => void }) {
  const [hide, setHide] = useState(false);
  const [maxW, setMaxW] = useState<number | undefined>(w);
  if (hide) return null;
  return (
    <img
      className="rams-img" src={src} alt={alt ?? ""}
      style={maxW ? { maxWidth: maxW } : undefined}
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalWidth && img.naturalHeight && Math.max(img.naturalWidth, img.naturalHeight) <= 40) setHide(true);
        else if (!maxW && img.naturalWidth) setMaxW(img.naturalWidth);
      }}
      onClick={() => onZoom(src)}
    />
  );
}

function ratingTone(rating: number | null): string {
  if (rating == null) return "none";
  if (rating <= 6) return "green";
  if (rating <= 12) return "amber";
  return "red";
}
function Chip({ label, score }: { label: string; score: RiskScore | null }) {
  const tone = ratingTone(score?.rating ?? null);
  return (
    <div className={`rams-chip ${tone}`}>
      <span className="rams-chip-l">{label}</span>
      {score?.likelihood != null && score?.severity != null
        ? <span className="rams-chip-ls">{score.likelihood}×{score.severity}</span> : null}
      <span className="rams-chip-r">{score?.rating ?? "—"}</span>
    </div>
  );
}
function RiskCard({ row }: { row: RiskRow }) {
  const hasScores = (row.initial?.rating ?? null) != null || (row.residual?.rating ?? null) != null;
  return (
    <div className="rams-risk">
      <div className="rams-risk-hd">
        {row.ref && <span className="rams-risk-ref">{row.ref}</span>}
        <div><div className="rams-risk-haz">{row.hazard}</div>{row.who && <div className="rams-risk-who">Who: {row.who}</div>}</div>
      </div>
      {hasScores && (
        <div className="rams-risk-scores"><Chip label="Initial" score={row.initial} /><span className="rams-risk-arrow">→</span><Chip label="Residual" score={row.residual} /></div>
      )}
      {row.controls.length > 0 && (
        <ul className="rams-risk-controls">{row.controls.map((c, i) => <li key={i}>{c}</li>)}</ul>
      )}
    </div>
  );
}

/* ── Sign-off panel (last section) ─────────────────────────────────────────── */
function SignOffPanel({ signedAt, canSign, onAccept, talk, docLabel }: {
  signedAt?: string | null; canSign: boolean;
  onAccept?: (sig: string, geo?: { coords: SignCoords | null; status: GeoStatus }) => Promise<void> | void;
  /** Toolbox talk: also record where they were. Best-effort — a refused or
   *  failed fix must never stop an operative completing a talk on site, so it
   *  saves with the reason instead of blocking. */
  talk?: boolean; docLabel: string;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [coords, setCoords] = useState<SignCoords | null>(null);
  const [geo, setGeo] = useState<GeoStatus | "idle" | "locating">("idle");

  function captureLocation(): Promise<{ coords: SignCoords | null; status: GeoStatus }> {
    return new Promise((resolve) => {
      if (!("geolocation" in navigator)) { setGeo("unavailable"); resolve({ coords: null, status: "unavailable" }); return; }
      setGeo("locating");
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const c = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
          setCoords(c); setGeo("ok"); resolve({ coords: c, status: "ok" });
        },
        (e) => {
          const status: GeoStatus = e.code === e.PERMISSION_DENIED ? "denied" : "unavailable";
          setGeo(status); resolve({ coords: null, status });
        },
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
      );
    });
  }
  // Ask as soon as they can sign, so the permission prompt isn't racing the tap.
  useEffect(() => { if (talk && canSign && geo === "idle") void captureLocation(); /* eslint-disable-next-line */ }, [talk, canSign]);

  if (signedAt) {
    return (
      <div className="rams-signed">
        ✓ {docLabel} signed · {new Date(signedAt).toLocaleString("en-GB")}
      </div>
    );
  }
  async function accept() {
    if (!confirmed || !sig) return;
    setBusy(true); setErr(null);
    try {
      // Refresh at the moment of signing — where they are NOW is the record.
      const g = talk ? await captureLocation() : undefined;
      await onAccept?.(sig, g);
    }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't save your signature"); }
    finally { setBusy(false); }
  }
  return (
    <div className={`rams-signoff${canSign ? "" : " disabled"}`}>
      <div className="rams-signoff-hd">Sign-off</div>
      {!canSign && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Read every section to the end before signing.</div>
      )}
      {err && <div className="flash error" style={{ marginBottom: 8 }}>{err}</div>}
      <label className="rams-confirm">
        <input type="checkbox" checked={confirmed} disabled={!canSign} onChange={(e) => setConfirmed(e.target.checked)} />
        <span>
          {talk
            ? "I have read and understood this toolbox talk and will follow the points it sets out."
            : "I have read and understood this RAMS in full and agree to work to it and follow all the control measures it sets out."}
        </span>
      </label>
      {talk && canSign && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          {geo === "locating" ? "📍 Getting your location…"
            : geo === "ok" ? `📍 Location recorded${coords ? ` · ±${Math.round(coords.accuracy)}m` : ""}`
            : geo === "denied" ? "📍 Location is off — you can still sign, but it won't record where you took the talk. Turn location on for this site to record it."
            : geo === "unavailable" ? "📍 No location fix — you can still sign; it'll be recorded without one."
            : null}
        </div>
      )}
      <div className="rams-sigwrap">
        <div className="rams-sig-label">Sign above with your finger</div>
        <SignaturePad onChange={setSig} />
      </div>
      {/* Tick and signature can be done in EITHER order — neither gates the
          other. A disabled button with no reason just looks broken, so say
          which of the two is still outstanding. */}
      {canSign && (!confirmed || !sig) && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8, textAlign: "center" }}>
          {!confirmed && !sig ? "Tick the box and sign to finish — either order."
            : !confirmed ? "Now tick the box above to finish."
            : "Now sign above to finish."}
        </div>
      )}
      <button className="accent rams-accept" disabled={!canSign || !confirmed || !sig || busy} onClick={accept}>
        {busy ? "Saving…" : talk ? "Sign & complete talk" : "Sign & accept RAMS"}
      </button>
    </div>
  );
}
