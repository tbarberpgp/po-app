import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { SignaturePad } from "./SignaturePad";
import type { PublicSite, PublicOperative } from "../../shared/types";
import logoUrl from "../logo.png";

type Coords = { lat: number; lng: number; accuracy: number } | null;
type GeoState = "idle" | "locating" | "ok" | "denied" | "unavailable";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function SiteSignIn() {
  const { token = "" } = useParams<{ token: string }>();
  const [site, setSite] = useState<PublicSite | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // Operatives now pick themselves from the register rather than typing a name.
  // `name` is kept only to label the confirmation card + sign-in payload.
  const [operativeId, setOperativeId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [acked, setAcked] = useState<Record<number, boolean>>({});
  const [briefingAck, setBriefingAck] = useState(false);

  const [coords, setCoords] = useState<Coords>(null);
  const [geo, setGeo] = useState<GeoState>("idle");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<{ id: number; name: string } | null>(null);

  const storeKey = `pgp-site-signin:${token}`;

  // Load the site + today's notices.
  useEffect(() => {
    api.pubGetSite(token).then(setSite).catch((e) => setLoadErr(e.message));
  }, [token]);

  // Restore a prior sign-in on this device (same day only).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storeKey);
      if (raw) {
        const v = JSON.parse(raw) as { id: number; name: string; date: string };
        if (v.date === todayISO()) setSignedIn({ id: v.id, name: v.name });
        else localStorage.removeItem(storeKey);
      }
    } catch { /* ignore */ }
  }, [storeKey]);

  // Best-effort location capture on load (and refreshed at submit).
  function captureLocation(): Promise<Coords> {
    return new Promise((resolve) => {
      if (!("geolocation" in navigator)) { setGeo("unavailable"); resolve(null); return; }
      setGeo("locating");
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const c = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
          setCoords(c); setGeo("ok"); resolve(c);
        },
        (e) => { setGeo(e.code === e.PERMISSION_DENIED ? "denied" : "unavailable"); resolve(null); },
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
      );
    });
  }
  useEffect(() => { if (site && !signedIn) captureLocation(); /* eslint-disable-next-line */ }, [site]);

  const notices = site?.notices ?? [];
  const briefing = site?.briefing ?? null;
  const operatives = site?.operatives ?? [];
  const selectedOp = operativeId ? operatives.find((o) => o.id === operativeId) ?? null : null;
  const allAcked = notices.every((n) => acked[n.id]);
  const briefingOk = !briefing || briefingAck;
  const canSubmit = !!operativeId && !!signature && allAcked && briefingOk && !busy;

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      // Take a fresh fix at the moment of signing in.
      const c = (await captureLocation()) ?? coords;
      const res = await api.pubSignIn(token, {
        operative_id: operativeId ?? undefined,
        name: name.trim(),
        signature: signature ?? undefined,
        lat: c?.lat, lng: c?.lng, accuracy: c?.accuracy,
        ack_notice_ids: notices.map((n) => n.id),
        briefing_ack: briefingAck,
      });
      localStorage.setItem(storeKey, JSON.stringify({ id: res.id, name: name.trim(), date: todayISO() }));
      setSignedIn({ id: res.id, name: name.trim() });
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function signOut() {
    if (!signedIn) return;
    setBusy(true);
    try {
      await api.pubSignOut(token, signedIn.id);
      localStorage.removeItem(storeKey);
      setSignedIn(null);
      // Reset the form for the next person on a shared device.
      setOperativeId(null); setName(""); setSignature(null); setAcked({}); setBriefingAck(false);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  if (loadErr) {
    return (
      <div className="site-signin-page">
        <div className="site-signin-inner">
          <img className="site-logo" src={logoUrl} alt="PGP" />
          <div className="card" style={{ textAlign: "center" }}>
            <h2 style={{ marginTop: 0 }}>Sign-in unavailable</h2>
            <p className="muted">{loadErr}</p>
            <p className="muted" style={{ fontSize: 13 }}>Ask your site manager for an up-to-date QR code or link.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!site) {
    return (
      <div className="site-signin-page">
        <div className="site-signin-inner"><div className="empty">Loading…</div></div>
      </div>
    );
  }

  return (
    <div className="site-signin-page">
      <div className="site-signin-inner">
        <img className="site-logo" src={logoUrl} alt="PGP" />
        <div className="site-head">
          <div className="site-code">{site.project.code}</div>
          <div className="site-name">{site.site_group_name || site.project.name}</div>
        </div>

        {signedIn ? (
          <div className="card site-done">
            <div className="site-tick">✓</div>
            <h2 style={{ margin: "8px 0 4px" }}>You're signed in</h2>
            <p className="muted">{signedIn.name} · {new Date().toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</p>
            <p className="muted" style={{ fontSize: 13 }}>Remember to sign out at the end of your shift.</p>
            {err && <div className="flash error">{err}</div>}
            <button className="primary" style={{ width: "100%", marginTop: 8 }} onClick={signOut} disabled={busy}>
              {busy ? "…" : "Sign out"}
            </button>
          </div>
        ) : (
          <div className="card">
            {err && <div className="flash error">{err}</div>}

            {/* A plain div, NOT a <label>: a <label> forwards clicks on its
                children to its first labelable control (the toggle button),
                which would immediately reopen the dropdown after a pick. */}
            <div className="field"><span>Your name *</span>
              <OperativePicker
                operatives={operatives}
                value={operativeId}
                onChange={(op) => { setOperativeId(op.id); setName(op.name); }}
              />
            </div>
            {selectedOp && (selectedOp.company || selectedOp.trade) && (
              <p className="muted" style={{ fontSize: 12.5, margin: "-6px 0 14px" }}>
                {[selectedOp.company, selectedOp.trade].filter(Boolean).join(" · ")}
              </p>
            )}
            {operatives.length === 0 && (
              <p className="muted" style={{ fontSize: 12.5, margin: "-6px 0 14px" }}>
                No operatives are assigned to this site yet. Ask your site manager to assign you to this site before signing in.
              </p>
            )}

            {briefing && (
              <div className="site-notices">
                <div className="site-section-label">Daily briefing — please read &amp; acknowledge</div>
                <label className={`ack-card${briefingAck ? " acked" : ""}`}>
                  <div className="ack-head">
                    <span className="pill warn">Daily briefing</span>
                    <span className="ack-title">{briefing.title}</span>
                  </div>
                  {briefing.content && <div className="ack-body">{briefing.content}</div>}
                  <div className="ack-confirm">
                    <input type="checkbox" checked={briefingAck} onChange={(e) => setBriefingAck(e.target.checked)} />
                    <span>I have read and understood this</span>
                  </div>
                </label>
              </div>
            )}

            {notices.length > 0 && (
              <div className="site-notices">
                <div className="site-section-label">Today's site notices — please read &amp; acknowledge</div>
                {notices.map((n) => (
                  <label key={n.id} className={`ack-card${acked[n.id] ? " acked" : ""}`}>
                    <div className="ack-head">
                      <span className={`pill ${n.type === "toolbox" ? "info" : "neutral"}`}>
                        {n.type === "toolbox" ? "Toolbox talk" : "Briefing"}
                      </span>
                      <span className="ack-title">{n.title}</span>
                    </div>
                    {n.content && <div className="ack-body">{n.content}</div>}
                    <div className="ack-confirm">
                      <input type="checkbox" checked={!!acked[n.id]} onChange={(e) => setAcked((s) => ({ ...s, [n.id]: e.target.checked }))} />
                      <span>I have read and understood this</span>
                    </div>
                  </label>
                ))}
              </div>
            )}

            <div className="field">
              <span>Signature *</span>
              <SignaturePad onChange={setSignature} />
            </div>

            <div className={`site-geo geo-${geo}`}>
              {geo === "locating" && "📍 Getting your location…"}
              {geo === "ok" && coords && `📍 Location captured (±${Math.round(coords.accuracy)}m)`}
              {geo === "denied" && "⚠️ Location permission denied — please enable location so your sign-in is recorded on site."}
              {geo === "unavailable" && "⚠️ Location unavailable on this device."}
              {geo === "idle" && " "}
            </div>

            <button className="primary" style={{ width: "100%", marginTop: 4 }} onClick={submit} disabled={!canSubmit}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            {!canSubmit && !busy && (
              <p className="muted" style={{ fontSize: 12, textAlign: "center", marginTop: 8 }}>
                {!operativeId ? "Select your name" : !briefingOk ? "Acknowledge the daily briefing" : !allAcked ? "Acknowledge today's notices" : !signature ? "Add your signature" : ""}
              </p>
            )}
          </div>
        )}
        <div className="site-foot muted">PowerGrid Projects · Site sign-in</div>
      </div>
    </div>
  );
}

/** Searchable dropdown of registered operatives — replaces freeform name entry
 *  on the site sign-in. Type to filter (by name, company or trade); tap or use
 *  arrow keys + Enter to pick. Self-contained so the public page has no app
 *  dependencies. */
function OperativePicker({
  operatives, value, onChange,
}: {
  operatives: PublicOperative[];
  value: string | null;
  onChange: (op: PublicOperative) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => operatives.find((o) => o.id === value) ?? null, [operatives, value]);
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return operatives;
    return operatives.filter((o) =>
      o.name.toLowerCase().includes(q) ||
      (o.company ?? "").toLowerCase().includes(q) ||
      (o.trade ?? "").toLowerCase().includes(q),
    );
  }, [operatives, search]);

  // Close on outside tap/click.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) { setOpen(false); setSearch(""); }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0); }, [open]);
  useEffect(() => { setHighlight(0); }, [search]);

  function pick(op: PublicOperative) { onChange(op); setOpen(false); setSearch(""); }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(filtered.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const op = filtered[highlight]; if (op) pick(op); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); setSearch(""); }
  }

  const disabled = operatives.length === 0;
  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => { if (!disabled) setOpen((v) => !v); }}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        style={{
          width: "100%", minHeight: 46, padding: "10px 14px",
          background: "var(--card)", color: selected ? "var(--ink)" : "var(--muted)",
          border: `1px solid ${open ? "var(--accent)" : "var(--line-strong)"}`,
          borderRadius: "var(--radius-md)", fontSize: 15, textAlign: "left",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
          cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit",
          boxShadow: open ? "0 0 0 3px var(--accent-soft)" : "none",
          transition: "border-color 120ms, box-shadow 120ms",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected ? selected.name : "— select your name —"}
        </span>
        <span style={{ fontSize: 10, opacity: 0.6, flexShrink: 0 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 30,
            background: "var(--card)", border: "1px solid var(--line-strong)", borderRadius: "var(--radius-md)",
            boxShadow: "0 10px 28px rgba(15, 17, 48, 0.20)", maxHeight: 320,
            display: "flex", flexDirection: "column", overflow: "hidden",
          }}
        >
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type to search…"
            autoComplete="off"
            style={{
              border: "none", borderBottom: "1px solid var(--line)", borderRadius: 0,
              padding: "12px 14px", fontSize: 15, outline: "none", boxShadow: "none", minHeight: 46,
              fontFamily: "inherit", background: "var(--card)", color: "var(--ink)",
            }}
          />
          <div role="listbox" style={{ overflowY: "auto", flex: 1 }}>
            {filtered.length === 0 ? (
              <div className="muted" style={{ padding: 14, fontSize: 13 }}>No one matches “{search}”.</div>
            ) : filtered.map((op, i) => (
              <div
                key={op.id}
                role="option"
                aria-selected={op.id === value}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(op)}
                style={{
                  padding: "10px 14px", cursor: "pointer",
                  background: i === highlight ? "var(--accent-soft)" : op.id === value ? "var(--card-2)" : "transparent",
                  borderTop: i === 0 ? "none" : "1px solid var(--line)",
                }}
              >
                <div style={{ fontSize: 14.5, fontWeight: 500, color: "var(--ink)" }}>{op.name}</div>
                {(op.company || op.trade) && (
                  <div className="muted" style={{ fontSize: 11.5 }}>{[op.company, op.trade].filter(Boolean).join(" · ")}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
