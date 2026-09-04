import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import qrcode from "qrcode-generator";
import "leaflet/dist/leaflet.css";
import { api, fmtDate, fmtMoney } from "../lib/api";
import { ProjectTicketInbox } from "./DeliveriesInbox";
import { Topbar } from "./Shell";
import { SupplierCombobox, compareSuppliers } from "./SupplierCombobox";
import { GroupedCombobox } from "./GroupedCombobox";
import { generateAttendanceXlsx } from "../lib/attendance-xlsx";
import { generateAttendancePdf, generateHsPackPdf } from "../lib/attendance-pdf";
import { can } from "../../shared/permissions";
import { poDeliveryLabel, type PoDeliveryState } from "../../shared/po-delivery-status";
import { MATRIX_QUAL_TYPES, QUAL_TYPES } from "../lib/quals";
import { generateTrainingMatrixXlsx } from "../lib/training-matrix-xlsx";
import type {
  CurrentUser, OpsSite, OwnedPlant, PlantLog, ProgressPhoto, Project, RamsDocument, OperativeCert,
  ProjectSiteGroup, SiteBriefing, SiteDelivery, DeliveryTicketCandidate, PoDeliveryStatus, SiteNotice, SiteSignin, Supplier,
} from "../../shared/types";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
/** YYYY-MM-DD `weeks` after `iso` (used to preview a plant off-hire date). */
function addWeeksISO(iso: string, weeks: number): string {
  const d = new Date(iso + "T00:00:00Z");
  if (isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + Math.round(weeks * 7));
  return d.toISOString().slice(0, 10);
}
function fmtTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
/** Date + time of a sign-in, e.g. "08 Jul, 07:34" — so the record shows which
 *  day it was, not just the time. */
function fmtDateTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
/** Inclusive days between two YYYY-MM-DD dates (min 1). `to` defaults to today. */
function daysOnSite(from: string | null, to: string | null): number | null {
  if (!from) return null;
  const a = new Date(from + "T00:00:00");
  const b = new Date((to ?? todayISO()) + "T00:00:00");
  const d = Math.floor((b.getTime() - a.getTime()) / 86_400_000) + 1;
  return Math.max(1, d);
}

/** Build a scalable QR SVG string from a value (no network). */
function buildQrSvg(value: string, cellSize = 4): string {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return qr.createSvgTag({ cellSize, margin: 2, scalable: true });
}

/** Crisp, scalable QR rendered from a value. */
function QrCode({ value, size = 200 }: { value: string; size?: number }) {
  const svg = useMemo(() => buildQrSvg(value), [value]);
  return (
    <div className="qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

/** Open a print-friendly poster of the site sign-in QR and trigger the print dialog. */
function printQrPoster(url: string, code: string, name: string) {
  const svg = buildQrSvg(url, 8);
  const w = window.open("", "_blank", "width=820,height=920");
  if (!w) { alert("Please allow pop-ups to print the QR poster."); return; }
  w.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>Site sign-in — ${escapeHtml(code)}</title>
    <style>
      *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;padding:48px;text-align:center;color:#0f1130}
      .head{font-size:28px;font-weight:700;margin-bottom:6px}
      .code{font-size:42px;font-weight:800;letter-spacing:1px}
      .name{font-size:20px;color:#555;margin:2px 0 4px}
      .qr{width:390px;height:390px;margin:22px auto}
      .qr svg{width:100%;height:100%}
      .steps{max-width:460px;margin:18px auto 0;text-align:left;font-size:15px;line-height:1.6}
      .url{font-family:monospace;font-size:13px;color:#444;word-break:break-all;margin-top:14px}
      @media print{body{padding:24px}}
    </style></head><body>
      <div class="head">Scan to sign in</div>
      <div class="code">${escapeHtml(code)}</div>
      <div class="name">${escapeHtml(name)}</div>
      <div class="qr">${svg}</div>
      <div class="steps"><b>On arrival, every operative must:</b>
        <ol><li>Scan this code with your phone camera</li><li>Read &amp; acknowledge today's briefing</li><li>Enter your name and sign in</li></ol>
      </div>
      <div class="url">${escapeHtml(url)}</div>
      <script>window.onload=function(){setTimeout(function(){window.focus();window.print();},300)}</script>
    </body></html>`,
  );
  w.document.close();
}

/** OpenStreetMap (Leaflet) map of the day's sign-in locations. Lazy-loads Leaflet. */
function AttendanceMap({ signins }: { signins: SiteSignin[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const points = useMemo(
    () => signins
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({ name: s.name, lat: s.lat as number, lng: s.lng as number })),
    [signins],
  );

  useEffect(() => {
    if (!ref.current || points.length === 0) return;
    let map: import("leaflet").Map | undefined;
    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      if (cancelled || !ref.current) return;
      map = L.map(ref.current, { scrollWheelZoom: false });
      // CARTO Voyager — a clean, lightly-coloured basemap (roads, parks, water)
      // with labels: Google-Maps-like but far less busy than raw OSM.
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png", {
        subdomains: "abcd",
        maxZoom: 20,
        attribution: "&copy; OpenStreetMap &copy; CARTO",
      }).addTo(map);
      for (const p of points) {
        L.circleMarker([p.lat, p.lng], { radius: 7, color: "#ee5d2b", fillColor: "#ee5d2b", fillOpacity: 0.85, weight: 2 })
          .addTo(map)
          .bindPopup(`<b>${escapeHtml(p.name)}</b>`);
      }
      map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])).pad(0.3), { maxZoom: 17 });
    })();
    return () => { cancelled = true; map?.remove(); };
  }, [points]);

  if (points.length === 0) return null;
  return <div ref={ref} className="ops-attendance-map" />;
}

// ── Operations landing — the list of live sites ─────────────────────────────
export function OperationsHome(_props: { me: CurrentUser | null }) {
  const [sites, setSites] = useState<OpsSite[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.opsSites().then(setSites).catch((e) => setErr(e.message));
  }, []);

  return (
    <>
      <Topbar crumbs="Operations" title="Site teams" />
      <main>
        {err && <div className="flash error">{err}</div>}
        {sites.length === 0 ? (
          <div className="empty">No live projects.</div>
        ) : (
          <div className="ops-site-grid">
            {sites.map((s) => (
              <Link key={s.id} to={`/operations/${s.id}`} className="ops-site-card card">
                <div className="ops-site-head">
                  <span className="ops-site-code">{s.code}</span>
                  {s.on_site_now > 0 && <span className="pill ok dot">{s.on_site_now} on site</span>}
                </div>
                <div className="ops-site-name">{s.name}</div>
                <div className="ops-site-stats">
                  <span>{s.signins_today} signed in today</span>
                  <span>{s.plant_on_site} plant on site</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

// ── Per-site operations workspace ────────────────────────────────────────────
type OpsTab = "attendance" | "operatives" | "notices" | "plant" | "deliveries" | "rams" | "photos";

const OPS_TABS: Array<{ key: OpsTab; label: string }> = [
  { key: "attendance", label: "Attendance" },
  { key: "operatives", label: "Operatives" },
  { key: "notices", label: "Briefings & toolbox" },
  { key: "deliveries", label: "Deliveries" },
  { key: "rams", label: "RAMS & docs" },
  { key: "photos", label: "Progress photos" },
  { key: "plant", label: "Plant on site" },
];

/** The tabbed Operations content for one project — reused by the standalone
 *  Operations site page AND embedded as the Operations tab on the project page. */
export function ProjectOperations({ projectId, canEdit, project, autoOpenDelivery, onDeliveryFormOpened }: { projectId: string; canEdit: boolean; project: Project | null; autoOpenDelivery?: boolean; onDeliveryFormOpened?: () => void }) {
  const [tab, setTab] = useState<OpsTab>("attendance");
  const [siteGroup, setSiteGroup] = useState<ProjectSiteGroup | null>(null);
  // When the parent asks to check in a delivery (topbar action), jump straight
  // to the Deliveries sub-tab; DeliveriesPanel then opens the check-in form.
  useEffect(() => {
    if (autoOpenDelivery) setTab("deliveries");
  }, [autoOpenDelivery]);
  // Is this contract part of a shared site? Drives the banner + the fact that
  // attendance / RAMS / notices / deliveries below are shared across the site.
  useEffect(() => {
    api.opsProjectSiteGroup(projectId).then(setSiteGroup).catch(() => setSiteGroup(null));
  }, [projectId]);
  return (
    <>
      {siteGroup && (
        <div className="ck-short" style={{ marginBottom: 14 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-2)" strokeWidth="1.8"><path d="M3 21h18M5 21V8l7-4 7 4v13" /><path d="M9 21v-6h6v6" /></svg>
          <span>
            Part of site <b>{siteGroup.name}</b> — sign-in, RAMS, deliveries &amp; programme are shared across{" "}
            <b>{siteGroup.members.map((m) => m.code).join(", ")}</b>.
          </span>
        </div>
      )}
      <nav className="tabs" role="tablist" style={{ marginBottom: 16 }}>
        {OPS_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`tab-btn${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "attendance" && <AttendancePanel projectId={projectId} canEdit={canEdit} project={project} />}
      {tab === "operatives" && <OperativesPanel projectId={projectId} canEdit={canEdit} project={project} />}
      {tab === "notices" && <NoticesPanel projectId={projectId} canEdit={canEdit} onGoToAttendance={() => setTab("attendance")} />}
      {tab === "deliveries" && <DeliveriesPanel projectId={projectId} canEdit={canEdit} autoOpen={autoOpenDelivery} onAutoOpenConsumed={onDeliveryFormOpened} />}
      {tab === "rams" && <RamsPanel projectId={projectId} canEdit={canEdit} />}
      {tab === "photos" && <PhotosPanel projectId={projectId} canEdit={canEdit} />}
      {tab === "plant" && <PlantPanel projectId={projectId} canEdit={canEdit} />}
    </>
  );
}

export function OperationsSite({ me }: { me: CurrentUser | null }) {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const canEdit = can(me?.role, "delivery.edit");
  const [project, setProject] = useState<Project | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.getProject(projectId).then((r) => setProject(r.project)).catch((e) => setErr(e.message));
  }, [projectId]);

  return (
    <>
      <Topbar
        crumbs={<Link to="/operations">Operations</Link>}
        title={project ? `${project.code} — ${project.name}` : "Site"}
      />
      <main>
        {err && <div className="flash error">{err}</div>}
        <ProjectOperations projectId={projectId} canEdit={canEdit} project={project} />
      </main>
    </>
  );
}

// ── Attendance + the public sign-in link / QR ────────────────────────────────
function AttendancePanel({ projectId, canEdit, project }: { projectId: string; canEdit: boolean; project: Project | null }) {
  const [token, setToken] = useState<string | null>(null);
  const [date, setDate] = useState(todayISO());
  const [rows, setRows] = useState<SiteSignin[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  function loadDay() {
    api.opsAttendance(projectId, date).then(setRows).catch((e) => setErr(e.message));
  }
  useEffect(loadDay, [projectId, date]);
  useEffect(() => {
    // Editors get a link minted on demand; everyone else just reads the existing one.
    (canEdit ? api.opsEnsureSiteLink(projectId) : api.opsGetSiteLink(projectId))
      .then((r) => setToken(r.token))
      .catch(() => setToken(null));
  }, [projectId, canEdit]);

  const siteUrl = token ? `${window.location.origin}/site/${token}` : "";

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(siteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the field is selectable as a fallback */ }
  }

  async function rotate() {
    if (!confirm("Generate a new link? The current QR / link will stop working.")) return;
    setBusy(true);
    try {
      const r = await api.opsRotateSiteLink(projectId);
      setToken(r.token);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  const [q, setQ] = useState("");
  const shown = q.trim()
    ? rows.filter((r) => `${r.name} ${r.company ?? ""} ${r.trade ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))
    : rows;
  const onSite = rows.filter((r) => !r.signed_out_at).length;
  // Summary stats (match the design's attendance header band). The standing
  // daily briefing is mandatory at sign-in, so every sign-in acknowledged it
  // when one is set; RAMS-signed is matched from the operative register.
  const hasBriefing = rows.some((r) => r.briefing_ack != null);
  const briefed = hasBriefing ? rows.filter((r) => r.briefing_ack).length : null;
  const ramsTracked = rows.some((r) => r.rams_signed != null);
  const ramsSigned = rows.filter((r) => r.rams_signed).length;
  const firstIn = rows.length ? rows.reduce((min, r) => (r.signed_in_at < min ? r.signed_in_at : min), rows[0].signed_in_at) : null;

  async function signOut(id: number) {
    setErr(null);
    try { await api.opsSignOut(projectId, id); loadDay(); }
    catch (e) { setErr((e as Error).message); }
  }
  async function signOutAll() {
    if (!confirm(`Sign out everyone currently on site (${onSite})?`)) return;
    setErr(null);
    try { await api.opsSignOutAll(projectId); loadDay(); }
    catch (e) { setErr((e as Error).message); }
  }
  // Demo project only — sign an operative in by hand so the whole sign-in →
  // briefing → toolbox-talk chain can be walked through from a desk. The worker
  // enforces this; the UI just doesn't offer it anywhere else.
  const isDemo = projectId === "sandbox";
  const [crewList, setCrewList] = useState<Awaited<ReturnType<typeof api.operativesByProject>>>([]);
  useEffect(() => {
    if (!isDemo) return;
    api.operativesByProject(projectId).then(setCrewList).catch(() => setCrewList([]));
  }, [isDemo, projectId]);
  async function manualSignIn(operativeId: string) {
    if (!operativeId) return;
    setErr(null);
    try {
      const r = await api.opsManualSignIn(projectId, operativeId);
      if (r.already_on_site) setErr("They're already signed in on site today.");
      loadDay();
    } catch (e) { setErr((e as Error).message); }
  }
  // Correct a sign-out time (or set one on an open row) — HH:MM on the sign-in's day.
  async function editSignoutTime(r: SiteSignin) {
    const current = r.signed_out_at
      ? new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(r.signed_out_at))
      : "17:00";
    const t = prompt(`Sign-out time for ${r.name} (HH:MM, 24-hour${r.signed_out_auto ? " — currently the 19:00 auto stamp" : ""}):`, current);
    if (!t) return;
    setErr(null);
    try { await api.opsEditSignoutTime(projectId, r.id, t.trim()); loadDay(); }
    catch (e) { setErr((e as Error).message); }
  }
  // Range export: PDF is the proof-of-acceptance document; Excel for analysis.
  // Dates picked in a small dialog with native calendar inputs.
  const [exportOpen, setExportOpen] = useState(false);
  const [expFrom, setExpFrom] = useState(() => new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10));
  const [expTo, setExpTo] = useState(todayISO());
  async function runExport(kind: "pdf" | "xlsx" | "pack") {
    if (!expFrom || !expTo) return;
    setBusy(true);
    try {
      if (kind === "pack") {
        const r = await api.opsHsPackData(projectId, expFrom, expTo);
        await generateHsPackPdf(project?.code ?? "", project?.name ?? "", r.from, r.to, r.signins, r.acks, r.briefings, r.talks, r.quals);
      } else {
        const r = await api.opsAttendanceExport(projectId, expFrom, expTo);
        if (kind === "pdf") await generateAttendancePdf(project?.code ?? "", project?.name ?? "", r.from, r.to, r.signins, r.acks, r.briefings);
        else generateAttendanceXlsx(project?.code ?? "", r.from, r.to, r.signins, r.acks, r.briefings);
      }
      setExportOpen(false);
    } catch (e) { setErr(e instanceof Error ? e.message : "export failed"); }
    finally { setBusy(false); }
  }

  return (
    <>
      {err && <div className="flash error">{err}</div>}

      <div className="kpis" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="kpi-label">On site now</div>
          <div className="kpi-value">{onSite}{onSite > 0 && <span className="pill ok dot" style={{ marginLeft: 6, fontSize: 11, verticalAlign: "middle" }}>live</span>}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Signed in {date === todayISO() ? "today" : "that day"}</div>
          <div className="kpi-value">{rows.length}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Briefing acknowledged</div>
          <div className="kpi-value">{briefed == null ? "—" : <>{briefed}<span className="muted" style={{ fontSize: 15 }}> / {rows.length}</span></>}</div>
          <div className="kpi-sub">{briefed == null ? "no briefing set" : "acknowledged at sign-in"}</div>
        </div>
        {ramsTracked ? (
          <div className="kpi">
            <div className="kpi-label">RAMS signed</div>
            <div className="kpi-value">{ramsSigned}<span className="muted" style={{ fontSize: 15 }}> / {rows.length}</span></div>
            <div className="kpi-sub">{rows.length - ramsSigned > 0 ? `${rows.length - ramsSigned} to re-sign` : "all signed"}</div>
          </div>
        ) : (
          <div className="kpi">
            <div className="kpi-label">First sign-in</div>
            <div className="kpi-value">{firstIn ? fmtTime(firstIn) : "—"}</div>
          </div>
        )}
      </div>

      <div className="ops-attendance-layout">
        {/* Sign-in link / QR */}
        <div className="card ops-signin-card">
          <h3 style={{ marginTop: 0 }}>Site sign-in</h3>
          {token ? (
            <>
              <QrCode value={siteUrl} size={200} />
              <p className="muted" style={{ fontSize: 13 }}>
                Operatives scan this (or open the link) to sign in, acknowledge today's
                briefing and record their location.
              </p>
              <div className="ops-link-row">
                <input className="input" readOnly value={siteUrl} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="ghost tiny" onClick={copyLink}>{copied ? "Copied" : "Copy"}</button>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <a className="ghost tiny" href={siteUrl} target="_blank" rel="noreferrer" style={{ display: "inline-block", textDecoration: "none" }}>Open</a>
                <button type="button" className="ghost tiny" onClick={() => printQrPoster(siteUrl, project?.code ?? "Site", project?.name ?? "")}>Print QR</button>
                {canEdit && (
                  <button type="button" className="ghost tiny" onClick={rotate} disabled={busy}>Reset link</button>
                )}
              </div>
            </>
          ) : (
            <p className="muted">No sign-in link yet{canEdit ? "" : " — ask a manager to set one up"}.</p>
          )}
        </div>

        {/* Attendance list */}
        <div className="card ops-attendance-card">
          <div className="card-hd" style={{ flexWrap: "wrap", gap: 10 }}>
            <h2 style={{ fontSize: 17 }}>On site</h2>
            <span className="pill neutral">{onSite} here{rows.length - onSite > 0 ? ` · ${rows.length - onSite} signed out` : ""}</span>
            <span className="grow" />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or company" style={{ width: 190, maxWidth: "45%" }} />
            {canEdit && isDemo && crewList.length > 0 && (
              <select className="input" value="" style={{ width: "auto" }}
                title="Demo only — sign an operative in from here so you can test the sign-in, briefing and toolbox-talk flow on yourself. Live sites use the QR code."
                onChange={(e) => { const v = e.target.value; e.currentTarget.value = ""; void manualSignIn(v); }}>
                <option value="">+ Sign someone in (demo)…</option>
                {crewList.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}{o.signed_in_today ? " — already in today" : ""}</option>
                ))}
              </select>
            )}
            {canEdit && onSite > 0 && <button className="ghost tiny" onClick={signOutAll}>Sign out all</button>}
            <input className="input" type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} style={{ width: "auto" }} />
            <button className="accent tiny" disabled={busy}
              title="Download the sign-in register with briefing acceptance and signatures — PDF proof of acceptance, or Excel for analysis"
              onClick={() => setExportOpen(true)}>Export ↓</button>
          </div>
          {exportOpen && (
            // z-index above Leaflet's panes/controls (they reach ~1000), or the
            // attendance map bleeds through the dialog.
            <div style={{ position: "fixed", inset: 0, background: "rgba(15,17,48,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1400 }}
              onClick={() => !busy && setExportOpen(false)}>
              <div className="card" style={{ width: 400, maxWidth: "calc(100% - 32px)" }} onClick={(e) => e.stopPropagation()}>
                <div className="card-hd"><h3 style={{ flex: 1 }}>Export attendance &amp; briefing acceptance</h3></div>
                <div className="card-bd">
                  <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
                    Sign-in register with the daily briefing accepted at each sign-in, toolbox-talk acknowledgements and operative signatures.
                  </p>
                  <div className="row" style={{ gap: 10 }}>
                    {/* showPicker(): Safari renders date inputs as bare segment
                        editors — without this, clicking never opens a calendar. */}
                    <label className="field" style={{ flex: 1 }}>
                      <span>From</span>
                      <input className="input" type="date" value={expFrom} max={expTo || todayISO()} onChange={(e) => setExpFrom(e.target.value)}
                        onClick={(e) => { try { (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.(); } catch { /* segment editing still works */ } }} />
                    </label>
                    <label className="field" style={{ flex: 1 }}>
                      <span>To</span>
                      <input className="input" type="date" value={expTo} min={expFrom} max={todayISO()} onChange={(e) => setExpTo(e.target.value)}
                        onClick={(e) => { try { (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.(); } catch { /* segment editing still works */ } }} />
                    </label>
                  </div>
                  <div className="row" style={{ marginTop: 14, justifyContent: "flex-end", gap: 8 }}>
                    <button className="ghost" onClick={() => setExportOpen(false)} disabled={busy}>Cancel</button>
                    <button className="ghost" onClick={() => void runExport("xlsx")} disabled={busy || !expFrom || !expTo} title="Spreadsheet version, for filtering/analysis">Excel</button>
                    <button className="ghost" onClick={() => void runExport("pack")} disabled={busy || !expFrom || !expTo}
                      title="Full pack: register + briefing texts + toolbox talks (full copy & acknowledgements) + operative qualifications">
                      H&amp;S pack
                    </button>
                    <button className="accent" onClick={() => void runExport("pdf")} disabled={busy || !expFrom || !expTo}>
                      {busy ? "Preparing…" : "Download PDF"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
          <AttendanceMap signins={rows} />
          {rows.length === 0 ? (
            <div className="empty">No sign-ins for {fmtDate(date)}.</div>
          ) : shown.length === 0 ? (
            <div className="empty">No one matches “{q}”.</div>
          ) : (
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Operative</th>
                  <th>Trade</th>
                  <th>Signed in</th>
                  {hasBriefing && <th className="center">Briefing</th>}
                  {ramsTracked && <th className="center">RAMS</th>}
                  <th className="center">Location</th>
                  <th className="center">Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  return (
                    <tr key={r.id} className={r.signed_out_at ? "ops-row-inactive" : ""}>
                      <td data-label="Operative">
                        <div className="row" style={{ gap: 9 }}>
                          <span className="avatar" style={{ width: 28, height: 28, fontSize: 11, flexShrink: 0 }}>{r.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}</span>
                          <div style={{ minWidth: 0 }}><b>{r.name}</b>{r.company && <div className="muted" style={{ fontSize: 12 }}>{r.company}</div>}</div>
                        </div>
                      </td>
                      <td className="muted" data-label="Trade">{r.trade ?? "—"}</td>
                      <td data-label="Signed in">
                        {fmtDateTime(r.signed_in_at)}
                        {r.signed_out_at && (
                          <span className="muted"> – {fmtTime(r.signed_out_at)}{r.signed_out_auto ? (
                            <span className="pill warn" style={{ marginLeft: 5, fontSize: 10 }} title="No sign-out was recorded — closed automatically at 19:00. Click ✎ to correct it.">auto</span>
                          ) : null}</span>
                        )}
                        {canEdit && (
                          <button className="ghost tiny" style={{ marginLeft: 5, padding: "1px 5px" }} onClick={() => void editSignoutTime(r)}
                            title={r.signed_out_at ? "Edit the sign-out time" : "Set a sign-out time for this sign-in"}>✎</button>
                        )}
                      </td>
                      {hasBriefing && <td className="center" data-label="Briefing"><span className="pill ok dot">Acknowledged</span></td>}
                      {ramsTracked && (
                        <td className="center" data-label="RAMS">
                          {r.rams_signed == null
                            ? <span className="muted">—</span>
                            : r.rams_signed
                              ? <span className="pill ok dot">Signed</span>
                              : <span className="pill warn dot">Unsigned</span>}
                        </td>
                      )}
                      <td className="center" data-label="Location">{r.lat != null && r.lng != null ? <a className="muted" href={`https://www.google.com/maps?q=${r.lat},${r.lng}`} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }} title={r.accuracy != null ? `±${Math.round(r.accuracy)}m` : "View on map"}>📍 Map</a> : <span className="muted">—</span>}</td>
                      <td className="center" data-label="Status">
                        {r.signed_out_at ? <span className="pill neutral">Signed out</span> : <span className="pill ok dot">On site</span>}
                        {canEdit && !r.signed_out_at && <button className="ghost tiny" style={{ marginLeft: 6 }} onClick={() => signOut(r.id)}>Sign out</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <HsPackScheduleCard projectId={projectId} canEdit={canEdit} project={project} />
    </>
  );
}

// Scheduled H&S pack release: register + briefing texts + toolbox-talk copies
// + operative qualifications, emailed automatically each period.
function HsPackScheduleCard({ projectId, canEdit, project }: { projectId: string; canEdit: boolean; project: Project | null }) {
  const [sched, setSched] = useState<import("../../shared/types").HsPackSchedule | null>(null);
  const [active, setActive] = useState(false);
  const [frequency, setFrequency] = useState("weekly");
  const [weekday, setWeekday] = useState(1);
  const [sendHour, setSendHour] = useState(7);
  // Recipients are chips in the UI but stored as one comma string on the schedule
  // (no schema change) — serialised only at the API boundary.
  const [recips, setRecips] = useState<string[]>([]);
  const [emailDraft, setEmailDraft] = useState("");
  const [inclManagers, setInclManagers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.opsHsPackSchedule(projectId).then((s) => {
      setSched(s);
      if (s) {
        setActive(!!s.active); setFrequency(s.frequency); setWeekday(s.weekday);
        setSendHour(s.send_hour); setInclManagers(!!s.include_managers);
        setRecips((s.recipients ?? "").split(/[,;\s]+/).map((x) => x.trim()).filter((x) => x.includes("@")));
      }
    }).catch(() => setSched(null));
  }, [projectId]);

  // Chips + a half-typed address in the box. Everything the save should send.
  function currentRecips(): string[] {
    const list = [...recips];
    const d = emailDraft.trim().replace(/[,;]+$/, "");
    if (d.includes("@") && !list.includes(d)) list.push(d);
    return list;
  }
  function addEmail() {
    const e = emailDraft.trim().replace(/[,;]+$/, "");
    if (!e.includes("@")) return;
    if (!recips.includes(e)) setRecips([...recips, e]);
    setEmailDraft("");
  }

  /** Save the schedule. `over` overrides on-screen state — the toggle uses it to
   *  flip active and persist in one go. Folds any half-typed email into chips. */
  async function persist(over: Partial<{ active: boolean }> = {}) {
    const list = currentRecips();
    const s = await api.opsSaveHsPackSchedule(projectId, {
      frequency, weekday, send_hour: sendHour, recipients: list.join(", "),
      include_managers: inclManagers, active, ...over,
    });
    setSched(s); setRecips(list); setEmailDraft("");
    return s;
  }
  async function toggle() {
    const next = !active;
    if (next && currentRecips().length === 0 && !inclManagers) {
      setErr("Add a recipient email or tick “include managers” before switching auto-release on."); return;
    }
    setActive(next); setBusy(true); setErr(null); setMsg(null);
    try { await persist({ active: next }); setMsg(next ? "Auto-release on — packs email themselves on schedule." : "Auto-release off."); }
    catch (e) { setActive(!next); setErr(e instanceof Error ? e.message : "couldn't save"); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setErr(null); setMsg(null);
    try { await persist(); setMsg(active ? "Schedule saved — packs release automatically." : "Saved (auto-release is off)."); }
    catch (e) { setErr(e instanceof Error ? e.message : "failed to save"); }
    finally { setBusy(false); }
  }
  async function sendNow() {
    const to = todayISO();
    const from = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    const list = currentRecips();
    const who = [...list, ...(inclManagers ? ["the project/site/commercial managers"] : [])];
    if (!who.length) { setErr("Add at least one recipient email (or tick include managers) before sending."); return; }
    if (!confirm(`Email the H&S pack for ${from} to ${to} now?\n\nGoing to: ${who.join(", ")}`)) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      await persist();   // save first, so the send uses exactly what's on screen
      const r = await api.opsHsPackSendNow(projectId, from, to);
      setMsg(`Pack sent to ${r.sent_to.join(", ")}`);
    } catch (e) { setErr(e instanceof Error ? e.message : "send failed"); }
    finally { setBusy(false); }
  }
  // Direct download of the same pack (last 7 days) — no email involved.
  async function downloadPack() {
    const to = todayISO();
    const from = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.opsHsPackData(projectId, from, to);
      await generateHsPackPdf(project?.code ?? "", project?.name ?? "", r.from, r.to, r.signins, r.acks, r.briefings, r.talks, r.quals);
    } catch (e) { setErr(e instanceof Error ? e.message : "download failed"); }
    finally { setBusy(false); }
  }

  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-hd" style={{ flexWrap: "wrap", gap: 10 }}>
        <h3>H&amp;S pack release</h3>
        {active ? <span className="pill ok dot">Scheduled</span> : <span className="pill neutral">Off</span>}
        <span className="muted" style={{ fontSize: 12.5 }}>
          Emails the full pack — sign-in register, briefing texts, toolbox talks (full copy) and operative qualifications.
        </span>
        <span className="grow" />
        {sched?.last_sent_at && <span className="muted" style={{ fontSize: 12 }}>Last sent {fmtDate(sched.last_sent_at)}</span>}
        {/* On/off switch, same control the report distribution rules use. */}
        <label className="row" style={{ gap: 8, fontSize: 13, alignItems: "center" }}>
          <span className="muted">Auto-release</span>
          <button type="button" className={`mini-toggle${active ? " on" : ""}`} disabled={!canEdit || busy}
            onClick={() => void toggle()} aria-label={active ? "Switch auto-release off" : "Switch auto-release on"}><span /></button>
        </label>
      </div>
      <div className="card-bd">
        {err && <div className="flash error" style={{ marginBottom: 10 }}>{err}</div>}
        {msg && <div className="flash" style={{ marginBottom: 10 }}>{msg}</div>}
        {/* Recipient chips — type an address, Enter/comma/Add to chip it, × or Backspace to remove. */}
        <div className="field" style={{ marginBottom: 12 }}>
          <span>Send to{recips.length > 0 && <span className="muted" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}> · {recips.length} recipient{recips.length === 1 ? "" : "s"}</span>}</span>
          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <div className="chip-input" style={{ flex: 1 }} onClick={() => document.getElementById("hs-email-input")?.focus()}>
              {recips.map((e) => (
                <span key={e} className="chip">{e}<button onClick={(ev) => { ev.stopPropagation(); setRecips(recips.filter((x) => x !== e)); }} aria-label={`Remove ${e}`}>×</button></span>
              ))}
              <input id="hs-email-input" type="email" value={emailDraft} disabled={!canEdit}
                placeholder={recips.length ? "Add another…" : "hse@client.com"}
                onChange={(e) => setEmailDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "," || e.key === ";") { e.preventDefault(); addEmail(); }
                  else if (e.key === "Backspace" && !emailDraft && recips.length) setRecips(recips.slice(0, -1));
                }} />
            </div>
            {canEdit && <button type="button" className="ghost" onClick={addEmail} disabled={!emailDraft.includes("@")} style={{ whiteSpace: "nowrap" }}>+ Add</button>}
          </div>
          <label className="row" style={{ gap: 6, fontSize: 12.5, marginTop: 8 }}>
            <input type="checkbox" style={{ minHeight: 0 }} checked={inclManagers} onChange={(e) => setInclManagers(e.target.checked)} disabled={!canEdit} />
            Also send to this site's PM, site &amp; commercial managers
          </label>
        </div>
        <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field" style={{ width: 150 }}>
            <span>Frequency</span>
            <select className="input" value={frequency} onChange={(e) => setFrequency(e.target.value)} disabled={!canEdit}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly (1st)</option>
            </select>
          </label>
          {frequency === "weekly" && (
            <label className="field" style={{ width: 150 }}>
              <span>Day</span>
              <select className="input" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} disabled={!canEdit}>
                {days.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
              </select>
            </label>
          )}
          <label className="field" style={{ width: 120 }}>
            <span>Time (UK)</span>
            <select className="input" value={sendHour} onChange={(e) => setSendHour(Number(e.target.value))} disabled={!canEdit}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
            </select>
          </label>
          <span className="grow" />
          {canEdit && (
            <div className="row" style={{ gap: 8, paddingBottom: 2 }}>
              <button className="primary" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save schedule"}</button>
              <button className="ghost" onClick={() => void sendNow()} disabled={busy} title="Saves the settings above, then emails the last 7 days' pack to them now">Send now</button>
              <button className="ghost" onClick={() => void downloadPack()} disabled={busy} title="Download the last 7 days' pack as a PDF — no email">Download PDF</button>
            </div>
          )}
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
          Weekly packs cover the previous 7 full days; monthly packs (sent on the 1st) cover the previous calendar month.
          The same pack can be downloaded any time via Export ↓ → H&amp;S pack.
        </p>
      </div>
    </div>
  );
}

