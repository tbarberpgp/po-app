import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { SignaturePad } from "./SignaturePad";
import { fmtLiftDate } from "../../shared/qitp-lift";
import type { QitpCabinDetail, QitpItem, QitpRecord, QitpSection, QitpSectionStatus, QitpSignoff } from "../../shared/types";

type Rec = QitpRecord;
type Photo = { id: number; section_id: number; item_index: number | null };
const blank = (sectionId: number): Rec => ({ section_id: sectionId, status: "not_started", checks: [], entries: [], inspector: null, company: null, notes: null, photo_ref: null });
function normChecks(stored: boolean[] | null | undefined, len: number): boolean[] {
  const out = new Array(len).fill(false);
  if (Array.isArray(stored)) for (let i = 0; i < len; i++) out[i] = !!stored[i];
  return out;
}
/** Typed readings, one slot per item — same shape as normChecks so a section
 *  whose template grew still lines up with what was recorded earlier. */
function normEntries(stored: string[] | null | undefined, len: number): string[] {
  const out = new Array(len).fill("");
  if (Array.isArray(stored)) for (let i = 0; i < len; i++) out[i] = stored[i] == null ? "" : String(stored[i]);
  return out;
}
/** A section is released once every responsible party has signed. */
function releasedFor(section: QitpSection, signoffs: QitpSignoff[]): boolean {
  const parties = section.responsible ?? [];
  if (!parties.length) return false;
  const signed = new Set(signoffs.filter((s) => s.section_id === section.id).map((s) => s.party));
  return parties.every((p) => signed.has(p));
}

/** Public, phone-first cabin inspection reached by QR scan. Sections in order with
 *  hold-point gating (sections after an un-released HOLD are locked), per-section
 *  Pass/Fail, per-item photos, and multi-party sign-off to release. */
