import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, fmtDate } from "../lib/api";
import { Topbar } from "./Shell";
import { can } from "../../shared/permissions";
import { QUAL_TYPES } from "../lib/quals";
import type { CurrentUser, Operative, OperativeQual, OperativeRamsRow } from "../../shared/types";

type OperativeRow = Operative & { qual_count: number; rams_pending: number; qual_worst: string; quals_pending: number; assigned_project_code: string | null };

function qualPill(status: string) {
  return status === "expired" ? "rejected"
    : status === "expiring" || status === "pending" ? "warn"
    : status === "valid" ? "ok" : "neutral";
}
/** "email & SMS" | "email" | "SMS" | null — which channels an invite went out on. */
function sentVia(r: { email: boolean; sms: boolean }): string | null {
  const parts: string[] = [];
  if (r.email) parts.push("email");
  if (r.sms) parts.push("SMS");
  return parts.length ? parts.join(" & ") : null;
}

// Sites to assign an operative to. Contracts that share a physical site are
// grouped — RAMS/sign-ins route to the group's base project — so offer one entry
// per group plus each standalone contract. The value is the project id assignment attaches to.
type ProjList = Awaited<ReturnType<typeof api.listProjects>>;
type GroupList = Awaited<ReturnType<typeof api.opsSiteGroups>>;
function siteOptionsFrom(projects: ProjList, groups: GroupList): { value: string; label: string }[] {
  const memberIds = new Set<string>();
  for (const g of groups) for (const m of g.members) memberIds.add(m.id);
  const opts: { value: string; label: string }[] = [];
  for (const g of groups) {
    const value = g.base_project_id || g.members[0]?.id;
    if (value && g.members.length) opts.push({ value, label: g.name });
  }
  for (const p of projects) {
    if (!memberIds.has(p.id)) opts.push({ value: p.id, label: `${p.code} — ${p.name}` });
  }
  return opts.sort((a, b) => a.label.localeCompare(b.label));
}