// ── Operatives assigned to this site ─────────────────────────────────────────
// An operative is on one site at a time (like a PO belongs to one project).
// Assigning someone already on another site moves them and notifies that site.
function OperativesPanel({ projectId, canEdit, project }: { projectId: string; canEdit: boolean; project: Project | null }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.operativesByProject>>>([]);
  const [all, setAll] = useState<Awaited<ReturnType<typeof api.operatives>>>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [inductBusy, setInductBusy] = useState<string | null>(null);

  const [ramsDocs, setRamsDocs] = useState<RamsDocument[]>([]);
  const [distributeDoc, setDistributeDoc] = useState<RamsDocument | null>(null);
  const [showAssign, setShowAssign] = useState(false);
  const [view, setView] = useState<"list" | "matrix">("list");
  // Qual upload target: { operative, and (from a matrix cell) the pre-picked type }.
  const [uploadFor, setUploadFor] = useState<{ id: string; name: string; type?: string } | null>(null);
  // Expandable rows: lazy-load each operative's full detail (contact, cards,
  // RAMS) only when its chevron is opened.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, Awaited<ReturnType<typeof api.operative>> | "loading" | "error">>({});
  function toggleRow(id: string) {
    const willOpen = !expanded.has(id);
    setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    if (willOpen && !details[id]) {
      setDetails((d) => ({ ...d, [id]: "loading" }));
      api.operative(id)
        .then((r) => setDetails((d) => ({ ...d, [id]: r })))
        .catch(() => setDetails((d) => ({ ...d, [id]: "error" })));
    }
  }
  function refresh() { api.operativesByProject(projectId).then(setRows).catch((e) => setErr(e.message)); }
  function refreshAll() { if (canEdit) api.operatives().then(setAll).catch(() => setAll([])); }
  useEffect(() => {
    refresh(); refreshAll();
    api.opsRams(projectId).then((d) => setRamsDocs(d.documents.filter((x) => x.active))).catch(() => setRamsDocs([]));
  }, [projectId, canEdit]);

  // Everyone not already on this site can be assigned (moving them if needed).
  const assignable = all.filter((o) => o.assigned_project_id !== projectId);

  async function assign() {
    if (!pick) return;
    const op = all.find((o) => o.id === pick);
    if (op?.assigned_project_id && op.assigned_project_id !== projectId) {
      const where = op.assigned_project_code ? ` (${op.assigned_project_code})` : "";
      if (!confirm(`${op.name} is currently on another site${where}.\n\nReassign them to ${project?.code ?? "this site"}? Their previous site manager will be notified.`)) return;
    }
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.assignOperative(pick, projectId);
      setMsg(r.reassigned ? (r.notified ? "Reassigned — previous site manager notified." : "Reassigned to this site.") : "Added to this site.");
      setPick("");
      setTimeout(() => setMsg(null), 5000);
      refresh(); refreshAll();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't assign"); }
    finally { setBusy(false); }
  }
  async function unassign(id: string, name: string) {
    if (!confirm(`Remove ${name} from this site's roster? They can sign back in once reassigned.`)) return;
    setErr(null);
    try { await api.unassignOperative(id); refresh(); refreshAll(); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't remove"); }
  }

  async function confirmSiteInduction(id: string, done: boolean) {
    setInductBusy(id); setErr(null);
    try { await api.setSiteInduction(id, projectId, done); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't update site induction"); }
    finally { setInductBusy(null); }
  }

  const siteInducted = rows.filter((o) => o.site_inducted).length;
  const ramsOk = rows.filter((o) => o.rams_pending === 0).length;
  const cardsAlert = rows.filter((o) => o.qual_worst === "expired" || o.qual_worst === "expiring").length;

  // ── Training matrix: competencies (columns) × operatives (rows) ─────────────
  // Columns are the standard competencies plus any extra card types actually
  // uploaded on this site, so gaps (missing cards) are visible.
  const STATUS_RANK: Record<string, number> = { valid: 4, expiring: 3, pending: 2, expired: 1, none: 0 };
  const matrixCols = useMemo(() => {
    const cols = [...MATRIX_QUAL_TYPES] as string[];
    const seen = new Set(cols);
    for (const o of rows) for (const q of o.quals) if (q.type && !seen.has(q.type)) { seen.add(q.type); cols.push(q.type); }
    return cols;
  }, [rows]);
  // Best-available card status a person holds for a competency (a valid card
  // beats an expiring one beats a pending self-upload beats an expired one).
  const cellStatus = (o: (typeof rows)[number], type: string): string => {
    let best = "none";
    for (const q of o.quals) if (q.type === type && (STATUS_RANK[q.status] ?? 0) > (STATUS_RANK[best] ?? 0)) best = q.status;
    return best;
  };
  function exportMatrix() {
    const code = project?.code ?? "site";
    const ops = rows.map((o) => ({
      name: o.name, company: o.company, trade: o.trade, inducted: !!o.site_inducted,
      cells: Object.fromEntries(matrixCols.map((c) => [c, cellStatus(o, c)])),
    }));
    const bytes = generateTrainingMatrixXlsx(code, project?.name ?? "", matrixCols, ops);
    const ab = new ArrayBuffer(bytes.byteLength); new Uint8Array(ab).set(bytes);
    const url = URL.createObjectURL(new Blob([ab], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = document.createElement("a"); a.href = url; a.download = `training-matrix-${code}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  }
  // After a card upload: refresh site rows + drop the cached detail so the
  // expanded panel reloads with the new card.
  function afterUpload(opId: string) {
    setUploadFor(null);
    setDetails((d) => { const n = { ...d }; delete n[opId]; return n; });
    refresh(); refreshAll();
  }

  return (
    <>
      {err && <div className="flash error">{err}</div>}

      {rows.length > 0 && (
        <div className="kpis" style={{ marginBottom: 16 }}>
          <div className="kpi"><div className="kpi-label">Assigned to site</div><div className="kpi-value">{rows.length}</div></div>
          <div className="kpi">
            <div className="kpi-label">Site inducted</div>
            <div className="kpi-value">{siteInducted}<span className="muted" style={{ fontSize: 15 }}> / {rows.length}</span></div>
            <div className="kpi-sub">{rows.length - siteInducted > 0 ? `${rows.length - siteInducted} to induct` : "all site-inducted"}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">RAMS signed</div>
            <div className="kpi-value">{ramsOk}<span className="muted" style={{ fontSize: 15 }}> / {rows.length}</span></div>
            <div className="kpi-sub">{rows.length - ramsOk > 0 ? `${rows.length - ramsOk} outstanding` : "all signed"}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Cards expiring / expired</div>
            <div className="kpi-value">{cardsAlert}</div>
            <div className="kpi-sub">{cardsAlert > 0 ? "needs attention" : "all valid"}</div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-hd">
          <h2 style={{ fontSize: 17 }}>Operatives on site</h2>
          <span className="pill neutral">{rows.length}</span>
          <span className="muted" style={{ fontSize: 12.5 }}>Assigned to this site — induction, cards &amp; RAMS at a glance.</span>
          <span className="grow" />
          {rows.length > 0 && (
            <div className="seg" style={{ marginRight: 8 }}>
              <button className={`seg-btn${view === "list" ? " active" : ""}`} onClick={() => setView("list")}>List</button>
              <button className={`seg-btn${view === "matrix" ? " active" : ""}`} onClick={() => setView("matrix")}>Training matrix</button>
            </div>
          )}
          {view === "matrix" && rows.length > 0 && (
            <button className="ghost tiny" onClick={exportMatrix} title="Export the training matrix to Excel">⤓ Excel</button>
          )}
          {canEdit && (
            <>
              <button
                className="ghost tiny"
                disabled={ramsDocs.length === 0}
                title={ramsDocs.length === 0 ? "Upload a RAMS document on the RAMS & docs tab first" : "Distribute RAMS to the crew for signature"}
                onClick={() => ramsDocs[0] && setDistributeDoc(ramsDocs[0])}
              >↗ Send RAMS for signature</button>
              <button className="accent tiny" onClick={() => setShowAssign((v) => !v)}>+ Assign operative</button>
            </>
          )}
        </div>

        {canEdit && showAssign && (
          <div style={{ padding: "10px 16px 14px", borderBottom: "1px solid var(--line)" }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              Each operative is on one site at a time — assigning someone who's on another site moves them here and emails that site's manager.
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ maxWidth: 340 }}>
                <option value="">— select operative —</option>
                {assignable.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}{o.assigned_project_code ? ` (on ${o.assigned_project_code})` : ""}</option>
                ))}
              </select>
              <button className="accent tiny" onClick={assign} disabled={!pick || busy}>{busy ? "Assigning…" : "Assign to site"}</button>
              <Link to="/operatives" className="ghost tiny" style={{ textDecoration: "none" }}>Open register</Link>
              {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <div className="empty" style={{ padding: 28 }}>No operatives assigned to this site yet.{canEdit ? " Use “+ Assign operative” to add the crew." : ""}</div>
        ) : view === "matrix" ? (
          <div style={{ overflowX: "auto", padding: "0 16px 14px" }}>
            <table className="ops-table" style={{ minWidth: 520 }}>
              <thead>
                <tr>
                  <th style={{ position: "sticky", left: 0, background: "var(--card)", zIndex: 1 }}>Operative</th>
                  {matrixCols.map((c) => <th key={c} className="center" style={{ whiteSpace: "nowrap", fontSize: 12 }}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td style={{ position: "sticky", left: 0, background: "var(--card)", zIndex: 1 }}>
                      <b>{o.name}</b>
                      {o.company && <div className="muted" style={{ fontSize: 11 }}>{o.company}</div>}
                    </td>
                    {matrixCols.map((c) => {
                      const st = cellStatus(o, c);
                      return (
                        <td key={c} className="center"
                            style={{ cursor: canEdit ? "pointer" : "default" }}
                            title={canEdit ? `${st === "none" ? "Upload" : "Update"} ${c} for ${o.name}` : `${c}: ${st}`}
                            onClick={canEdit ? () => setUploadFor({ id: o.id, name: o.name, type: c }) : undefined}>
                          <MatrixChip status={st} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted" style={{ padding: "8px 2px 0", fontSize: 12 }}>
              {canEdit ? "Click any cell to upload or update that card. " : ""}✓ green = valid · ✓ amber = expiring · ✕ = expired · • = awaiting verification · – = none on file.
            </p>
          </div>
        ) : (
          <table className="ops-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Company</th>
                <th>Trade</th>
                <th className="center">Company induction</th>
                <th className="center">Site induction</th>
                <th>Cards</th>
                <th className="center">RAMS</th>
                {canEdit && <th style={{ width: 150 }}></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const open = expanded.has(o.id);
                const detail = details[o.id];
                return (
                <Fragment key={o.id}>
                <tr style={open ? { background: "var(--accent-soft)" } : undefined}>
                  <td data-label="Name" onClick={() => toggleRow(o.id)} style={{ cursor: "pointer" }} title="Show details">
                    <div className="row" style={{ gap: 8, alignItems: "center" }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--muted)", flexShrink: 0, transition: "transform 120ms", transform: open ? "rotate(90deg)" : "none" }}><path d="M9 6l6 6-6 6" /></svg>
                      <span className="avatar" style={{ width: 28, height: 28, fontSize: 11, flexShrink: 0 }}>{o.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}</span>
                      <b>{o.name}</b>
                    </div>
                  </td>
                  <td className="muted" data-label="Company">{o.company || "—"}</td>
                  <td className="muted" data-label="Trade">{o.trade || "—"}</td>
                  <td className="center" data-label="Company induction">{o.induction_done ? <span className="pill ok dot">Inducted</span> : <span className="pill warn dot">Not inducted</span>}</td>
                  <td className="center" data-label="Site induction">
                    {o.site_inducted ? (
                      <span className="row" style={{ gap: 6, justifyContent: "center", alignItems: "center", flexWrap: "wrap" }}>
                        <span className="pill ok dot" title={o.site_inducted_at ? `Site inducted ${fmtDate(o.site_inducted_at)}` : undefined}>Inducted</span>
                        {canEdit && <button className="ghost tiny" disabled={inductBusy === o.id} onClick={() => confirmSiteInduction(o.id, false)}>Undo</button>}
                      </span>
                    ) : canEdit ? (
                      <button className="accent tiny" disabled={inductBusy === o.id} onClick={() => confirmSiteInduction(o.id, true)}>{inductBusy === o.id ? "…" : "Confirm"}</button>
                    ) : <span className="pill warn dot">Not inducted</span>}
                  </td>
                  <td data-label="Cards">
                    {o.quals.length === 0 ? <span className="muted">—</span> : (
                      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                        {o.quals.map((q, i) => (
                          q.status === "expired" ? <span key={i} className="pill rejected">{q.type} expired</span>
                            : q.status === "expiring" ? <span key={i} className="pill warn">{q.type}</span>
                            : q.status === "pending" ? <span key={i} className="pill neutral">{q.type} · pending</span>
                            : <span key={i} style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{q.type}</span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="center" data-label="RAMS">{o.rams_pending > 0 ? <span className="pill warn dot">Pending</span> : <span className="pill ok dot">Signed</span>}</td>
                  {canEdit && (
                    <td className="ops-table-actions" style={{ textAlign: "right" }}>
                      <button className="ghost tiny" title="Upload a qualification card for this operative" onClick={() => setUploadFor({ id: o.id, name: o.name })}>Upload card</button>
                      {o.rams_pending > 0 && ramsDocs[0] && <button className="ghost tiny" onClick={() => setDistributeDoc(ramsDocs[0])}>Send RAMS</button>}
                      <button className="ghost tiny danger" onClick={() => unassign(o.id, o.name)}>Remove</button>
                    </td>
                  )}
                </tr>
                {open && (
                  <tr>
                    <td colSpan={canEdit ? 8 : 7} style={{ background: "var(--accent-soft)", padding: 0 }}>
                      {!detail || detail === "loading"
                        ? <div className="muted" style={{ padding: "14px 20px", fontSize: 13 }}>Loading details…</div>
                        : detail === "error"
                          ? <div className="muted" style={{ padding: "14px 20px", fontSize: 13 }}>Couldn't load details.</div>
                          : <OperativeDetailPanel detail={detail} />}
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {distributeDoc && <RamsDistributeModal projectId={projectId} doc={distributeDoc} onClose={() => { setDistributeDoc(null); refresh(); }} />}
      {uploadFor && (
        <QualUploadModal
          operativeId={uploadFor.id}
          operativeName={uploadFor.name}
          presetType={uploadFor.type}
          onClose={() => setUploadFor(null)}
          onSaved={() => afterUpload(uploadFor.id)}
        />
      )}
    </>
  );
}

/** Status chip for a training-matrix cell — compact so many competencies fit. */
function MatrixChip({ status }: { status: string }) {
  if (status === "valid") return <span className="pill ok dot" title="Valid">✓</span>;
  if (status === "expiring") return <span className="pill warn dot" title="Expiring soon">✓</span>;
  if (status === "expired") return <span className="pill rejected" title="Expired">✕</span>;
  if (status === "pending") return <span className="pill neutral" title="Awaiting verification">•</span>;
  return <span className="muted" style={{ fontSize: 14 }}>–</span>;
}

/** Upload a qualification card for one operative (manager-verified on save).
 *  Opened from the site Operatives list (per row) or a training-matrix cell
 *  (with the competency pre-selected). Posts to the same endpoint the register
 *  drawer uses. */
function QualUploadModal({ operativeId, operativeName, presetType, onClose, onSaved }: {
  operativeId: string;
  operativeName: string;
  presetType?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<string>(presetType && (QUAL_TYPES as readonly string[]).includes(presetType) ? presetType : presetType ? "Other" : QUAL_TYPES[0]);
  // If the preset was a non-standard type, keep it as a free-text "Other" label.
  const [otherLabel, setOtherLabel] = useState<string>(presetType && !(QUAL_TYPES as readonly string[]).includes(presetType) ? presetType : "");
  // A preset (from a matrix cell) or a user-picked type is deliberate; the
  // untouched default defers to whatever's read off the card photo.
  const [typeTouched, setTypeTouched] = useState(!!presetType);
  const [cardNo, setCardNo] = useState("");
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const qualType = type === "Other" && otherLabel.trim() ? otherLabel.trim() : type;
      const fd = new FormData();
      fd.set("qual_type", qualType);
      fd.set("qual_type_manual", typeTouched ? "1" : "0");
      if (cardNo.trim()) fd.set("card_no", cardNo.trim());
      if (expiry) fd.set("expiry_date", expiry);
      const file = fileRef.current?.files?.[0];
      if (file) fd.set("file", file);
      await api.addOperativeQual(operativeId, fd);
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't save card"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,17,48,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={onClose}>
      <div className="card" style={{ maxWidth: 460, width: "calc(100% - 32px)" }} onClick={(e) => e.stopPropagation()}>
        <div className="card-hd"><h3 style={{ flex: 1 }}>Upload qualification</h3></div>
        <div className="card-bd">
          {err && <div className="flash error" style={{ marginBottom: 8 }}>{err}</div>}
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>For <b>{operativeName}</b>. Manager uploads count as verified straight away.</div>
          <div style={{ display: "grid", gap: 8 }}>
            <div>
              <label>Type (read from the photo if left as-is)</label>
              <select value={type} onChange={(e) => { setType(e.target.value); setTypeTouched(true); }}>{QUAL_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
            </div>
            {type === "Other" && (
              <div><label>Card name</label><input value={otherLabel} onChange={(e) => setOtherLabel(e.target.value)} placeholder="e.g. Confined space" /></div>
            )}
            <div className="row" style={{ gap: 8 }}>
              <div style={{ flex: 1 }}><label>Card no.</label><input value={cardNo} onChange={(e) => setCardNo(e.target.value)} /></div>
              <div style={{ flex: 1 }}><label>Expiry</label><input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></div>
            </div>
            <div><label>Photo / PDF of the card</label><input ref={fileRef} type="file" accept="image/*,application/pdf" /></div>
          </div>
        </div>
        <div className="card-hd" style={{ borderTop: "1px solid var(--line)", borderBottom: "none" }}>
          <div style={{ flex: 1 }} />
          <button className="ghost" onClick={onClose} disabled={busy}>Cancel</button>{" "}
          <button className="accent" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save card"}</button>
        </div>
      </div>
    </div>
  );
}

/** Expanded row detail for an operative on the site — contact + induction date,
 *  qualification cards with expiry, and the RAMS they've been issued, with a
 *  link to the full register record. Data is lazy-loaded by the parent. */
function OperativeDetailPanel({ detail }: { detail: Awaited<ReturnType<typeof api.operative>> }) {
  const op = detail.operative;
  const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "");
  const kv = { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, marginBottom: 5 } as const;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 24, padding: "16px 20px" }}>
      <div>
        <div className="eyebrow" style={{ marginBottom: 8 }}>Contact &amp; induction</div>
        <div style={kv}><span className="muted">Mobile</span><span>{op.phone || "—"}</span></div>
        <div style={kv}><span className="muted">Email</span><span style={{ wordBreak: "break-all", textAlign: "right" }}>{op.email || "—"}</span></div>
        <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 4 }}>
          {op.induction_done ? <span className="pill ok dot">Inducted</span> : <span className="pill warn dot">Not inducted</span>}
          {op.induction_done && op.induction_at && <span className="muted" style={{ fontSize: 12 }}>{fmt(op.induction_at)}</span>}
        </div>
      </div>
      <div>
        <div className="eyebrow" style={{ marginBottom: 8 }}>Cards</div>
        {detail.quals.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>None on file.</div> : detail.quals.map((q) => (
          <div key={q.id} style={kv}>
            <span style={{ fontWeight: 500 }}>{q.qual_type}{q.status === "expired" ? <span className="muted" style={{ fontWeight: 400 }}> · expired</span> : q.status === "pending" ? <span className="muted" style={{ fontWeight: 400 }}> · pending</span> : ""}</span>
            <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{q.expiry_date ? `exp ${fmt(q.expiry_date)}` : "—"}</span>
          </div>
        ))}
      </div>
      <div>
        <div className="eyebrow" style={{ marginBottom: 8 }}>RAMS</div>
        {detail.rams.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>None assigned.</div> : detail.rams.map((r) => (
          <div key={r.id} style={{ ...kv, alignItems: "center" }}>
            <span>{r.project_code} · {r.rams_title}</span>
            {r.signed_at ? <span className="pill ok dot">Signed</span> : <span className="pill warn dot">Pending</span>}
          </div>
        ))}
        <Link to="/operatives" style={{ display: "inline-block", marginTop: 8, fontSize: 12.5, color: "var(--accent-2)", textDecoration: "none", fontWeight: 600 }}>Open full profile →</Link>
      </div>
    </div>
  );
}

// ── Briefings & toolbox talks ────────────────────────────────────────────────

/** "PGP - TBT - 04 Working at Height.docx" → "Working at Height". Strips the
 *  house prefix and sequence number so the library reads as topics. */
function tbtTitleFromFilename(name: string): string {
  return name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/^\s*PGP\s*-\s*TBT\s*-\s*/i, "")
    .replace(/^\s*Toolbox\s*Talk[_:]?\s*/i, "")
    .replace(/^\s*\d{1,2}\s+/, "")
    .trim() || name;
}

/** Flatten converted HTML to the plain text the recorded talk stores, keeping
 *  block boundaries as line breaks so bullets survive. */
function htmlToText(html: string): string {
  if (!html) return "";
  const withBreaks = html
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<br\s*\/?>/gi, "\n");
  const el = document.createElement("div");
  el.innerHTML = withBreaks;
  return (el.textContent ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n").map((l) => l.trim()).join("\n")
    .trim();
}

// Standing daily briefing — set once, shown + (mandatorily) acknowledged at every
// sign-in. Acknowledgement is implicit: an operative cannot sign in without it,
// so "acknowledged today" == today's sign-ins, and the crew not yet on site are
// the ones still outstanding.
function StandingBriefingCard({ projectId, canEdit, crew, ackedToday, onGoToAttendance }: {
  projectId: string; canEdit: boolean; crew: number; ackedToday: number; onGoToAttendance?: () => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState<SiteBriefing | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);

  async function generate() {
    const p = aiPrompt.trim();
    if (!p) return;
    setAiBusy(true); setAiErr(null);
    try {
      const draft = await api.opsDraftBriefing(projectId, p);
      setTitle(draft.title);
      setContent(draft.content);
    } catch (e) { setAiErr((e as Error).message); }
    finally { setAiBusy(false); }
  }

  function load() {
    api.opsGetBriefing(projectId)
      .then((b) => { setSaved(b); setTitle(b?.title ?? ""); setContent(b?.content ?? ""); })
      .catch(() => {});
  }
  useEffect(load, [projectId]);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const b = await api.opsSetBriefing(projectId, { title: title.trim(), content: content.trim() });
      setSaved(b); setTitle(b?.title ?? ""); setContent(b?.content ?? ""); setEditing(false); setAiPrompt(""); setAiErr(null);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  async function clear() {
    if (!confirm("Remove the standing daily briefing? Operatives will no longer acknowledge it at sign-in.")) return;
    setBusy(true); setErr(null);
    try { await api.opsClearBriefing(projectId); setSaved(null); setTitle(""); setContent(""); setEditing(false); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  function startEdit() { setTitle(saved?.title ?? ""); setContent(saved?.content ?? ""); setEditing(true); }
  function cancelEdit() { setTitle(saved?.title ?? ""); setContent(saved?.content ?? ""); setEditing(false); setAiPrompt(""); setAiErr(null); }

  const dirty = title.trim() !== (saved?.title ?? "") || content.trim() !== (saved?.content ?? "");
  const outstanding = crew > 0 ? Math.max(0, crew - ackedToday) : 0;
  const pct = crew > 0 ? Math.min(100, Math.round((ackedToday / crew) * 100)) : 0;

  const editor = (
    <div style={{ marginTop: saved ? 18 : 14, paddingTop: saved ? 18 : 0, borderTop: saved ? "1px solid var(--line)" : "none" }}>
      <div style={{ background: "var(--accent-soft)", border: "1px solid var(--line)", borderRadius: 10, padding: 12, marginBottom: 14 }}>
        <div className="row" style={{ alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontWeight: 600, color: "var(--accent)" }}>✨ Write with AI</span>
          <span className="muted" style={{ fontSize: 12.5 }}>Drafts a full briefing from today's key points — review before saving.</span>
        </div>
        <textarea
          className="input"
          rows={2}
          value={aiPrompt}
          onChange={(e) => setAiPrompt(e.target.value)}
          placeholder="e.g. roof felting on Block D, scaffold inspected this morning, rain forecast after 2pm, keep walkways clear"
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generate(); }}
        />
        <div className="row" style={{ marginTop: 8, alignItems: "center", gap: 10 }}>
          <button className="primary tiny" onClick={generate} disabled={aiBusy || !aiPrompt.trim()}>
            {aiBusy ? "Drafting…" : title.trim() || content.trim() ? "Re-draft" : "Generate briefing"}
          </button>
          {aiErr && <span className="muted" style={{ fontSize: 12.5, color: "var(--danger, #b91c1c)" }}>{aiErr}</span>}
          {!aiErr && <span className="muted" style={{ fontSize: 12 }}>You can edit the result before saving.</span>}
        </div>
      </div>
      <label className="field">
        <span>Title</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Site rules & today's hazards" />
      </label>
      <label className="field" style={{ marginTop: 12 }}>
        <span>Briefing</span>
        <textarea className="input" rows={4} value={content} onChange={(e) => setContent(e.target.value)} placeholder="What every operative must read & acknowledge before signing in…" />
      </label>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={save} disabled={busy || (!title.trim() && !content.trim()) || (saved != null && !dirty)}>
          {busy ? "Saving…" : saved ? "Update briefing" : "Set briefing"}
        </button>
        <button className="ghost" onClick={cancelEdit} disabled={busy}>Cancel</button>
        {saved && <span className="muted" style={{ fontSize: 12.5 }}>Re-acknowledgement will be required from everyone on next sign-in.</span>}
      </div>
    </div>
  );

  // Read-only view for non-editors.
  if (!canEdit) {
    if (!saved) return null;
    return (
      <div className="card">
        <div className="card-hd">
          <h3>Daily briefing</h3>
          <span className="pill ok dot">Active</span>
          <span className="muted" style={{ fontSize: 12.5 }}>Shown &amp; acknowledged at every sign-in.</span>
        </div>
        <div className="card-bd">
          <h3 className="serif" style={{ fontSize: 18, marginBottom: 6 }}>{saved.title}</h3>
          {saved.content && <p style={{ margin: 0, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{saved.content}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-hd">
        <h3>Daily briefing</h3>
        <span className={`pill ${saved ? "ok" : "neutral"} dot`}>{saved ? "Active" : "Not set"}</span>
        <span className="muted" style={{ fontSize: 12.5 }}>Shown &amp; acknowledged at every sign-in until changed.</span>
        <span className="grow" />
        {saved && !editing && (
          <>
            <button className="ghost tiny" onClick={startEdit} disabled={busy}>Edit</button>
            <button className="ghost tiny" onClick={clear} disabled={busy}>Clear</button>
          </>
        )}
        {!saved && !editing && <button className="primary tiny" onClick={() => setEditing(true)}>Set daily briefing</button>}
      </div>
      <div className="card-bd">
        {err && <div className="flash error" style={{ marginBottom: 12 }}>{err}</div>}

        {saved ? (
          <div className="ops-briefing-grid">
            <div className="grow">
              <h3 className="serif" style={{ fontSize: 18, marginBottom: 6 }}>{saved.title}</h3>
              {saved.content && <p style={{ margin: 0, color: "var(--ink-2)", whiteSpace: "pre-wrap", maxWidth: 680 }}>{saved.content}</p>}
              <div className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
                Updated{saved.updated_by ? ` by ${saved.updated_by}` : ""} · {fmtDate(saved.updated_at)}
              </div>
            </div>
            <div className="ops-briefing-ack">
              <div className="eyebrow" style={{ marginBottom: 8 }}>Acknowledged at sign-in</div>
              {crew > 0 ? (
                <>
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 6, gap: 8 }}>
                    <span className="num serif" style={{ fontSize: 22 }}>{ackedToday}<span className="muted" style={{ fontSize: 13 }}> / {crew}</span></span>
                    {outstanding > 0
                      ? <span className="pill warn">{outstanding} outstanding</span>
                      : <span className="pill ok dot">All in</span>}
                  </div>
                  <div className="bar"><div className={outstanding > 0 ? "warn" : "ok"} style={{ width: `${pct}%` }} /></div>
                </>
              ) : (
                <div>
                  <span className="num serif" style={{ fontSize: 22 }}>{ackedToday}</span>
                  <div className="muted" style={{ fontSize: 12 }}>signed in today</div>
                </div>
              )}
              <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>Mandatory before sign-in.</div>
              {onGoToAttendance && <button className="ghost tiny" style={{ marginTop: 8, paddingLeft: 0 }} onClick={onGoToAttendance}>View attendance →</button>}
            </div>
          </div>
        ) : !editing ? (
          <div>
            <div style={{ fontWeight: 600 }}>No daily briefing at sign-in</div>
            <div className="muted" style={{ fontSize: 13 }}>Operatives will sign in without reading a site message. Set one for today's hazards, exclusion zones, or weather calls.</div>
          </div>
        ) : null}

        {editing && editor}
      </div>
    </div>
  );
}

/** What actually went out. Reports each channel honestly: "0 texted" when SMS
 *  isn't configured looked identical to a failure, and a re-send suppressed by
 *  the 3-minute de-dupe looked like nothing happened at all. */
function sendSummary(r: { sent: number; emailed: number; texted: number; cooldown: number }): string {
  if (r.cooldown && !r.emailed && !r.texted) {
    return `Recorded against the site, but nothing was sent: ${r.cooldown === r.sent ? "they were" : `${r.cooldown} of ${r.sent} were`} messaged in the last 3 minutes, so the duplicate was suppressed. Wait 3 minutes and send again.`;
  }
  const bits = [
    `${r.emailed} emailed`,
    `${r.texted} texted`,
    ...(r.cooldown ? [`${r.cooldown} suppressed (messaged in the last 3 min)`] : []),
  ];
  return `Delivered to ${r.sent} — ${bits.join(", ")}. Acknowledgements land here as they sign.`;
}

// Toolbox-talk log — the talk library + what this site's crew has acknowledged.
// A talk goes to whoever signed in that day, and is counted against exactly that
// set, so the denominator comes from the delivery — not the site's whole crew.
function ToolboxTalksSection({ projectId, canEdit, toolbox, others, onChanged }: {
  projectId: string; canEdit: boolean; toolbox: SiteNotice[]; others: SiteNotice[]; onChanged: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [noticeDate, setNoticeDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The library is PGP's own uploaded talks and nothing else. H&S wording is a
  // controlled document — the app must never offer content the company didn't write.
  const [uploaded, setUploaded] = useState<Awaited<ReturnType<typeof api.opsToolboxTemplates>>>([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const tbtFileRef = useRef<HTMLInputElement>(null);
  function loadTemplates() { api.opsToolboxTemplates().then(setUploaded).catch(() => setUploaded([])); }
  useEffect(loadTemplates, []);
  // How many signed in today — the size of the crew a talk sent now would reach.
  // null while loading, so the banner doesn't flash a wrong number.
  const [onSiteToday, setOnSiteToday] = useState<number | null>(null);
  useEffect(() => {
    api.operativesByProject(projectId)
      .then((a) => setOnSiteToday(a.filter((o) => o.signed_in_today).length))
      .catch(() => setOnSiteToday(null));
  }, [projectId]);
  const options: Array<{ key: string; title: string; required?: boolean; uploaded: string }> =
    uploaded.map((u) => ({ key: `u:${u.id}`, title: u.title, required: !!u.required, uploaded: u.id }));
  // A talk can be delivered on a site more than once; the row shows the latest.
  // `toolbox` arrives newest-first, so the first hit per template wins.
  const latestByTemplate = new Map<string, SiteNotice>();
  for (const n of toolbox) if (n.template_id && !latestByTemplate.has(n.template_id)) latestByTemplate.set(n.template_id, n);
  // Talks delivered here that aren't from the library (hand-typed, or older).
  const adhoc = toolbox.filter((n) => !n.template_id || !uploaded.some((u) => u.id === n.template_id));
  const undelivered = uploaded.filter((u) => !latestByTemplate.has(u.id));

  // The library talk this is being recorded from — carries its document (and so
  // the gated read-through) onto the notice the crew acknowledges.
  const [fromTemplate, setFromTemplate] = useState<string | null>(null);
  function openNew(presetTitle = "", presetContent = "") { setTitle(presetTitle); setContent(presetContent); setFromTemplate(null); setNoticeDate(todayISO()); setErr(null); setShowForm(true); }
  /** Prefill from a library talk. Selected by the option key, not the title, so
   *  two talks can share a name. */
  async function applyTemplate(key: string) {
    const opt = options.find((o) => o.key === key);
    if (!opt) return;
    if (!showForm) openNew();
    setTitle(opt.title);
    setFromTemplate(opt.uploaded);
    try {
      const full = await api.opsToolboxTemplate(opt.uploaded);
      setContent(full.content ?? htmlToText(full.html_content ?? ""));
    } catch { setContent(""); }
  }

  /** Upload a Word/PDF talk into the library. Word is converted to readable
   *  text/HTML here (same as RAMS); no signature — talks are acknowledged at
   *  sign-in, never signed. */
  async function uploadTemplate(files: FileList | null) {
    if (!files?.length) return;
    setUploadBusy(true); setErr(null);
    let ok = 0; const failed: string[] = [];
    for (const f of Array.from(files)) {
      try {
        const fd = new FormData();
        fd.append("file", f);
        fd.append("title", tbtTitleFromFilename(f.name));
        if (/\.docx$/i.test(f.name)) {
          const mod = await import("mammoth");
          const convert = (mod as { convertToHtml?: typeof import("mammoth").convertToHtml }).convertToHtml
            ?? (mod as unknown as { default: typeof import("mammoth") }).default.convertToHtml;
          const result = await convert({ arrayBuffer: await f.arrayBuffer() });
          const html = result.value
            .replace(/<img[^>]*>/gi, "")
            .replace(/<input[^>]*type=["']?checkbox["']?[^>]*>/gi, (m) => (/\bchecked\b/i.test(m) ? "☑ " : "☐ "))
            .replace(/<input[^>]*>/gi, "")
            .replace(/<\/?(?:textarea|select|button|form)[^>]*>/gi, "")
            .trim();
          if (!html) { failed.push(`${f.name} (unreadable)`); continue; }
          fd.append("html_content", html);
          fd.append("content", htmlToText(html));
          // Structured sections drive the gated read-through on the operative's
          // phone (same parser + reader as RAMS). Best-effort: without them the
          // talk still reads, just as one page rather than section-by-section.
          try {
            const { parseRamsDocx } = await import("../../shared/parse-rams");
            // bareBoldHeadings: talks head sections with bold labels ("Purpose",
            // "Key hazards"), not RAMS "1. …" numbering.
            const { doc } = parseRamsDocx(new Uint8Array(await f.arrayBuffer()), { bareBoldHeadings: true });
            if (doc.sections.length) fd.append("sections_json", JSON.stringify(doc));
          } catch (e) { console.warn("toolbox structured parse skipped:", e); }
        }
        await api.opsUploadToolboxTemplate(fd);
        ok++;
      } catch (e) { failed.push(`${f.name} (${e instanceof Error ? e.message : "failed"})`); }
    }
    if (tbtFileRef.current) tbtFileRef.current.value = "";
    if (failed.length) setErr(`Uploaded ${ok}. Couldn't upload: ${failed.join("; ")}`);
    setUploadBusy(false);
    loadTemplates();
  }
  async function removeTemplate(id: string, title: string) {
    if (!confirm(`Remove "${title}" from the toolbox-talk library? Talks already recorded from it keep their text.`)) return;
    try { await api.opsDeleteToolboxTemplate(id); loadTemplates(); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't remove"); }
  }
  async function create() {
    if (!title.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api.opsCreateNotice(projectId, {
        type: "toolbox", title: title.trim(), content: content.trim() || undefined,
        notice_date: noticeDate, template_id: fromTemplate ?? undefined,
      });
      setShowForm(false); setTitle(""); setContent(""); setFromTemplate(null); onChanged();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  async function toggle(n: SiteNotice) { await api.opsUpdateNotice(n.id, { active: n.active ? 0 : 1 }); onChanged(); }
  async function remove(n: SiteNotice) { if (!confirm(`Delete "${n.title}"?`)) return; await api.opsDeleteNotice(n.id); onChanged(); }

  // Push a talk to the site's crew — the talk equivalent of distributing RAMS.
  const [sendingId, setSendingId] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  /** Who a talk goes to: the crew who signed in TODAY, not everyone assigned to
   *  the site. A toolbox talk covers the people who were actually here for it —
   *  sending it to someone who wasn't on site records an attendance that never
   *  happened. Includes anyone who has since signed out; they were still here.
   *  (RAMS is the opposite and stays as-is: everyone assigned must sign before
   *  they work, on site or not.) Null with the error already shown. */
  async function crewToSend(): Promise<Awaited<ReturnType<typeof api.operativesByProject>> | null> {
    let ops: Awaited<ReturnType<typeof api.operativesByProject>> = [];
    try { ops = await api.operativesByProject(projectId); }
    catch { setErr("Couldn't load the site's crew."); return null; }
    if (!ops.length) { setErr("No operatives are assigned to this site yet — assign the crew first."); return null; }
    const here = ops.filter((o) => o.signed_in_today);
    if (!here.length) {
      setErr(`Nobody has signed in on this site today, so there's no one to deliver a talk to. A talk goes to the crew who were on site for it — ${ops.length} ${ops.length === 1 ? "operative is" : "operatives are"} assigned but none have signed in.`);
      return null;
    }
    return here;
  }
  async function sendToCrew(n: SiteNotice) {
    setErr(null); setMsg(null);
    const ops = await crewToSend();
    if (!ops) return;
    if (!confirm(`Send "${n.title}" to the ${ops.length} operative${ops.length === 1 ? "" : "s"} who signed in on this site today?\n\nThey get a link to read it through, sign it, and record where they were.`)) return;
    setSendingId(n.id);
    try {
      const r = await api.opsDistributeToolboxTalk({ notice_id: n.id, project_id: projectId, operative_ids: ops.map((o) => o.id) });
      setMsg(sendSummary(r));
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't send"); }
    finally { setSendingId(null); }
  }

  /** Deliver straight from the library: record the talk against this site and
   *  push it to the crew in one action. Recording first, then hunting for a
   *  "Send to crew" button on the row, hid distribution behind a step that reads
   *  like paperwork — this is the RAMS "Distribute" equivalent. */
  const [sendingTemplate, setSendingTemplate] = useState<string | null>(null);
  async function deliverFromLibrary(u: { id: string; title: string }) {
    setErr(null); setMsg(null);
    const ops = await crewToSend();
    if (!ops) return;
    if (!confirm(`Deliver "${u.title}" to the ${ops.length} operative${ops.length === 1 ? "" : "s"} who signed in on this site today?\n\nIt's recorded as delivered today, and each of them gets a link to read it through, sign it, and record where they were.`)) return;
    setSendingTemplate(u.id);
    try {
      const full = await api.opsToolboxTemplate(u.id);
      const { id } = await api.opsCreateNotice(projectId, {
        type: "toolbox", title: u.title,
        content: (full.content ?? htmlToText(full.html_content ?? "")) || undefined,
        notice_date: todayISO(), template_id: u.id,
      });
      const r = await api.opsDistributeToolboxTalk({ notice_id: id, project_id: projectId, operative_ids: ops.map((o) => o.id) });
      setMsg(`“${u.title}” — ${sendSummary(r)}`);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't send"); }
    finally { setSendingTemplate(null); }
  }

  /** The acknowledgement bar + count for a delivered talk. Counted against the
   *  operatives it was SENT to (those on site that day), not the site's whole
   *  crew — otherwise a talk delivered to 10 of 14 could never read complete.
   *  A talk recorded but never sent has no denominator, so just show the count. */
  function ackCell(n: SiteNotice) {
    const acked = n.ack_count ?? 0;
    const sent = n.sent_count ?? 0;
    if (sent === 0) {
      return <span className="muted" style={{ fontSize: 12 }}>{acked > 0 ? `${acked} acknowledged` : "not sent"}</span>;
    }
    const pct = Math.min(100, Math.round((acked / sent) * 100));
    return (
      <div className="minibar">
        <div className="bar"><div className={acked >= sent ? "ok" : acked > 0 ? "warn" : ""} style={{ width: `${pct}%` }} /></div>
        <span className="num" style={{ fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{acked}/{sent}</span>
      </div>
    );
  }

  /** One row per talk in the library, carrying its latest delivery on THIS site
   *  — the same shape as a RAMS document row, so Send sits where Distribute does. */
  function libraryRow(u: (typeof uploaded)[number]) {
    const last = latestByTemplate.get(u.id) ?? null;
    const sending = sendingTemplate === u.id || (last != null && sendingId === last.id);
    return (
      <tr key={`t:${u.id}`}>
        <td data-label="Talk" style={!last ? { borderLeft: "3px solid var(--accent)" } : undefined}>
          <div style={{ fontWeight: 600, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            {u.title}
            {u.required === 1 && <span className="pill navy">Required</span>}
            {!last && <span style={{ background: "var(--accent-soft)", color: "var(--accent-2)", fontSize: 10, fontWeight: 700, letterSpacing: "0.03em", padding: "2px 6px", borderRadius: 4, whiteSpace: "nowrap" }}>NOT DELIVERED</span>}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {u.has_doc ? "Read section-by-section on their phone" : "No reader — PDF"}
            {u.file_name ? ` · ${u.file_name}` : ""}
          </div>
        </td>
        <td data-label="Delivered">{last ? fmtDate(last.notice_date) : <span className="muted">—</span>}</td>
        <td data-label="Acknowledged">{last ? ackCell(last) : <span className="muted" style={{ fontSize: 12 }}>—</span>}</td>
        <td className="ops-table-actions">
          {canEdit && (
            <>
              <button className="accent tiny" disabled={sending} onClick={() => void deliverFromLibrary(u)}
                title={`Deliver "${u.title}" to this site's crew — records it and emails & texts each operative a link to read it through and acknowledge`}>
                {sending ? "Sending…" : last ? "Send again" : "Send to crew"}
              </button>{" "}
              <button className="ghost tiny danger" onClick={() => void removeTemplate(u.id, u.title)}
                title="Remove from the library (every site)">Remove</button>
            </>
          )}
        </td>
      </tr>
    );
  }

  /** A talk delivered on this site that didn't come from the library — typed by
   *  hand, or recorded before the talk was added. Kept visible so the site's
   *  H&S record stays complete. */
  function adhocRow(n: SiteNotice) {
    return (
      <tr key={`n:${n.id}`} className={n.active ? "" : "ops-row-inactive"}>
        <td data-label="Talk">
          <div style={{ fontWeight: 600, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            {n.title}
            <span className="pill neutral">One-off</span>
            {!n.active && <span className="pill neutral">Inactive</span>}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>Recorded{n.created_by ? ` by ${n.created_by}` : ""} · not in your library</div>
        </td>
        <td data-label="Delivered">{fmtDate(n.notice_date)}</td>
        <td data-label="Acknowledged">{ackCell(n)}</td>
        <td className="ops-table-actions">
          {canEdit && (
            <>
              <button className="accent tiny" disabled={sendingId === n.id} onClick={() => void sendToCrew(n)}
                title="Email & text the crew a link to read this talk through and acknowledge it — they don't have to be on site.">
                {sendingId === n.id ? "Sending…" : "Send to crew"}
              </button>{" "}
              <button className="ghost tiny" onClick={() => toggle(n)}>{n.active ? "Deactivate" : "Reactivate"}</button>{" "}
              <button className="ghost tiny danger" onClick={() => remove(n)}>Delete</button>
            </>
          )}
        </td>
      </tr>
    );
  }

  return (
    <div className="card">
      <div className="card-hd" style={{ flexWrap: "wrap", gap: 10 }}>
        <h3>Toolbox talks</h3>
        <span className="pill">{uploaded.length + adhoc.length}</span>
        <span className="muted" style={{ fontSize: 12.5 }}>Your talk library &amp; what this site's crew has acknowledged.</span>
        <span className="grow" />
        {canEdit && (
          <>
            <input ref={tbtFileRef} type="file" accept=".docx,.pdf" multiple hidden
              onChange={(e) => void uploadTemplate(e.target.files)} />
            <button className="ghost tiny" disabled={uploadBusy} onClick={() => tbtFileRef.current?.click()}
              title="Add your own toolbox talks (Word .docx or PDF) to the library — they become options for every site. Select several at once.">
              {uploadBusy ? "Uploading…" : "↑ Upload talks"}
            </button>
          </>
        )}
        {canEdit && !showForm && <button className="accent tiny" onClick={() => openNew()}>+ New toolbox talk</button>}
      </div>

      {showForm && (
        <div className="card-bd" style={{ borderBottom: "1px solid var(--line)" }}>
          {err && <div className="flash error" style={{ marginBottom: 12 }}>{err}</div>}
          <div className="ops-form-grid">
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              <span>Start from a talk in the library</span>
              <select className="input" value="" disabled={!options.length}
                onChange={(e) => { if (e.target.value) void applyTemplate(e.target.value); }}>
                <option value="">{options.length ? "Choose a talk to prefill (optional)…" : "No talks in the library yet — upload one above"}</option>
                {options.map((o) => (
                  <option key={o.key} value={o.key}>{o.title}{o.required ? " — required" : ""}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              <span>Topic</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Working at height & edge protection" />
            </label>
            <label className="field">
              <span>Date delivered</span>
              <input className="input" type="date" value={noticeDate} max={todayISO()} onChange={(e) => setNoticeDate(e.target.value)} />
            </label>
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              <span>Details</span>
              <textarea className="input" rows={3} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Key points operatives must read and acknowledge…" />
            </label>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={create} disabled={busy || !title.trim()}>{busy ? "Saving…" : "Record toolbox talk"}</button>
            <button className="ghost" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {(msg || (err && !showForm)) && (
        <div className="card-bd" style={{ paddingTop: 10, paddingBottom: 0 }}>
          {msg && <div className="flash">{msg}</div>}
          {err && !showForm && <div className="flash error">{err}</div>}
        </div>
      )}

      {canEdit && undelivered.length > 0 && (
        <div className="ops-distribute-banner">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-2)" strokeWidth="1.8"><path d="M12 16V4M8 8l4-4 4 4M5 20h14" /></svg>
          <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
            <b>{undelivered.length}</b> of your {uploaded.length} talks {undelivered.length === 1 ? "hasn't" : "haven't"} been delivered on this site.
            {" "}<b>Send to crew</b> goes to the{" "}
            {onSiteToday === null ? "operatives who signed in today" : <><b>{onSiteToday}</b> {onSiteToday === 1 ? "operative" : "operatives"} who signed in today</>}
            {" "}— they read it through and acknowledge it.
          </span>
        </div>
      )}

      {uploaded.length === 0 && adhoc.length === 0 ? (
        <div className="empty in-card">
          <h3 className="serif" style={{ fontSize: 19, marginBottom: 6 }}>No toolbox talks yet</h3>
          <p className="muted" style={{ maxWidth: 460, margin: "0 auto" }}>
            Upload your talks with <b>↑ Upload talks</b> — they go in the library once and can then be sent to any site's crew to read &amp; acknowledge.
          </p>
          {canEdit && <div style={{ marginTop: 20 }}><button className="accent" onClick={() => tbtFileRef.current?.click()}>↑ Upload talks</button></div>}
        </div>
      ) : (
        <table className="ops-table">
          <thead>
            <tr><th>Talk</th><th>Delivered</th><th>Acknowledged</th><th style={{ width: 220 }}></th></tr>
          </thead>
          <tbody>
            {uploaded.map(libraryRow)}
            {adhoc.map(adhocRow)}
          </tbody>
        </table>
      )}

      {others.length > 0 && (
        <>
          <div className="card-hd" style={{ borderTop: "1px solid var(--line)" }}>
            <h3 style={{ fontSize: 15 }}>Other notices</h3><span className="pill neutral">{others.length}</span>
          </div>
          <table className="ops-table">
            <thead>
              <tr><th>Notice</th><th>Posted</th><th>Acknowledged</th><th style={{ width: 220 }}></th></tr>
            </thead>
            <tbody>{others.map(adhocRow)}</tbody>
          </table>
        </>
      )}
    </div>
  );
}

// Briefings & toolbox tab = standing Daily briefing + the toolbox-talk log.
function NoticesPanel({ projectId, canEdit, onGoToAttendance }: { projectId: string; canEdit: boolean; onGoToAttendance?: () => void }) {
  const [notices, setNotices] = useState<SiteNotice[]>([]);
  const [crew, setCrew] = useState(0);
  const [ackedToday, setAckedToday] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  function refresh() { api.opsNotices(projectId).then(setNotices).catch((e) => setErr(e.message)); }
  useEffect(refresh, [projectId]);
  useEffect(() => {
    api.operativesByProject(projectId).then((a) => setCrew(a.length)).catch(() => {});
    api.opsAttendance(projectId, todayISO()).then((r) => setAckedToday(r.length)).catch(() => {});
  }, [projectId]);

  const toolbox = notices.filter((n) => n.type === "toolbox");
  const others = notices.filter((n) => n.type !== "toolbox");

  return (
    <>
      {err && <div className="flash error">{err}</div>}
      <StandingBriefingCard projectId={projectId} canEdit={canEdit} crew={crew} ackedToday={ackedToday} onGoToAttendance={onGoToAttendance} />
      <ToolboxTalksSection projectId={projectId} canEdit={canEdit} toolbox={toolbox} others={others} onChanged={refresh} />
    </>
  );
}

/** Do two unit strings mean the same thing? Tolerant of case, plurals and
 *  spacing ("rolls" == "Roll"). Used to decide whether a delivered-quantity
 *  tally can be shown as a proper fraction of the ordered quantity. */
function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (u: string) => u.trim().toLowerCase().replace(/[.\s]/g, "").replace(/s$/, "");
  return !!a && !!b && n(a) === n(b);
}

/** Leading product-code token of a material description, normalised for matching
 *  ("SAVBRF - Euroroof…" / "SAVBRF Euroroof…" → "SAVBRF"). Mirrors the worker. */
function materialCode(s: string): string {
  const first = (s || "").trim().split(/\s+/)[0] || "";
  return first.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Full-screen image viewer so a ticket photo opens in place instead of jumping
// to a new browser tab. Click the backdrop or press Esc to close.
function ImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.82)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
    >
      <button
        aria-label="Close"
        onClick={onClose}
        style={{ position: "absolute", top: 14, right: 16, background: "rgba(0,0,0,0.5)", color: "#fff", border: "none", borderRadius: 999, width: 40, height: 40, fontSize: 22, lineHeight: 1, cursor: "pointer" }}
      >×</button>
      <img
        src={url}
        alt="Delivery ticket"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 8, boxShadow: "0 8px 40px rgba(0,0,0,0.5)" }}
      />
    </div>
  );
}

// ── WhatsApp delivery tickets ───────────────────────────────────────────────
// Delivery tickets photographed into the site WhatsApp group arrive as progress
// photos. We scan those images for a PO number and surface the genuine tickets
// here so a manager can confirm them into the deliveries log with one tap.
// A tiny confidence bar + label for a ticket's match state (green = matched to a
// PO, amber = inferred from the ticket's item codes).
export function ConfBar({ pct, tone, label }: { pct: number; tone: "ok" | "warn"; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)" }}>
      <span style={{ width: 54, height: 4, borderRadius: 2, background: "var(--line)", overflow: "hidden", display: "inline-block" }}>
        <span style={{ display: "block", height: "100%", width: `${Math.max(0, Math.min(100, pct))}%`, background: tone === "warn" ? "var(--warn)" : "var(--success)" }} />
      </span>
      {label}
    </span>
  );
}

/** @deprecated superseded by ProjectTicketInbox (two-pane deliveries inbox). */
export function WhatsappTicketsPanel({ projectId, onCheckedIn }: { projectId: string; onCheckedIn: () => void }) {
  const [cands, setCands] = useState<DeliveryTicketCandidate[]>([]);
  const [unscanned, setUnscanned] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "matched" | "needs">("all");
  const [query, setQuery] = useState("");
  // All live projects — the site chooser when a ticket landed on the wrong site.
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof api.listProjects>>>([]);
  useEffect(() => { api.listProjects().then(setProjects).catch(() => {}); }, []);

  function load() {
    api.opsTicketCandidates(projectId)
      .then((r) => { setCands(r.candidates); setUnscanned(r.unscanned); setLoaded(true); })
      .catch(() => setLoaded(true));
  }
  useEffect(load, [projectId]);

  async function scan() {
    setScanning(true); setErr(null); setMsg(null);
    try {
      // Drain the backlog in batches so a long history gets fully reviewed.
      let totalTickets = 0, totalScanned = 0, guard = 0;
      for (;;) {
        const r = await api.opsScanWhatsappTickets(projectId, 6);
        totalTickets += r.tickets; totalScanned += r.scanned;
        setMsg(`Scanned ${totalScanned}… ${totalTickets} ticket${totalTickets === 1 ? "" : "s"} found`);
        if (r.remaining <= 0 || r.scanned === 0 || ++guard >= 30) break;
      }
      setMsg(totalScanned === 0 ? "No new WhatsApp photos to scan." : `Scanned ${totalScanned} photo${totalScanned === 1 ? "" : "s"} — ${totalTickets} delivery ticket${totalTickets === 1 ? "" : "s"} found.`);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "couldn't scan WhatsApp photos");
    } finally { setScanning(false); }
  }

  // Re-read the current candidates with the latest extractor (line items, better
  // classification, PO matching). One bounded pass, drained in batches.
  async function rescan() {
    setRescanning(true); setErr(null); setMsg(null);
    try {
      const before = new Date().toISOString();
      let total = 0, guard = 0;
      for (;;) {
        const r = await api.opsRescanTicketCandidates(projectId, before, 6);
        total += r.rescanned;
        setMsg(`Re-reading ${total}…`);
        if (r.remaining <= 0 || r.rescanned === 0 || ++guard >= 40) break;
      }
      setMsg(total === 0 ? "Nothing to re-read." : `Re-read ${total} ticket${total === 1 ? "" : "s"} with the latest scanner.`);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "couldn't re-read the tickets");
    } finally { setRescanning(false); }
  }

  async function dismiss(id: number) {
    setBusyId(id);
    try { await api.opsDismissTicketCandidate(projectId, id); setCands((cs) => cs.filter((c) => c.id !== id)); }
    catch (e) { setErr(e instanceof Error ? e.message : "couldn't dismiss"); }
    finally { setBusyId(null); }
  }

  // Nothing to show until there's either a backlog to scan or a found ticket.
  if (!loaded) return null;
  if (cands.length === 0 && unscanned === 0) return null;

  // Match-state split + filtered/searched view for the inbox toolbar.
  const matchedN = cands.filter((c) => c.matched_po_id).length;
  const needsN = cands.length - matchedN;
  const q = query.trim().toLowerCase();
  const shown = cands.filter((c) => {
    if (filter === "matched" && !c.matched_po_id) return false;
    if (filter === "needs" && c.matched_po_id) return false;
    if (q) {
      const hay = `${c.supplier_name || ""} ${c.summary || ""} ${c.delivery_note_number || ""} ${c.matched_po_number || c.po_number || c.guess_po_number || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const chipStyle = (on: boolean) => ({ cursor: "pointer", border: `1px solid ${on ? "var(--ink)" : "var(--line-strong)"}`, background: on ? "var(--ink)" : "var(--card)", color: on ? "var(--paper)" : "var(--ink-2)", borderRadius: 999, padding: "5px 11px", fontSize: 12.5, fontWeight: 600 } as const);

  return (
    <div style={{ marginBottom: 16 }}>
      {lightbox && <ImageLightbox url={lightbox} onClose={() => setLightbox(null)} />}
      <div className="eyebrow" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span>WhatsApp delivery tickets</span>
        {cands.length > 0 && <span className="pill ok" style={{ fontWeight: 400 }}>{cands.length} to confirm</span>}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
          {cands.length > 0 && (
            <button className="ghost tiny" onClick={rescan} disabled={rescanning || scanning} title="Re-read these tickets with the latest scanner">
              {rescanning ? "Re-reading…" : "Rescan"}
            </button>
          )}
          {unscanned > 0 && (
            <button className="ghost tiny" onClick={scan} disabled={scanning || rescanning}>
              {scanning ? "Scanning…" : `Scan ${unscanned} photo${unscanned === 1 ? "" : "s"}`}
            </button>
          )}
        </span>
      </div>
      {msg && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{msg}</div>}
      {err && <div className="error" style={{ marginBottom: 8 }}>{err}</div>}

      {cands.length > 0 && (
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          <button style={chipStyle(filter === "all")} onClick={() => setFilter("all")}>All · {cands.length}</button>
          <button style={chipStyle(filter === "matched")} onClick={() => setFilter("matched")}>Matched to PO · {matchedN}</button>
          <button style={chipStyle(filter === "needs")} onClick={() => setFilter("needs")}>Needs a PO · {needsN}</button>
          <input className="input" style={{ marginLeft: "auto", maxWidth: 240, fontSize: 13 }} placeholder="Search supplier, DN or PO…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}

      {cands.length === 0 ? (
        unscanned > 0 && !scanning && <div className="muted" style={{ fontSize: 13 }}>Scan the site's WhatsApp photos to find any delivery tickets.</div>
      ) : shown.length === 0 ? (
        <div className="muted" style={{ fontSize: 13, padding: "10px 2px" }}>No tickets match this filter.</div>
      ) : (
        <div className="ops-notice-list">
          {shown.map((c) => {
            const nItems = c.items?.length ?? 0;
            return (
            <div key={c.id} className="card ops-delivery">
              <button type="button" className="ops-thumb-link" style={{ border: "none", background: "none", padding: 0, cursor: "zoom-in" }} onClick={() => setLightbox(c.ticket_url)}>
                <img className="ops-thumb" src={c.ticket_url} alt="Delivery ticket" />
              </button>
              <div className="ops-delivery-body">
                <div className="ops-notice-head" style={{ flexWrap: "wrap" }}>
                  {c.matched_po_id ? (
                    <>
                      <span className="pill ok" title={c.matched_by === "supplier" ? "Matched by supplier name" : "Matched by PO number"}>PO {c.matched_po_number}</span>
                      <ConfBar pct={c.conf ?? 90} tone="ok" label={`${c.conf ?? 90}% · ${c.matched_by === "supplier" ? "supplier" : "PO read"}`} />
                      {c.matched_project_code && <span className="pill neutral" style={{ fontSize: 11 }} title="Contract this delivery belongs to">{c.matched_project_code}</span>}
                    </>
                  ) : c.method === "line" && c.guess_po_number ? (
                    <>
                      <span className="pill warn" title="Inferred from the ticket's item codes — confirm before check-in">PO {c.guess_po_number}?</span>
                      <ConfBar pct={c.conf ?? 50} tone="warn" label={`${c.conf ?? 50}% · inferred from items`} />
                      {c.guess_project_code && <span className="pill neutral" style={{ fontSize: 11 }}>{c.guess_project_code}</span>}
                    </>
                  ) : c.po_number ? (
                    <span className="pill warn" title="PO number read off the ticket but no matching live PO">PO {c.po_number}?</span>
                  ) : (
                    <span className="pill neutral">No PO matched</span>
                  )}
                  {c.delivery_date && <span className="muted" style={{ fontSize: 12 }}>{fmtDate(c.delivery_date)}</span>}
                </div>
                <div className="ops-notice-title">{c.supplier_name || c.matched_po_supplier || c.summary || "Delivery ticket"}</div>
                {c.summary && (c.supplier_name || c.matched_po_supplier) && <div className="muted" style={{ fontSize: 12 }}>{c.summary}</div>}
                <div className="muted" style={{ fontSize: 12, display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {c.delivery_note_number && <span>DN {c.delivery_note_number}</span>}
                  {nItems > 0 && <span>{nItems} line item{nItems === 1 ? "" : "s"} read</span>}
                </div>
                {openId === c.id ? (
                  <CandidateCheckIn
                    projectId={projectId}
                    cand={c}
                    projects={projects}
                    onCancel={() => setOpenId(null)}
                    onDone={() => { setOpenId(null); setCands((cs) => cs.filter((x) => x.id !== c.id)); onCheckedIn(); }}
                  />
                ) : (
                  <div className="row" style={{ gap: 8, marginTop: 8 }}>
                    <button className="primary tiny" onClick={() => setOpenId(c.id)} disabled={busyId === c.id}>Check in…</button>
                    <button className="ghost tiny" onClick={() => dismiss(c.id)} disabled={busyId === c.id}>Not a ticket</button>
                  </div>
                )}
              </div>
            </div>
          );})}
        </div>
      )}
    </div>
  );
}

// Shared "which site + which PO/supplier" chooser. Used to steer a WhatsApp
// ticket to the right site at check-in, and to move/reassign a delivery that
// was logged against the wrong site. Picking a PO carries its supplier.
/** A PO row from the list endpoint, reduced to the delivery state a picker
 *  shows. An order can take several delivery notes, so "PO-26003-0038 ·
 *  Fixfast" alone left no way to tell an untouched order from one that has
 *  already been received in full — which is the difference between logging a
 *  second drop and checking the same note in twice. */
type PoRowDelivery = {
  delivery_state?: PoDeliveryState;
  delivery_drops?: number;
  delivery_lines_delivered?: number;
  delivery_lines_started?: number;
  delivery_lines_total?: number;
};
function poDeliveryText(p: PoRowDelivery): string {
  if (!p.delivery_state) return "";
  return poDeliveryLabel({
    state: p.delivery_state,
    lines_delivered: p.delivery_lines_delivered ?? 0,
    lines_started: p.delivery_lines_started ?? 0,
    lines_total: p.delivery_lines_total ?? 0,
    drops: p.delivery_drops ?? 0,
  });
}
/** Suffix for a native <option>, which can carry no markup of its own. */
function poOptionSuffix(p: PoRowDelivery): string {
  const t = poDeliveryText(p);
  return t ? ` — ${t}` : "";
}
/** Said again under the select once an order is chosen: an already-complete
 *  order is where a check-in is most likely to be a duplicate, and the option
 *  text scrolls out of sight the moment the list closes. */
function PoDeliveryLine({ po }: { po: PoRowDelivery | null }) {
  if (!po?.delivery_state || po.delivery_state === "none") return null;
  const drops = po.delivery_drops ?? 0;
  // The bare `label` rule uppercases everything inside it, which is right for
  // the field captions and wrong for a sentence — the same reset the other
  // prose inside these labels carries.
  const sentence: React.CSSProperties = { fontSize: 11.5, marginTop: 3, textTransform: "none", letterSpacing: 0, fontWeight: 400 };
  if (po.delivery_state === "full") {
    return (
      <div style={{ ...sentence, color: "var(--warn)" }}>
        Already fully delivered{drops > 1 ? ` — ${drops} notes logged against it` : ""}. This check-in adds a
        further receipt.
      </div>
    );
  }
  const t = poDeliveryText(po);
  return (
    <div style={{ ...sentence, color: "var(--muted)" }}>
      {t.charAt(0).toUpperCase() + t.slice(1)} — this drop adds to what has already arrived.
    </div>
  );
}

function SitePoChooser({ projects, initialSite, initialPoId, initialSupplier, initialCompletesPo, initialPoLineId, initialReceivedQty, initialReceivedUnit, busy, confirmLabel, onCancel, onConfirm }: {
  projects: Awaited<ReturnType<typeof api.listProjects>>;
  initialSite: string;
  initialPoId: string;
  initialSupplier: string;
  initialCompletesPo?: number;
  initialPoLineId?: number | null;
  initialReceivedQty?: number | null;
  initialReceivedUnit?: string | null;
  busy: boolean;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (v: { target_project_id: string; po_id: string; po_number: string; supplier: string; completes_po: string; po_line_id: string; po_line_desc: string; received_qty: string; received_unit: string }) => void;
}) {
  const [site, setSite] = useState(initialSite);
  const [pos, setPos] = useState<Awaited<ReturnType<typeof api.listPOs>>>([]);
  const [poId, setPoId] = useState(initialPoId);
  const [supplier, setSupplier] = useState(initialSupplier);
  const [partial, setPartial] = useState(initialCompletesPo === 0);
  const [dropQty, setDropQty] = useState(initialReceivedQty != null ? String(initialReceivedQty) : "");
  const [dropUnit, setDropUnit] = useState(initialReceivedUnit || "");
  // Line items of the selected PO (fetched on demand — the list endpoint omits them).
  const [poLines, setPoLines] = useState<Array<{ id?: number; item: string; qty: number; unit: string }>>([]);
  const [poLineId, setPoLineId] = useState<string>(initialPoLineId ? String(initialPoLineId) : "");
  useEffect(() => {
    let live = true;
    api.listPOs({ project_id: site }).then((r) => {
      if (!live) return;
      const open = r.filter((p) => p.status !== "deleted");
      setPos(open);
      setPoId((cur) => (open.some((p) => p.id === cur) ? cur : ""));
    }).catch(() => { if (live) setPos([]); });
    return () => { live = false; };
  }, [site]);
  useEffect(() => {
    if (!poId) { setPoLines([]); setPoLineId(""); return; }
    let live = true;
    api.getPO(poId).then((po) => {
      if (!live) return;
      const lines = (po.lines || []).map((l) => ({ id: l.id, item: l.item, qty: l.qty, unit: l.unit }));
      setPoLines(lines);
      setPoLineId((cur) => (cur && lines.some((l) => String(l.id) === cur) ? cur : ""));
    }).catch(() => { if (live) setPoLines([]); });
    return () => { live = false; };
  }, [poId]);
  const selPo = pos.find((p) => p.id === poId) || null;
  const selLine = poLines.find((l) => String(l.id) === poLineId) || null;
  // Default the drop's unit to the line's ordered unit when a line is picked, so
  // a matching-unit delivery (e.g. rolls of rolls) burns down as a real fraction.
  useEffect(() => {
    if (selLine?.unit) setDropUnit((cur) => cur || selLine.unit);
  }, [poLineId]);
  return (
    <div className="card" style={{ marginTop: 8, padding: 10, display: "grid", gap: 8 }}>
      <label className="field"><span>Site</span>
        <select className="input" value={site} onChange={(e) => setSite(e.target.value)}>
          {projects.filter((p) => !p.completed_at).map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
        </select>
      </label>
      <label className="field"><span>Assign to PO</span>
        <select className="input" value={poId} onChange={(e) => setPoId(e.target.value)}>
          <option value="">— No PO — set supplier below —</option>
          {pos.map((p) => <option key={p.id} value={p.id}>{p.po_number} · {p.supplier ?? "—"}{p.order_type === "framework" ? " (framework)" : p.order_type === "call_off" ? " (call-off)" : ""}{poOptionSuffix(p)}</option>)}
        </select>
        <PoDeliveryLine po={selPo} />
      </label>
      {selPo && poLines.length > 0 && (
        <label className="field"><span>PO line item <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· optional</span></span>
          <select className="input" value={poLineId} onChange={(e) => setPoLineId(e.target.value)}>
            <option value="">— Whole PO —</option>
            {poLines.map((l) => <option key={l.id} value={String(l.id)}>{l.item}{l.qty ? ` (${l.qty}${l.unit ? " " + l.unit : ""})` : ""}</option>)}
          </select>
        </label>
      )}
      {selLine && (
        <div className="field"><span>Delivered this drop <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· optional</span></span>
          <div className="row" style={{ gap: 8 }}>
            <input className="input" style={{ maxWidth: 100 }} inputMode="decimal" value={dropQty} onChange={(e) => setDropQty(e.target.value)} placeholder="qty" />
            <input className="input" style={{ flex: 1 }} value={dropUnit} onChange={(e) => setDropUnit(e.target.value)} placeholder="unit e.g. packs, pallets" />
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>Counts toward the running total for this line — {selLine.item}.</div>
        </div>
      )}
      {!selPo && <label className="field"><span>Supplier</span>
        <input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="e.g. Alumasc Water Management Solutions" />
      </label>}
      {selPo && (
        <label className="row" style={{ gap: 8, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
          <span>Part delivery (worked out automatically from the quantities — tick only if none could be read)</span>
        </label>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button className="primary tiny" disabled={busy} onClick={() => onConfirm({ target_project_id: site, po_id: selPo ? selPo.id : "", po_number: selPo ? selPo.po_number : "", supplier: selPo ? (selPo.supplier ?? "") : supplier.trim(), completes_po: selPo && partial ? "0" : "1", po_line_id: selLine ? String(selLine.id) : "", po_line_desc: selLine ? selLine.item : "", received_qty: selLine ? dropQty.trim() : "", received_unit: selLine ? dropUnit.trim() : "" })}>{busy ? "Saving…" : confirmLabel}</button>
        <button className="ghost tiny" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Check a WhatsApp ticket candidate in, choosing the correct site + PO first.
/** The inbox guess names the PO's project by CODE — resolve to an id for the site select. */
function guessProjectId(cand: DeliveryTicketCandidate, projects: Array<{ id: string; code: string }>): string | null {
  return cand.guess_project_code ? (projects.find((p) => p.code === cand.guess_project_code)?.id ?? null) : null;
}

export function CandidateCheckIn({ projectId, cand, projects, onCancel, onDone }: {
  projectId: string;
  cand: DeliveryTicketCandidate;
  projects: Awaited<ReturnType<typeof api.listProjects>>;
  onCancel: () => void;
  onDone: () => void;
}) {
  const isMulti = (cand.items?.length ?? 0) > 1;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Even a one-item ticket may have a wrong/missing PO number — fall back to
  // matching the PO from its item code, same as the multi-line note.
  const [initSite, setInitSite] = useState(cand.matched_project_id || guessProjectId(cand, projects) || projectId);
  const [initPo, setInitPo] = useState(cand.matched_po_id || cand.guess_po_id || "");
  const [suggestedPo, setSuggestedPo] = useState(false);
  useEffect(() => {
    if (isMulti || cand.matched_po_id || cand.guess_po_id) return;
    api.opsSuggestPoForCandidate(projectId, cand.id).then((r) => {
      const top = r.ranked?.[0];
      if (top) { setInitSite(top.project_id); setInitPo(top.id); setSuggestedPo(true); }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A note with several items (SAVBRF, MG3BASE…) maps onto several PO lines, so
  // it gets the multi-line matcher; a one-item ticket uses the simple chooser.
  if (isMulti) {
    return <MultiLineCheckIn projectId={projectId} cand={cand} projects={projects} onCancel={onCancel} onDone={onDone} />;
  }
  return (
    <>
      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
      {suggestedPo && <div className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>PO matched from the ticket's item code.</div>}
      <SitePoChooser
        key={initPo}
        projects={projects}
        initialSite={initSite}
        initialPoId={initPo}
        initialSupplier={cand.supplier_name || ""}
        initialReceivedQty={cand.scanned_qty}
        initialReceivedUnit={cand.scanned_unit}
        busy={busy}
        confirmLabel="Confirm check-in"
        onCancel={onCancel}
        onConfirm={async (v) => {
          setBusy(true); setErr(null);
          try {
            const ov: Record<string, string> = { target_project_id: v.target_project_id, completes_po: v.completes_po };
            if (v.po_id) { ov.po_id = v.po_id; ov.po_number = v.po_number; }
            if (v.supplier) ov.supplier = v.supplier;
            if (v.po_line_id) { ov.po_line_id = v.po_line_id; ov.po_line_desc = v.po_line_desc; }
            if (v.received_qty) ov.received_qty = v.received_qty;
            if (v.received_unit) ov.received_unit = v.received_unit;
            await api.opsCheckInTicketCandidate(projectId, cand.id, ov);
            onDone();
          } catch (e) { setErr(e instanceof Error ? e.message : "couldn't check in"); setBusy(false); }
        }}
      />
    </>
  );
}

/** Match each item on a multi-line delivery note to a PO line by product code
 *  (SAVBRF → the SAVBRF line), suggest the PO from those codes when the printed
 *  order ref is wrong, and check the whole note in as one delivery per line. */
function MultiLineCheckIn({ projectId, cand, projects, onCancel, onDone }: {
  projectId: string;
  cand: DeliveryTicketCandidate;
  projects: Awaited<ReturnType<typeof api.listProjects>>;
  onCancel: () => void;
  onDone: () => void;
}) {
  const items = cand.items || [];
  const [site, setSite] = useState(cand.matched_project_id || guessProjectId(cand, projects) || projectId);
  const [poId, setPoId] = useState(cand.matched_po_id || cand.guess_po_id || "");
  const [pos, setPos] = useState<Awaited<ReturnType<typeof api.listPOs>>>([]);
  const [poLines, setPoLines] = useState<Array<{ id?: number; item: string; qty: number; unit: string }>>([]);
  // Reconciliation for the chosen PO: each line's ordered qty + cumulative prior
  // receipts, so we can show "N left after this delivery" per line.
  const [recon, setRecon] = useState<Awaited<ReturnType<typeof api.opsReconcileTicket>> | null>(null);
  const [rows, setRows] = useState(items.map((it) => ({ include: true, lineId: "", qty: it.qty != null ? String(it.qty) : "", unit: it.unit || "", desc: it.description })));
  const [part, setPart] = useState(false);
  // Scheme tickets: every item is a pack of the SAME priced line (insulation
  // boards etc.). One picker assigns all items at once, and the combined-entry
  // panel converts packs → the line's own unit so the burn-down compares like
  // with like.
  const [bulkLine, setBulkLine] = useState("");
  const [combine, setCombine] = useState(false);
  const [boardsPerPack, setBoardsPerPack] = useState(2);
  const [combinedQty, setCombinedQty] = useState("");
  const [combinedTouched, setCombinedTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggested, setSuggested] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // If the ticket didn't match a PO by number, ask the server which PO its item
  // codes point to and pre-select that site + PO.
  useEffect(() => {
    if (cand.matched_po_id || cand.guess_po_id) return;
    setSuggesting(true);
    api.opsSuggestPoForCandidate(projectId, cand.id).then((r) => {
      const top = r.ranked?.[0];
      if (top) { setSite(top.project_id); setPoId(top.id); setSuggested(true); }
    }).catch(() => {}).finally(() => setSuggesting(false));
  }, [projectId, cand.id, cand.matched_po_id]);

  useEffect(() => { api.listPOs({ project_id: site }).then((r) => setPos(r.filter((p) => p.status !== "deleted"))).catch(() => setPos([])); }, [site]);

  // Load the chosen PO's lines, then auto-match each ticket item to a line by code.
  useEffect(() => {
    if (!poId) { setPoLines([]); return; }
    let live = true;
    api.getPO(poId).then((po) => {
      if (!live) return;
      const ls = (po.lines || []).map((l) => ({ id: l.id, item: l.item, qty: l.qty, unit: l.unit }));
      setPoLines(ls);
      // Exact (normalised) description beats a shared leading code, and a PO
      // line is only auto-assigned once — three "M20 …" items spread across
      // the three M20 lines instead of stacking on the first.
      setRows((prev) => {
        const taken = new Set<string>();
        const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
        return prev.map((r) => {
          const code = materialCode(r.desc);
          const exact = ls.find((l) => l.id != null && !taken.has(String(l.id)) && norm(l.item) === norm(r.desc));
          const hit = exact ?? ls.find((l) => l.id != null && !taken.has(String(l.id)) && materialCode(l.item) === code && code.length >= 3);
          if (hit) taken.add(String(hit.id));
          return { ...r, lineId: hit ? String(hit.id) : (ls.some((l) => String(l.id) === r.lineId) ? r.lineId : ""), unit: r.unit || (hit?.unit ?? "") };
        });
      });
    }).catch(() => { if (live) setPoLines([]); });
    return () => { live = false; };
  }, [poId]);

  // Pull the chosen PO's ordered-vs-received burn-down (cumulative prior drops).
  useEffect(() => {
    if (!poId) { setRecon(null); return; }
    let live = true;
    api.opsReconcileTicket(projectId, cand.id, poId).then((r) => { if (live) setRecon(r); }).catch(() => { if (live) setRecon(null); });
    return () => { live = false; };
  }, [poId, projectId, cand.id]);

  const selPo = pos.find((p) => p.id === poId) || null;
  const matchedCount = rows.filter((r) => r.include && r.lineId).length;

  // Every included item on the same PO line → offer to log ONE combined entry.
  const included = rows.filter((r) => r.include);
  const uniqLines = new Set(included.map((r) => r.lineId).filter(Boolean));
  const schemeLineId = included.length > 1 && uniqLines.size === 1 && included.every((r) => r.lineId) ? [...uniqLines][0]! : null;
  const schemeLine = schemeLineId ? poLines.find((l) => String(l.id) === schemeLineId) ?? null : null;
  // "1200 x 2400" printed on a board line → m² per board.
  const boardArea = (desc: string): number | null => {
    const m = desc.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/i);
    return m ? (Number(m[1]) * Number(m[2])) / 1e6 : null;
  };
  const areaCalc = (() => {
    let total = 0, missing = 0;
    for (const r of included) {
      const a = boardArea(r.desc);
      const q = parseFloat((r.qty || "").replace(/[^0-9.]/g, "")) || 0;
      if (a == null || q <= 0) { missing++; continue; }
      total += a * q * boardsPerPack;
    }
    return { total: Math.round(total * 100) / 100, missing };
  })();
  useEffect(() => {
    if (combine && !combinedTouched) setCombinedQty(areaCalc.total > 0 ? String(areaCalc.total) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combine, boardsPerPack, schemeLineId, rows.map((r) => `${r.include}:${r.qty}`).join("|")]);

  async function confirm() {
    setBusy(true); setErr(null);
    try {
      let lines = rows.filter((r) => r.include && r.lineId).map((r) => {
        const l = poLines.find((x) => String(x.id) === r.lineId);
        return { po_line_id: r.lineId, po_line_desc: l?.item || r.desc, received_qty: r.qty.trim(), received_unit: r.unit.trim() };
      });
      if (combine && schemeLine) {
        const total = Number(combinedQty);
        if (!Number.isFinite(total) || total <= 0) { setErr(`Enter the combined quantity in ${schemeLine.unit || "the line's unit"} for the scheme line.`); setBusy(false); return; }
        lines = [{ po_line_id: String(schemeLine.id), po_line_desc: schemeLine.item, received_qty: String(total), received_unit: schemeLine.unit || "" }];
      }
      if (!lines.length) { setErr("Match at least one item to a PO line, or use single check-in."); setBusy(false); return; }
      await api.opsCheckInTicketCandidate(projectId, cand.id, {
        target_project_id: site,
        po_id: selPo ? selPo.id : "",
        po_number: selPo ? selPo.po_number : "",
        supplier: selPo?.supplier || cand.supplier_name || "",
        part: part ? "1" : "0",
        lines,
      });
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't check in"); setBusy(false); }
  }

  return (
    <div className="card" style={{ marginTop: 8, padding: 10, display: "grid", gap: 8 }}>
      <label className="field"><span>Site</span>
        <select className="input" value={site} onChange={(e) => { setSite(e.target.value); setPoId(""); }}>
          {projects.filter((p) => !p.completed_at).map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
        </select>
      </label>
      <label className="field"><span>PO {suggested && <span className="pill ok" style={{ fontSize: 10, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>matched from item codes</span>}</span>
        <select className="input" value={poId} onChange={(e) => setPoId(e.target.value)}>
          <option value="">{suggesting ? "Finding the PO from item codes…" : "— Pick a PO —"}</option>
          {pos.map((p) => <option key={p.id} value={p.id}>{p.po_number} · {p.supplier ?? "—"}{p.order_type === "call_off" ? " (call-off)" : ""}{poOptionSuffix(p)}</option>)}
        </select>
        <PoDeliveryLine po={selPo} />
      </label>
      {poId && (
        <div style={{ display: "grid", gap: 4 }}>
          {/* "matched" read as "agrees". It only ever meant the item found a PO line —
              the ordered-vs-received figures under each row are what actually agree. */}
          <div className="eyebrow" style={{ fontSize: 11 }}>Ticket items → PO lines <span className="muted" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>· {matchedCount} of {rows.length} linked to a PO line</span></div>
          <div className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>Whole note is one line?</span>
            <div style={{ flex: 1, minWidth: 220 }}>
              <GroupedCombobox
                groups={[
                  { label: "", options: [{ value: "", label: "— Pick per item below —" }] },
                  { label: "Lines on the PO", options: poLines.filter((l) => l.id != null).map((l) => ({ value: String(l.id), label: l.item, hint: l.qty != null ? `${l.qty}${l.unit ? ` ${l.unit}` : ""} ordered` : undefined })) },
                ]}
                value={bulkLine}
                onChange={(v) => { setBulkLine(v); if (v) setRows((p) => p.map((x) => ({ ...x, lineId: v }))); }}
                placeholder="Assign every item to one PO line…"
                searchPlaceholder="Search PO lines…"
                ariaLabel="Assign every item to one PO line"
              />
            </div>
          </div>
          {rows.map((r, i) => (
            <div key={i} className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap", opacity: r.include ? 1 : 0.5 }}>
              <input type="checkbox" checked={r.include} onChange={(e) => setRows((p) => p.map((x, j) => j === i ? { ...x, include: e.target.checked } : x))} />
              <span style={{ flex: 1, fontSize: 12.5, minWidth: 130 }}>{r.desc}</span>
              <input className="input" style={{ width: 60 }} inputMode="decimal" value={r.qty} onChange={(e) => setRows((p) => p.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} placeholder="qty" />
              <input className="input" style={{ width: 70 }} value={r.unit} onChange={(e) => setRows((p) => p.map((x, j) => j === i ? { ...x, unit: e.target.value } : x))} placeholder="unit" />
              {(() => {
                // Sectioned, searchable line picker: the code-matched candidates
                // for THIS ticket item float to the top; everything else on the
                // PO sits below, all type-to-filter.
                const code = materialCode(r.desc);
                const withIds = poLines.filter((l) => l.id != null);
                const hits = code.length >= 3 ? withIds.filter((l) => materialCode(l.item) === code) : [];
                const hitIds = new Set(hits.map((l) => String(l.id)));
                const rest = withIds.filter((l) => !hitIds.has(String(l.id)));
                const opt = (l: { id?: number; item: string; qty?: number | null; unit?: string | null }) =>
                  ({ value: String(l.id), label: l.item, hint: l.qty != null ? `${l.qty}${l.unit ? ` ${l.unit}` : ""} ordered` : undefined });
                const groups = [
                  { label: "", options: [{ value: "", label: "— No PO line —" }] },
                  ...(hits.length ? [{ label: "Matches this item", options: hits.map(opt) }] : []),
                  { label: hits.length ? "Other lines on the PO" : "Lines on the PO", options: rest.map(opt) },
                ].filter((g) => g.options.length > 0);
                return (
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <GroupedCombobox
                      groups={groups}
                      value={r.lineId}
                      onChange={(v) => setRows((p) => p.map((x, j) => j === i ? { ...x, lineId: v } : x))}
                      placeholder="— No PO line —"
                      searchPlaceholder="Search PO lines…"
                      ariaLabel={`PO line for ${r.desc}`}
                    />
                  </div>
                );
              })()}
              {(() => {
                const st = r.include && r.lineId ? (recon?.po_lines.find((l) => String(l.id) === r.lineId) || null) : null;
                if (!st) return null;
                const thisQty = parseFloat((r.qty || "").replace(/[^0-9.]/g, "")) || 0;
                const remaining = Math.round((st.ordered - st.received - thisQty) * 100) / 100;
                return (
                  <div style={{ flexBasis: "100%", display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11.5, marginTop: 3, marginLeft: 26 }}>
                    <span className="muted">Ordered <b style={{ color: "var(--ink)" }}>{st.ordered}{st.unit ? ` ${st.unit}` : ""}</b></span>
                    <span className="muted">Recv'd to date <b style={{ color: "var(--ink)" }}>{st.received}</b></span>
                    {/* remaining < 0 means this drop takes the line PAST what was
                        ordered. That was rendering as a green "completes this line",
                        so checking in 2,500 against an order for 25 looked correct. */}
                    {remaining < -0.0001
                      ? <span style={{ color: "var(--danger)", fontWeight: 600 }}>{Math.abs(remaining)}{st.unit ? ` ${st.unit}` : ""} MORE than ordered</span>
                      : <span style={{ color: remaining > 0.0001 ? "var(--warn)" : "var(--success)", fontWeight: 600 }}>{remaining > 0.0001 ? `${remaining}${st.unit ? ` ${st.unit}` : ""} left after this` : "completes this line ✓"}</span>}
                  </div>
                );
              })()}
            </div>
          ))}
          {schemeLine && (
            <div style={{ border: "1px dashed var(--line)", borderRadius: 8, padding: "8px 10px", display: "grid", gap: 6 }}>
              <label className="row" style={{ gap: 8, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={combine} onChange={(e) => { setCombine(e.target.checked); setCombinedTouched(false); }} />
                <span>Log as <b>one combined entry</b> on “{schemeLine.item}”{schemeLine.unit ? <> — the line is measured in <b>{schemeLine.unit}</b>, the ticket is in packs</> : null}</span>
              </label>
              {combine && (
                <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 12.5 }}>
                  <label className="row" style={{ gap: 5, alignItems: "center" }}>
                    <span className="muted">Boards per pack</span>
                    <select className="input" style={{ width: 58 }} value={boardsPerPack} onChange={(e) => { setBoardsPerPack(Number(e.target.value)); setCombinedTouched(false); }}>
                      {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                  <span className="muted">
                    Sizes read off the items ≈ <b style={{ color: "var(--ink)" }}>{areaCalc.total || "?"} m²</b>
                    {areaCalc.missing > 0 && <> · couldn't read sizes on {areaCalc.missing} item{areaCalc.missing === 1 ? "" : "s"}</>}
                  </span>
                  <label className="row" style={{ gap: 5, alignItems: "center" }}>
                    <span className="muted">Total received{schemeLine.unit ? ` (${schemeLine.unit})` : ""}</span>
                    <input className="input" style={{ width: 90 }} inputMode="decimal" value={combinedQty}
                      onChange={(e) => { setCombinedQty(e.target.value); setCombinedTouched(true); }} />
                  </label>
                </div>
              )}
            </div>
          )}
          <label className="row" style={{ gap: 8, alignItems: "center", fontSize: 13, cursor: "pointer", marginTop: 4 }}>
            <input type="checkbox" checked={part} onChange={(e) => setPart(e.target.checked)} />
            <span>Part delivery (worked out automatically from the quantities — tick only if none could be read)</span>
          </label>
        </div>
      )}
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ gap: 8 }}>
        <button className="primary tiny" disabled={busy || !poId} onClick={confirm}>{busy ? "Checking in…" : combine && schemeLine ? "Check in 1 combined entry" : `Check in ${matchedCount} line${matchedCount === 1 ? "" : "s"}`}</button>
        <button className="ghost tiny" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Deliveries: check-in with ticket photo + sign-off ───────────────────────
type DeliveryLine = { description: string; expected: number | null; received: number; unit: string | null };

function DeliveriesPanel({ projectId, canEdit, autoOpen, onAutoOpenConsumed }: { projectId: string; canEdit: boolean; autoOpen?: boolean; onAutoOpenConsumed?: () => void }) {
  const [rows, setRows] = useState<SiteDelivery[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // Move/reassign a logged delivery (wrong site or supplier).
  const [moveId, setMoveId] = useState<number | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [partial, setPartial] = useState(false); // this check-in is a part-load; keep the PO open
  // Optional PO line item this check-in is against (fetched when a PO is matched).
  const [poLines, setPoLines] = useState<Array<{ id?: number; item: string; qty: number; unit: string }>>([]);
  const [poLineId, setPoLineId] = useState("");
  const [dropUnit, setDropUnit] = useState(""); // unit for this drop's received qty (scheme lines)
  const [allProjects, setAllProjects] = useState<Awaited<ReturnType<typeof api.listProjects>>>([]);
  useEffect(() => { api.listProjects().then(setAllProjects).catch(() => {}); }, []);
  const [showForm, setShowForm] = useState(false);
  const [description, setDescription] = useState("");
  const [supplier, setSupplier] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [poId, setPoId] = useState("");
  const [pos, setPos] = useState<Awaited<ReturnType<typeof api.listPOs>>>([]);
  // On a grouped site, deliveries are logged once but tagged to a contract.
  const [siteGroup, setSiteGroup] = useState<ProjectSiteGroup | null>(null);
  const [contractId, setContractId] = useState<string>("");
  const [status, setStatus] = useState<SiteDelivery["status"]>("received");
  const [deliveredAt, setDeliveredAt] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  // Per-line reconciliation from the scanned ticket: stated qty (expected) vs the
  // qty the operative actually confirms (received). Shortfalls are summarised into
  // status + notes on submit — no schema change needed.
  const [lines, setLines] = useState<DeliveryLine[]>([]);
  const [matchPct, setMatchPct] = useState<number | null>(null);
  // Detected fields shown on the Scanning step once the OCR returns.
  const [extracted, setExtracted] = useState<{ supplier: string; dn: string; date: string; items: number } | null>(null);
  // Full-screen check-in flow: capture → scanning → match/confirm → done.
  const [step, setStep] = useState<"capture" | "scanning" | "match" | "done">("capture");
  const [doneSummary, setDoneSummary] = useState<{ po: string | null; recv: number | null; exp: number | null; short: number } | null>(null);
  const ticketRef = useRef<HTMLInputElement>(null);
  function resetFields() {
    setDescription(""); setSupplier(""); setPoNumber(""); setPoId(""); setStatus("received");
    setDeliveredAt(todayISO()); setNotes(""); setSignature(null); setScanMsg(null);
    setLines([]); setMatchPct(null); setExtracted(null); setContractId(""); setPartial(false); setPoLineId(""); setDropUnit("");
    if (ticketRef.current) ticketRef.current.value = "";
  }
  function openForm(seed?: () => void) { resetFields(); setDoneSummary(null); setStep("capture"); seed?.(); setShowForm(true); }
  function closeForm() { setShowForm(false); setStep("capture"); setDoneSummary(null); resetFields(); }

  const [poStatus, setPoStatus] = useState<PoDeliveryStatus[]>([]);
  const [expandedPo, setExpandedPo] = useState<string | null>(null);
  function refresh() {
    api.opsDeliveries(projectId).then(setRows).catch((e) => setErr(e.message));
    api.opsPoDeliveryStatus(projectId).then(setPoStatus).catch(() => {});
  }
  useEffect(refresh, [projectId]);
  useEffect(() => { api.listPOs({ project_id: projectId }).then(setPos).catch(() => {}); }, [projectId]);
  useEffect(() => { api.opsProjectSiteGroup(projectId).then(setSiteGroup).catch(() => setSiteGroup(null)); }, [projectId]);
  // Load the matched PO's line items so the check-in can be assigned to one.
  useEffect(() => {
    if (!poId) { setPoLines([]); setPoLineId(""); return; }
    let live = true;
    api.getPO(poId).then((po) => {
      if (!live) return;
      const ls = (po.lines || []).map((l) => ({ id: l.id, item: l.item, qty: l.qty, unit: l.unit }));
      setPoLines(ls);
      setPoLineId((cur) => (cur && ls.some((l) => String(l.id) === cur) ? cur : ""));
    }).catch(() => { if (live) setPoLines([]); });
    return () => { live = false; };
  }, [poId]);

  // Deep-linked from the "Check in a delivery" topbar action: open the form
  // straight away, then tell the parent we've consumed the request so it
  // doesn't re-fire when the panel is revisited via the sub-nav.
  useEffect(() => {
    if (autoOpen && canEdit) {
      setShowForm(true);
      onAutoOpenConsumed?.();
    }
  }, [autoOpen, canEdit]);

  // Scan the attached ticket and pre-fill the form (incl. the matched PO).
  async function scanTicket() {
    const f = ticketRef.current?.files?.[0];
    if (!f) { setErr("Choose the ticket photo or PDF first, then Scan."); return; }
    setErr(null); setScanMsg(null); setStep("scanning");
    try {
      const r = await api.opsScanDelivery(projectId, f);
      const x = r.extracted;
      if (x.summary) setDescription(x.summary);
      const sup = r.matched_po?.supplier || x.supplier_name;
      if (sup) setSupplier(sup);
      if (x.delivery_date) setDeliveredAt(x.delivery_date);
      if (x.delivery_note_number) setNotes((n) => n.trim() ? n : `Delivery note ${x.delivery_note_number}`);
      if (r.matched_po) { setPoId(r.matched_po.id); setPoNumber(r.matched_po.po_number); }
      // Auto-tag the delivery to the matched PO's contract on a grouped site.
      if (r.matched_po?.project_id) setContractId(r.matched_po.project_id);
      // Match confidence: a PO-number hit is effectively certain; a supplier-name
      // match carries the candidate's overlap score.
      if (r.matched_po) {
        const cand = r.candidates.find((c) => c.id === r.matched_po!.id);
        setMatchPct(r.matched_po.matched_by === "po_number" ? 99 : cand ? Math.round(cand.score * 100) : null);
      } else setMatchPct(null);
      // Seed the expected-vs-received steppers from the ticket's line items.
      setLines(x.items.map((i) => ({ description: i.description, expected: i.qty, received: i.qty ?? 0, unit: i.unit })));
      setDropUnit((cur) => cur || (x.items[0]?.unit ?? ""));
      // Detected-fields summary for the Scanning step.
      setExtracted({ supplier: sup || x.supplier_name || "—", dn: x.delivery_note_number || "—", date: x.delivery_date || "—", items: x.items.length });
      setScanMsg(
        r.matched_po
          ? `Matched ${r.matched_po.po_number}${r.matched_po.supplier ? ` — ${r.matched_po.supplier}` : ""} (by ${r.matched_po.matched_by === "po_number" ? "PO number" : "supplier"}).`
          : (x.po_number
              ? `Read PO “${x.po_number}” but no matching PO on this project — pick one below.`
              : "No PO reference found — pick the PO below."),
      );
      // Stay on the Scanning step to show what was detected; the operative taps
      // "Match to a PO →" to continue (mirrors the design flow).
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't scan the ticket"); setStep("capture"); }
  }

  function setReceived(idx: number, v: number) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, received: Math.max(0, v) } : l)));
  }
  // Lines delivered short of what the ticket stated.
  const shortLines = lines.filter((l) => l.expected != null && l.received < l.expected);

  async function submit() {
    // Description is auto-derived from the scan/PO when the operative didn't type one.
    const desc = description.trim() || (poNumber.trim() ? `Delivery — ${poNumber.trim()}` : supplier.trim() || "Delivery checked in");
    setBusy(true);
    try {
      // Any shortfall on the reconciled lines downgrades the delivery to "partial"
      // and gets summarised into notes for the buyer (no per-line schema needed).
      const effectiveStatus = status === "rejected" ? "rejected" : shortLines.length > 0 ? "partial" : status;
      const shortSummary = shortLines.length
        ? `Short: ${shortLines.map((l) => `${l.description} ${l.received}/${l.expected}${l.unit ? ` ${l.unit}` : ""}`).join("; ")}`
        : "";
      const combinedNotes = [notes.trim(), shortSummary].filter(Boolean).join(" · ");

      const fd = new FormData();
      fd.append("description", desc);
      if (supplier.trim()) fd.append("supplier", supplier.trim());
      if (poNumber.trim()) fd.append("po_number", poNumber.trim());
      if (poId) fd.append("po_id", poId);
      if (siteGroup) fd.append("contract_project_id", contractId || projectId);
      fd.append("status", effectiveStatus);
      fd.append("delivered_at", deliveredAt);
      fd.append("completes_po", poId && partial ? "0" : "1");
      if (poId && poLineId) {
        const line = poLines.find((l) => String(l.id) === poLineId);
        if (line) { fd.append("po_line_id", poLineId); fd.append("po_line_desc", line.item); }
        if (dropUnit.trim()) fd.append("received_unit", dropUnit.trim());
      }
      if (combinedNotes) fd.append("notes", combinedNotes);
      // Persist expected-vs-received totals (from the reconciled lines) so the
      // Received list can show the bar and the shortfall sticks.
      const qtyLines = lines.filter((l) => l.expected != null);
      if (qtyLines.length > 0) {
        fd.append("expected_qty", String(qtyLines.reduce((s, l) => s + (l.expected ?? 0), 0)));
        fd.append("received_qty", String(qtyLines.reduce((s, l) => s + l.received, 0)));
      }
      const f = ticketRef.current?.files?.[0];
      if (f) fd.append("ticket", f);
      if (signature) fd.append("signature", signature);
      await api.opsAddDelivery(projectId, fd);
      const recv = qtyLines.length ? qtyLines.reduce((s, l) => s + l.received, 0) : null;
      const exp = qtyLines.length ? qtyLines.reduce((s, l) => s + (l.expected ?? 0), 0) : null;
      const summary = { po: poNumber.trim() || null, recv, exp, short: shortLines.length };
      resetFields();
      setDoneSummary(summary);
      setStep("done");
      refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  async function remove(d: SiteDelivery) {
    if (!confirm(`Delete delivery "${d.description}"?`)) return;
    await api.opsDeleteDelivery(d.id); refresh();
  }

  return (
    <>
      {err && <div className="flash error">{err}</div>}

      {(rows.length > 0 || pos.length > 0) && (() => {
        const today = todayISO();
        const deliveredPoIds = new Set(rows.map((r) => r.po_id).filter(Boolean));
        const awaiting = pos.filter((p) => (p.status === "approved" || p.status === "issued") && p.order_type !== "framework" && !deliveredPoIds.has(p.id)).length;
        const checkedInToday = rows.filter((r) => r.delivered_at === today).length;
        const shortDamaged = rows.filter((r) => r.status === "partial" || r.status === "rejected").length;
        return (
          <div className="kpis" style={{ marginBottom: 16 }}>
            <div className="kpi"><div className="kpi-label">Awaiting delivery</div><div className="kpi-value">{awaiting}</div><div className="kpi-sub">from open POs</div></div>
            <div className="kpi"><div className="kpi-label">Checked in today</div><div className="kpi-value">{checkedInToday}</div></div>
            <div className="kpi"><div className="kpi-label">Received (all)</div><div className="kpi-value">{rows.length}</div></div>
            <div className="kpi"><div className="kpi-label">Short / rejected</div><div className="kpi-value">{shortDamaged}</div><div className="kpi-sub">{shortDamaged > 0 ? "needs attention" : "all good"}</div></div>
          </div>
        );
      })()}

      {canEdit && (
        <div style={{ marginBottom: 12 }}>
          <button className="primary" onClick={() => openForm()}>Check in a delivery</button>
        </div>
      )}

      {showForm && (
        <div className="checkin-overlay" role="dialog" aria-modal="true">
          <div className="checkin-sheet">
            <div className="checkin-hd">
              <button className="checkin-x" onClick={step === "match" ? () => setStep(extracted ? "scanning" : "capture") : step === "scanning" ? () => setStep("capture") : closeForm} aria-label={step === "match" || step === "scanning" ? "Back" : "Close"}>{step === "match" || step === "scanning" ? "‹" : "✕"}</button>
              <div style={{ minWidth: 0 }}>
                <div className="checkin-title">{step === "capture" ? "Check in a delivery" : step === "scanning" ? "Reading ticket…" : step === "match" ? "Confirm delivery" : "Delivery checked in"}</div>
                {(step === "scanning" || step === "match") && <div className="checkin-sub">{step === "scanning" ? "Extracting supplier & lines" : "Matched against the PO"}</div>}
              </div>
              <span className="grow" />
              {step !== "done" && (
                <div className="checkin-dots">
                  {(["capture", "scanning", "match"] as const).map((s) => <span key={s} className={`cdot${step === s ? " on" : ""}`} />)}
                </div>
              )}
            </div>

            <div className="checkin-body">
              {err && <div className="flash error">{err}</div>}

              {step === "capture" && (
                <div className="cam">
                  <input ref={ticketRef} type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={(e) => { if (e.target.files?.[0]) scanTicket(); }} />
                  <div className="cam-hint">Align the delivery ticket inside the frame</div>
                  <div className="cam-guide" />
                  <span className="cam-corner tl" /><span className="cam-corner tr" /><span className="cam-corner bl" /><span className="cam-corner br" />
                  <div className="cam-ticket">
                    <div className="ct-h">DELIVERY NOTE</div>
                    <div className="ct-sub">Photograph it, or choose from gallery</div>
                    <div className="ct-line" /><div className="ct-line s" /><div className="ct-line" />
                  </div>
                  <div className="cam-foot">
                    <button type="button" className="cam-link" onClick={closeForm}>Cancel</button>
                    <button type="button" className="shutter" aria-label="Take photo" onClick={() => ticketRef.current?.click()} />
                    <button type="button" className="cam-link" onClick={() => ticketRef.current?.click()}>Gallery</button>
                  </div>
                </div>
              )}

              {step === "scanning" && (
                <div className="checkin-scanning">
                  <div className="scanwrap">
                    {!extracted && <div className="scanline" />}
                    <div className="sw-h">DELIVERY NOTE</div>
                    <div className="sw-sub">{extracted?.supplier ?? "Reading supplier…"}</div>
                    <div className="scan-lines"><i /><i /><i /><i /></div>
                    {extracted && <div className="sw-foot">{extracted.dn} · {extracted.date}</div>}
                  </div>
                  {extracted ? (
                    <div className="card" style={{ margin: 0 }}>
                      <div className="ck-det-hd">Detected</div>
                      <div className="ck-field"><span className="k">Supplier</span><span className="v">{extracted.supplier}</span></div>
                      <div className="ck-field"><span className="k">Delivery note</span><span className="v">{extracted.dn}</span></div>
                      <div className="ck-field"><span className="k">Date</span><span className="v">{extracted.date}</span></div>
                      <div className="ck-field"><span className="k">Line items</span><span className="v">{extracted.items} found</span></div>
                    </div>
                  ) : (
                    <div className="muted" style={{ textAlign: "center" }}>Reading the ticket…</div>
                  )}
                </div>
              )}

              {step === "match" && (
                <>
                  {poId || poNumber ? (
                    <div className="matchbar">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{poNumber || "Linked PO"}</div>
                        {supplier && <div className="muted" style={{ fontSize: 12 }}>{supplier}</div>}
                      </div>
                      {/* This is confidence in the PO IDENTITY — read off the PO
                          number or supplier name on the ticket. It says nothing
                          about whether the items or quantities agree, which is
                          what the rows below are for. Unlabelled, a bare 99%
                          beside a green tick reads as "all checked". */}
                      {matchPct != null && (
                        <span className="matchbar-pct" title="How sure we are this is the right PO, from the PO number or supplier name on the ticket. It does not mean the items or quantities agree — check those below.">
                          {matchPct}% PO
                        </span>
                      )}
                    </div>
                  ) : (
                    <label className="field"><span>Match to a purchase order{scanMsg ? <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}> · {scanMsg}</span> : null}</span>
                      <select className="input" value={poId} onChange={(e) => { const v = e.target.value; setPoId(v); const p = pos.find((x) => x.id === v); setPoNumber(p ? p.po_number : ""); if (p?.supplier && !supplier.trim()) setSupplier(p.supplier); }}>
                        <option value="">— not linked —</option>
                        {pos.map((p) => (<option key={p.id} value={p.id}>{p.po_number} — {p.supplier}{p.order_type === "framework" ? " (framework)" : p.order_type === "call_off" ? " (call-off)" : ""}</option>))}
                      </select>
                    </label>
                  )}

                  {siteGroup && (
                    <label className="field"><span>Contract <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· which area of {siteGroup.name}</span></span>
                      <select className="input" value={contractId || projectId} onChange={(e) => setContractId(e.target.value)}>
                        {siteGroup.members.map((m) => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}
                      </select>
                    </label>
                  )}

                  {lines.length > 0 ? (
                    <>
                      <div className="eyebrow" style={{ margin: "2px 0 -2px" }}>Expected vs received <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· adjust if short</span></div>
                      <div className="card" style={{ margin: 0, padding: "2px 14px" }}>
                        {lines.map((l, i) => {
                          const short = l.expected != null && l.received < l.expected;
                          return (
                            <div key={i} className={`del-line${short ? " short" : ""}`}>
                              <div style={{ minWidth: 0 }}>
                                <div className="del-line-nm">{l.description}</div>
                                <div className="muted" style={{ fontSize: 12 }}>{l.expected != null ? `expected ${l.expected}${l.unit ? ` ${l.unit}` : ""}` : "no qty on ticket"}</div>
                              </div>
                              {l.expected != null ? (
                                <div className="qty">
                                  <button type="button" onClick={() => setReceived(i, l.received - 1)} aria-label="one fewer">−</button>
                                  <span className="n">{l.received}</span>
                                  <button type="button" onClick={() => setReceived(i, l.received + 1)} aria-label="one more">+</button>
                                </div>
                              ) : <span className="muted" style={{ fontSize: 12 }}>—</span>}
                            </div>
                          );
                        })}
                      </div>
                      {shortLines.length > 0 && (
                        <div className="ck-short">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
                          <span>{shortLines.length} line{shortLines.length === 1 ? "" : "s"} short — flagged on the PO &amp; to the buyer.</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <label className="field"><span>What was delivered</span><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. 12 × pallets insulation board" /></label>
                  )}

                  <label className="field"><span>Notes <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· optional</span></span><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
                  {poId && poLines.length > 0 && (
                    <label className="field"><span>PO line item <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· optional</span></span>
                      <select className="input" value={poLineId} onChange={(e) => setPoLineId(e.target.value)}>
                        <option value="">— Whole PO —</option>
                        {poLines.map((l) => <option key={l.id} value={String(l.id)}>{l.item}{l.qty ? ` (${l.qty}${l.unit ? " " + l.unit : ""})` : ""}</option>)}
                      </select>
                    </label>
                  )}
                  {poId && poLineId && (
                    <label className="field"><span>Delivered this drop — unit <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· optional</span></span>
                      <input className="input" value={dropUnit} onChange={(e) => setDropUnit(e.target.value)} placeholder="e.g. packs, pallets" />
                      <span className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>The received quantity above counts toward this line's running total, in this unit.</span>
                    </label>
                  )}
                  {poId && (
                    <label className="row" style={{ gap: 8, alignItems: "center", fontSize: 13, cursor: "pointer", marginTop: 4 }}>
                      <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
                      <span>Part delivery (worked out automatically from the quantities — tick only if none could be read)</span>
                    </label>
                  )}
                </>
              )}

              {step === "done" && (
                <div className="checkin-done">
                  <div className="done-ic"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg></div>
                  <h2 className="serif" style={{ margin: "0 0 6px" }}>Delivery checked in</h2>
                  <p className="muted" style={{ margin: "0 18px" }}>
                    {doneSummary?.po ? `${doneSummary.po} updated.` : "Recorded on site."}{doneSummary && doneSummary.short > 0 ? " The buyer's been flagged on the shortfall." : ""}
                  </p>
                  {doneSummary?.exp != null && (
                    <div style={{ marginTop: 18 }}>
                      <span className={`pill ${doneSummary.short > 0 ? "warn" : "ok"} dot`}>{doneSummary.recv} of {doneSummary.exp} units</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {step !== "capture" && (
              <div className="checkin-foot">
                {step === "scanning" && (extracted
                  ? <button className="primary" style={{ width: "100%" }} onClick={() => setStep("match")}>Match to a PO →</button>
                  : <button className="primary" disabled style={{ width: "100%" }}>Scanning…</button>)}
                {step === "match" && <button className="primary" style={{ width: "100%" }} onClick={submit} disabled={busy || (lines.length === 0 && !description.trim())}>{busy ? "Saving…" : "Confirm check-in"}</button>}
                {step === "done" && (
                  <div className="row" style={{ gap: 10 }}>
                    <button className="primary" style={{ flex: 1 }} onClick={closeForm}>Done</button>
                    <button className="ghost" style={{ flex: 1 }} onClick={() => openForm()}>Check in another</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {lightbox && <ImageLightbox url={lightbox} onClose={() => setLightbox(null)} />}
      {canEdit && <ProjectTicketInbox projectId={projectId} onCheckedIn={refresh} />}

      {(() => {
        // Per-line burn-down: a PO stays in "awaiting" until every line is
        // delivered. Expand a PO to see which lines are outstanding and log a
        // delivery against a specific line.
        const outstanding = poStatus.filter((p) => !p.fully_delivered);
        if (outstanding.length === 0) return null;
        return (
          <div style={{ marginBottom: 16 }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Awaiting delivery <span className="muted" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>· {outstanding.length} PO{outstanding.length === 1 ? "" : "s"}</span></div>
            {/* One compact table, not a card per PO — 29 open orders must scan
                like a register, with the per-line breakdown expanding in place. */}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <table className="ops-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Status</th>
                    <th>PO</th>
                    <th>Supplier</th>
                    <th className="num">Lines</th>
                    <th style={{ width: 90 }}></th>
                    <th style={{ width: 26 }}></th>
                  </tr>
                </thead>
                <tbody>
              {outstanding.map((p) => {
                const started = p.lines_delivered > 0;
                const open = expandedPo === p.id;
                return (
                  <Fragment key={p.id}>
                    <tr
                      onClick={() => p.lines.length > 0 && setExpandedPo(open ? null : p.id)}
                      style={{ cursor: p.lines.length > 0 ? "pointer" : "default", ...(open ? { background: "var(--accent-soft)" } : {}) }}
                    >
                      <td><span className={`pill ${started ? "neutral" : "warn"}`}>{started ? "Part-delivered" : "Awaiting"}</span></td>
                      <td><Link to={`/pos/${p.id}`} style={{ fontWeight: 600, whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>{p.po_number}</Link></td>
                      <td className="muted" style={{ fontSize: 13 }}>{p.supplier ?? "—"}{p.order_type === "call_off" ? " · call-off" : ""}</td>
                      <td className="num muted" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{p.lines_total > 0 ? `${p.lines_delivered}/${p.lines_total}` : "—"}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {canEdit && <button className="ghost tiny" onClick={() => openForm(() => { setPoId(p.id); setPoNumber(p.po_number); setSupplier(p.supplier ?? ""); })}>Check in</button>}
                      </td>
                      <td className="muted" style={{ fontSize: 13 }}>{p.lines.length > 0 ? (open ? "▾" : "▸") : ""}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={6} style={{ background: "var(--accent-soft)", padding: "6px 8px 8px" }}>
                        {p.lines.map((l) => {
                          // When the drops arrived in the same unit the line was
                          // ordered in (rolls vs rolls), show a true fraction +
                          // remaining. When they differ (packs vs m²/scheme), fall
                          // back to a running tally with no misleading fraction.
                          const hasQty = l.drops > 0 && l.delivered_qty != null;
                          const matched = hasQty && sameUnit(l.delivered_unit, l.unit) && l.qty > 0;
                          const remaining = matched ? Math.round((l.qty - (l.delivered_qty ?? 0)) * 100) / 100 : null;
                          return (
                          <div key={l.id} className="row" style={{ gap: 8, alignItems: "center", padding: "5px 6px", flexWrap: "wrap" }}>
                            <span title={l.delivered ? "Delivered" : l.in_progress ? "Part-delivered" : "Outstanding"} style={{ width: 16, textAlign: "center", color: l.delivered ? "var(--success)" : l.in_progress ? "var(--warn)" : "var(--muted)" }}>{l.delivered ? "✓" : l.in_progress ? "◐" : "○"}</span>
                            <span style={{ flex: 1, fontSize: 13, minWidth: 140, textDecoration: l.delivered ? "line-through" : "none", opacity: l.delivered ? 0.6 : 1 }}>{l.item}</span>
                            <span className="num" style={{ fontSize: 12, textAlign: "right", minWidth: 84 }}>
                              {matched ? (
                                <>
                                  <span style={{ display: "block", color: l.delivered ? "var(--success)" : "var(--warn)", fontWeight: 600 }}>{l.delivered_qty} / {l.qty} {l.unit}</span>
                                  {!l.delivered && remaining != null && remaining > 0 && <span className="muted" style={{ display: "block", fontSize: 11 }}>{remaining} to come</span>}
                                </>
                              ) : (
                                <>
                                  {hasQty && (
                                    <span style={{ display: "block", color: l.delivered ? "var(--success)" : "var(--warn)", fontWeight: 600 }}>{l.delivered_qty}{l.delivered_unit ? ` ${l.delivered_unit}` : ""} · {l.drops} drop{l.drops === 1 ? "" : "s"}</span>
                                  )}
                                  {!hasQty && l.drops > 0 && <span style={{ display: "block", color: "var(--warn)", fontWeight: 600 }}>{l.drops} drop{l.drops === 1 ? "" : "s"}</span>}
                                  <span className="muted" style={{ display: "block", fontSize: 11 }}>ordered {l.qty}{l.unit ? ` ${l.unit}` : ""}</span>
                                </>
                              )}
                            </span>
                            {canEdit && !l.delivered && (
                              <button className="ghost tiny" onClick={() => openForm(() => { setPoId(p.id); setPoNumber(p.po_number); setSupplier(p.supplier ?? ""); setPoLineId(String(l.id)); })}>Log delivery</button>
                            )}
                          </div>
                          );
                        })}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {rows.length > 0 && <div className="eyebrow" style={{ marginBottom: 8 }}>Received</div>}
      {rows.length === 0 ? (
        <div className="empty">No deliveries checked in yet.</div>
      ) : (
        <div className="ops-notice-list">
          {(() => {
            // One card per physical ticket: the rows of a multi-line check-in
            // share the copied ticket file, so ticket_key is the group.
            const groups: Array<typeof rows> = [];
            const at = new Map<string, number>();
            for (const d of rows) {
              const k = d.ticket_key ? `t:${d.ticket_key}` : `solo:${d.id}`;
              const i = at.get(k);
              if (i == null) { at.set(k, groups.length); groups.push([d]); } else groups[i].push(d);
            }
            return groups.map((g) => {
              const d = g[0];
              const multi = g.length > 1;
              const reassignBody = (row: typeof d, v: { target_project_id: string; supplier: string; po_id: string; po_number: string; completes_po: string; po_line_id: string; po_line_desc: string; received_qty: string; received_unit: string }) => {
                const body: Record<string, string> = { target_project_id: v.target_project_id, supplier: v.supplier, po_id: v.po_id, po_number: v.po_number, completes_po: v.completes_po, po_line_id: v.po_line_id, po_line_desc: v.po_line_desc, received_qty: v.received_qty, received_unit: v.received_unit };
                // A ticket check-in titles the row after its PO line — keep the
                // title in step when the line changes.
                if (row.description && row.description === row.po_line_desc && v.po_line_desc) body.description = v.po_line_desc;
                return body;
              };
              const chooserFor = (row: typeof d) => (
                <SitePoChooser
                  projects={allProjects}
                  initialSite={row.contract_project_id || projectId}
                  initialPoId={row.po_id || ""}
                  initialSupplier={row.supplier || ""}
                  initialCompletesPo={row.completes_po}
                  initialPoLineId={row.po_line_id}
                  initialReceivedQty={row.received_qty}
                  initialReceivedUnit={row.received_unit}
                  busy={moveBusy}
                  confirmLabel="Move / reassign"
                  onCancel={() => setMoveId(null)}
                  onConfirm={async (v) => {
                    setMoveBusy(true); setErr(null);
                    try {
                      await api.opsReassignDelivery(row.id, reassignBody(row, v));
                      setMoveId(null); refresh();
                    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't move the delivery"); }
                    finally { setMoveBusy(false); }
                  }}
                />
              );
              return (
            <div key={d.ticket_key || `solo-${d.id}`} className="card ops-delivery">
              {d.ticket_key && d.ticket_type?.startsWith("image/") && (
                <button type="button" className="ops-thumb-link" style={{ border: "none", background: "none", padding: 0, cursor: "zoom-in" }} onClick={() => setLightbox(api.opsFileUrl(d.ticket_key!))}>
                  <img className="ops-thumb" src={api.opsFileUrl(d.ticket_key)} alt="Delivery ticket" />
                </button>
              )}
              <div className="ops-delivery-body">
                <div className="ops-notice-head">
                  <span className={`pill ${d.status === "received" ? "ok" : d.status === "rejected" ? "warn" : "neutral"}`}>
                    {d.status === "received" ? "Received" : d.status === "rejected" ? "Rejected" : "Partial"}
                  </span>
                  <span className="muted" style={{ fontSize: 12 }}>{fmtDate(d.delivered_at)}</span>
                  {d.po_number && (d.po_id
                    ? <Link to={`/pos/${d.po_id}`} className="muted" style={{ fontSize: 12 }}>PO {d.po_number}</Link>
                    : <span className="muted" style={{ fontSize: 12 }}>PO {d.po_number}</span>)}
                  {multi && <span className="pill neutral" style={{ fontSize: 11 }}>{g.length} lines · one note</span>}
                  {!multi && d.po_line_desc && <span className="pill neutral" style={{ fontSize: 11 }} title="PO line item this delivery is against">{d.po_line_desc}</span>}
                  {d.contract_code && <span className="pill neutral" style={{ fontSize: 11 }} title="Contract this delivery belongs to">{d.contract_code}</span>}
                  {d.ticket_key && <a href={api.opsFileUrl(d.ticket_key)} target="_blank" rel="noreferrer" className="muted" style={{ fontSize: 12, textDecoration: "none" }} title="Open the delivery ticket">📎 View ticket</a>}
                </div>
                {multi ? (
                  <>
                    <div className="ops-notice-title">{d.supplier || "Delivery"} — {g.length} items checked in together</div>
                    <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
                      {g.map((r) => (
                        <div key={r.id}>
                          <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", padding: "3px 0" }}>
                            <span style={{ flex: 1, fontSize: 13, minWidth: 160 }}>{r.description}</span>
                            {r.received_qty != null && <span className="num" style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>{r.received_qty}{r.received_unit ? ` ${r.received_unit}` : ""}</span>}
                            {r.po_line_desc && r.po_line_desc !== r.description && <span className="pill neutral" style={{ fontSize: 11 }} title="PO line item this line is against">{r.po_line_desc}</span>}
                            {canEdit && moveId !== r.id && (
                              <span style={{ display: "inline-flex", gap: 6 }}>
                                <button className="ghost tiny" onClick={() => setMoveId(r.id)}>Reassign line</button>
                                <button className="ghost tiny danger" onClick={() => remove(r)}>Delete</button>
                              </span>
                            )}
                          </div>
                          {canEdit && moveId === r.id && chooserFor(r)}
                        </div>
                      ))}
                    </div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{[d.supplier, d.signed_by ? `Signed: ${d.signed_by}` : null].filter(Boolean).join(" · ")}</div>
                    {d.notes && <div className="ops-notice-body">{d.notes}</div>}
                  </>
                ) : (
                  <>
                    <div className="ops-notice-title">{d.description}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{[d.supplier, d.signed_by ? `Signed: ${d.signed_by}` : null].filter(Boolean).join(" · ")}</div>
                    {d.expected_qty != null && d.expected_qty > 0 && (() => {
                      const rec = d.received_qty ?? 0;
                      const short = rec < d.expected_qty!;
                      const pct = Math.min(100, Math.round((rec / d.expected_qty!) * 100));
                      return (
                        <div className="row" style={{ gap: 10, marginTop: 6, maxWidth: 340 }}>
                          <div className="bar" style={{ flex: 1 }}><div className={short ? "warn" : "ok"} style={{ width: `${pct}%` }} /></div>
                          <span className="num" style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>{rec}/{d.expected_qty}</span>
                          {short && <span className="pill warn dot">{(d.expected_qty! - rec)} short</span>}
                        </div>
                      );
                    })()}
                    {d.notes && <div className="ops-notice-body">{d.notes}</div>}
                    {d.signature && <img className="ops-att-sig" src={d.signature} alt="signature" style={{ marginTop: 6 }} />}
                    {canEdit && moveId === d.id && chooserFor(d)}
                    {canEdit && moveId !== d.id && (
                      <div className="ops-notice-actions">
                        <button className="ghost tiny" onClick={() => setMoveId(d.id)}>Move / reassign</button>
                        <button className="ghost tiny danger" onClick={() => remove(d)}>Delete</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
              );
            });
          })()}
        </div>
      )}
    </>
  );
}

// ── Cross-project check-in (Projects workspace) ───────────────────────────────
// Same full-screen wizard as DeliveriesPanel, but with no project chosen up
// front: the scan finds which live site the PO belongs to (or the operative
// picks it). On confirm it posts to that resolved project's deliveries.
export function GlobalDeliveryCheckIn({ onClose, onDone }: { onClose: () => void; onDone?: () => void }) {
  const [step, setStep] = useState<"capture" | "scanning" | "match" | "done">("capture");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ticketRef = useRef<HTMLInputElement>(null);

  // Resolved target.
  const [projectId, setProjectId] = useState("");
  const [projectLabel, setProjectLabel] = useState("");
  const [poId, setPoId] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [supplier, setSupplier] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [deliveredAt, setDeliveredAt] = useState(todayISO());
  const [matchPct, setMatchPct] = useState<number | null>(null);
  const [lines, setLines] = useState<DeliveryLine[]>([]);
  const [extracted, setExtracted] = useState<{ supplier: string; dn: string; date: string; items: number } | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [doneSummary, setDoneSummary] = useState<{ po: string | null; recv: number | null; exp: number | null; short: number; project: string } | null>(null);

  // Manual fallback pickers.
  const [allProjects, setAllProjects] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [candidates, setCandidates] = useState<Awaited<ReturnType<typeof api.opsScanDeliveryGlobal>>["candidates"]>([]);
  const [posForProject, setPosForProject] = useState<Awaited<ReturnType<typeof api.listPOs>>>([]);

  useEffect(() => {
    api.listProjects().then((rs) => setAllProjects(rs.filter((r) => !r.completed_at).map((r) => ({ id: r.id, code: r.code, name: r.name })))).catch(() => {});
  }, []);
  // When a site is chosen but no PO matched, load its POs for the picker.
  useEffect(() => {
    if (!projectId || poId) { return; }
    api.listPOs({ project_id: projectId }).then(setPosForProject).catch(() => setPosForProject([]));
  }, [projectId, poId]);

  function resetAll() {
    setProjectId(""); setProjectLabel(""); setPoId(""); setPoNumber(""); setSupplier("");
    setDescription(""); setNotes(""); setDeliveredAt(todayISO()); setMatchPct(null);
    setLines([]); setExtracted(null); setScanMsg(null); setCandidates([]); setPosForProject([]);
    setErr(null); setDoneSummary(null);
    if (ticketRef.current) ticketRef.current.value = "";
  }
  function clearSite() { setProjectId(""); setProjectLabel(""); setPoId(""); setPoNumber(""); setMatchPct(null); }

  async function scanTicket() {
    const f = ticketRef.current?.files?.[0];
    if (!f) { setErr("Choose the ticket photo or PDF first."); return; }
    setErr(null); setScanMsg(null); setStep("scanning");
    try {
      const r = await api.opsScanDeliveryGlobal(f);
      const x = r.extracted;
      if (x.summary) setDescription(x.summary);
      const sup = r.matched_po?.supplier || x.supplier_name;
      if (sup) setSupplier(sup);
      if (x.delivery_date) setDeliveredAt(x.delivery_date);
      if (x.delivery_note_number) setNotes((n) => (n.trim() ? n : `Delivery note ${x.delivery_note_number}`));
      setCandidates(r.candidates);
      if (r.matched_po) {
        setProjectId(r.matched_po.project_id);
        setProjectLabel(`${r.matched_po.project_code} — ${r.matched_po.project_name}`);
        setPoId(r.matched_po.id);
        setPoNumber(r.matched_po.po_number);
        setMatchPct(99);
      } else {
        setMatchPct(null);
      }
      setLines(x.items.map((i) => ({ description: i.description, expected: i.qty, received: i.qty ?? 0, unit: i.unit })));
      setExtracted({ supplier: sup || x.supplier_name || "—", dn: x.delivery_note_number || "—", date: x.delivery_date || "—", items: x.items.length });
      setScanMsg(
        r.matched_po
          ? `Matched ${r.matched_po.po_number} on ${r.matched_po.project_code}.`
          : (x.po_number
              ? `Read PO “${x.po_number}” but no live project has it — pick the site below.`
              : "No PO reference found — pick the site below."),
      );
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't scan the ticket"); setStep("capture"); }
  }

  function pickCandidate(cnd: (typeof candidates)[number]) {
    setProjectId(cnd.project_id);
    setProjectLabel(`${cnd.project_code} — ${cnd.project_name}`);
    setPoId(cnd.id);
    setPoNumber(cnd.po_number);
    if (cnd.supplier && !supplier.trim()) setSupplier(cnd.supplier);
    setMatchPct(cnd.score >= 1 ? 99 : Math.round(cnd.score * 100));
  }

  function setReceived(idx: number, v: number) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, received: Math.max(0, v) } : l)));
  }
  const shortLines = lines.filter((l) => l.expected != null && l.received < l.expected);

  async function submit() {
    if (!projectId) { setErr("Pick which site this delivery is for."); return; }
    const desc = description.trim() || (poNumber.trim() ? `Delivery — ${poNumber.trim()}` : supplier.trim() || "Delivery checked in");
    setBusy(true);
    try {
      const shortSummary = shortLines.length
        ? `Short: ${shortLines.map((l) => `${l.description} ${l.received}/${l.expected}${l.unit ? ` ${l.unit}` : ""}`).join("; ")}`
        : "";
      const combinedNotes = [notes.trim(), shortSummary].filter(Boolean).join(" · ");
      const fd = new FormData();
      fd.append("description", desc);
      if (supplier.trim()) fd.append("supplier", supplier.trim());
      if (poNumber.trim()) fd.append("po_number", poNumber.trim());
      if (poId) fd.append("po_id", poId);
      fd.append("status", shortLines.length > 0 ? "partial" : "received");
      fd.append("delivered_at", deliveredAt);
      if (combinedNotes) fd.append("notes", combinedNotes);
      const qtyLines = lines.filter((l) => l.expected != null);
      if (qtyLines.length > 0) {
        fd.append("expected_qty", String(qtyLines.reduce((s, l) => s + (l.expected ?? 0), 0)));
        fd.append("received_qty", String(qtyLines.reduce((s, l) => s + l.received, 0)));
      }
      const f = ticketRef.current?.files?.[0];
      if (f) fd.append("ticket", f);
      await api.opsAddDelivery(projectId, fd);
      const recv = qtyLines.length ? qtyLines.reduce((s, l) => s + l.received, 0) : null;
      const exp = qtyLines.length ? qtyLines.reduce((s, l) => s + (l.expected ?? 0), 0) : null;
      setDoneSummary({ po: poNumber.trim() || null, recv, exp, short: shortLines.length, project: projectLabel || "the site" });
      setStep("done");
      onDone?.();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="checkin-overlay" role="dialog" aria-modal="true">
      <div className="checkin-sheet">
        <div className="checkin-hd">
          <button className="checkin-x" onClick={step === "match" ? () => setStep("scanning") : step === "scanning" ? () => setStep("capture") : onClose} aria-label={step === "match" || step === "scanning" ? "Back" : "Close"}>{step === "match" || step === "scanning" ? "‹" : "✕"}</button>
          <div style={{ minWidth: 0 }}>
            <div className="checkin-title">{step === "capture" ? "Check in a delivery" : step === "scanning" ? "Reading ticket…" : step === "match" ? "Confirm delivery" : "Delivery checked in"}</div>
            {(step === "scanning" || step === "match") && <div className="checkin-sub">{step === "scanning" ? "Finding the site & PO" : "Confirm the site, then quantities"}</div>}
          </div>
          <span className="grow" />
          {step !== "done" && (
            <div className="checkin-dots">
              {(["capture", "scanning", "match"] as const).map((s) => <span key={s} className={`cdot${step === s ? " on" : ""}`} />)}
            </div>
          )}
        </div>

        <div className="checkin-body">
          {err && <div className="flash error">{err}</div>}

          {step === "capture" && (
            <div className="cam">
              <input ref={ticketRef} type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={(e) => { if (e.target.files?.[0]) scanTicket(); }} />
              <div className="cam-hint">Align the delivery ticket inside the frame</div>
              <div className="cam-guide" />
              <span className="cam-corner tl" /><span className="cam-corner tr" /><span className="cam-corner bl" /><span className="cam-corner br" />
              <div className="cam-ticket">
                <div className="ct-h">DELIVERY NOTE</div>
                <div className="ct-sub">Photograph it, or choose from gallery</div>
                <div className="ct-line" /><div className="ct-line s" /><div className="ct-line" />
              </div>
              <div className="cam-foot">
                <button type="button" className="cam-link" onClick={onClose}>Cancel</button>
                <button type="button" className="shutter" aria-label="Take photo" onClick={() => ticketRef.current?.click()} />
                <button type="button" className="cam-link" onClick={() => ticketRef.current?.click()}>Gallery</button>
              </div>
            </div>
          )}

          {step === "scanning" && (
            <div className="checkin-scanning">
              <div className="scanwrap">
                {!extracted && <div className="scanline" />}
                <div className="sw-h">DELIVERY NOTE</div>
                <div className="sw-sub">{extracted?.supplier ?? "Reading supplier…"}</div>
                <div className="scan-lines"><i /><i /><i /><i /></div>
                {extracted && <div className="sw-foot">{extracted.dn} · {extracted.date}</div>}
              </div>
              {extracted ? (
                <div className="card" style={{ margin: 0 }}>
                  <div className="ck-det-hd">Detected</div>
                  <div className="ck-field"><span className="k">Supplier</span><span className="v">{extracted.supplier}</span></div>
                  <div className="ck-field"><span className="k">Delivery note</span><span className="v">{extracted.dn}</span></div>
                  <div className="ck-field"><span className="k">Date</span><span className="v">{extracted.date}</span></div>
                  <div className="ck-field"><span className="k">Site</span><span className="v">{projectLabel || (scanMsg ? "Pick on next step" : "—")}</span></div>
                </div>
              ) : (
                <div className="muted" style={{ textAlign: "center" }}>Reading the ticket…</div>
              )}
            </div>
          )}

          {step === "match" && (
            <>
              {projectId ? (
                <div className="matchbar">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{projectLabel || "Site"}</div>
                    {(poNumber || supplier) && <div className="muted" style={{ fontSize: 12 }}>{[poNumber, supplier].filter(Boolean).join(" · ")}</div>}
                  </div>
                  {matchPct != null && (
                    <span className="matchbar-pct" title="How sure we are this is the right site and PO, from what was read off the ticket. It does not mean the items or quantities agree — check those below.">
                      {matchPct}% PO
                    </span>
                  )}
                  <button type="button" className="cam-link" style={{ marginLeft: 8, color: "var(--accent)" }} onClick={clearSite}>Change</button>
                </div>
              ) : (
                <>
                  {candidates.length > 0 && (
                    <>
                      <div className="eyebrow" style={{ margin: "2px 0 6px" }}>Which site is this for?{scanMsg ? <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}> · {scanMsg}</span> : null}</div>
                      <div className="ops-notice-list">
                        {candidates.map((cnd) => (
                          <button key={cnd.id} type="button" className="card" style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", padding: "10px 14px", cursor: "pointer", margin: 0 }} onClick={() => pickCandidate(cnd)}>
                            <span className="pill neutral">{cnd.project_code}</span>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontWeight: 600 }}>{cnd.po_number}{cnd.order_type === "framework" ? " · framework" : cnd.order_type === "call_off" ? " · call-off" : ""}</div>
                              <div className="muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cnd.project_name}{cnd.supplier ? ` · ${cnd.supplier}` : ""}</div>
                            </div>
                            <span className="muted">›</span>
                          </button>
                        ))}
                      </div>
                      <div className="muted" style={{ fontSize: 12, textAlign: "center", margin: "2px 0" }}>…or choose the site manually</div>
                    </>
                  )}
                  <label className="field"><span>Site{candidates.length === 0 && scanMsg ? <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}> · {scanMsg}</span> : null}</span>
                    <select className="input" value={projectId} onChange={(e) => { const v = e.target.value; const p = allProjects.find((x) => x.id === v); setProjectId(v); setProjectLabel(p ? `${p.code} — ${p.name}` : ""); setPoId(""); setPoNumber(""); }}>
                      <option value="">— select a project —</option>
                      {allProjects.map((p) => (<option key={p.id} value={p.id}>{p.code} — {p.name}</option>))}
                    </select>
                  </label>
                </>
              )}

              {projectId && !poId && (
                <label className="field"><span>Purchase order <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· optional</span></span>
                  <select className="input" value={poId} onChange={(e) => { const v = e.target.value; setPoId(v); const p = posForProject.find((x) => x.id === v); setPoNumber(p ? p.po_number : ""); if (p?.supplier && !supplier.trim()) setSupplier(p.supplier); }}>
                    <option value="">— not linked —</option>
                    {posForProject.map((p) => (<option key={p.id} value={p.id}>{p.po_number} — {p.supplier}{p.order_type === "framework" ? " (framework)" : p.order_type === "call_off" ? " (call-off)" : ""}</option>))}
                  </select>
                </label>
              )}

              {lines.length > 0 ? (
                <>
                  <div className="eyebrow" style={{ margin: "2px 0 -2px" }}>Expected vs received <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· adjust if short</span></div>
                  <div className="card" style={{ margin: 0, padding: "2px 14px" }}>
                    {lines.map((l, i) => {
                      const short = l.expected != null && l.received < l.expected;
                      return (
                        <div key={i} className={`del-line${short ? " short" : ""}`}>
                          <div style={{ minWidth: 0 }}>
                            <div className="del-line-nm">{l.description}</div>
                            <div className="muted" style={{ fontSize: 12 }}>{l.expected != null ? `expected ${l.expected}${l.unit ? ` ${l.unit}` : ""}` : "no qty on ticket"}</div>
                          </div>
                          {l.expected != null ? (
                            <div className="qty">
                              <button type="button" onClick={() => setReceived(i, l.received - 1)} aria-label="one fewer">−</button>
                              <span className="n">{l.received}</span>
                              <button type="button" onClick={() => setReceived(i, l.received + 1)} aria-label="one more">+</button>
                            </div>
                          ) : <span className="muted" style={{ fontSize: 12 }}>—</span>}
                        </div>
                      );
                    })}
                  </div>
                  {shortLines.length > 0 && (
                    <div className="ck-short">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
                      <span>{shortLines.length} line{shortLines.length === 1 ? "" : "s"} short — flagged on the PO &amp; to the buyer.</span>
                    </div>
                  )}
                </>
              ) : (
                <label className="field"><span>What was delivered</span><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. 12 × pallets insulation board" /></label>
              )}

              <label className="field"><span>Notes <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· optional</span></span><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
            </>
          )}

          {step === "done" && (
            <div className="checkin-done">
              <div className="done-ic"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg></div>
              <h2 className="serif" style={{ margin: "0 0 6px" }}>Delivery checked in</h2>
              <p className="muted" style={{ margin: "0 18px" }}>
                {doneSummary?.project ? `${doneSummary.project} — ` : ""}{doneSummary?.po ? `${doneSummary.po} updated.` : "recorded on site."}{doneSummary && doneSummary.short > 0 ? " The buyer's been flagged on the shortfall." : ""}
              </p>
              {doneSummary?.exp != null && (
                <div style={{ marginTop: 18 }}>
                  <span className={`pill ${doneSummary.short > 0 ? "warn" : "ok"} dot`}>{doneSummary.recv} of {doneSummary.exp} units</span>
                </div>
              )}
            </div>
          )}
        </div>

        {step !== "capture" && (
          <div className="checkin-foot">
            {step === "scanning" && (extracted
              ? <button className="primary" style={{ width: "100%" }} onClick={() => setStep("match")}>Continue →</button>
              : <button className="primary" disabled style={{ width: "100%" }}>Scanning…</button>)}
            {step === "match" && <button className="primary" style={{ width: "100%" }} onClick={submit} disabled={busy || !projectId || (lines.length === 0 && !description.trim())}>{busy ? "Saving…" : "Confirm check-in"}</button>}
            {step === "done" && (
              <div className="row" style={{ gap: 10 }}>
                <button className="primary" style={{ flex: 1 }} onClick={onClose}>Done</button>
                <button className="ghost" style={{ flex: 1 }} onClick={() => { resetAll(); setStep("capture"); }}>Check in another</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── RAMS / safety documents ──────────────────────────────────────────────────
// ── Documents hub helpers ──────────────────────────────────────────────────
/** Whole days until `date` (negative = past). Null for no/!invalid date. */
function daysToExpiry(date?: string | null): number | null {
  if (!date) return null;
  const t = new Date(date.length <= 10 ? date + "T00:00:00" : date).getTime();
  return Number.isNaN(t) ? null : Math.floor((t - Date.now()) / 86_400_000);
}
function expiryTone(date?: string | null): "expired" | "soon" | "ok" | null {
  const d = daysToExpiry(date);
  return d == null ? null : d < 0 ? "expired" : d <= 14 ? "soon" : "ok";
}
const EXPIRY_COLOR: Record<"expired" | "soon" | "ok", string> = {
  expired: "#b91c1c", soon: "#c2630f", ok: "var(--ink-2)",
};
/** Certificates are expiry-tracked but never signed; everything else is signable. */
const isSignable = (cat: string) => cat !== "Certificate";

/** ⋯ row-actions menu for an uploaded document. */
function RamsRowMenu({ onRevision, onToggleArchive, archived, onDelete }: {
  onRevision: () => void; onToggleArchive: () => void; archived: boolean; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const item: React.CSSProperties = { display: "block", width: "100%", textAlign: "left", background: "none", border: 0, padding: "8px 12px", font: "inherit", fontSize: 13, cursor: "pointer", borderRadius: 6, whiteSpace: "nowrap" };
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button className="ghost tiny" onClick={() => setOpen((v) => !v)} aria-label="More actions" style={{ padding: "2px 9px", fontWeight: 700 }}>⋯</button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 30, background: "var(--card)", border: "1px solid var(--line-strong)", borderRadius: "var(--radius-md)", boxShadow: "0 8px 24px rgba(15,17,48,0.12)", minWidth: 150, padding: 4 }}>
          <button style={item} onClick={() => { setOpen(false); onRevision(); }}>New revision</button>
          <button style={item} onClick={() => { setOpen(false); onToggleArchive(); }}>{archived ? "Restore" : "Archive"}</button>
          <button style={{ ...item, color: "#b91c1c" }} onClick={() => { setOpen(false); onDelete(); }}>Delete</button>
        </div>
      )}
    </div>
  );
}

function RamsPanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [rows, setRows] = useState<RamsDocument[]>([]);
  const [certs, setCerts] = useState<OperativeCert[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("RAMS");
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [distributeDoc, setDistributeDoc] = useState<RamsDocument | null>(null);
  const [catFilter, setCatFilter] = useState("all");
  // Revision control: when set, the upload form saves the next revision of this
  // document (auto-numbered) and supersedes it. `openHist` tracks which families
  // have their earlier-revisions list expanded.
  const [revisesDoc, setRevisesDoc] = useState<RamsDocument | null>(null);
  const [openHist, setOpenHist] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  function refresh() {
    api.opsRams(projectId).then((r) => { setRows(r.documents); setCerts(r.operative_certs); }).catch((e) => setErr(e.message));
  }
  useEffect(refresh, [projectId]);

  function openNew() { setRevisesDoc(null); setTitle(""); setCategory("RAMS"); setExpiry(""); setShowForm(true); }
  function startRevision(d: RamsDocument) { setRevisesDoc(d); setShowForm(true); setErr(null); }

  async function upload() {
    const f = fileRef.current?.files?.[0];
    if (!f) { setErr("Choose a file to upload first."); return; }
    // Certificates are reference-only (PDF/scan) — no Word conversion, no signing.
    // Everything else is signable and must be a Word doc we can make readable.
    const isCert = !revisesDoc && category === "Certificate";
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      if (!isCert) {
        if (!/\.docx$/i.test(f.name)) {
          setErr("Signable docs (RAMS, method, COSHH, permit) must be a Word (.docx) so operatives can read & sign. For a PDF/scan, choose the Certificate category.");
          setBusy(false); return;
        }
        // Convert the Word doc → HTML in the browser (mammoth), so the operative
        // can read it inline and scroll-to-sign. Lazy-imported to keep it out of
        // the main bundle.
        const mod = await import("mammoth");
        const convert = (mod as { convertToHtml?: typeof import("mammoth").convertToHtml }).convertToHtml
          ?? (mod as unknown as { default: typeof import("mammoth") }).default.convertToHtml;
        const result = await convert({ arrayBuffer: await f.arrayBuffer() });
        // Make the converted HTML lightweight + read-only:
        //  • strip embedded images (mammoth inlines them as base64 — a letterhead
        //    logo alone can add 2MB+, far too big to store),
        //  • turn Word checkbox fields into static ☐ / ☑ glyphs and drop any other
        //    form inputs so the operative can't edit or tick the RAMS.
        const html = result.value
          .replace(/<img[^>]*>/gi, "")
          .replace(/<input[^>]*type=["']?checkbox["']?[^>]*>/gi, (m) => (/\bchecked\b/i.test(m) ? "☑ " : "☐ "))
          .replace(/<input[^>]*>/gi, "")
          .replace(/<\/?(?:textarea|select|button|form)[^>]*>/gi, "")
          .trim();
        if (!html) {
          setErr("Couldn't read any content from that Word document. Re-save it as .docx, or use the RAMS template.");
          setBusy(false); return;
        }
        fd.append("html_content", html);
        // Also parse the .docx into a structured RamsDoc for the gated section
        // reader (one section at a time, scroll-to-end, risk cards). Best-effort:
        // any failure leaves the html fallback in place and never blocks upload.
        try {
          const { parseRamsDocx } = await import("../../shared/parse-rams");
          const { doc, media } = parseRamsDocx(new Uint8Array(await f.arrayBuffer()));
          if (doc.sections.length) {
            fd.append("sections_json", JSON.stringify(doc));
            for (const [key, bytes] of Object.entries(media)) {
              fd.append("media", new Blob([bytes as unknown as BlobPart]), key);
            }
          }
        } catch (e) { console.warn("RAMS structured parse skipped:", e); }
      }
      if (revisesDoc) {
        // Revision of an existing doc — title/category/version are inherited and
        // auto-numbered server-side; nothing is typed.
        fd.append("revises_id", String(revisesDoc.id));
      } else {
        if (title.trim()) fd.append("title", title.trim());
        fd.append("category", category);
      }
      if (expiry) fd.append("expiry_date", expiry);
      await api.opsUploadRams(projectId, fd);
      setTitle(""); setCategory("RAMS"); setExpiry(""); setRevisesDoc(null);
      if (fileRef.current) fileRef.current.value = "";
      setShowForm(false);
      refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  async function toggle(d: RamsDocument) { await api.opsUpdateRams(d.id, { active: !d.active }); refresh(); }
  async function remove(d: RamsDocument) {
    if (!confirm(`Delete "${d.title}"?`)) return;
    await api.opsDeleteRams(d.id); refresh();
  }

  return (
    <>
      {err && <div className="flash error">{err}</div>}

      {(rows.length > 0 || certs.length > 0) && (() => {
        // Current (highest) revision per family that's still active.
        const fam = new Map<string, RamsDocument>();
        for (const d of rows) {
          const k = d.rev_group || `id:${d.id}`;
          const cur = fam.get(k);
          if (!cur || (d.revision ?? 1) > (cur.revision ?? 1)) fam.set(k, d);
        }
        const heads = [...fam.values()].filter((d) => d.active);
        // Expiry candidates: docs with an expiry + operative certs.
        const expItems = [
          ...heads.filter((d) => d.expiry_date).map((d) => ({ name: d.title, expiry: d.expiry_date!, who: d.created_by })),
          ...certs.filter((c) => c.expiry_date).map((c) => ({ name: c.qual_type, expiry: c.expiry_date!, who: c.operative_name })),
        ];
        const expiring = expItems.filter((x) => { const n = daysToExpiry(x.expiry); return n != null && n >= 0 && n <= 14; }).sort((a, b) => daysToExpiry(a.expiry)! - daysToExpiry(b.expiry)!);
        const expired = expItems.filter((x) => { const n = daysToExpiry(x.expiry); return n != null && n < 0; }).sort((a, b) => daysToExpiry(b.expiry)! - daysToExpiry(a.expiry)!);
        const docCount = heads.length + certs.length;
        const catCount = new Set([...heads.map((d) => d.category), ...(certs.length ? ["Certificate"] : [])]).size;
        const signable = heads.filter((d) => isSignable(d.category) && (d.crew_count ?? 0) > 0);
        const ackPct = signable.length === 0 ? null
          : Math.round((signable.reduce((s, d) => s + Math.min(1, (d.signed_count ?? 0) / (d.crew_count || 1)), 0) / signable.length) * 100);
        return (
          <div className="kpis" style={{ marginBottom: 16 }}>
            <div className="kpi"><div className="kpi-label">Documents</div><div className="kpi-value">{docCount}</div><div className="kpi-sub">across {catCount} categor{catCount === 1 ? "y" : "ies"}</div></div>
            <div className="kpi"><div className="kpi-label">Expiring ≤ 14 days</div><div className="kpi-value" style={{ color: expiring.length ? EXPIRY_COLOR.soon : undefined }}>{expiring.length}</div><div className="kpi-sub">{expiring[0] ? `${expiring[0].name} · ${fmtDate(expiring[0].expiry)}` : "none"}</div></div>
            <div className="kpi"><div className="kpi-label">Expired</div><div className="kpi-value" style={{ color: expired.length ? EXPIRY_COLOR.expired : undefined }}>{expired.length}</div><div className="kpi-sub">{expired[0] ? `${expired[0].name} · ${expired[0].who}` : "none"}</div></div>
            <div className="kpi"><div className="kpi-label">Acknowledged</div><div className="kpi-value">{ackPct == null ? "—" : `${ackPct}%`}</div><div className="kpi-sub">{ackPct == null ? "no signable docs" : "across signable docs"}</div></div>
          </div>
        );
      })()}

      {canEdit && showForm && (
        <div className="card" style={{ marginBottom: 12 }}>
          {revisesDoc && (
            <div className="flash info" style={{ marginBottom: 10 }}>
              New revision of <b>{revisesDoc.title}</b> — it'll be saved as the next revision
              ({revisesDoc.revision ? `Rev ${(revisesDoc.revision ?? 1) + 1}` : "Rev 2"}) and replace the current one.
              Crews will need to re-sign it.
            </div>
          )}
          <div className="ops-form-grid">
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              <span>{category === "Certificate" && !revisesDoc ? "Certificate file (PDF, image or Word)" : "Word document (.docx) *"}</span>
              <input ref={fileRef} className="input" type="file" accept={category === "Certificate" && !revisesDoc ? ".pdf,.jpg,.jpeg,.png,.docx" : ".docx"} />
              <span className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                {category === "Certificate" && !revisesDoc
                  ? "Reference document — stored as-is (a third-party cert, a card scan). Not sent for signature."
                  : "Uploaded as Word so it's converted to a phone-readable page operatives read & sign. Use the RAMS template for best results."}
              </span>
            </label>
            {!revisesDoc && <>
              <label className="field"><span>Title</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="defaults to file name" /></label>
              <label className="field"><span>Category</span>
                <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option>RAMS</option><option>Method</option><option>COSHH</option><option>Permit</option><option>Certificate</option><option>Other</option>
                </select>
              </label>
            </>}
            <label className="field"><span>Expiry (optional)</span><input className="input" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></label>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="primary" onClick={upload} disabled={busy}>{busy ? "Uploading…" : revisesDoc ? "Upload new revision" : "Upload"}</button>
            <button className="ghost" onClick={() => { setShowForm(false); setRevisesDoc(null); }}>Cancel</button>
          </div>
        </div>
      )}

      {rows.length === 0 && certs.length === 0 ? (
        <div className="card">
          <div className="card-hd"><h2 style={{ fontSize: 17 }}>RAMS &amp; docs</h2><span className="grow" />{canEdit && <button className="accent tiny" onClick={openNew}>+ Upload document</button>}</div>
          <div className="empty in-card">
            <div className="ic"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2h8l4 4v16H6z" /><path d="M14 2v4h4M9 13h6M9 17h6" /></svg></div>
            <h3 className="serif" style={{ fontSize: 19 }}>No documents uploaded</h3>
            <p className="muted" style={{ maxWidth: 460, margin: "0 auto" }}>Upload RAMS, method statements, COSHH sheets, permits and operative certs. Operatives acknowledge them at sign-in.</p>
            <div className="templates">
              <button className="tmpl" onClick={() => canEdit && openNew()}>Roofing RAMS <span className="req">Required</span></button>
              <button className="tmpl" onClick={() => canEdit && openNew()}>Working at Height method</button>
              <button className="tmpl" onClick={() => canEdit && openNew()}>COSHH sheet</button>
              <button className="tmpl" onClick={() => canEdit && openNew()}>Hot works permit</button>
              <button className="tmpl" onClick={() => canEdit && openNew()}>Scaffold handover cert</button>
            </div>
            {canEdit && <div style={{ marginTop: 20 }}><button className="accent" onClick={openNew}>+ Upload document</button></div>}
          </div>
        </div>
      ) : (() => {
        const cats = [...new Set([...rows.map((d) => d.category), ...(certs.length ? ["Certificate"] : [])])];
        const list = catFilter === "all" ? rows : rows.filter((d) => d.category === catFilter);
        const showCerts = catFilter === "all" || catFilter === "Certificate";
        // Group revisions of the same document into a family; show the current
        // revision as the row, with earlier revisions tucked behind an expander.
        const gmap = new Map<string, RamsDocument[]>();
        for (const d of list) { const k = d.rev_group || `id:${d.id}`; (gmap.get(k) ?? gmap.set(k, []).get(k)!).push(d); }
        const groups = [...gmap.entries()].map(([key, docs]) => {
          const sorted = [...docs].sort((a, b) => (b.revision ?? 1) - (a.revision ?? 1) || (a.created_at < b.created_at ? 1 : -1));
          const head = sorted.find((d) => d.active) ?? sorted[0];
          return { key, head, history: sorted.filter((d) => d.id !== head.id) };
        }).sort((a, b) => (Number(b.head.active) - Number(a.head.active)) || (a.head.created_at < b.head.created_at ? 1 : -1));
        const undistributed = groups.filter((g) => g.head.active && isSignable(g.head.category) && !g.head.distributed).map((g) => g.head);
        const totalRows = groups.length + (showCerts ? certs.length : 0);

        const docRow = (d: RamsDocument, g: typeof groups[number], head: boolean) => {
          const crew = d.crew_count ?? 0;
          const signed = d.signed_count ?? 0;
          const pct = crew > 0 ? Math.min(100, Math.round((signed / crew) * 100)) : 0;
          const histN = g.history.length;
          const expanded = openHist.has(g.key);
          const tone = expiryTone(d.expiry_date);
          const signable = isSignable(d.category);
          const isNew = head && d.active && signable && !d.distributed;
          return (
            <tr key={d.id} className={d.active ? "" : "ops-row-inactive"} style={tone === "soon" && d.active ? { background: "var(--warn-soft, #fdf1e7)" } : undefined}>
              <td data-label="Document" style={isNew ? { borderLeft: "3px solid var(--accent)" } : undefined}>
                <div style={{ fontWeight: head ? 600 : 400, paddingLeft: head ? 0 : 18, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                  {d.title}
                  {isNew && <span style={{ background: "var(--accent-soft)", color: "var(--accent-2)", fontSize: 10, fontWeight: 700, letterSpacing: "0.03em", padding: "2px 6px", borderRadius: 4, whiteSpace: "nowrap" }}>NEW · UNDISTRIBUTED</span>}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Uploaded {fmtDate(d.created_at)}{d.created_by ? ` · ${d.created_by}` : ""}
                  {head && histN > 0 && <> · <button onClick={() => setOpenHist((s) => { const n = new Set(s); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n; })} style={{ background: "none", border: 0, padding: 0, color: "var(--accent-2)", cursor: "pointer", font: "inherit", fontSize: 12 }}>{expanded ? "▾ hide history" : `▸ ${histN} earlier revision${histN === 1 ? "" : "s"}`}</button></>}
                </div>
              </td>
              <td className="center" data-label="Category"><span className={`pill ${d.category === "RAMS" ? "navy" : "neutral"}`}>{d.category}</span></td>
              <td data-label="Version" className="num">{d.version ?? (d.revision ? `v${d.revision}` : "—")}</td>
              <td data-label="Expiry">{d.expiry_date ? <span style={{ color: tone ? EXPIRY_COLOR[tone] : undefined, fontWeight: tone && tone !== "ok" ? 600 : 400, fontSize: 13 }}>{fmtDate(d.expiry_date)}</span> : <span className="muted">—</span>}</td>
              <td data-label="Signed">
                {!d.active ? <span className="pill neutral">{head ? "Archived" : "Superseded"}</span>
                  : !signable ? (tone === "expired" ? <span className="pill warn">Expired</span> : <span className="muted" style={{ fontSize: 12 }}>no signature</span>)
                  : crew > 0 ? (
                    <div className="minibar">
                      <div className="bar"><div className={signed >= crew ? "ok" : "warn"} style={{ width: `${pct}%` }} /></div>
                      <span className="num" style={{ fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{signed}/{crew}</span>
                    </div>
                  ) : <span className="muted" style={{ fontSize: 12 }}>no crew</span>}
              </td>
              <td className="ops-table-actions">
                <a className="ghost tiny" href={api.opsFileUrl(d.file_key)} target="_blank" rel="noreferrer" style={{ textDecoration: "none", display: "inline-block" }}>View</a>{" "}
                {canEdit && head && d.active && signable && <><button className="accent tiny" onClick={() => setDistributeDoc(d)}>Distribute</button>{" "}</>}
                {canEdit && head && <RamsRowMenu onRevision={() => startRevision(d)} archived={!d.active} onToggleArchive={() => toggle(d)} onDelete={() => remove(d)} />}
              </td>
            </tr>
          );
        };

        const certRow = (cert: OperativeCert) => {
          const tone = expiryTone(cert.expiry_date);
          const sub = [cert.operative_company, cert.card_no].filter(Boolean).join(" · ");
          return (
            <tr key={`cert:${cert.id}`} style={tone === "soon" ? { background: "var(--warn-soft, #fdf1e7)" } : undefined}>
              <td data-label="Document">
                <div style={{ fontWeight: 600 }}>{cert.qual_type} — {cert.operative_name}</div>
                <div className="muted" style={{ fontSize: 12 }}>{sub || "Operative certificate"}</div>
              </td>
              <td className="center" data-label="Category"><span className="pill neutral">Certificate</span></td>
              <td data-label="Version" className="num"><span className="muted">—</span></td>
              <td data-label="Expiry">{cert.expiry_date ? <span style={{ color: tone ? EXPIRY_COLOR[tone] : undefined, fontWeight: tone && tone !== "ok" ? 600 : 400, fontSize: 13 }}>{fmtDate(cert.expiry_date)}</span> : <span className="muted">—</span>}</td>
              <td data-label="Signed">{tone === "expired" ? <span className="pill warn">Expired</span> : <span className="muted" style={{ fontSize: 12 }}>no signature</span>}</td>
              <td className="ops-table-actions">
                {cert.file_key ? <a className="ghost tiny" href={api.operativeFileUrl(cert.file_key)} target="_blank" rel="noreferrer" style={{ textDecoration: "none", display: "inline-block" }}>View</a> : <span className="muted" style={{ fontSize: 12 }}>—</span>}
              </td>
            </tr>
          );
        };
        const firstSignable = groups.find((g) => g.head.active && isSignable(g.head.category))?.head ?? null;

        return (
          <div className="card">
            <div className="card-hd" style={{ flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ fontSize: 17 }}>Documents</h2>
              <span className="pill">{totalRows}</span>
              <span className="grow" />
              {cats.length > 1 && (
                <select className="input" value={catFilter} onChange={(e) => setCatFilter(e.target.value)} style={{ width: "auto" }}>
                  <option value="all">All categories</option>
                  {cats.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
                </select>
              )}
              {canEdit && <button className="accent tiny" onClick={openNew}>+ Upload document</button>}
            </div>
            {canEdit && undistributed.length > 0 && (
              <div className="ops-distribute-banner">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-2)" strokeWidth="1.8"><path d="M12 16V4M8 8l4-4 4 4M5 20h14" /></svg>
                <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>New RAMS uploaded? <b>Distribute for signature</b> to the operatives assigned to this site.</span>
                <span className="grow" />
                <button className="accent tiny" onClick={() => setDistributeDoc(undistributed[0])}>Distribute…</button>
              </div>
            )}
            <table className="ops-table">
              <thead>
                <tr><th>Document</th><th className="center">Category</th><th>Version</th><th>Expiry</th><th>Signed</th><th style={{ width: 200 }}></th></tr>
              </thead>
              <tbody>
                {groups.flatMap((g) => [
                  docRow(g.head, g, true),
                  ...(openHist.has(g.key) ? g.history.map((h) => docRow(h, g, false)) : []),
                ])}
                {showCerts && certs.map((cert) => certRow(cert))}
              </tbody>
            </table>
            {firstSignable && (
              <div style={{ padding: "10px 16px", borderTop: "1px solid var(--line)" }}>
                <button onClick={() => setDistributeDoc(firstSignable)} style={{ background: "none", border: 0, padding: 0, font: "inherit", fontSize: 13, color: "var(--accent-2)", cursor: "pointer" }}>View all signatures &amp; outstanding →</button>
              </div>
            )}
          </div>
        );
      })()}
      {distributeDoc && <RamsDistributeModal projectId={projectId} doc={distributeDoc} onClose={() => setDistributeDoc(null)} />}
    </>
  );
}

/** Scalable recipient picker — distribute one RAMS doc to many site operatives
 *  at once. Search + filter chips + scrollable checklist + select-all-shown,
 *  designed for large crews rather than a chip cloud. */
function RamsDistributeModal({ projectId, doc, onClose }: { projectId: string; doc: RamsDocument; onClose: () => void }) {
  const [ops, setOps] = useState<Awaited<ReturnType<typeof api.operativesByProject>>>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "pending" | "notinducted">("all");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ sent: number; emailed: number; texted: number } | null>(null);

  useEffect(() => { api.operativesByProject(projectId).then(setOps).catch(() => setOps([])); }, [projectId]);

  const shown = ops.filter((o) => {
    if (q.trim() && !o.name.toLowerCase().includes(q.trim().toLowerCase())) return false;
    if (filter === "pending" && !(o.rams_pending > 0)) return false;
    if (filter === "notinducted" && o.induction_done) return false;
    return true;
  });
  const allShownSelected = shown.length > 0 && shown.every((o) => sel.has(o.id));
  function toggleSel(id: string) { setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); }
  function toggleAllShown() {
    setSel((s) => {
      const n = new Set(s);
      if (allShownSelected) for (const o of shown) n.delete(o.id);
      else for (const o of shown) n.add(o.id);
      return n;
    });
  }
  async function send() {
    if (sel.size === 0) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.distributeRams({ rams_id: doc.id, project_id: projectId, operative_ids: [...sel] });
      setDone({ sent: r.sent, emailed: r.emailed, texted: r.texted });
      setTimeout(onClose, 2200);
    } catch (e) { setErr(e instanceof Error ? e.message : "couldn't distribute"); setBusy(false); }
  }
  const chip = (key: typeof filter, label: string) => (
    <button type="button" className={filter === key ? "accent tiny" : "ghost tiny"} onClick={() => setFilter(key)}>{label}</button>
  );

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 480, maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
        <div className="card-hd" style={{ alignItems: "center" }}>
          <h3 style={{ flex: 1, fontSize: 15 }}>Distribute for signature</h3>
          <button className="ghost tiny" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: "0 16px 8px" }}>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>{doc.title} — sent to each selected operative to read &amp; sign from their profile.</div>
          {err && <div className="flash error" style={{ marginBottom: 8 }}>{err}</div>}
          <input className="input" placeholder="Search operatives…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
          <div className="row" style={{ gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
            {chip("all", "All")}{chip("pending", "RAMS pending")}{chip("notinducted", "Not inducted")}
            <span style={{ flex: 1 }} />
            <button type="button" className="ghost tiny" onClick={toggleAllShown} disabled={shown.length === 0}>{allShownSelected ? "Clear shown" : "Select all shown"}</button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
          {shown.length === 0 ? (
            <div className="muted" style={{ fontSize: 13, padding: 16 }}>{ops.length === 0 ? "No operatives assigned to this site yet." : "No operatives match."}</div>
          ) : shown.map((o) => (
            <label key={o.id} className="row" style={{ alignItems: "center", gap: 10, padding: "9px 16px", borderBottom: "1px solid var(--line)", cursor: "pointer" }}>
              <input type="checkbox" checked={sel.has(o.id)} onChange={() => toggleSel(o.id)} style={{ width: 16, height: 16, minHeight: 0 }} />
              <span style={{ flex: 1 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{o.name}</span>
                {o.trade && <span className="muted" style={{ fontSize: 12 }}> · {o.trade}</span>}
              </span>
              {!o.induction_done && <span className="pill warn" style={{ fontSize: 10 }}>Not inducted</span>}
              {o.rams_pending > 0 && <span className="pill warn" style={{ fontSize: 10 }}>{o.rams_pending} pending</span>}
            </label>
          ))}
        </div>
        <div className="row" style={{ padding: 14, gap: 8, alignItems: "center" }}>
          {done != null ? (
            done.emailed + done.texted > 0
              ? <span className="pill ok">Sent — {done.emailed} emailed{done.texted ? `, ${done.texted} texted` : ""} ✓</span>
              : <span className="pill warn">Recorded for {done.sent}, but no email/SMS went out — check operative contact details &amp; email setup.</span>
          ) : (
            <>
              <button className="accent" onClick={send} disabled={busy || sel.size === 0}>{busy ? "Sending…" : `Send to ${sel.size || 0}`}</button>
              <button className="ghost" onClick={onClose}>Cancel</button>
              <span style={{ flex: 1 }} />
              <span className="muted" style={{ fontSize: 12 }}>{sel.size} selected</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Daily progress photos ─────────────────────────────────────────────────────
function PhotosPanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [rows, setRows] = useState<ProgressPhoto[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [caption, setCaption] = useState("");
  const [takenOn, setTakenOn] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function refresh() { api.opsPhotos(projectId).then(setRows).catch((e) => setErr(e.message)); }
  useEffect(refresh, [projectId]);

  async function upload() {
    const files = fileRef.current?.files;
    if (!files || files.length === 0) { setErr("Choose at least one photo."); return; }
    setBusy(true);
    // Best-effort location stamp for the batch.
    const coords = await new Promise<{ lat: number; lng: number } | null>((res) => {
      if (!navigator.geolocation) return res(null);
      navigator.geolocation.getCurrentPosition(
        (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => res(null),
        { timeout: 8000, maximumAge: 60_000 },
      );
    });
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", f);
        if (caption.trim()) fd.append("caption", caption.trim());
        fd.append("taken_on", takenOn);
        if (coords) { fd.append("lat", String(coords.lat)); fd.append("lng", String(coords.lng)); }
        await api.opsUploadPhoto(projectId, fd);
      }
      setCaption("");
      if (fileRef.current) fileRef.current.value = "";
      setShowForm(false);
      refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  async function remove(p: ProgressPhoto) {
    if (!confirm("Delete this photo?")) return;
    await api.opsDeletePhoto(p.id); refresh();
  }

  return (
    <>
      {err && <div className="flash error">{err}</div>}
      {canEdit && showForm && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="ops-form-grid">
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              <span>Photos *</span>
              <input ref={fileRef} className="input" type="file" accept="image/*" capture="environment" multiple />
            </label>
            <label className="field"><span>Date</span><input className="input" type="date" value={takenOn} max={todayISO()} onChange={(e) => setTakenOn(e.target.value)} /></label>
            <label className="field"><span>Caption</span><input className="input" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="optional — applied to all" /></label>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="primary" onClick={upload} disabled={busy}>{busy ? "Uploading…" : "Upload photos"}</button>
            <button className="ghost" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="card">
          <div className="card-hd"><h2 style={{ fontSize: 17 }}>Progress photos</h2><span className="grow" />{canEdit && <button className="accent tiny" onClick={() => setShowForm(true)}>+ Add photos</button>}</div>
          <div className="empty in-card">
            <div className="ic"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7h4l2-2h6l2 2h4v12H3z" /><circle cx="12" cy="13" r="3.5" /></svg></div>
            <h3 className="serif" style={{ fontSize: 19 }}>No progress photos yet</h3>
            <p className="muted" style={{ maxWidth: 460, margin: "0 auto" }}>Capture site progress by area. Photos are time- and date-stamped automatically and tagged to the operative who took them — handy for applications and disputes.</p>
            <div className="dropzone" style={{ maxWidth: 440, margin: "18px auto 0" }}>
              <div style={{ fontWeight: 600, color: "var(--ink)" }}>Drag photos here</div>
              <div style={{ fontSize: 12.5 }}>or use the site app to upload from your phone</div>
            </div>
            {canEdit && <div style={{ marginTop: 18 }}><button className="accent" onClick={() => setShowForm(true)}>+ Add photos</button></div>}
          </div>
        </div>
      ) : (() => {
        const groups = groupPhotosByDate(rows);
        const thisWeek = rows.filter((p) => { const d = p.created_at ? Date.parse(p.created_at) : 0; return d > 0 && Date.now() - d < 7 * 864e5; }).length;
        const last = rows.reduce<ProgressPhoto | null>((m, p) => (!m || (p.created_at ?? "") > (m.created_at ?? "") ? p : m), null);
        return (
          <>
            <div className="kpis" style={{ marginBottom: 16 }}>
              <div className="kpi"><div className="kpi-label">Photos</div><div className="kpi-value">{rows.length}</div></div>
              <div className="kpi"><div className="kpi-label">This week</div><div className="kpi-value">{thisWeek}</div></div>
              <div className="kpi"><div className="kpi-label">Days captured</div><div className="kpi-value">{groups.length}</div></div>
              <div className="kpi"><div className="kpi-label">Last upload</div><div className="kpi-value" style={{ fontSize: 21 }}>{last?.created_at ? fmtTime(last.created_at) : "—"}</div><div className="kpi-sub">{last?.created_by ?? ""}</div></div>
            </div>
            <div className="card">
              <div className="card-hd"><h2 style={{ fontSize: 17 }}>Progress photos</h2><span className="pill">{rows.length}</span><span className="grow" />{canEdit && <button className="accent tiny" onClick={() => setShowForm(true)}>+ Add photos</button>}</div>
              <div style={{ padding: "0 16px 16px" }}>
                {groups.map((g) => (
                  <div key={g.date ?? "undated"} style={{ marginBottom: 8 }}>
                    <div className="eyebrow" style={{ margin: "12px 0 8px" }}>{g.date ? fmtDate(g.date) : "Undated"} <span className="muted" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>· {g.photos.length} photo{g.photos.length === 1 ? "" : "s"}</span></div>
                    <div className="ops-photo-grid">
                      {g.photos.map((p) => (
                        <div key={p.id} className="ops-photo">
                          <a href={api.opsFileUrl(p.file_key)} target="_blank" rel="noreferrer">
                            <img src={api.opsFileUrl(p.file_key)} alt={p.caption ?? "progress photo"} loading="lazy" />
                          </a>
                          {p.caption && <div className="ops-photo-caption" style={{ fontWeight: 600, color: "var(--ink)", paddingTop: 7, paddingBottom: 2 }}>{p.caption}</div>}
                          <div className="ops-photo-meta">
                            <span className="muted">{fmtTime(p.created_at)}{p.created_by ? ` · ${p.created_by}` : ""}</span>
                            {p.lat != null && p.lng != null && (
                              <a href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noreferrer" title="Location">📍</a>
                            )}
                            {canEdit && <button className="link-danger" onClick={() => remove(p)} title="Delete">✕</button>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        );
      })()}
    </>
  );
}

/** Group progress photos by taken-on date, most-recent day first. */
function groupPhotosByDate(photos: ProgressPhoto[]): Array<{ date: string | null; photos: ProgressPhoto[] }> {
  const map = new Map<string, ProgressPhoto[]>();
  for (const p of photos) {
    const k = p.taken_on ?? "";
    const arr = map.get(k) ?? [];
    arr.push(p);
    map.set(k, arr);
  }
  return [...map.entries()]
    .sort((a, b) => (b[0] || "").localeCompare(a[0] || ""))
    .map(([date, ps]) => ({ date: date || null, photos: ps }));
}

// ── Plant on site ─────────────────────────────────────────────────────────────
function PlantPanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [rows, setRows] = useState<PlantLog[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [item, setItem] = useState("");
  const [supplier, setSupplier] = useState("");
  const [onHireFrom, setOnHireFrom] = useState(todayISO());
  const [dayRate, setDayRate] = useState("");
  const [rateUnit, setRateUnit] = useState<"day" | "week">("week");
  const [expectedWeeks, setExpectedWeeks] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  // Supplier is picked from the approved-suppliers register (same combobox as
  // New PO), with a custom-entry escape for plant-hire firms not yet on it.
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierCustom, setSupplierCustom] = useState(false);
  // Company-owned plant: items transferred onto this site, plus the yard pool.
  const [owned, setOwned] = useState<OwnedPlant[]>([]);
  const [transferId, setTransferId] = useState("");
  const formTop = useRef<HTMLDivElement>(null);

  function refresh() {
    api.opsPlant(projectId).then(setRows).catch((e) => setErr(e.message));
  }
  function loadOwned() { api.ownedPlant().then(setOwned).catch(() => setOwned([])); }
  useEffect(refresh, [projectId]);
  useEffect(loadOwned, []);
  useEffect(() => { api.listSuppliers().then(setSuppliers).catch(() => setSuppliers([])); }, []);
  const supplierOpts = useMemo(
    () => suppliers.map((s) => ({ name: s.name, status: s.status, priced: 0, total: 0 })).sort(compareSuppliers),
    [suppliers],
  );

  // Weekly-equivalent rate, used both for the live "raises a PO" hint and the
  // PO line value (qty = weeks, unit = week).
  const rateNum = Number(dayRate) || 0;
  const weeksNum = Number(expectedWeeks) || 0;
  const weeklyRate = rateUnit === "week" ? rateNum : rateNum * 7;
  const poEstimate = weeklyRate * weeksNum;

  // Hiring plant raises a PO (normal approval workflow): one plant-hire line,
  // value = weekly-equivalent rate × expected weeks. The plant log is then
  // linked to that PO, with a planned off-hire date driving reminders.
  async function add() {
    if (!item.trim()) return;
    if (!supplier.trim()) { setErr("Pick a supplier — hiring plant raises a PO."); return; }
    if (rateNum <= 0) { setErr("Enter the hire rate."); return; }
    if (weeksNum <= 0) { setErr("Enter the expected hire duration in weeks."); return; }
    setBusy(true);
    try {
      const po = await api.createPO({
        project_id: projectId,
        supplier: supplier.trim(),
        notes: `Plant hire — ${item.trim()} · ${weeksNum} wk${weeksNum === 1 ? "" : "s"} @ £${rateNum}/${rateUnit}`,
        // Plant hire is a preliminaries cost — expend the Prelims budget,
        // tagged to a "Plant hire" prelim heading.
        category: "prelims",
        lines: [{ material_id: null, item: `Plant hire — ${item.trim()}`, type: "Plant hire", qty: weeksNum, unit: "week", unit_cost: weeklyRate }],
      });
      await api.opsAddPlant(projectId, {
        item: item.trim(),
        supplier: supplier.trim(),
        on_hire_from: onHireFrom || undefined,
        day_rate: rateNum,
        rate_unit: rateUnit,
        expected_weeks: weeksNum,
        po_id: po.id,
        notes: notes.trim() || undefined,
      });
      setItem(""); setSupplier(""); setSupplierCustom(false); setOnHireFrom(todayISO()); setDayRate(""); setRateUnit("week"); setExpectedWeeks(""); setNotes(""); setShowForm(false);
      refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  async function offHire(p: PlantLog) {
    if (!confirm(`Mark "${p.item}" off-hired today?`)) return;
    await api.opsUpdatePlant(p.id, { off_hire_to: todayISO() });
    refresh();
  }
  async function remove(p: PlantLog) {
    if (!confirm(`Delete "${p.item}"?`)) return;
    await api.opsDeletePlant(p.id);
    refresh();
  }

  const onSiteCount = rows.filter((r) => !r.off_hire_to).length;
  const offHireCount = rows.filter((r) => r.off_hire_to).length;
  const totalAccrual = rows.reduce((s, r) => {
    const days = daysOnSite(r.on_hire_from, r.off_hire_to);
    if (days == null || r.day_rate == null) return s;
    const units = r.rate_unit === "week" ? Math.ceil(days / 7) : days;
    return s + units * r.day_rate;
  }, 0);
  const weeklyRunRate = rows.filter((r) => !r.off_hire_to).reduce((s, r) => (r.day_rate == null ? s : s + (r.rate_unit === "week" ? r.day_rate : r.day_rate * 7)), 0);

  return (
    <>
      {err && <div className="flash error">{err}</div>}

      {rows.length > 0 && (
        <div className="kpis" style={{ marginBottom: 16 }}>
          <div className="kpi"><div className="kpi-label">On site now</div><div className="kpi-value">{onSiteCount}</div></div>
          <div className="kpi"><div className="kpi-label">Off hire</div><div className="kpi-value">{offHireCount}</div></div>
          <div className="kpi"><div className="kpi-label">Accrued to date</div><div className="kpi-value">{fmtMoney(totalAccrual)}</div><div className="kpi-sub">feeds prelims cross-check</div></div>
          <div className="kpi"><div className="kpi-label">Weekly run-rate</div><div className="kpi-value">{fmtMoney(weeklyRunRate)}</div><div className="kpi-sub">items on site</div></div>
        </div>
      )}

      {rows.length > 0 && (
        <div ref={formTop} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 8, flexWrap: "wrap" }}>
          <div className="muted">{onSiteCount} item{onSiteCount === 1 ? "" : "s"} currently on site</div>
          {canEdit && !showForm && <button className="primary" onClick={() => setShowForm(true)}>Add plant</button>}
        </div>
      )}

      {canEdit && showForm && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="ops-form-grid">
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              <span>Item</span>
              <input className="input" value={item} onChange={(e) => setItem(e.target.value)} placeholder="e.g. 9t excavator" />
            </label>
            <label className="field"><span>Supplier</span>
              {supplierCustom ? (
                <div className="row" style={{ gap: 6 }}>
                  <input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Type supplier name" style={{ flex: 1, minWidth: 0 }} autoFocus />
                  <button type="button" className="ghost tiny" onClick={() => { setSupplierCustom(false); setSupplier(""); }}>From list</button>
                </div>
              ) : (
                <SupplierCombobox
                  onProject={[]}
                  offProject={supplierOpts}
                  value={supplier}
                  isCustom={false}
                  onChange={setSupplier}
                  onCustom={() => { setSupplierCustom(true); setSupplier(""); }}
                />
              )}
            </label>
            <label className="field"><span>On hire from</span><input className="input" type="date" value={onHireFrom} onChange={(e) => setOnHireFrom(e.target.value)} /></label>
            <label className="field"><span>Rate (£)</span>
              <div className="row" style={{ gap: 6 }}>
                <input className="input" type="number" inputMode="decimal" value={dayRate} onChange={(e) => setDayRate(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
                <select className="input" value={rateUnit} onChange={(e) => setRateUnit(e.target.value as "day" | "week")} style={{ width: "auto" }}>
                  <option value="day">/ day</option>
                  <option value="week">/ week</option>
                </select>
              </div>
            </label>
            <label className="field"><span>Expected hire (weeks)</span><input className="input" type="number" inputMode="decimal" min="0" step="0.5" value={expectedWeeks} onChange={(e) => setExpectedWeeks(e.target.value)} placeholder="e.g. 4" /></label>
            <label className="field" style={{ gridColumn: "1 / -1" }}><span>Notes</span><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          </div>
          <div className="ck-short" style={{ marginTop: 10 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-2)" strokeWidth="1.8"><path d="M12 16V4M8 8l4-4 4 4M5 20h14" /></svg>
            <span>Hiring raises a purchase order{poEstimate > 0 ? <> — est. <b>{fmtMoney(poEstimate)}</b> ({weeksNum} wk × {fmtMoney(weeklyRate)}/wk)</> : null} that expends the <b>Prelims budget</b>. Off-hire date{onHireFrom && weeksNum > 0 ? <> ≈ <b>{fmtDate(addWeeksISO(onHireFrom, weeksNum))}</b></> : null}.</span>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="primary" onClick={add} disabled={busy || !item.trim() || !supplier.trim() || rateNum <= 0 || weeksNum <= 0}>{busy ? "Raising PO…" : "Add plant & raise PO"}</button>
            <button className="ghost" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="card">
          <div className="card-hd"><h2 style={{ fontSize: 17 }}>Plant on site</h2><span className="grow" />{canEdit && <button className="accent tiny" onClick={() => setShowForm(true)}>+ Add plant</button>}</div>
          <div className="empty in-card">
            <div className="ic"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 14h7V8h4l4 4v2h-2M3 14v3h2M19 14v3h-2M7 19a1.6 1.6 0 100-3.2A1.6 1.6 0 007 19zM15 19a1.6 1.6 0 100-3.2A1.6 1.6 0 0015 19z" /></svg></div>
            <h3 className="serif" style={{ fontSize: 19 }}>No plant logged</h3>
            <p className="muted" style={{ maxWidth: 460, margin: "0 auto" }}>Log hired plant with a daily or weekly rate. We accrue rate × time on site so the Prelims budget always reflects what's running.</p>
            <div className="templates">
              <button className="tmpl" onClick={() => canEdit && (setItem("MEWP / scissor lift"), setShowForm(true))}>MEWP / scissor lift</button>
              <button className="tmpl" onClick={() => canEdit && (setItem("Tower scaffold"), setShowForm(true))}>Tower scaffold</button>
              <button className="tmpl" onClick={() => canEdit && (setItem("Welfare unit"), setShowForm(true))}>Welfare unit</button>
              <button className="tmpl" onClick={() => canEdit && (setItem("Telehandler"), setShowForm(true))}>Telehandler</button>
              <button className="tmpl" onClick={() => canEdit && (setItem("Waste skip"), setShowForm(true))}>Waste skip</button>
            </div>
            {canEdit && <div style={{ marginTop: 20 }}><button className="accent" onClick={() => setShowForm(true)}>+ Add plant</button></div>}
          </div>
        </div>
      ) : (
        <div className="card">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Supplier</th>
                <th>On hire</th>
                <th className="num">Days</th>
                <th className="num">Rate</th>
                <th className="num">Est. cost</th>
                <th className="center">Status</th>
                {canEdit && <th style={{ width: 130 }}></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const days = daysOnSite(p.on_hire_from, p.off_hire_to);
                const units = days == null ? null : (p.rate_unit === "week" ? Math.ceil(days / 7) : days);
                const cost = units != null && p.day_rate != null ? units * p.day_rate : null;
                const planned = p.expected_off_hire;
                const offDue = !p.off_hire_to && planned
                  ? (planned < todayISO() ? "overdue" : planned <= addWeeksISO(todayISO(), 3 / 7) ? "soon" : "ok")
                  : null;
                return (
                  <tr key={p.id}>
                    <td data-label="Item">{p.item}
                      {p.po_id && p.po_number && <div style={{ fontSize: 11 }}><Link to={`/pos/${p.po_id}`} style={{ textDecoration: "none" }}>PO {p.po_number}</Link></div>}
                      {p.notes && <div className="muted" style={{ fontSize: 11 }}>{p.notes}</div>}
                    </td>
                    <td data-label="Supplier">{p.supplier ?? "—"}</td>
                    <td className="muted" data-label="On hire">{p.on_hire_from ? fmtDate(p.on_hire_from) : "—"}{p.off_hire_to ? ` → ${fmtDate(p.off_hire_to)}` : planned ? ` → ${fmtDate(planned)}` : ""}</td>
                    <td className="num" data-label="Days">{days ?? "—"}</td>
                    <td className="num" data-label="Rate">{p.day_rate != null ? <>{fmtMoney(p.day_rate)}<span className="muted" style={{ fontSize: 11 }}>/{p.rate_unit === "week" ? "wk" : "day"}</span></> : "—"}</td>
                    <td className="num" data-label="Est. cost">{cost != null ? fmtMoney(cost) : "—"}</td>
                    <td className="center" data-label="Status">
                      {p.off_hire_to ? <span className="pill neutral">Off hire</span>
                        : offDue === "overdue" ? <span className="pill warn dot">Off-hire overdue</span>
                        : offDue === "soon" ? <span className="pill warn dot">Off-hire soon</span>
                        : <span className="pill ok dot">On site</span>}
                    </td>
                    {canEdit && (
                      <td className="ops-table-actions">
                        {!p.off_hire_to && <button className="ghost tiny" onClick={() => offHire(p)}>Off hire</button>}{" "}
                        <button className="ghost tiny danger" onClick={() => remove(p)}>Delete</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Company-owned plant transferred to this site (no PO) ──────────── */}
      {(() => {
        const here = owned.filter((o) => o.assigned_project_id === projectId);
        const yard = owned.filter((o) => !o.assigned_project_id);
        if (here.length === 0 && yard.length === 0) return null;
        const pill = (s?: string) => (s === "expired" ? "danger" : s === "expiring" ? "warn" : s === "valid" ? "ok" : "neutral");
        const label = (s?: string) => (s === "expired" ? "Test expired" : s === "expiring" ? "Retest soon" : s === "valid" ? "In test" : "No test");
        const transfer = async (id: string, proj: string | null) => { try { await api.assignOwnedPlant(id, proj); loadOwned(); } catch (e) { setErr((e as Error).message); } };
        return (
          <div className="card" style={{ marginTop: 18 }}>
            <div className="card-hd" style={{ flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ fontSize: 17 }}>Owned plant on site</h2>
              <span className="pill">{here.length}</span>
              <span className="muted hide-on-mobile" style={{ fontSize: 12.5 }}>from the company plant register — no PO raised</span>
              <span className="grow" />
              {canEdit && yard.length > 0 && (
                <div className="row" style={{ gap: 6 }}>
                  <select className="input" value={transferId} onChange={(e) => setTransferId(e.target.value)} style={{ width: "auto" }}>
                    <option value="">Bring owned plant on site…</option>
                    {yard.map((o) => <option key={o.id} value={o.id}>{o.name}{o.asset_no ? ` (#${o.asset_no})` : ""}</option>)}
                  </select>
                  <button className="accent tiny" disabled={!transferId} onClick={() => { const id = transferId; setTransferId(""); transfer(id, projectId); }}>Transfer here</button>
                </div>
              )}
            </div>
            {here.length === 0 ? (
              <div className="empty in-card"><p className="muted" style={{ margin: 0 }}>No owned plant on this site yet. Bring an item from the yard above, or manage the <Link to="/plant">plant register</Link>.</p></div>
            ) : (
              <table className="ops-table">
                <thead><tr><th>Item</th><th>Category</th><th className="center">Tests</th>{canEdit && <th style={{ width: 120 }}></th>}</tr></thead>
                <tbody>
                  {here.map((o) => (
                    <tr key={o.id}>
                      <td data-label="Item"><b>{o.name}</b>{o.asset_no && <div className="muted" style={{ fontSize: 12 }}>#{o.asset_no}</div>}</td>
                      <td className="muted" data-label="Category">{o.category ?? "—"}</td>
                      <td className="center" data-label="Tests"><span className={`pill ${pill(o.test_status)} dot`}>{label(o.test_status)}</span></td>
                      {canEdit && <td className="ops-table-actions"><button className="ghost tiny" onClick={() => transfer(o.id, null)}>Return to yard</button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })()}
    </>
  );
}