export function CabinQitp() {
  const { token = "" } = useParams<{ token: string }>();
  const [data, setData] = useState<QitpCabinDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [recs, setRecs] = useState<Map<number, Rec>>(new Map());
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [signoffs, setSignoffs] = useState<QitpSignoff[]>([]);
  const [isSuper, setIsSuper] = useState(false);

  useEffect(() => { api.me().then((m) => setIsSuper(m?.role === "superadmin")).catch(() => {}); }, []);

  async function load() {
    try {
      const d = await api.pubCabin(token);
      setData(d);
      setRecs(new Map(d.sections.map((s) => [s.id, d.records.find((r) => r.section_id === s.id) ?? blank(s.id)])));
      setPhotos(d.photos);
      setSignoffs(d.signoffs);
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't load this cabin."); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [token]);

  function patch(sectionId: number, p: Partial<Rec>) {
    setRecs((m) => { const n = new Map(m); n.set(sectionId, { ...(n.get(sectionId) ?? blank(sectionId)), ...p }); return n; });
  }

  if (err) return <div className="cq-shell"><div className="flash error" style={{ margin: 16 }}>{err}</div></div>;
  if (!data) return <div className="cq-shell"><div className="empty" style={{ padding: 40 }}>Loading…</div></div>;

  const { cabin, project, sections } = data;
  // Hold gating: once an un-released HOLD is reached, every later section is locked.
  let blocked = false;
  const lockOf: Record<number, string | null> = {};
  let lastHoldTitle = "";
  for (const s of sections) {
    lockOf[s.id] = blocked ? lastHoldTitle : null;
    if (s.point_type === "HOLD" && !releasedFor(s, signoffs)) { blocked = true; lastHoldTitle = s.title; }
  }

  return (
    <div className="cq-shell">
      <header className={`cq-head floor-${cabin.floor.toLowerCase()}`}>
        <div className="cq-head-band">{cabin.floor} floor</div>
        <div className="cq-head-main">
          <div className="cq-num">{cabin.number}</div>
          <div className="cq-sub">
            <div>{project.code} · {project.name}</div>
            <div className="muted">
              {[cabin.elevation, cabin.wing].filter(Boolean).join(" · ")}
              {cabin.dismantle_day != null && <> · Dismantle day {cabin.dismantle_day}</>}
              {cabin.reinstall_date && <> · Reinstall {fmtLiftDate(cabin.reinstall_date)}</>}
            </div>
          </div>
        </div>
      </header>

      <main className="cq-main">
        {sections.map((s) => (
          <SectionCard
            key={s.id} token={token} section={s} isSuper={isSuper}
            rec={recs.get(s.id) ?? blank(s.id)}
            photos={photos.filter((p) => p.section_id === s.id)}
            signoffs={signoffs.filter((so) => so.section_id === s.id)}
            lockedBy={lockOf[s.id]}
            onPatch={(p) => patch(s.id, p)}
            onPhotoAdd={(added) => setPhotos((prev) => [...prev, ...added])}
            onPhotoRemove={(id) => setPhotos((prev) => prev.filter((p) => p.id !== id))}
            onSigned={(party, name, at) => setSignoffs((prev) => [...prev.filter((x) => !(x.section_id === s.id && x.party === party)), { section_id: s.id, party, signed_name: name, signed_at: at }])}
            onCleared={() => setSignoffs((prev) => prev.filter((x) => x.section_id !== s.id))}
          />
        ))}
      </main>
    </div>
  );
}

const STATUS_BTNS: { value: QitpSectionStatus; label: string; cls: string }[] = [
  { value: "pass", label: "Pass", cls: "pass" },
  { value: "in_progress", label: "In progress", cls: "prog" },
  { value: "fail", label: "Fail", cls: "fail" },
];

function SectionCard({
  token, section, rec, photos, signoffs, lockedBy, isSuper, onPatch, onPhotoAdd, onPhotoRemove, onSigned, onCleared,
}: {
  token: string; section: QitpSection; rec: Rec; photos: Photo[]; signoffs: QitpSignoff[];
  lockedBy: string | null; isSuper: boolean;
  onPatch: (p: Partial<Rec>) => void;
  onPhotoAdd: (added: Photo[]) => void; onPhotoRemove: (id: number) => void;
  onSigned: (party: string, name: string, at: string) => void; onCleared: () => void;
}) {
  const items: QitpItem[] = (section.items ?? []).map((it) => typeof it === "string" ? { text: it as string, hold: /^HOLD:/i.test(it as string), photo: "none" } : it);
  const parties = section.responsible ?? [];
  const [notes, setNotes] = useState(rec.notes ?? "");
  const [inspector, setInspector] = useState(rec.inspector ?? "");
  const [company, setCompany] = useState(rec.company ?? "");
  const [checks, setChecks] = useState<boolean[]>(() => normChecks(rec.checks, items.length));
  const [entries, setEntries] = useState<string[]>(() => normEntries(rec.entries, items.length));
  const [signParty, setSignParty] = useState<string | null>(null);
  const [signName, setSignName] = useState("");
  const [sig, setSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setNotes(rec.notes ?? ""); setInspector(rec.inspector ?? ""); setCompany(rec.company ?? "");
    setChecks(normChecks(rec.checks, items.length));
    setEntries(normEntries(rec.entries, items.length));
  }, [rec.notes, rec.inspector, rec.company, rec.checks, rec.entries, items.length]);

  const locked = !!lockedBy;
  const signedParties = new Set(signoffs.map((s) => s.party));
  const released = parties.length > 0 && parties.every((p) => signedParties.has(p));
  const itemPhotos = (i: number) => photos.filter((p) => p.item_index === i);
  const sectionPhotos = photos.filter((p) => p.item_index == null);

  function save(p: Partial<Rec>) {
    const sent = p.entries ?? entries;
    api.pubCabinSetSection(token, section.id, {
      status: p.status ?? rec.status, notes: p.notes ?? notes, inspector: p.inspector ?? inspector,
      company: p.company ?? company, checks: p.checks ?? checks, entries: sent,
    }).catch(() => {});
    // EVERY save carries the readings, so mirror them onto the record too —
    // otherwise a save triggered by something else (ticking an item, setting
    // Pass) leaves rec.entries stale and the reset effect below blanks a
    // reading that was typed but not yet blurred.
    if (p.entries === undefined) onPatch({ entries: sent });
  }
  function setStatus(status: QitpSectionStatus) {
    if (status === "pass") {
      const missing = items.findIndex((it, i) => it.photo === "required" && itemPhotos(i).length === 0);
      if (missing >= 0) { setErr(`A photo is required on item ${missing + 1} before this section can pass.`); return; }
      const noReading = items.findIndex((it, i) => it.entry === "required" && !(entries[i] ?? "").trim());
      if (noReading >= 0) { setErr(`A reading is required on item ${noReading + 1} before this section can pass.`); return; }
    }
    setErr(null);
    const next: QitpSectionStatus = rec.status === status ? "not_started" : status;  // tap again to clear
    onPatch({ status: next }); save({ status: next });
  }
  function toggleCheck(i: number, on: boolean) {
    const next = checks.slice(); next[i] = on; setChecks(next);
    const status: QitpSectionStatus = on && rec.status === "not_started" ? "in_progress" : rec.status;
    onPatch({ checks: next, status }); save({ checks: next, status });
  }
  /** Commit a typed reading (on blur, like notes) — recording one also moves an
   *  untouched section to in-progress, same as ticking an item.
   *  Compare against the PERSISTED value, not `entries`: onChange has already
   *  written the keystroke into that state, so comparing to it would match
   *  every time and never save. */
  function commitEntry(i: number, value: string) {
    if ((normEntries(rec.entries, items.length)[i] ?? "") === value) return;
    const next = entries.slice(); next[i] = value; setEntries(next);
    const status: QitpSectionStatus = value.trim() && rec.status === "not_started" ? "in_progress" : rec.status;
    onPatch({ entries: next, status }); save({ entries: next, status });
  }
  async function doSign() {
    if (!signParty || !signName.trim() || !sig) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.pubCabinSign(token, section.id, { party: signParty, name: signName.trim(), signature: sig });
      onSigned(signParty, signName.trim(), r.signed_at);
      setSignParty(null); setSig(null); setSignName("");
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't save signature"); }
    finally { setBusy(false); }
  }
  async function clearSection() {
    setBusy(true); setErr(null);
    try { await api.qitpUnsign(token, section.id); onCleared(); onPatch({ status: "not_started", checks: [] }); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't clear"); }
    finally { setBusy(false); }
  }

  const hasState = rec.status !== "not_started" || checks.some(Boolean) || signoffs.length > 0;

  return (
    <section className={`cq-sec${locked ? " locked" : ""}${rec.status === "fail" ? " is-fail" : ""}${released ? " is-released" : ""}`}>
      <div className="cq-sec-hd">
        <span className="cq-seq">{section.seq}</span>
        <div className="cq-sec-title">{section.title}</div>
        {section.point_type && <span className={`cq-point ${section.point_type.toLowerCase()}`}>{section.point_type}</span>}
      </div>
      {parties.length > 0 && (
        <div className="cq-parties">{parties.map((p) => <span key={p} className={`cq-party-chip${signedParties.has(p) ? " signed" : ""}`}>{signedParties.has(p) ? "✓ " : ""}{p}</span>)}</div>
      )}

      {locked ? (
        <div className="cq-locked">🔒 Locked until <b>{lockedBy}</b> is signed off & released.</div>
      ) : (
        <>
          {items.length > 0 && (
            <ul className="cq-checklist">
              {items.map((it, i) => (
                <li key={i} className={checks[i] ? "done" : ""}>
                  <input type="checkbox" checked={!!checks[i]} onChange={(e) => toggleCheck(i, e.target.checked)} />
                  <div className="cq-item-main">
                    <span>{it.text}{it.hold && <b className="cq-flag"> ⚑ HOLD</b>}{it.photo === "required" && <em className="cq-req"> · photo required</em>}{it.entry === "required" && <em className="cq-req"> · reading required</em>}</span>
                    {/* Typed reading for items that record a value rather than a
                        state — paint QA temperatures, humidity, dew point, DFT. */}
                    {it.entry && it.entry !== "none" && (
                      <input
                        className="cq-item-entry"
                        type="text"
                        inputMode="text"
                        value={entries[i] ?? ""}
                        placeholder="Reading"
                        aria-label={`${it.text} — reading`}
                        maxLength={120}
                        onChange={(e) => { const next = entries.slice(); next[i] = e.target.value; setEntries(next); }}
                        onBlur={(e) => commitEntry(i, e.target.value)}
                      />
                    )}
                    {it.photo !== "none" && (
                      <PhotoStrip token={token} sectionId={section.id} itemIndex={i} photos={itemPhotos(i)} onAdd={onPhotoAdd} onRemove={onPhotoRemove} compact />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {err && <div className="flash error" style={{ marginBottom: 10 }}>{err}</div>}
          <div className="cq-statusrow">
            {STATUS_BTNS.map((b) => (
              <button key={b.value} className={`cq-statusbtn ${b.cls}${rec.status === b.value ? " on" : ""}`} onClick={() => setStatus(b.value)}>{b.label}</button>
            ))}
          </div>

          <div className="cq-twofield">
            <label className="cq-field"><span>Inspector</span>
              <input value={inspector} placeholder="Name" onChange={(e) => setInspector(e.target.value)} onBlur={(e) => { onPatch({ inspector: e.target.value }); save({ inspector: e.target.value }); }} /></label>
            <label className="cq-field"><span>Company</span>
              <input value={company} placeholder={parties.join(" / ") || "PGP / Durata / …"} onChange={(e) => setCompany(e.target.value)} onBlur={(e) => { onPatch({ company: e.target.value }); save({ company: e.target.value }); }} /></label>
          </div>

          <label className="cq-field">
            <span>Notes</span>
            <textarea rows={2} value={notes} placeholder="Observations, defects, actions…"
              onChange={(e) => setNotes(e.target.value)} onBlur={() => { onPatch({ notes }); save({ notes }); }} />
          </label>

          <div className="cq-photos">
            <div className="cq-photos-hd">Evidence photos {sectionPhotos.length > 0 && <span className="muted">({sectionPhotos.length})</span>}</div>
            <PhotoStrip token={token} sectionId={section.id} itemIndex={null} photos={sectionPhotos} onAdd={onPhotoAdd} onRemove={onPhotoRemove} />
          </div>

          {/* Sign-off — every responsible party must sign to release the section. */}
          <div className="cq-signoff-block">
            <div className="cq-signoff-hd">
              Sign-off to release{parties.length > 1 && <span className="muted"> · all {parties.length} parties</span>}
              {released && <span className="cq-released-tag">✓ Released</span>}
            </div>
            {parties.map((party) => {
              const so = signoffs.find((s) => s.party === party);
              return (
                <div key={party} className="cq-party-row">
                  <span className="cq-party-label">{party}</span>
                  {so ? (
                    <span className="cq-party-done">✓ {so.signed_name} · {new Date(so.signed_at).toLocaleString("en-GB")}</span>
                  ) : (
                    <button className="cq-party-sign" onClick={() => { setSignParty(party); setSignName(""); setSig(null); }}>✍️ Sign as {party}</button>
                  )}
                </div>
              );
            })}
            {isSuper && hasState && <button className="cq-clear-admin" onClick={clearSection} disabled={busy}>↺ Clear section (admin)</button>}
          </div>

          {signParty && (
            <div className="cq-signbox">
              <div className="cq-sig-label">Signing as <b>{signParty}</b></div>
              <label className="cq-field"><span>Your name</span>
                <input value={signName} placeholder="Full name" onChange={(e) => setSignName(e.target.value)} /></label>
              <div className="cq-field"><span>Signature</span><SignaturePad onChange={setSig} /></div>
              <div className="cq-sign-actions">
                <button className="ghost" onClick={() => { setSignParty(null); setSig(null); }}>Cancel</button>
                <button className="accent grow" disabled={!signName.trim() || !sig || busy} onClick={doSign}>{busy ? "Saving…" : "Sign & confirm"}</button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Reusable thumbnails + camera/upload controls, for a section or a single item. */
function PhotoStrip({ token, sectionId, itemIndex, photos, onAdd, onRemove, compact }: {
  token: string; sectionId: number; itemIndex: number | null; photos: Photo[];
  onAdd: (added: Photo[]) => void; onRemove: (id: number) => void; compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const libRef = useRef<HTMLInputElement>(null);
  async function add(files: FileList | null) {
    if (!files || !files.length) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append("photo", f);
      if (itemIndex != null) fd.append("item_index", String(itemIndex));
      const r = await api.pubCabinPhoto(token, sectionId, fd);
      onAdd(r.photos.map((p) => ({ id: p.id, section_id: sectionId, item_index: p.item_index })));
    } catch (e) { setErr(e instanceof Error ? e.message : "Upload failed"); }
    finally { setBusy(false); if (camRef.current) camRef.current.value = ""; if (libRef.current) libRef.current.value = ""; }
  }
  return (
    <div className={compact ? "cq-istrip" : ""}>
      {photos.length > 0 && (
        <div className="cq-thumbs">
          {photos.map((p) => (
            <div key={p.id} className={`cq-thumb${compact ? " sm" : ""}`}>
              <img src={`/pub/cabin/${token}/photo/${p.id}`} alt="" loading="lazy" />
              <button className="cq-thumb-x" onClick={() => onRemove(p.id)} aria-label="Remove">✕</button>
            </div>
          ))}
        </div>
      )}
      {err && <div className="flash error" style={{ marginTop: 6 }}>{err}</div>}
      <div className="cq-photo-btns">
        <button className="cq-photo-btn" onClick={() => camRef.current?.click()} disabled={busy}>📷 {compact ? "Photo" : "Camera"}</button>
        <button className="cq-photo-btn" onClick={() => libRef.current?.click()} disabled={busy}>⤴ Upload</button>
        <input ref={camRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => add(e.target.files)} />
        <input ref={libRef} type="file" accept="image/*" multiple hidden onChange={(e) => add(e.target.files)} />
      </div>
    </div>
  );
}