export function Operatives({ me }: { me: CurrentUser | null }) {
  const canEdit = can(me?.role, "delivery.edit");
  const [rows, setRows] = useState<OperativeRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // The detail opens in a non-modal right-hand slide-over. `shownId` is what the
  // drawer currently renders; when `selected` changes to a different operative we
  // cross-fade (fade out → swap → fade in, ~150ms) rather than remount-flash.
  const [shownId, setShownId] = useState<string | null>(null);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (selected == null) return;                        // close handled below
    if (shownId == null) { setShownId(selected); return; } // first open — just slide in
    if (selected !== shownId) {                          // switching — cross-fade the content
      setFading(true);
      const t = setTimeout(() => { setShownId(selected); setFading(false); }, 150);
      return () => clearTimeout(t);
    }
  }, [selected, shownId]);
  useEffect(() => {                                      // after the slide-out, drop the content
    if (selected != null || shownId == null) return;
    const t = setTimeout(() => setShownId(null), 220);
    return () => clearTimeout(t);
  }, [selected, shownId]);
  useEffect(() => {                                      // Esc closes the drawer
    if (selected == null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);
  const navigate = useNavigate();
  const location = useLocation();
  const [showNew, setShowNew] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A summary flashed back from the bulk-upload route after an import.
  useEffect(() => {
    const flash = (location.state as { flash?: string } | null)?.flash;
    if (!flash) return;
    setNotice(flash);
    window.history.replaceState({}, "");          // don't re-flash on refresh / back
    const t = setTimeout(() => setNotice(null), 9000);
    return () => clearTimeout(t);
  }, [location.state]);
  const [q, setQ] = useState("");
  // Bulk site-assignment: tick operatives in the register, pick a site, assign all.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulkSite, setBulkSite] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [projects, setProjects] = useState<ProjList>([]);
  const [groups, setGroups] = useState<GroupList>([]);
  useEffect(() => {
    if (!canEdit) return;
    api.listProjects().then(setProjects).catch(() => setProjects([]));
    api.opsSiteGroups().then(setGroups).catch(() => setGroups([]));
  }, [canEdit]);
  const siteOptions = useMemo(() => siteOptionsFrom(projects, groups), [projects, groups]);

  function refresh() {
    api.operatives().then(setRows).catch((e) => setErr(e.message));
  }
  useEffect(refresh, []);

  // Search across name / company / trade, then sort by any column (click a header).
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const toggleSort = (key: string) => setSort((s) => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "added" ? "desc" : "asc" });
  const filtered = q.trim()
    ? rows.filter((r) => `${r.name} ${r.company ?? ""} ${r.trade ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))
    : rows;
  const sortVal = (r: OperativeRow): string | number => {
    switch (sort.key) {
      case "company": return (r.company ?? "").toLowerCase();
      case "trade": return (r.trade ?? "").toLowerCase();
      case "site": return (r.assigned_project_code ?? "").toLowerCase();
      case "induction": return r.induction_done ? 1 : 0;
      case "cards": return r.qual_count;
      case "rams": return r.rams_pending;
      case "added": return r.created_at;            // ISO date sorts chronologically
      default: return r.name.toLowerCase();
    }
  };
  const shown = [...filtered].sort((a, b) => {
    const dir = sort.dir === "asc" ? 1 : -1;
    const av = sortVal(a), bv = sortVal(b);
    return av < bv ? -dir : av > bv ? dir : a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
  });

  const toggleCheck = (id: string) => setChecked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allShownChecked = shown.length > 0 && shown.every((r) => checked.has(r.id));
  const toggleCheckAll = () => setChecked(() => allShownChecked ? new Set<string>() : new Set(shown.map((r) => r.id)));
  async function bulkAssign() {
    if (!bulkSite || checked.size === 0) return;
    setBulkBusy(true); setErr(null); setNotice(null);
    let ok = 0; const failed: string[] = [];
    for (const id of checked) {
      try { await api.assignOperative(id, bulkSite); ok++; }
      catch { failed.push(rows.find((r) => r.id === id)?.name ?? id); }
    }
    const label = siteOptions.find((o) => o.value === bulkSite)?.label ?? "site";
    setNotice(`Assigned ${ok} operative${ok === 1 ? "" : "s"} to ${label}${failed.length ? ` · ${failed.length} failed (${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""})` : ""}.`);
    setTimeout(() => setNotice(null), 8000);
    setChecked(new Set()); setBulkSite(""); setBulkBusy(false); refresh();
  }

  return (
    <>
      <Topbar
        crumbs="Operations"
        title="Operatives"
        actions={canEdit ? (
          <div className="row" style={{ gap: 8 }}>
            <button className="ghost" onClick={() => navigate("/operatives/bulk-upload")}>Bulk upload</button>
            <button className="accent" onClick={() => setShowNew(true)}>+ New operative</button>
          </div>
        ) : null}
      />
      <main>
        {err && <div className="flash error">{err}</div>}
        {notice && <div className="flash success">{notice}</div>}
        {showNew && (
          <NewOperativeForm
            onClose={() => setShowNew(false)}
            onSaved={(id, invited) => {
              setShowNew(false); refresh(); setSelected(id);
              const via = sentVia(invited);
              setNotice(via
                ? `Operative added — profile link sent by ${via} so they can upload cards & sign RAMS.`
                : "Operative added. Add an email or phone, then use “Send link” to invite them.");
              setTimeout(() => setNotice(null), 7000);
            }}
          />
        )}
        <div className="card">
          <div className="card-hd">
            <h2>Register</h2>
            <span className="pill">{rows.length}</span>
            <span className="grow" />
            {rows.length > 0 && <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, company or trade" style={{ width: 240, maxWidth: "55%" }} />}
          </div>
          {canEdit && checked.size > 0 && (
            <div className="card-bd" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid var(--line)", background: "var(--card-2)" }}>
              <span><strong>{checked.size}</strong> selected</span>
              <span className="grow" />
              <select value={bulkSite} onChange={(e) => setBulkSite(e.target.value)} style={{ maxWidth: 260 }} aria-label="Site to assign to">
                <option value="">— assign to site —</option>
                {siteOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <button className="accent" disabled={!bulkSite || bulkBusy} onClick={bulkAssign}>{bulkBusy ? "Assigning…" : `Assign ${checked.size}`}</button>
              <button className="ghost" onClick={() => setChecked(new Set())}>Clear</button>
            </div>
          )}
          {rows.length === 0 ? (
            <div style={{ padding: 28 }}><div className="empty">No operatives yet — add your site team so they can be inducted, sign RAMS and track their cards.</div></div>
          ) : shown.length === 0 ? (
            <div style={{ padding: 28 }}><div className="empty">No operatives match “{q}”.</div></div>
          ) : (
            <table>
              <thead>
                <tr>
                  {canEdit && <th style={{ width: 34 }}><input type="checkbox" checked={allShownChecked} onChange={toggleCheckAll} aria-label="Select all" style={{ width: 15, height: 15, minHeight: 0 }} /></th>}
                  {([["name", "Name", false], ["company", "Company", false], ["trade", "Trade", false], ["site", "Site", true], ["induction", "Company induction", true], ["cards", "Cards", true], ["rams", "RAMS", true], ["added", "Added", true]] as Array<[string, string, boolean]>).map(([k, label, center]) => (
                    <th key={k} className={center ? "center" : undefined} style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }} onClick={() => toggleSort(k)} title="Click to sort">
                      {label}{sort.key === k && <span style={{ marginLeft: 4, color: "var(--accent)" }}>{sort.dir === "asc" ? "▲" : "▼"}</span>}
                    </th>
                  ))}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} style={{ cursor: "pointer" }} className={checked.has(r.id) ? "sel" : undefined} onClick={() => setSelected(selected === r.id ? null : r.id)}>
                    {canEdit && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={checked.has(r.id)} onChange={() => toggleCheck(r.id)} aria-label={`Select ${r.name}`} style={{ width: 15, height: 15, minHeight: 0 }} /></td>}
                    <td><b>{r.name}</b></td>
                    <td className="muted">{r.company ?? "—"}</td>
                    <td className="muted">{r.trade ?? "—"}</td>
                    <td className="center">{r.assigned_project_code ? <span className="pill info">{r.assigned_project_code}</span> : <span className="muted">—</span>}</td>
                    <td className="center">
                      {r.induction_done ? <span className="pill ok">Inducted</span> : <span className="pill warn">Not inducted</span>}
                    </td>
                    <td className="center">
                      {r.qual_count === 0 ? <span className="muted">—</span> : <span className={`pill ${qualPill(r.qual_worst)}`}>{r.qual_count} card{r.qual_count === 1 ? "" : "s"}</span>}
                      {r.quals_pending > 0 && <span className="pill warn" style={{ marginLeft: 6 }}>{r.quals_pending} to verify</span>}
                    </td>
                    <td className="center">{r.rams_pending > 0 ? <span className="pill warn">{r.rams_pending} to sign</span> : <span className="pill ok">✓</span>}</td>
                    <td className="center muted" style={{ whiteSpace: "nowrap" }}>{r.created_at ? fmtDate(r.created_at) : "—"}</td>
                    <td style={{ textAlign: "right" }}><span className="muted">{selected === r.id ? "▾" : "▸"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

      </main>

      {/* Non-modal right-hand slide-over. The scrim is purely visual (pointer-events:
          none) so the list behind stays clickable — selecting another operative is
          one click and the content cross-fades. Close via ✕ or Esc. */}
      {shownId && (
        <>
          <div className={`od-scrim${selected != null ? " show" : ""}`} aria-hidden />
          <aside className={`od-drawer${selected != null ? " open" : ""}`} role="dialog" aria-modal="false" aria-label="Operative detail">
            <div className={`od-fade${fading ? " out" : ""}`}>
              <OperativeDetail key={shownId} id={shownId} canEdit={canEdit} onChanged={refresh} onClose={() => setSelected(null)} onRemoved={() => { setSelected(null); refresh(); }} />
            </div>
          </aside>
        </>
      )}
    </>
  );
}

function NewOperativeForm({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string, invited: { email: boolean; sms: boolean }) => void }) {
  const [f, setF] = useState({ name: "", phone: "", company: "", trade: "", email: "", inducted: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api.createOperative({ name: f.name.trim(), phone: f.phone.trim() || undefined, company: f.company.trim() || undefined, trade: f.trade.trim() || undefined, email: f.email.trim() || undefined, induction_done: f.inducted });
      onSaved(r.id, r.invited);
    } catch (e) { setErr(e instanceof Error ? e.message : "failed"); setBusy(false); }
  }
  return (
    <form className="card" onSubmit={submit}>
      <div className="card-hd"><h3>New operative</h3></div>
      <div className="card-bd">
        {err && <div className="flash error">{err}</div>}
        <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
          <div className="grow"><label>Name *</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
          <div className="grow"><label>Phone (matches site sign-in)</label><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="07700 900111" /></div>
          <div className="grow"><label>Company</label><input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></div>
          <div className="grow"><label>Trade</label><input value={f.trade} onChange={(e) => setF({ ...f, trade: e.target.value })} /></div>
          <div className="grow"><label>Email *</label><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="name@company.co.uk" required /></div>
        </div>
        <label className="row" style={{ gap: 8, alignItems: "center", marginTop: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={f.inducted} onChange={(e) => setF({ ...f, inducted: e.target.checked })} />
          <span style={{ fontSize: 13 }}>Company induction completed</span>
        </label>
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          On create we email them their personal profile link straight away — they open it to upload their cards (tickets) and sign any RAMS before going on site. Email is required; add a mobile too if you'd also like to text it. Site induction is confirmed per-project on the site's Operations → Operatives tab.
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button type="submit" className="accent" disabled={busy || !f.name.trim() || !f.email.trim()}>{busy ? "Creating…" : "Create & send link"}</button>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </form>
  );
}

function OperativeDetail({ id, canEdit, onChanged, onRemoved, onClose }: { id: string; canEdit: boolean; onChanged: () => void; onRemoved: () => void; onClose: () => void }) {
  const [d, setD] = useState<{ operative: Operative; quals: OperativeQual[]; rams: OperativeRamsRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  function load() { api.operative(id).then(setD).catch((e) => setErr(e.message)); }
  useEffect(load, [id]);
  if (!d) return null;
  const op = d.operative;

  async function toggleInduction() {
    await api.updateOperative(id, { induction_done: !op.induction_done });
    load(); onChanged();
  }
  async function remove() {
    if (!window.confirm(`Remove ${op.name} from the operative register?\n\nThey'll be removed from the register and can no longer sign in. Their induction, signed RAMS and card history are kept for the record.`)) return;
    setRemoving(true); setErr(null);
    try { await api.archiveOperative(id); onRemoved(); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't remove operative"); setRemoving(false); }
  }

  return (
    <div className="od-inner">
      <div className="card-hd od-hd" style={{ alignItems: "center", gap: 8 }}>
        <div className="row" style={{ gap: 10, flex: 1, minWidth: 0 }}>
          <div className="avatar" style={{ flexShrink: 0 }}>{op.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?"}</div>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0 }}>{op.name}</h2>
            <div className="muted" style={{ fontSize: 12.5 }}>{[op.company, op.trade].filter(Boolean).join(" · ") || "—"}</div>
          </div>
        </div>
        {canEdit && (
          op.induction_done
            ? <button className="ghost" onClick={toggleInduction}>Mark induction incomplete</button>
            : <button className="accent" onClick={toggleInduction}>Mark inducted</button>
        )}
        {canEdit && <button className="danger" onClick={remove} disabled={removing}>{removing ? "Removing…" : "Remove"}</button>}
        <button className="od-x" onClick={onClose} aria-label="Close" title="Close (Esc)">✕</button>
      </div>
      <div className="card-bd">
        {err && <div className="flash error">{err}</div>}

        <div className="kpis" style={{ marginBottom: 16 }}>
          <div className={`kpi${op.induction_done ? "" : " tone-warn"}`}>
            <div className="kpi-label">Company induction</div>
            <div className="kpi-value" style={{ fontSize: 18 }}>{op.induction_done ? "Complete" : "Outstanding"}</div>
            {op.induction_at && <div className="kpi-sub">{fmtDate(op.induction_at)}</div>}
          </div>
          <div className="kpi"><div className="kpi-label">Phone</div><div className="kpi-value" style={{ fontSize: 18 }}>{op.phone ?? "—"}</div><div className="kpi-sub">used to match site sign-ins</div></div>
        </div>

        <ProfileShare id={id} token={op.token} email={op.email ?? ""} hasPhone={!!op.phone?.trim()} canEdit={canEdit} onChanged={() => { load(); onChanged(); }} />

        <QualsSection id={id} quals={d.quals} canEdit={canEdit} onChanged={() => { load(); onChanged(); }} />
        <RamsSection id={id} rams={d.rams} canEdit={canEdit} hasEmail={!!op.email?.trim()} hasPhone={!!op.phone?.trim()} onChanged={() => { load(); onChanged(); }} />
      </div>
    </div>
  );
}

function ProfileShare({ id, token, email: initialEmail, hasPhone, canEdit, onChanged }: { id: string; token: string; email: string; hasPhone: boolean; canEdit: boolean; onChanged: () => void }) {
  const profileUrl = `${location.origin}/operative/${token}`;
  const [email, setEmail] = useState(initialEmail);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setEmail(initialEmail); }, [initialEmail]);
  const dirty = email.trim() !== (initialEmail ?? "").trim();

  async function copyLink() {
    try { await navigator.clipboard.writeText(profileUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  }
  async function saveEmail() {
    setBusy(true); setErr(null);
    try { await api.updateOperative(id, { email: email.trim() }); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't save email"); throw e; }
    finally { setBusy(false); }
  }
  async function emailLink() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      if (dirty) await api.updateOperative(id, { email: email.trim() }); // persist any edit first
      const r = await api.emailOperativeLink(id);
      const via = sentVia(r);
      setMsg(via ? `Sent by ${via} ✓` : "Saved — but nothing went out (email/SMS isn't set up on the server).");
      setTimeout(() => setMsg(null), 5000);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't send the link"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <div className="eyebrow">Send their profile / RAMS link</div>
      {err && <div className="flash error" style={{ marginTop: 6 }}>{err}</div>}
      {canEdit && (
        <div className="row" style={{ alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="operative@email.com" style={{ maxWidth: 280 }} />
          {dirty && <button className="ghost tiny" onClick={() => saveEmail().catch(() => {})} disabled={busy}>Save email</button>}
          <button className="accent tiny" onClick={emailLink} disabled={busy || (!email.trim() && !hasPhone)}>Send link</button>
          {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
        </div>
      )}
      <div className="row" style={{ alignItems: "center", gap: 8, marginTop: 8 }}>
        <input readOnly value={profileUrl} onFocus={(e) => e.currentTarget.select()} style={{ maxWidth: 420 }} />
        <button className="ghost tiny" onClick={copyLink}>{copied ? "Copied" : "Copy"}</button>
        <a className="ghost tiny" href={profileUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>Open</a>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        We text &amp; email this automatically when they're added. Use <b>Send link</b> to re-send (email + SMS), or copy it for WhatsApp — they open it to read &amp; sign RAMS, see their cards and upload qualifications. No login needed.
      </div>
    </div>
  );
}

function QualsSection({ id, quals, canEdit, onChanged }: { id: string; quals: OperativeQual[]; canEdit: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<string>(QUAL_TYPES[0]);
  // Only a type the user actually picked overrides what's read off the card
  // photo — the untouched default (CSCS) must not mislabel an IPAF card.
  const [typeTouched, setTypeTouched] = useState(false);
  const [cardNo, setCardNo] = useState("");
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function add() {
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.set("qual_type", type);
      fd.set("qual_type_manual", typeTouched ? "1" : "0");
      if (cardNo.trim()) fd.set("card_no", cardNo.trim());
      if (expiry) fd.set("expiry_date", expiry);
      const file = fileRef.current?.files?.[0];
      if (file) fd.set("file", file);
      await api.addOperativeQual(id, fd);
      setAdding(false); setCardNo(""); setExpiry(""); setType(QUAL_TYPES[0]); setTypeTouched(false);
      if (fileRef.current) fileRef.current.value = "";
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't save card"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <div className="row" style={{ alignItems: "center", marginBottom: 8 }}>
        <div className="eyebrow" style={{ flex: 1 }}>Qualification cards</div>
        {canEdit && !adding && <button className="ghost tiny" onClick={() => setAdding(true)}>+ Add card / upload</button>}
      </div>
      {err && <div className="flash error" style={{ marginBottom: 8 }}>{err}</div>}
      {adding && (
        <div className="card" style={{ marginBottom: 10, padding: 12 }}>
          <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
            <div><label>Type</label><select value={type} onChange={(e) => { setType(e.target.value); setTypeTouched(true); }}>{QUAL_TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>
            <div><label>Card no.</label><input value={cardNo} onChange={(e) => setCardNo(e.target.value)} style={{ maxWidth: 160 }} placeholder="read from photo" /></div>
            <div><label>Expiry</label><input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></div>
            <div><label>Photo</label><input ref={fileRef} type="file" accept="image/*,application/pdf" title="Type, card number and expiry are read off the photo — only fill fields you want to override" /></div>
            <button className="accent" onClick={add} disabled={busy}>{busy ? "Saving…" : "Save card"}</button>
            <button className="ghost" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
      {quals.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>
          No cards uploaded.{canEdit && !adding && <> <button className="link" onClick={() => setAdding(true)} style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0, font: "inherit" }}>Add a card</button> — choose a type, optional expiry, and a photo of the card.</>}
        </div>
      ) : (
        <div className="qcards">
          {quals.map((q) => {
            const detail = q.status === "expired"
              ? `expired${q.expiry_date ? ` ${fmtDate(q.expiry_date)}` : ""}`
              : q.status === "pending" ? "awaiting review"
              : q.expiry_date ? `valid to ${fmtDate(q.expiry_date)}` : "no expiry";
            const inner = (
              <>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3.5" width="12" height="9" rx="1.5" /><path d="M2 6.5h12" /></svg>
                <span>{q.qual_type}{q.card_no ? ` ${q.card_no}` : ""} · {detail}</span>
              </>
            );
            return (
              <span key={q.id} className={`qcard${q.status === "expired" ? " expired" : q.status === "pending" ? " pending" : ""}`}>
                {q.file_key
                  ? <a href={api.operativeFileUrl(q.file_key)} target="_blank" rel="noreferrer">{inner}</a>
                  : <span className="qcard-in">{inner}</span>}
                {q.source === "self" && <span className="qcard-tag">self</span>}
                {canEdit && !q.verified_at && <button className="qcard-act" onClick={async () => { await api.verifyOperativeQual(q.id); onChanged(); }}>Verify</button>}
                {canEdit && <button className="qcard-act danger" title="Remove card" onClick={async () => { if (confirm(`Remove ${q.qual_type}?`)) { await api.deleteOperativeQual(q.id); onChanged(); } }}>×</button>}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RamsSection({ id, rams, canEdit, hasEmail, hasPhone, onChanged }: { id: string; rams: OperativeRamsRow[]; canEdit: boolean; hasEmail: boolean; hasPhone: boolean; onChanged: () => void }) {
  const hasContact = hasEmail || hasPhone;
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof api.listProjects>>>([]);
  const [groups, setGroups] = useState<Awaited<ReturnType<typeof api.opsSiteGroups>>>([]);
  const [projectId, setProjectId] = useState("");
  const [siteRams, setSiteRams] = useState<Awaited<ReturnType<typeof api.opsRams>>["documents"]>([]);
  const [loadingRams, setLoadingRams] = useState(false);
  const [picks, setPicks] = useState<Set<number>>(new Set());
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!canEdit) return;
    api.listProjects().then(setProjects).catch(() => setProjects([]));
    api.opsSiteGroups().then(setGroups).catch(() => setGroups([]));
  }, [canEdit]);

  // Contracts that share a physical site are grouped — RAMS, sign-ins and
  // deliveries route to the group's base project. So offer the combined site
  // (one entry per group) rather than each block; standalone contracts stay on
  // their own. The option value is the project RAMS actually attach to.
  const siteOptions = useMemo(() => siteOptionsFrom(projects, groups), [projects, groups]);
  useEffect(() => {
    setPicks(new Set()); setSiteRams([]);
    if (!projectId) return;
    setLoadingRams(true);
    api.opsRams(projectId)
      .then((rs) => setSiteRams(rs.documents.filter((r) => r.active)))
      .catch(() => setSiteRams([]))
      .finally(() => setLoadingRams(false));
  }, [projectId]);

  async function assign() {
    if (!projectId || picks.size === 0) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const n = picks.size;
      for (const rid of picks) await api.assignRams(id, { rams_id: rid, project_id: projectId });
      const label = `${n} RAMS`;
      if (notify && hasContact) {
        const r = await api.emailOperativeLink(id).catch(() => ({ email: false, sms: false }));
        const via = sentVia(r);
        setMsg(via ? `Sent ${label} — and sent them the link by ${via}.` : `Sent ${label} (link not delivered — check their contact details/server).`);
      } else {
        setMsg(`Sent ${label} — share their profile link so they can sign.`);
      }
      setPicks(new Set());
      setTimeout(() => setMsg(null), 5000);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't send RAMS"); }
    finally { setBusy(false); }
  }

  // Put the operative ON the selected site (sets their site assignment + queues
  // that site's RAMS to sign). This is the bit that updates the "Site" column.
  const [assigning, setAssigning] = useState(false);
  async function assignToSite() {
    if (!projectId) return;
    setAssigning(true); setErr(null); setMsg(null);
    try {
      await api.assignOperative(id, projectId);
      const label = siteOptions.find((o) => o.value === projectId)?.label ?? "the site";
      setMsg(`Assigned to ${label} — that site's RAMS are queued for them to sign${hasContact ? " and their link has been sent" : " (share their profile link so they can sign)"}.`);
      setTimeout(() => setMsg(null), 6000);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't assign to site"); }
    finally { setAssigning(false); }
  }

  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 8 }}>RAMS</div>
      {canEdit && (
        <div className="card" style={{ padding: 12, marginBottom: 10 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Pick a site and <strong>Assign to site</strong> to put them on it (queues that site's RAMS to sign). Or tick specific RAMS below to (re)send.</div>
          <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-start" }}>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ maxWidth: 240 }}>
              <option value="">— select site —</option>
              {siteOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button className="primary tiny" onClick={assignToSite} disabled={!projectId || assigning}>{assigning ? "Assigning…" : "Assign to site"}</button>
            {projectId && (siteRams.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 170, overflowY: "auto", border: "1px solid var(--line)", borderRadius: "var(--radius-md)", padding: "8px 10px", minWidth: 240, flex: 1 }}>
                {siteRams.map((r) => (
                  <label key={r.id} className="row" style={{ alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={picks.has(r.id)} onChange={() => setPicks((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} style={{ width: 15, height: 15, minHeight: 0 }} />
                    <span>{r.title}{r.category ? <span className="muted"> · {r.category}</span> : null}</span>
                  </label>
                ))}
              </div>
            ) : (
              <span className="muted" style={{ fontSize: 12 }}>
                {loadingRams ? "Loading…" : "No RAMS uploaded for this site yet — add them in the project's Operations → RAMS & docs."}
              </span>
            ))}
            <button className="accent tiny" onClick={assign} disabled={!projectId || picks.size === 0 || busy}>{busy ? "Sending…" : `Send RAMS${picks.size ? ` (${picks.size})` : ""}`}</button>
          </div>
          {hasContact && (
            <label className="row" style={{ alignItems: "center", gap: 6, marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} style={{ width: 16, height: 16 }} />
              Also send them the link now ({[hasEmail && "email", hasPhone && "SMS"].filter(Boolean).join(" & ")})
            </label>
          )}
          {msg && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{msg}</div>}
          {err && <div className="flash error" style={{ marginTop: 8 }}>{err}</div>}
        </div>
      )}
      {rams.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>No RAMS assigned yet. Allocate a site &amp; choose a RAMS above.</div>
      ) : (
        <table>
          <thead><tr><th>Project</th><th>RAMS</th><th className="center">Status</th></tr></thead>
          <tbody>
            {rams.map((r) => (
              <tr key={r.id}>
                <td>{r.project_code}</td>
                <td>{r.rams_title}</td>
                <td className="center">{r.signed_at ? <span className="pill ok" title={fmtDate(r.signed_at)}>Signed {fmtDate(r.signed_at)}</span> : <span className="pill warn">Awaiting signature</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
