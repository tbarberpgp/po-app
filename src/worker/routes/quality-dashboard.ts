// Public, read-only, client-facing QITP quality dashboard (server-rendered HTML).
//
// A single project's Quality Inspection & Test Plan progress, summarised for the
// client at a glance with click-to-open drill-in drawers. Served un-authenticated
// from /pub/quality/:token (the /pub/* prefix is Access-bypassed in production) so
// anyone with the share link can view it — there are no edit controls by design.
//
// Every figure is derived from live QITP data (qitp_sections/cabins/records/
// signoffs/photos) using the same "released = every responsible party signed"
// definition as the internal dashboard. Metrics the schema doesn't record
// (first-time pass rate, NCR close-history, programme plan dates, key handover
// dates) render as honest placeholders rather than invented numbers.
//
// Design source of truth: design_handoff_quality_dashboard/PGP Client Quality
// Dashboard.html — the CSS is ported verbatim; the hard-coded demo data is
// replaced by the rollup below.

import type { Env } from "../env";
import { PGP_LOGO } from "./pgp-logo";
import { PGP_FAVICON } from "./pgp-favicon";

type Sec = { id: number; seq: number; title: string; point_type: string | null; responsible: string[] };
type Rec = { cabin_id: number; section_id: number; status: string; notes: string | null; updated_at: string | null };
type Sign = { cabin_id: number; section_id: number; party: string; signed_name: string; signed_at: string };
type Cab = { id: number; number: string; floor: string };

const FLOORS = ["Top", "Middle", "Ground"] as const;

