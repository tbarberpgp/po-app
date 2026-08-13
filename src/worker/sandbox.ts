import type { Env } from "./env";
import { normalisePhone } from "../shared/operatives-import";

/**
 * The sandbox is a single, fixed-id demo project people can safely play in.
 * Its id is constant so every safety guard is a cheap string compare — it can
 * never push to Xero or send a real email (see the isSandboxId guards across the
 * worker), it's excluded from all portfolio rollups, and it's reset to the
 * seeded baseline below every night. Seeded operatives are tagged created_by =
 * 'sandbox-seed' so the reset can replace them without touching the real register.
 */
export const SANDBOX_PROJECT_ID = "sandbox";
export const SANDBOX_PROJECT_CODE = "DEMO";
const SEED_MARK = "sandbox-seed";

/** True for anything belonging to the sandbox project — the guard used everywhere. */
export function isSandboxId(projectId: string | null | undefined): boolean {
  return projectId === SANDBOX_PROJECT_ID;
}

const DAY = 86_400_000;

/**
 * Wipe and re-seed the sandbox to a believable baseline: a programme, a few
 * operatives (with trades), framework + call-off + standard + paid POs, recent
 * deliveries, sign-ins (incl. visitors), plant on hire, and a daily site report.
 * Idempotent — safe to run nightly. Creates the project on first run.
 */