/** "1 Jul 2026" in UK local time. */
function ukDate(iso?: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric" }).format(d);
}
function pct(a: number, b: number): number { return b > 0 ? Math.round((a / b) * 100) : 0; }
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function parties(raw: string | null): string[] { try { const v = JSON.parse(raw ?? "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } }

export type QualityRollup = {
  project: { code: string; name: string };
  updatedLabel: string;
  totalCabins: number;
  gatesPer: number;
  totalGates: number;
  cabinsByFloor: Record<string, number>;
  parties: string[];
  currentPhase: { label: string; sub: string };
  donut: { passed: number; prog: number; notStarted: number; failed: number };
  stages: Array<{ n: number; title: string; hold: boolean; passed: number; future: boolean }>;
  levels: Array<{ floor: string; done: number; total: number }>;
  lift: { per: Array<{ floor: string; done: number; total: number }>; done: number };
  liftSectionTitle: string | null;
  holdWitnessed: number;
  holdGatesTotal: number;
  cabinsDismantled: number;
  photos: { total: number; thisWeek: number; byStage: Array<{ title: string; n: number }> };
  ncrs: Array<{ cabin: string; section: string; note: string | null; raised: string | null }>;
  activity: Array<{ cls: "pass" | "hold" | "ncr"; icon: string; text: string; meta: string }>;
};

/** Compute the full client rollup for a project's QITP, or null if it has none. */
export async function computeQualityRollup(env: Env, projectId: string): Promise<QualityRollup | null> {
  const project = await env.DB.prepare("SELECT code, name FROM projects WHERE id = ? AND deleted_at IS NULL")
    .bind(projectId).first<{ code: string; name: string }>();
  if (!project) return null;

  const sections: Sec[] = (await env.DB.prepare(
    "SELECT id, seq, title, point_type, responsible FROM qitp_sections WHERE project_id = ? ORDER BY seq",
  ).bind(projectId).all<{ id: number; seq: number; title: string; point_type: string | null; responsible: string | null }>())
    .results.map((s) => ({ id: s.id, seq: s.seq, title: s.title, point_type: s.point_type, responsible: parties(s.responsible) }));
  if (sections.length === 0) return null;

  const cabins: Cab[] = (await env.DB.prepare(
    "SELECT id, number, floor FROM qitp_cabins WHERE project_id = ? ORDER BY floor, number",
  ).bind(projectId).all<Cab>()).results;

  const recs = (await env.DB.prepare(
    "SELECT r.cabin_id, r.section_id, r.status, r.notes, r.updated_at FROM qitp_records r JOIN qitp_cabins c ON c.id = r.cabin_id WHERE c.project_id = ?",
  ).bind(projectId).all<Rec>()).results;
  const signs = (await env.DB.prepare(
    "SELECT s.cabin_id, s.section_id, s.party, s.signed_name, s.signed_at FROM qitp_signoffs s JOIN qitp_cabins c ON c.id = s.cabin_id WHERE c.project_id = ?",
  ).bind(projectId).all<Sign>()).results;
  const photoRows = (await env.DB.prepare(
    "SELECT ph.section_id, ph.created_at FROM qitp_photos ph JOIN qitp_cabins c ON c.id = ph.cabin_id WHERE c.project_id = ?",
  ).bind(projectId).all<{ section_id: number; created_at: string }>()).results;

  const secById = new Map(sections.map((s) => [s.id, s]));
  const key = (cid: number, sid: number) => `${cid}:${sid}`;
  const recByKey = new Map(recs.map((r) => [key(r.cabin_id, r.section_id), r]));
  const signParties = new Map<string, Set<string>>();
  for (const s of signs) {
    const k = key(s.cabin_id, s.section_id);
    let set = signParties.get(k); if (!set) { set = new Set(); signParties.set(k, set); }
    set.add(s.party);
  }
  const released = (cid: number, sec: Sec): boolean => {
    if (sec.responsible.length === 0) return false;
    const got = signParties.get(key(cid, sec.id));
    return !!got && sec.responsible.every((p) => got.has(p));
  };

  // ── Donut / gate states ────────────────────────────────────────────────────
  let passed = 0, failed = 0, prog = 0;
  for (const cab of cabins) {
    for (const sec of sections) {
      if (released(cab.id, sec)) { passed++; continue; }
      const rec = recByKey.get(key(cab.id, sec.id));
      const partial = (signParties.get(key(cab.id, sec.id))?.size ?? 0) > 0;
      if (rec?.status === "fail") failed++;
      else if (partial || (rec && rec.status !== "not_started")) prog++;
    }
  }
  const totalGates = cabins.length * sections.length;
  const notStarted = totalGates - passed - failed - prog;

  // ── Stage funnel (per section, cabins released) ────────────────────────────
  const isReinstall = (t: string) => /re-?site|reinstall|final inspection|handover/i.test(t);
  const passedBySection = new Map<number, number>();
  for (const sec of sections) passedBySection.set(sec.id, cabins.filter((cab) => released(cab.id, sec)).length);
  const activityBySection = new Map<number, boolean>();
  for (const sec of sections) {
    const any = recs.some((r) => r.section_id === sec.id && r.status !== "not_started") || signs.some((s) => s.section_id === sec.id);
    activityBySection.set(sec.id, any);
  }
  const stages = sections.map((s) => ({
    n: s.seq, title: s.title, hold: s.point_type === "HOLD",
    passed: passedBySection.get(s.id) ?? 0,
    future: isReinstall(s.title) && (passedBySection.get(s.id) ?? 0) === 0 && !activityBySection.get(s.id),
  }));

  // ── Levels (released gates by floor) ───────────────────────────────────────
  const cabinsByFloor: Record<string, number> = {};
  for (const f of FLOORS) cabinsByFloor[f] = cabins.filter((c) => c.floor === f).length;
  const levels = FLOORS.map((f) => {
    const fc = cabins.filter((c) => c.floor === f);
    let done = 0; for (const cab of fc) for (const sec of sections) if (released(cab.id, sec)) done++;
    return { floor: f as string, done, total: fc.length * sections.length };
  });

  // ── Lift programme (cabins where the lift gate released), by floor ─────────
  const liftSection = sections.find((s) => /wrap.*lift|lift.*transport|\blift\b/i.test(s.title)) ?? null;
  const liftPer = FLOORS.map((f) => {
    const fc = cabins.filter((c) => c.floor === f);
    const done = liftSection ? fc.filter((cab) => released(cab.id, liftSection)).length : 0;
    return { floor: f as string, done, total: fc.length };
  });
  const liftDone = liftPer.reduce((a, x) => a + x.done, 0);

  // ── Hold points witnessed (released HOLD gates) ────────────────────────────
  const holdSections = sections.filter((s) => s.point_type === "HOLD");
  let holdWitnessed = 0;
  for (const cab of cabins) for (const sec of holdSections) if (released(cab.id, sec)) holdWitnessed++;

  // ── Cabins dismantled & stored (Storage/Receipt gate released) ─────────────
  const storeSection = sections.find((s) => /storage|receipt/i.test(s.title)) ?? liftSection;
  const cabinsDismantled = storeSection ? cabins.filter((cab) => released(cab.id, storeSection)).length : 0;

  // ── Photos ─────────────────────────────────────────────────────────────────
  const weekAgo = Date.now() - 7 * 86_400_000;
  const photoByStage = new Map<number, number>();
  let thisWeek = 0;
  for (const p of photoRows) {
    photoByStage.set(p.section_id, (photoByStage.get(p.section_id) ?? 0) + 1);
    if (new Date(p.created_at).getTime() >= weekAgo) thisWeek++;
  }

  // ── Open NCRs (failed gates) ───────────────────────────────────────────────
  const cabById = new Map(cabins.map((c) => [c.id, c]));
  const ncrs = recs
    .filter((r) => r.status === "fail")
    .map((r) => ({ cabin: cabById.get(r.cabin_id)?.number ?? "?", section: secById.get(r.section_id)?.title ?? "?", note: r.notes, raised: r.updated_at }))
    .sort((a, b) => String(b.raised ?? "").localeCompare(String(a.raised ?? "")));

  // ── Activity feed (recent sign-offs + fails) ───────────────────────────────
  type Ev = { t: string; cls: "pass" | "hold" | "ncr"; icon: string; text: string; meta: string };
  const evs: Ev[] = [];
  // Group sign-offs by (cabin, section): a released gate is a "pass"; a partial is a witness step.
  const signGroups = new Map<string, Sign[]>();
  for (const s of signs) { const k = key(s.cabin_id, s.section_id); const a = signGroups.get(k) ?? []; a.push(s); signGroups.set(k, a); }
  for (const [k, list] of signGroups) {
    const [cid, sid] = k.split(":").map(Number);
    const sec = secById.get(sid); const cab = cabById.get(cid);
    if (!sec || !cab) continue;
    const latest = list.slice().sort((a, b) => b.signed_at.localeCompare(a.signed_at))[0];
    const rel = released(cid, sec);
    const hold = sec.point_type === "HOLD";
    evs.push({
      t: latest.signed_at,
      cls: rel && hold ? "hold" : "pass", icon: rel && hold ? "⚑" : "✓",
      text: `<b>${esc(cab.number)}</b> — ${esc(sec.title)} ${rel ? "signed off" : "witness signature added"}`,
      meta: `${esc(latest.signed_name)}${list.length > 1 ? ` +${list.length - 1}` : ""} · ${ukDate(latest.signed_at)}`,
    });
  }
  for (const r of recs.filter((x) => x.status === "fail")) {
    const sec = secById.get(r.section_id); const cab = cabById.get(r.cabin_id);
    if (!sec || !cab) continue;
    evs.push({ t: r.updated_at ?? "", cls: "ncr", icon: "!", text: `<b>${esc(cab.number)}</b> — ${esc(sec.title)} non-conformance raised`, meta: `${r.notes ? esc(r.notes) + " · " : ""}${ukDate(r.updated_at)}` });
  }
  evs.sort((a, b) => String(b.t).localeCompare(String(a.t)));
  const activity = evs.slice(0, 6).map((e) => ({ cls: e.cls, icon: e.icon, text: e.text, meta: e.meta }));

  // ── Current phase label (honest, derived) ──────────────────────────────────
  const anyReinstall = sections.some((s) => isReinstall(s.title) && (passedBySection.get(s.id) ?? 0) > 0);
  const anyStore = cabinsDismantled > 0;
  const anyStrip = sections.some((s) => !isReinstall(s.title) && s.point_type !== "HOLD" && activityBySection.get(s.id));
  const currentPhase = anyReinstall
    ? { label: "Reinstall", sub: "re-site · handover" }
    : anyStore || liftDone > 0
      ? { label: "Dismantle", sub: "lift · store" }
      : anyStrip
        ? { label: "Strip-out", sub: "internal · external" }
        : { label: "Mobilisation", sub: "pre-start setup" };

  const distinctParties = [...new Set(sections.flatMap((s) => s.responsible))];

  return {
    project,
    updatedLabel: ukDate(),
    totalCabins: cabins.length,
    gatesPer: sections.length,
    totalGates,
    cabinsByFloor,
    parties: distinctParties,
    currentPhase,
    donut: { passed, prog, notStarted, failed },
    stages,
    levels,
    lift: { per: liftPer, done: liftDone },
    liftSectionTitle: liftSection?.title ?? null,
    holdWitnessed,
    holdGatesTotal: holdSections.length * cabins.length,
    cabinsDismantled,
    photos: { total: photoRows.length, thisWeek, byStage: sections.map((s) => ({ title: s.title, n: photoByStage.get(s.id) ?? 0 })) },
    ncrs,
    activity,
  };
}

// ── Drawer builders (mirror the mock's bar/row/ncr helpers) ──────────────────
function barHtml(name: string, color: string, val: number, total: number, unit?: string): string {
  const p = unit === "%" ? val : pct(val, total);
  const disp = unit === "%" ? `${val}%` : `<b>${val}</b>/${total}`;
  return `<div class="dbar"><span class="nm"><span class="dt" style="background:${color}"></span>${esc(name)}</span>`
    + `<span class="tk"><i data-dw="${p}" style="width:0;background:${color}"></i></span><span class="vl">${disp}</span></div>`;
}
function rowHtml(cls: string, icon: string, text: string, meta: string): string {
  return `<div class="drow"><span class="ic ${cls}">${icon}</span><div><div class="tx">${text}</div><div class="mt">${meta}</div></div></div>`;
}
function ncrHtml(id: string, title: string, desc: string, meta: string): string {
  return `<div class="dncr"><div class="top"><span class="id">${esc(id)}</span><span class="st">Open</span></div>`
    + `<div class="tx" style="font-weight:600;margin-bottom:3px">${esc(title)}</div>`
    + `<div class="desc">${esc(desc)}</div><div class="meta">${meta.split(" · ").map((m) => `<span>${esc(m)}</span>`).join("")}</div></div>`;
}
function noteHtml(text: string): string { return `<div class="dnote">${text}</div>`; }
function phNote(): string {
  return `<div class="dnote"><b style="color:var(--ink)">Not yet tracked.</b> This measure isn't recorded in the inspection system, so it isn't shown to avoid a misleading figure. It can be added once the underlying data is captured.</div>`;
}

const LC = { top: "var(--top)", mid: "var(--mid)", gnd: "var(--gnd)", green: "var(--gnd)", grey: "var(--line-strong)" };

/** Build the seven drill-in drawers from the rollup. */
function buildDrawers(r: QualityRollup): Record<string, { eyebrow: string; value: string; sub: string; body: string }> {
  const c = r.donut;
  const overallPct = pct(c.passed, r.totalGates);
  const lvlBars = r.levels.map((l, i) => barHtml(l.floor, [LC.top, LC.mid, LC.gnd][i], l.done, l.total)).join("");
  const liftBars = r.lift.per.map((l, i) => barHtml(l.floor, [LC.top, LC.mid, LC.gnd][i], l.done, l.total)).join("");
  const stageBars = r.stages.map((s) => barHtml(`Gate ${s.n}`, s.future ? LC.grey : LC.green, s.passed, r.totalCabins)).join("");
  const recentSignoffs = r.activity.filter((a) => a.cls !== "ncr").slice(0, 4);
  const signoffRows = recentSignoffs.length
    ? recentSignoffs.map((a) => rowHtml(a.cls, a.icon, a.text, a.meta)).join("")
    : noteHtml("No sign-offs recorded yet — they'll appear here as inspectors witness and release gates.");

  return {
    completion: {
      eyebrow: "Overall QITP completion", value: `${overallPct}%`,
      sub: `${c.passed} of ${r.totalGates} quality gates passed & witnessed`,
      body:
        `<div class="dblock"><h4>Gate status — all ${r.totalGates}</h4><div class="dstat">`
        + `<div class="c pos"><div class="n">${c.passed}</div><div class="l">Passed &amp; witnessed</div></div>`
        + `<div class="c"><div class="n">${c.prog}</div><div class="l">In progress</div></div>`
        + `<div class="c"><div class="n">${c.notStarted}</div><div class="l">Not started</div></div>`
        + `<div class="c neg"><div class="n">${c.failed}</div><div class="l">Failed / NCR</div></div>`
        + `</div></div>`
        + `<div class="dblock"><h4>Gates passed by stage</h4>${stageBars}</div>`
        + `<div class="dblock"><h4>Completion by level</h4>${lvlBars}`
        + noteHtml(`${r.gatesPer} gates per cabin × ${r.totalCabins} cabins = ${r.totalGates} total quality gates. Completion tracks passed &amp; witnessed gates against that total.`)
        + `</div>`,
    },
    dismantled: {
      eyebrow: "Cabins dismantled & stored", value: `${r.cabinsDismantled} <small style="font-family:Inter;font-size:16px;color:var(--muted);font-weight:500">/ ${r.totalCabins}</small>`,
      sub: `${pct(r.cabinsDismantled, r.totalCabins)}% of programme booked into store`,
      body:
        `<div class="dblock"><h4>Progress by level</h4>${liftBars}</div>`
        + `<div class="dblock"><h4>Recent dismantle sign-offs</h4>${signoffRows}</div>`
        + `<div class="dblock">${noteHtml("Counts a cabin once its Wrap, Lift &amp; Transport and Storage / Receipt gates are witnessed and released.")}</div>`,
    },
    holdpoints: {
      eyebrow: "Hold points witnessed", value: `${r.holdWitnessed}`,
      sub: `Witnessed hold-point gates released (all responsible parties signed)`,
      body:
        `<div class="dblock"><h4>Hold points</h4><div class="dstat">`
        + `<div class="c"><div class="n">${r.holdWitnessed}</div><div class="l">Witnessed &amp; released</div></div>`
        + `<div class="c"><div class="n">${r.holdGatesTotal}</div><div class="l">Total hold gates</div></div>`
        + `<div class="c"><div class="n">${pct(r.holdWitnessed, r.holdGatesTotal)}%</div><div class="l">Complete</div></div>`
        + `</div></div>`
        + `<div class="dblock"><h4>By hold-point gate</h4>`
        + r.stages.filter((s) => s.hold).map((s) => barHtml(`Gate ${s.n}`, s.future ? LC.grey : LC.green, s.passed, r.totalCabins)).join("")
        + noteHtml("A hold point is only counted once every responsible party (e.g. Durata, PGP) has signed it off for that cabin.")
        + `</div>`
        + `<div class="dblock"><h4>Latest witness records</h4>${signoffRows}</div>`,
    },
    ncr: {
      eyebrow: "Open non-conformances", value: `${r.ncrs.length}`,
      sub: r.ncrs.length ? `${r.ncrs.length} open · awaiting close-out` : "No open non-conformances",
      body:
        `<div class="dblock"><h4>Open now</h4>`
        + (r.ncrs.length
          ? r.ncrs.map((n, i) => ncrHtml(`NCR-${String(i + 1).padStart(3, "0")}`, `${n.section} — ${n.cabin}`, n.note || "Non-conformance raised at inspection; awaiting rework and re-inspection.", `${n.cabin} · raised ${ukDate(n.raised)}`)).join("")
          : noteHtml("<b style=\"color:var(--pass)\">None open.</b> No gate is currently failed — all inspected work is conforming."))
        + `</div>`
        + `<div class="dblock"><h4>Close-out history</h4>${phNote()}</div>`,
    },
    passrate: {
      eyebrow: "First-time pass rate", value: `<span style="color:var(--muted)">—</span>`,
      sub: "Not yet tracked",
      body: `<div class="dblock"><h4>First-time pass rate</h4>${phNote()}`
        + noteHtml("First-time pass rate needs a record of re-inspections after a failed gate. The current system stores a gate's latest state only, so this can't be calculated yet without losing accuracy.")
        + `</div>`,
    },
    programme: {
      eyebrow: "Dismantle lift programme", value: `${r.lift.done} <small style="font-family:Inter;font-size:16px;color:var(--muted);font-weight:500">/ ${r.totalCabins}</small>`,
      sub: r.liftSectionTitle ? `Cabins with the ${r.liftSectionTitle} gate released` : "Lift progress",
      body:
        `<div class="dblock"><h4>Lifted by level</h4>${liftBars}</div>`
        + `<div class="dblock"><h4>Plan vs actual</h4>${phNote()}`
        + noteHtml("The lift plan (cabins/day and the planned-to-date baseline) lives on the programme and isn't wired into this view yet, so plan-vs-actual and \"behind/ahead\" aren't shown.")
        + `</div>`,
    },
    photos: {
      eyebrow: "Inspection photos logged", value: `${r.photos.total.toLocaleString("en-GB")}`,
      sub: "Photographic evidence captured against gates",
      body:
        `<div class="dblock"><h4>Coverage</h4><div class="dstat">`
        + `<div class="c"><div class="n">${r.totalCabins ? (r.photos.total / r.totalCabins).toFixed(1) : "0"}</div><div class="l">Avg per cabin</div></div>`
        + `<div class="c pos"><div class="n">+${r.photos.thisWeek}</div><div class="l">Logged this week</div></div>`
        + `<div class="c"><div class="n">${r.photos.total}</div><div class="l">Total photos</div></div>`
        + `</div></div>`
        + `<div class="dblock"><h4>Photos by stage</h4>`
        + r.photos.byStage.map((s, i) => barHtml(`Gate ${i + 1}`, LC.top, s.n, Math.max(1, r.photos.total))).join("")
        + noteHtml("Evidence photos are captured against each gate during inspection. Full gallery available on request.")
        + `</div>`,
    },
  };
}

/** Render the complete standalone HTML page for the dashboard. */
export function qualityDashboardHtml(r: QualityRollup): string {
  const c = r.donut;
  const contractorSub = r.parties.length ? `witnessed w/ ${esc(r.parties.filter((p) => !/pgp/i.test(p)).join(", ") || r.parties.join(", "))}` : "";
  const phaseLabel = esc(r.currentPhase.label);

  // KPI cards (server-rendered with real values; passrate is a placeholder).
  const kpiCard = (accent: string, kpi: string, label: string, value: string, sub: string) =>
    `<div class="kpi clickable" style="--accent:${accent}" data-kpi="${kpi}" role="button" tabindex="0" aria-label="${esc(label)} — view breakdown">`
    + `<span class="drill"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span>`
    + `<div class="k">${esc(label)}</div><div class="v tnum">${value}</div><div class="s">${sub}</div></div>`;

  const kpis =
    kpiCard("var(--gnd)", "dismantled", "Cabins dismantled & stored", `${r.cabinsDismantled}<small> / ${r.totalCabins}</small>`, `${pct(r.cabinsDismantled, r.totalCabins)}% of programme`)
    + kpiCard("var(--top)", "holdpoints", "Hold points witnessed", `${r.holdWitnessed}`, "witnessed hold-point sign-offs")
    + kpiCard("var(--fail)", "ncr", "Open non-conformances", `${r.ncrs.length}`, r.ncrs.length ? "awaiting close-out" : "none open")
    + kpiCard("var(--orange)", "passrate", "First-time pass rate", `<span class="ph">—</span>`, `<span class="ph-t">not yet tracked</span>`);

  // Stage funnel rows.
  const stageRows = r.stages.map((s) =>
    `<div class="stage"><span class="sn">${s.n}</span>`
    + `<span class="snm"><div class="t">${esc(s.title)}</div>${s.hold ? '<div class="hold">⚑ HOLD POINT</div>' : ""}</span>`
    + `<span class="track${s.future ? " dim" : ""}"><i data-w="${pct(s.passed, r.totalCabins)}" style="width:0;background:${s.future ? "var(--line-strong)" : "linear-gradient(90deg,var(--gnd),#3d8a63)"}"></i></span>`
    + `<span class="val">${s.future ? "<small>upcoming</small>" : `${s.passed}<small> /${r.totalCabins}</small>`}</span></div>`,
  ).join("");

  // Programme level bars.
  const liftBars = r.lift.per.map((l, i) =>
    `<div class="lrow"><span class="lname"><span class="dt" style="background:${[LC.top, LC.mid, LC.gnd][i]}"></span>${l.floor}</span>`
    + `<span class="lbar"><i data-w="${pct(l.done, l.total)}" style="background:${[LC.top, LC.mid, LC.gnd][i]}"></i></span>`
    + `<span class="lnum"><b>${l.done}</b>/${l.total}</span></div>`,
  ).join("");

  // Activity feed.
  const activityHtml = r.activity.length
    ? `<ul class="feed">` + r.activity.map((a) => `<li><span class="fi ${a.cls}">${a.icon}</span><div><div class="ft">${a.text}</div><div class="fm">${a.meta}</div></div></li>`).join("") + `</ul>`
    : `<div class="empty-feed">No inspection activity logged yet. As gates are witnessed and signed off on site, the latest sign-offs, hold-point releases and any non-conformances appear here.</div>`;

  // Key dates — placeholders (not recorded in QITP).
  const keyDates = [
    { k: "Dismantle lifting starts", v: "TBC", m: "confirmed on programme" },
    { k: "Dismantle complete", v: "TBC", m: "forecast on programme" },
    { k: "Reinstall begins", v: "TBC", m: "subject to base readiness" },
    { k: "Final handover", v: "TBC", m: `${r.totalCabins} QITPs · full sign-off` },
  ].map((d) => `<div class="dcell"><div class="k">${esc(d.k)}</div><div class="v ph">${esc(d.v)}</div><div class="m">${esc(d.m)}</div></div>`).join("");

  const drawers = buildDrawers(r);
  const qjson = JSON.stringify({ donut: c, totalGates: r.totalGates, drawers }).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Quality Dashboard — ${esc(r.project.code)} ${esc(r.project.name)} · Power Grid Projects</title>
<link rel="icon" type="image/png" href="${PGP_FAVICON}">
<link rel="apple-touch-icon" href="${PGP_FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Source+Serif+Pro:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root,[data-theme=light]{
  --cream:#fbfaf7; --card:#ffffff; --ink:#0f1130; --ink2:#2a2d50; --navy:#0f1130; --orange:#ee5d2c; --orange2:#c64b1f;
  --line:#e6e3da; --line-strong:#c9c4b4; --soft:#f5f2eb; --muted:#6a6d8a;
  --top:#3b5bdb; --mid:#b06a0e; --gnd:#2f6f4f;
  --pass:#2f6f4f; --pass-s:#dff0e3; --fail:#b8331f; --fail-s:#fadbd2; --warn:#b06a0e; --warn-s:#faedd4;
  --serif:'Source Serif Pro',Cambria,Georgia,serif;
  --shadow:0 1px 2px rgba(15,17,48,.04),0 6px 20px rgba(15,17,48,.05);
}
[data-theme=dark]{
  --cream:#080a1c; --card:#11142b; --ink:#f5f3ec; --ink2:#c2bfb6; --navy:#11142b; --orange:#ff8a5a; --orange2:#ffa37f;
  --line:#232545; --line-strong:#3a3d62; --soft:#181b35; --muted:#8b89a0;
  --top:#8ea3ff; --mid:#f0b95a; --gnd:#74d49f;
  --pass:#74d49f; --pass-s:rgba(116,212,159,.16); --fail:#f4907a; --fail-s:rgba(244,144,122,.16); --warn:#f0b95a; --warn-s:rgba(240,185,90,.16);
  --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.28);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:Inter,-apple-system,system-ui,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--cream);-webkit-text-size-adjust:100%}
h1,h2,h3,.serif{font-family:var(--serif);font-weight:500;letter-spacing:-.01em;margin:0}
a{color:inherit;text-decoration:none}
.tnum{font-variant-numeric:tabular-nums}
.ph{color:var(--muted);font-weight:500}
.ph-t{color:var(--muted)}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.rise{opacity:0;animation:fadeUp .55s cubic-bezier(.22,1,.36,1) forwards}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.rise{opacity:1;transform:none}}
.topbar{position:sticky;top:0;z-index:50;background:var(--card);border-bottom:1px solid var(--line);padding:10px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:9px}
.topbar img.mark{height:30px;width:auto;display:block}
.topbar .vr{width:1px;height:28px;background:var(--line);margin:0 4px}
.topbar .ttl{font-family:var(--serif);font-weight:500;font-size:16px;color:var(--ink);line-height:1.15}
.topbar .sub{color:var(--muted);font-size:11.5px;margin-top:1px}
.topbar .spacer{flex:1}
.cbadge{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;letter-spacing:.03em;color:var(--ink);background:var(--soft);border:1px solid var(--line-strong);border-radius:999px;padding:5px 11px}
.cbadge .d{width:7px;height:7px;border-radius:50%;background:var(--pass)}
.iconbtn{background:var(--card);border:1px solid var(--line-strong);border-radius:9px;width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ink)}
.iconbtn:hover{border-color:var(--orange);background:var(--soft)}
.btn{background:var(--card);color:var(--ink);border:1px solid var(--line-strong);border-radius:9px;padding:8px 13px;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
.btn:hover{border-color:var(--orange);background:var(--soft)}
.wrap{max-width:1240px;margin:0 auto;padding:22px 20px 60px}
.hero{display:grid;grid-template-columns:1.15fr 1fr;gap:16px;margin-bottom:16px}
.herocard{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:var(--shadow);animation:fadeUp .5s cubic-bezier(.22,1,.36,1) both}
.hero .herocard:nth-child(2){animation-delay:.07s}
.hero .eyebrow{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}
.hero h1{font-size:27px;font-weight:600;margin:6px 0 3px}
.hero .metaline{color:var(--muted);font-size:13.5px}
.hero .metaline b{color:var(--ink)}
.metagrid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px 26px;margin-top:20px}
.metagrid .mi .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}
.metagrid .mi .v{font-family:var(--serif);font-size:16px;font-weight:600;margin-top:3px}
.metagrid .mi .v small{font-family:Inter;font-size:12px;color:var(--muted);font-weight:500}
.donutwrap{display:flex;align-items:center;gap:22px}
.donut{position:relative;flex:none;width:168px;height:168px}
.donut svg{transform:rotate(-90deg)}
.donut .ctr{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.donut .ctr .big{font-family:var(--serif);font-size:38px;font-weight:600;line-height:1}
.donut .ctr .lbl{font-size:11px;color:var(--muted);font-weight:600;margin-top:2px}
.dlegend{display:flex;flex-direction:column;gap:11px;flex:1}
.dlegend .row{display:flex;align-items:center;gap:9px;font-size:13px}
.dlegend .sw{width:11px;height:11px;border-radius:3px;flex:none}
.dlegend .row .nm{color:var(--ink2)}
.dlegend .row .ct{margin-left:auto;font-weight:700;font-variant-numeric:tabular-nums}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 17px;box-shadow:var(--shadow);position:relative;overflow:hidden;transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}
.kpi:hover{transform:translateY(-2px);box-shadow:0 2px 4px rgba(15,17,48,.05),0 12px 28px rgba(15,17,48,.09);border-color:var(--line-strong)}
.kpi::before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--accent,var(--orange))}
.kpi.clickable{cursor:pointer}
.kpi.clickable:focus-visible{outline:2px solid var(--orange);outline-offset:2px}
.kpi .drill{position:absolute;top:14px;right:14px;color:var(--muted);opacity:.55;transition:opacity .18s ease,transform .18s ease}
.kpi.clickable:hover .drill{opacity:1;transform:translateX(2px);color:var(--orange)}
.kpi .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}
.kpi .v{font-family:var(--serif);font-size:32px;font-weight:600;letter-spacing:-.01em;margin-top:7px;line-height:1}
.kpi .v small{font-family:Inter;font-size:15px;color:var(--muted);font-weight:500}
.kpi .s{font-size:12px;color:var(--muted);margin-top:7px;display:flex;align-items:center;gap:6px}
.grid2{display:grid;grid-template-columns:1.35fr 1fr;gap:16px}
.section{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);margin-bottom:16px;overflow:hidden;transition:box-shadow .2s ease}
.section:hover{box-shadow:0 2px 4px rgba(15,17,48,.05),0 12px 28px rgba(15,17,48,.08)}
.section > header{display:flex;align-items:center;gap:10px;padding:15px 18px;border-bottom:1px solid var(--line)}
.section > header h2{font-size:16px;font-weight:600}
.section > header .hint{font-size:12px;color:var(--muted);margin-left:auto}
.section .bd{padding:16px 18px}
.stage{display:flex;align-items:center;gap:13px;padding:9px 0}
.stage + .stage{border-top:1px dashed var(--line)}
.stage .sn{flex:none;width:26px;height:26px;border-radius:8px;background:var(--soft);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-family:var(--serif);font-weight:700;font-size:13px;color:var(--ink2)}
.stage .snm{flex:none;width:170px}
.stage .snm .t{font-size:13.5px;font-weight:600;line-height:1.15}
.stage .snm .hold{font-size:10px;font-weight:800;letter-spacing:.04em;color:var(--warn)}
.stage .track{flex:1;height:22px;background:var(--soft);border-radius:7px;overflow:hidden;position:relative}
.stage .track > i{display:block;height:100%;border-radius:7px;width:0;transition:width 1s cubic-bezier(.22,1,.36,1)}
.stage .val{flex:none;width:104px;text-align:right;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
.stage .val small{color:var(--muted);font-weight:500}
.lrow{display:flex;align-items:center;gap:12px;margin:11px 0;font-size:13px}
.lname{flex:none;width:74px;display:flex;align-items:center;gap:8px;font-weight:700}
.lname .dt{width:11px;height:11px;border-radius:3px}
.lbar{flex:1;height:11px;background:var(--soft);border-radius:6px;overflow:hidden}
.lbar i{display:block;height:100%;border-radius:6px;width:0;transition:width .95s cubic-bezier(.22,1,.36,1) .15s}
.lnum{flex:none;width:78px;text-align:right;font-variant-numeric:tabular-nums;color:var(--muted);font-weight:600}
.lnum b{color:var(--ink)}
.progline{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:8px}
.progline .lt{font-family:var(--serif);font-size:16px;font-weight:600}
.progline .lsub{font-size:12px;color:var(--muted);margin-top:2px}
.progline .ld{text-align:right;flex:none}
.progline .ldd{font-size:10.5px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.progline .ldv{font-family:var(--serif);font-size:17px;font-weight:600;color:var(--orange)}
.progline .ldv.tbc{color:var(--muted)}
.pcap{font-size:11.5px;color:var(--muted);margin-top:6px}
.astats{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.astat{background:var(--soft);border:1px solid var(--line);border-radius:11px;padding:13px 14px}
.astat .v{font-family:var(--serif);font-size:24px;font-weight:600;line-height:1}
.astat .k{font-size:11.5px;color:var(--muted);margin-top:5px;font-weight:500;line-height:1.25}
.astat.good .v{color:var(--pass)} .astat.warn .v{color:var(--warn)}
.feed{list-style:none;margin:0;padding:0}
.feed li{display:flex;gap:12px;padding:11px 0;border-bottom:1px dashed var(--line)}
.feed li:last-child{border-bottom:0;padding-bottom:0}
.feed .fi{flex:none;width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:14px}
.feed .fi.pass{background:var(--pass-s);color:var(--pass)}
.feed .fi.hold{background:var(--warn-s);color:var(--warn)}
.feed .fi.ncr{background:var(--fail-s);color:var(--fail)}
.feed .ft{font-size:13px;line-height:1.35}
.feed .ft b{font-weight:700}
.feed .fm{font-size:11.5px;color:var(--muted);margin-top:2px}
.empty-feed{font-size:12.5px;color:var(--muted);line-height:1.55;background:var(--soft);border:1px dashed var(--line-strong);border-radius:11px;padding:14px 15px}
.dates{display:grid;grid-template-columns:repeat(4,1fr);gap:0;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--card);box-shadow:var(--shadow)}
.dcell{padding:15px 18px;border-right:1px solid var(--line)}
.dcell:last-child{border-right:0}
.dcell .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}
.dcell .v{font-family:var(--serif);font-size:19px;font-weight:600;margin-top:5px}
.dcell .m{font-size:11.5px;color:var(--muted);margin-top:2px}
.dcell.hl .v{color:var(--orange)}
.footnote{margin-top:18px;font-size:11.5px;color:var(--muted);text-align:center;line-height:1.6}
@media (max-width:900px){
  .hero,.grid2{grid-template-columns:1fr}
  .kpis{grid-template-columns:repeat(2,1fr)}
  .dates{grid-template-columns:repeat(2,1fr)}
  .dcell:nth-child(2){border-right:0}
  .dcell:nth-child(-n+2){border-bottom:1px solid var(--line)}
}
@media (max-width:560px){
  .kpis{grid-template-columns:1fr}
  .donutwrap{flex-direction:column;align-items:flex-start}
  .stage .snm{width:130px}
}
.scrim{position:fixed;inset:0;background:rgba(15,17,48,.42);backdrop-filter:blur(2px);opacity:0;visibility:hidden;transition:opacity .28s ease,visibility .28s ease;z-index:80}
.scrim.open{opacity:1;visibility:visible}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(480px,94vw);background:var(--cream);border-left:1px solid var(--line);box-shadow:-12px 0 40px rgba(15,17,48,.18);transform:translateX(100%);transition:transform .34s cubic-bezier(.22,1,.36,1);z-index:81;display:flex;flex-direction:column}
.drawer.open{transform:none}
.drawer .dh{flex:none;padding:20px 22px 16px;border-bottom:1px solid var(--line);position:relative}
.drawer .dh .eyebrow{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.drawer .dh .dv{font-family:var(--serif);font-size:34px;font-weight:600;line-height:1;margin:8px 0 4px;letter-spacing:-.01em}
.drawer .dh .dsub{font-size:13px;color:var(--ink2)}
.drawer .dh .dx{position:absolute;top:16px;right:16px;width:34px;height:34px;border-radius:9px;border:1px solid var(--line-strong);background:var(--card);color:var(--ink);display:flex;align-items:center;justify-content:center;cursor:pointer}
.drawer .dh .dx:hover{border-color:var(--orange);background:var(--soft)}
.drawer .db{flex:1;overflow-y:auto;padding:18px 22px 40px}
.dblock{margin-bottom:22px}
.dblock:last-child{margin-bottom:0}
.dblock > h4{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 11px}
.dstat{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.dstat .c{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:11px 12px}
.dstat .c .n{font-family:var(--serif);font-size:20px;font-weight:600;line-height:1}
.dstat .c .l{font-size:11px;color:var(--muted);margin-top:4px;line-height:1.25}
.dstat .c.pos .n{color:var(--pass)} .dstat .c.neg .n{color:var(--fail)} .dstat .c.wrn .n{color:var(--warn)}
.dbar{display:flex;align-items:center;gap:11px;margin:9px 0;font-size:13px}
.dbar .nm{flex:none;width:78px;display:flex;align-items:center;gap:7px;font-weight:600}
.dbar .nm .dt{width:10px;height:10px;border-radius:3px;flex:none}
.dbar .tk{flex:1;height:9px;background:var(--soft);border-radius:5px;overflow:hidden}
.dbar .tk i{display:block;height:100%;border-radius:5px}
.dbar .vl{flex:none;width:74px;text-align:right;font-variant-numeric:tabular-nums;color:var(--muted);font-weight:600}
.dbar .vl b{color:var(--ink)}
.drow{display:flex;gap:12px;padding:11px 0;border-bottom:1px dashed var(--line)}
.drow:last-child{border-bottom:0}
.drow .ic{flex:none;width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700}
.drow .ic.pass{background:var(--pass-s);color:var(--pass)} .drow .ic.hold{background:var(--warn-s);color:var(--warn)} .drow .ic.ncr{background:var(--fail-s);color:var(--fail)}
.drow .tx{font-size:13px;line-height:1.35}
.drow .tx b{font-weight:700}
.drow .mt{font-size:11.5px;color:var(--muted);margin-top:2px}
.dncr{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--fail);border-radius:11px;padding:13px 14px;margin-bottom:10px}
.dncr .top{display:flex;align-items:center;gap:9px;margin-bottom:6px}
.dncr .id{font-family:var(--serif);font-weight:700;font-size:15px}
.dncr .st{margin-left:auto;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;background:var(--fail-s);color:var(--fail)}
.dncr .desc{font-size:13px;line-height:1.4;color:var(--ink2)}
.dncr .meta{font-size:11.5px;color:var(--muted);margin-top:7px;display:flex;flex-wrap:wrap;gap:4px 14px}
.dnote{font-size:12px;color:var(--muted);line-height:1.5;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:11px 13px}
.drillable{cursor:pointer}
.drillable:focus-visible{outline:2px solid var(--orange);outline-offset:2px}
.herocard.drillable{transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}
.herocard.drillable:hover{transform:translateY(-2px);box-shadow:0 2px 4px rgba(15,17,48,.05),0 14px 30px rgba(15,17,48,.10);border-color:var(--line-strong)}
.astat.drillable{transition:border-color .16s ease,background .16s ease,transform .16s ease;position:relative}
.astat.drillable:hover{border-color:var(--orange);background:var(--card);transform:translateY(-1px)}
.drill-hint{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:var(--muted);margin-left:auto;cursor:pointer;transition:color .16s ease}
.section > header .drill-hint svg{transition:transform .16s ease}
.section.drillable:hover .drill-hint,.drill-hint:hover{color:var(--orange)}
.section.drillable:hover .drill-hint svg{transform:translateX(2px)}
@media print{
  .topbar .iconbtn,.topbar .btn{display:none!important}
  body{background:#fff}
  *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;animation:none!important;transition:none!important;opacity:1!important}
  .section,.kpi,.herocard,.dates{box-shadow:none;break-inside:avoid}
}
</style>
</head>
<body data-theme="light">

<div class="topbar">
  <div class="brand"><img class="mark" src="${PGP_LOGO}" alt="PGP"></div>
  <div class="vr"></div>
  <div>
    <div class="ttl">Quality Dashboard</div>
    <div class="sub">${esc(r.project.code)} ${esc(r.project.name)} · Modular Cabin Refurbishment</div>
  </div>
  <div class="spacer"></div>
  <span class="cbadge"><span class="d"></span>Client view · read-only</span>
  <button class="btn" onclick="window.print()" title="Export PDF">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
    Export
  </button>
  <button class="iconbtn" id="themeBtn" title="Toggle theme" aria-label="Toggle theme"></button>
</div>

<div class="wrap">
  <div class="hero">
    <div class="herocard">
      <div class="eyebrow">Project quality assurance</div>
      <h1>Cabin refurbishment — QITP progress</h1>
      <div class="metaline">Inspection &amp; Test Plan across <b>${r.totalCabins} cabins</b> · ${r.gatesPer} quality gates each · updated <b>${esc(r.updatedLabel)}</b></div>
      <div class="metagrid">
        <div class="mi"><div class="k">Cabins in programme</div><div class="v">${r.totalCabins} <small>Top ${r.cabinsByFloor.Top ?? 0} · Mid ${r.cabinsByFloor.Middle ?? 0} · Gnd ${r.cabinsByFloor.Ground ?? 0}</small></div></div>
        <div class="mi"><div class="k">Quality gates</div><div class="v">${r.totalGates} <small>${r.gatesPer} per cabin</small></div></div>
        <div class="mi"><div class="k">Current phase</div><div class="v">${phaseLabel} <small>${esc(r.currentPhase.sub)}</small></div></div>
        <div class="mi"><div class="k">Inspecting contractor</div><div class="v">PGP <small>${contractorSub}</small></div></div>
      </div>
    </div>
    <div class="herocard drillable" data-drill="completion" role="button" tabindex="0" aria-label="Overall QITP completion — view breakdown">
      <div class="eyebrow" style="margin-bottom:16px;display:flex;align-items:center">Overall QITP completion <span class="drill-hint">View breakdown <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span></div>
      <div class="donutwrap">
        <div class="donut">
          <svg width="168" height="168" viewBox="0 0 168 168">
            <circle cx="84" cy="84" r="70" fill="none" stroke="var(--soft)" stroke-width="20"/>
            <circle id="dPass" cx="84" cy="84" r="70" fill="none" stroke="var(--pass)" stroke-width="20" stroke-linecap="butt"/>
            <circle id="dProg" cx="84" cy="84" r="70" fill="none" stroke="var(--top)" stroke-width="20" stroke-linecap="butt"/>
          </svg>
          <div class="ctr"><div class="big tnum" id="dPct">0%</div><div class="lbl">gates passed</div></div>
        </div>
        <div class="dlegend">
          <div class="row"><span class="sw" style="background:var(--pass)"></span><span class="nm">Passed &amp; witnessed</span><span class="ct" id="lgPass">0</span></div>
          <div class="row"><span class="sw" style="background:var(--top)"></span><span class="nm">In progress</span><span class="ct" id="lgProg">0</span></div>
          <div class="row"><span class="sw" style="background:var(--soft);border:1px solid var(--line-strong)"></span><span class="nm">Not started</span><span class="ct" id="lgTodo">0</span></div>
          <div class="row" style="margin-top:2px;border-top:1px dashed var(--line);padding-top:10px"><span class="sw" style="background:var(--fail)"></span><span class="nm">Failed / NCR raised</span><span class="ct" id="lgFail">0</span></div>
        </div>
      </div>
    </div>
  </div>

  <div class="kpis">${kpis}</div>

  <div class="grid2">
    <div>
      <section class="section drillable" data-drill="completion" role="button" tabindex="0" aria-label="Quality gates by stage — view breakdown">
        <header><h2>Quality gates by stage</h2><span class="drill-hint">View detail <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span></header>
        <div class="bd">${stageRows}</div>
      </section>

      <section class="section drillable" data-drill="programme" role="button" tabindex="0" aria-label="Dismantle lift programme — view breakdown">
        <header><h2>Dismantle lift programme</h2><span class="drill-hint">View detail <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span></header>
        <div class="bd">
          <div class="progline">
            <div><div class="lt">Cabins lifted &amp; transported</div><div class="lsub">against the strip-out programme</div></div>
            <div class="ld"><div class="ldd">Lifting starts</div><div class="ldv tbc">TBC</div></div>
          </div>
          <div class="pcap"><b style="color:var(--ink)">${r.lift.done}</b> of ${r.totalCabins} cabins with the lift gate witnessed &amp; released · <span class="ph">plan baseline on programme (TBC)</span></div>
          <div style="margin-top:14px">${liftBars}</div>
        </div>
      </section>
    </div>

    <div>
      <section class="section">
        <header><h2>Inspection assurance</h2></header>
        <div class="bd">
          <div class="astats">
            <div class="astat drillable" data-drill="passrate" role="button" tabindex="0" aria-label="First-time pass rate — view breakdown"><div class="v tnum"><span class="ph">—</span></div><div class="k">First-time pass rate <span class="ph-t">(not yet tracked)</span></div></div>
            <div class="astat drillable" data-drill="photos" role="button" tabindex="0" aria-label="Inspection photos logged — view breakdown"><div class="v tnum">${r.photos.total.toLocaleString("en-GB")}</div><div class="k">Inspection photos logged</div></div>
            <div class="astat good drillable" data-drill="completion" role="button" tabindex="0" aria-label="Gates passed and signed — view breakdown"><div class="v tnum">${c.passed}</div><div class="k">Gates passed &amp; signed</div></div>
            <div class="astat ${r.ncrs.length ? "warn" : ""} drillable" data-drill="ncr" role="button" tabindex="0" aria-label="Open NCRs — view breakdown"><div class="v tnum">${r.ncrs.length}</div><div class="k">Open NCRs awaiting close-out</div></div>
          </div>
        </div>
      </section>

      <section class="section">
        <header><h2>Recent quality activity</h2><span class="hint">latest</span></header>
        <div class="bd">${activityHtml}</div>
      </section>
    </div>
  </div>

  <div class="dates">${keyDates}</div>

  <div class="footnote">
    Figures reflect signed &amp; witnessed QITP records for project ${esc(r.project.code)} ${esc(r.project.name)} as at ${esc(r.updatedLabel)}, and update automatically as cabin gates are inspected on site. Hold points require every responsible party to sign.<br>
    Prepared by Power Grid Projects Ltd · this is a live summary view — full inspection records and photographic evidence available on request.
  </div>
</div>

<div class="scrim" id="scrim"></div>
<aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drTitle">
  <div class="dh">
    <div class="eyebrow" id="drEyebrow">Breakdown</div>
    <div class="dv tnum" id="drValue">—</div>
    <div class="dsub" id="drTitle">—</div>
    <button class="dx" id="drClose" aria-label="Close">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  </div>
  <div class="db" id="drBody"></div>
</aside>

<script>
var Q = ${qjson};
(function(){
  var C = 2*Math.PI*70, gap = 3;
  var pPass = Q.donut.passed/Q.totalGates, pProg = Q.donut.prog/Q.totalGates;
  var passEl = document.getElementById('dPass'), progEl = document.getElementById('dProg');
  passEl.setAttribute('stroke-dasharray', C); progEl.setAttribute('stroke-dasharray', C);
  progEl.style.transform = 'rotate('+ (pPass*360) +'deg)'; progEl.style.transformOrigin = '84px 84px';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  var passOff = C*(1-pPass), progOff = C*(1-pProg)+gap, pctv = Math.round(pPass*100);
  document.getElementById('lgPass').textContent = Q.donut.passed;
  document.getElementById('lgProg').textContent = Q.donut.prog;
  document.getElementById('lgTodo').textContent = Q.donut.notStarted;
  document.getElementById('lgFail').textContent = Q.donut.failed;
  var pctEl = document.getElementById('dPct');
  if(reduce){ passEl.style.strokeDashoffset = passOff; progEl.style.strokeDashoffset = progOff; pctEl.textContent = pctv+'%'; return; }
  passEl.style.strokeDashoffset = C; progEl.style.strokeDashoffset = C;
  passEl.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.22,1,.36,1)';
  progEl.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.22,1,.36,1) .25s';
  requestAnimationFrame(function(){ requestAnimationFrame(function(){ passEl.style.strokeDashoffset = passOff; progEl.style.strokeDashoffset = progOff; }); });
  var t0=null, dur=1100;
  function tick(ts){ if(!t0)t0=ts; var k=Math.min(1,(ts-t0)/dur); var e=1-Math.pow(1-k,3); pctEl.textContent=Math.round(e*pctv)+'%'; if(k<1)requestAnimationFrame(tick); }
  requestAnimationFrame(tick);
})();
(function(){
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  var bars = document.querySelectorAll('[data-w]');
  function paint(){ bars.forEach(function(b){ b.style.width = b.getAttribute('data-w')+'%'; }); }
  if(reduce){ paint(); return; }
  requestAnimationFrame(function(){ requestAnimationFrame(paint); });
})();
(function(){
  var scrim=document.getElementById('scrim'), drawer=document.getElementById('drawer');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  var lastFocus=null;
  function open(key){
    var d=Q.drawers[key]; if(!d) return;
    lastFocus=document.activeElement;
    document.getElementById('drEyebrow').textContent=d.eyebrow;
    document.getElementById('drValue').innerHTML=d.value;
    document.getElementById('drTitle').textContent=d.sub;
    document.getElementById('drBody').innerHTML=d.body;
    scrim.classList.add('open'); drawer.classList.add('open'); document.body.style.overflow='hidden';
    var bars=drawer.querySelectorAll('[data-dw]');
    if(reduce){ bars.forEach(function(b){b.style.width=b.getAttribute('data-dw')+'%';}); }
    else { requestAnimationFrame(function(){ requestAnimationFrame(function(){ bars.forEach(function(b){ b.style.transition='width .8s cubic-bezier(.22,1,.36,1)'; b.style.width=b.getAttribute('data-dw')+'%'; }); }); }); }
    document.getElementById('drClose').focus();
  }
  function close(){ scrim.classList.remove('open'); drawer.classList.remove('open'); document.body.style.overflow=''; if(lastFocus && lastFocus.focus) lastFocus.focus(); }
  document.querySelectorAll('.kpi.clickable').forEach(function(k){
    k.addEventListener('click', function(){ open(k.getAttribute('data-kpi')); });
    k.addEventListener('keydown', function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); open(k.getAttribute('data-kpi')); } });
  });
  document.querySelectorAll('[data-drill]').forEach(function(k){
    k.addEventListener('click', function(){ open(k.getAttribute('data-drill')); });
    k.addEventListener('keydown', function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); open(k.getAttribute('data-drill')); } });
  });
  document.getElementById('drClose').addEventListener('click', close);
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', function(e){ if(e.key==='Escape' && drawer.classList.contains('open')) close(); });
})();
(function(){
  var sun='<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var moon='<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>';
  var tb=document.getElementById('themeBtn');
  function setTheme(t){ document.body.setAttribute('data-theme',t); tb.innerHTML = t==='dark'?sun:moon; try{localStorage.setItem('pgp_quality_theme',t);}catch(e){} }
  tb.addEventListener('click', function(){ setTheme(document.body.getAttribute('data-theme')==='dark'?'light':'dark'); });
  setTheme((function(){try{return localStorage.getItem('pgp_quality_theme')||'light';}catch(e){return 'light';}})());
})();
</script>
</body>
</html>`;
}