export async function resetSandbox(env: Env): Promise<void> {
  const P = SANDBOX_PROJECT_ID;
  const now = new Date();
  const day = (off: number) => new Date(now.getTime() + off * DAY);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const iso = (d: Date) => d.toISOString();
  const at = (d: Date, h: number, m: number) => iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m)));
  const nowIso = iso(now);

  // ── 1. Clear existing sandbox data (child rows + seeded operatives) ──────────
  await env.DB.batch([
    env.DB.prepare("DELETE FROM po_lines WHERE po_id IN (SELECT id FROM purchase_orders WHERE project_id = ?)").bind(P),
    env.DB.prepare("DELETE FROM purchase_orders WHERE project_id = ?").bind(P),
    env.DB.prepare("DELETE FROM site_deliveries WHERE project_id = ?").bind(P),
    env.DB.prepare("DELETE FROM programme_activities WHERE project_id = ?").bind(P),
    env.DB.prepare("DELETE FROM site_signins WHERE project_id = ?").bind(P),
    env.DB.prepare("DELETE FROM plant_logs WHERE project_id = ?").bind(P),
    env.DB.prepare("DELETE FROM site_reports WHERE project_id = ?").bind(P),
    env.DB.prepare("DELETE FROM project_updates WHERE project_id = ?").bind(P),
    env.DB.prepare("DELETE FROM site_inductions WHERE project_id = ?").bind(P),
    env.DB.prepare("DELETE FROM operatives WHERE created_by = ?").bind(SEED_MARK),
  ]);

  // ── 2. The project row (upsert; contacts blank so nothing can be emailed) ────
  await env.DB.prepare(
    `INSERT INTO projects (id, code, name, client, currency, created_at, created_by,
                           site_manager_email, project_manager_email, commercial_manager_email, client_email)
       VALUES (?, ?, ?, ?, 'GBP', ?, ?, NULL, NULL, NULL, NULL)
     ON CONFLICT(id) DO UPDATE SET
       code = excluded.code, name = excluded.name, client = excluded.client,
       deleted_at = NULL, completed_at = NULL,
       site_manager_email = NULL, project_manager_email = NULL,
       commercial_manager_email = NULL, client_email = NULL`,
  ).bind(P, SANDBOX_PROJECT_CODE, "Demo / Sandbox Project", "Demo Client Ltd", nowIso, SEED_MARK).run();

  // ── 3. Operatives (tagged sandbox-seed, no email so invites can't fire) ──────
  const ops = [
    { id: "sb-op-1", name: "Demo Alan Joiner", trade: "Roofer", phone: "07700900001" },
    { id: "sb-op-2", name: "Demo Ben Carter", trade: "Roofer", phone: "07700900002" },
    { id: "sb-op-3", name: "Demo Cal Hughes", trade: "Labourer", phone: "07700900003" },
    { id: "sb-op-4", name: "Demo Dan Reeves", trade: "Scaffolder", phone: "07700900004" },
  ];
  await env.DB.batch(ops.map((o) =>
    env.DB.prepare(
      `INSERT INTO operatives (id, token, name, phone, phone_norm, company, trade, email,
                               induction_done, induction_at, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'Demo Roofing Co', ?, NULL, 1, ?, ?, ?)`,
    ).bind(o.id, `tok-${o.id}`, o.name, o.phone, normalisePhone(o.phone), o.trade, nowIso, nowIso, SEED_MARK),
  ));

  // ── 4. Programme (a small Gantt around "today") ──────────────────────────────
  const acts: Array<[number, number, string, number, number, number]> = [
    // [line_no, level, name, startOff, finishOff, pct]
    [1, 0, "BLOCK C — Re-roof", -30, 50, 0.45],
    [2, 1, "Scaffold & access", -30, -20, 1],
    [3, 1, "Strip existing covering", -19, -8, 1],
    [4, 1, "Felt & battens", -7, 6, 0.6],
    [5, 1, "Tiling", 7, 28, 0],
    [6, 1, "Leadwork & flashings", 24, 38, 0],
    [7, 1, "Scaffold strike & handover", 39, 50, 0],
  ];
  await env.DB.batch(acts.map(([ln, lvl, name, s, f, pct], i) =>
    env.DB.prepare(
      `INSERT INTO programme_activities (project_id, line_no, level, name, is_summary,
                 baseline_start, baseline_finish, planned_start, planned_finish, pct_complete,
                 duration_days, display_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(P, ln, lvl, name, lvl === 0 ? 1 : 0, ymd(day(s)), ymd(day(f)), ymd(day(s)), ymd(day(f)), pct,
      Math.max(1, f - s), i, nowIso),
  ));

  // ── 5. Purchase orders + lines (framework, call-off, standard, paid) ─────────
  const pos: Array<{
    id: string; num: string; supplier: string; status: string; total: number;
    order_type: string; parent?: string; paid?: boolean; category?: string;
    lines: Array<[string, number, string, number]>; // [item, qty, unit, unit_cost]
  }> = [
    { id: "sb-po-1", num: "PO-DEMO-0001", supplier: "SIG Roofing", status: "approved", order_type: "framework", total: 50000,
      lines: [["Concrete interlocking tiles (framework allowance)", 5000, "no", 1.85], ["Breathable felt 1m × 50m (framework)", 200, "roll", 42], ["Treated battens 25×50mm (framework)", 4000, "m", 0.55]] },
    { id: "sb-po-2", num: "PO-DEMO-0001-C1", supplier: "SIG Roofing", status: "issued", order_type: "call_off", parent: "sb-po-1", total: 8230,
      lines: [["Concrete interlocking tiles", 3800, "no", 1.85], ["Treated battens 25×50mm", 2000, "m", 0.55]] },
    { id: "sb-po-3", num: "PO-DEMO-0002", supplier: "Jewson", status: "approved", order_type: "standard", total: 3240,
      lines: [["Ridge tiles", 120, "no", 12], ["Dry verge units", 90, "no", 8], ["Mortar bags", 40, "bag", 18]] },
    { id: "sb-po-4", num: "PO-DEMO-0003", supplier: "Speedy Hire", status: "issued", order_type: "standard", total: 1260, paid: true, category: "prelims",
      lines: [["19m telehandler hire (week)", 2, "wk", 630]] },
  ];
  const poStmts = [];
  for (const po of pos) {
    poStmts.push(env.DB.prepare(
      `INSERT INTO purchase_orders (id, po_number, project_id, supplier, status, requires_approval,
                 order_type, parent_po_id, category, total_value, created_at, created_by, approved_at, approved_by, issued_at, paid_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(po.id, po.num, P, po.supplier, po.status, po.order_type, po.parent ?? null, po.category ?? "materials",
      po.total, iso(day(-12)), SEED_MARK,
      po.status === "approved" || po.status === "issued" ? iso(day(-11)) : null,
      po.status === "approved" || po.status === "issued" ? SEED_MARK : null,
      po.status === "issued" ? iso(day(-10)) : null,
      po.paid ? iso(day(-3)) : null));
    for (const [item, qty, unit, cost] of po.lines) {
      poStmts.push(env.DB.prepare(
        `INSERT INTO po_lines (po_id, item, qty, unit, unit_cost, line_total, is_unpriced)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
      ).bind(po.id, item, qty, unit, cost, Math.round(qty * cost * 100) / 100));
    }
  }
  await env.DB.batch(poStmts);

  // ── 6. Deliveries ────────────────────────────────────────────────────────────
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO site_deliveries (project_id, supplier, description, po_number, signed_by, status, delivered_at, created_at, created_by)
       VALUES (?, 'SIG Roofing', 'Tiles (part load) — 3800 of 3800', 'PO-DEMO-0001-C1', 'Demo Ben Carter', 'received', ?, ?, ?)`).bind(P, iso(day(-2)), iso(day(-2)), SEED_MARK),
    env.DB.prepare(`INSERT INTO site_deliveries (project_id, supplier, description, po_number, signed_by, status, delivered_at, created_at, created_by)
       VALUES (?, 'Jewson', 'Ridge tiles + dry verge', 'PO-DEMO-0002', 'Demo Alan Joiner', 'partial', ?, ?, ?)`).bind(P, iso(day(-1)), iso(day(-1)), SEED_MARK),
  ]);

  // ── 7. Sign-ins over the last 3 days (operatives + a couple of visitors) ─────
  const signStmts = [];
  const present = (d: Date, name: string, company: string, outH: number | null) =>
    env.DB.prepare(`INSERT INTO site_signins (project_id, name, company, signed_in_at, signed_out_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`).bind(P, name, company, at(d, 7, 5), outH == null ? null : at(d, outH, 0), at(d, 7, 5));
  for (const off of [-2, -1, 0]) {
    const d = day(off);
    signStmts.push(present(d, "Demo Alan Joiner", "Demo Roofing Co", off === 0 ? null : 16));
    signStmts.push(present(d, "Demo Ben Carter", "Demo Roofing Co", off === 0 ? null : 16));
    signStmts.push(present(d, "Demo Cal Hughes", "Demo Roofing Co", off === 0 ? null : 15));
    if (off !== 0) signStmts.push(present(d, "Demo Dan Reeves", "Apex Scaffolding", 14));
  }
  // Visitors (names not in the operative register → counted as visitors)
  signStmts.push(present(day(0), "Sam Client (visitor)", "Demo Client Ltd", 12));
  signStmts.push(present(day(-1), "Building Inspector", "Local Authority", 11));
  await env.DB.batch(signStmts);

  // ── 8. Plant on hire (off-hire date well in the future; never reminds) ───────
  await env.DB.prepare(`INSERT INTO plant_logs (project_id, item, supplier, on_hire_from, off_hire_to, day_rate, created_at, created_by)
       VALUES (?, '19m telehandler', 'Speedy Hire', ?, NULL, 126, ?, ?)`).bind(P, ymd(day(-10)), nowIso, SEED_MARK).run();

  // ── 9. A few field updates + a ready-made daily site report ──────────────────
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO project_updates (project_id, source, body, occurred_at, created_at)
       VALUES (?, 'whatsapp', 'Felt and battens to bays 3-5 complete, tiling starts tomorrow.', ?, ?)`).bind(P, iso(day(0)), nowIso),
    env.DB.prepare(`INSERT INTO project_updates (project_id, source, body, occurred_at, created_at)
       VALUES (?, 'whatsapp', 'Tile delivery received and craned to roof level.', ?, ?)`).bind(P, iso(day(0)), nowIso),
  ]);

  const reportData = {
    headline: "Steady progress on the Block C re-roof; felt and battens nearing completion ahead of tiling.",
    labour_count: "3 operatives", weather: "Dry, 16°",
    progress: ["Felt & battens to bays 3–5 complete", "Tiles craned to roof level", "Scaffold inspection passed"],
    deliveries: [], labour: [], hse: ["Toolbox talk: working at height refresher"],
    blockers: ["Awaiting structural sign-off on bay 6 before loading out"],
    lookahead: ["Start tiling bays 3–5", "Ridge & verge once tiling is up"],
    plant: ["19m telehandler"],
    safety: { incidents: 0, near_misses: 0, toolbox_talks: 1, rams_outstanding: 0 },
    programme: { day: 31, total_days: 80, pct_overall: 45, status: "On programme" },
    attendance: { on_site: 3, companies: 1, first_in: "07:05", last_out: "16:00", inductions: 0, visitors: 1 },
    labour_table: [{ company: "Demo Roofing Co", count: 3, hours: 24.5, trade: "Roofer ×2, Labourer ×1" }],
    deliveries_detail: [
      { supplier: "SIG Roofing", description: "Tiles (3800)", po_number: "PO-DEMO-0001-C1", status: "received" },
      { supplier: "Jewson", description: "Ridge + dry verge", po_number: "PO-DEMO-0002", status: "partial" },
    ],
  };
  await env.DB.prepare(
    `INSERT INTO site_reports (project_id, period_type, period_start, period_end, summary_md, data_json, update_count, status, generated_at, generated_by)
       VALUES (?, 'daily', ?, ?, '', ?, 2, 'generated', ?, ?)`,
  ).bind(P, ymd(day(0)), ymd(day(0)), JSON.stringify(reportData), nowIso, SEED_MARK).run();
}
