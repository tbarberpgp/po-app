import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";

// Authed, project-scoped QITP dashboard data. The public cabin inspection +
// sign-off journey lives in publicOps.ts (token-gated, reached by QR).
export const qitp = new Hono<{ Bindings: Env; Variables: Variables }>();

type SectionRow = { id: number; seq: number; title: string; point_type: string | null; responsible: string | null };
type CabinRow = {
  id: number; number: string; floor: string; elevation: string | null; wing: string | null;
  position: number | null; dismantle_day: number | null; reinstall_date: string | null; storage_bay: string | null; token: string;
};
type RecRow = { cabin_id: number; section_id: number; status: string };
type SignRow = { cabin_id: number; section_id: number; party: string };

export type CabinState = "not_started" | "in_progress" | "held" | "failed" | "complete";

function parties(s: SectionRow): string[] { try { const v = JSON.parse(s.responsible ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }

/** Derive a cabin's headline state + progress. A section is "released" when every
 *  responsible party has signed; a HOLD blocks downstream until released. */
export function deriveCabin(sections: SectionRow[], recs: RecRow[], signs: SignRow[]): { status: CabinState; done: number; total: number } {
  const total = sections.length;
  const statusBy = new Map(recs.map((r) => [r.section_id, r.status]));
  const signsBy = new Map<number, Set<string>>();
  for (const s of signs) { const set = signsBy.get(s.section_id) ?? new Set(); set.add(s.party); signsBy.set(s.section_id, set); }
  const released = (s: SectionRow) => { const p = parties(s); const got = signsBy.get(s.id); return p.length > 0 && p.every((x) => got?.has(x)); };

  const done = sections.filter(released).length;
  const hasFail = sections.some((s) => statusBy.get(s.id) === "fail");
  const started = recs.some((r) => r.status !== "not_started") || signs.length > 0;

  let predReleased = true, blockedHold = false;
  for (const s of sections) {
    if (s.point_type === "HOLD" && predReleased && !released(s)) { blockedHold = true; break; }
    predReleased = predReleased && released(s);
  }

  let status: CabinState;
  if (hasFail) status = "failed";
  else if (done === total) status = "complete";
  else if (blockedHold && started) status = "held";
  else if (started) status = "in_progress";
  else status = "not_started";
  return { status, done, total };
}

qitp.get("/:projectId/dashboard", async (c) => {
  const projectId = c.req.param("projectId");
  const project = await c.env.DB.prepare("SELECT code, name FROM projects WHERE id = ?").bind(projectId).first<{ code: string; name: string }>();
  if (!project) return c.json({ error: "Project not found" }, 404);

  const sections = (await c.env.DB.prepare(
    "SELECT id, seq, title, point_type, responsible FROM qitp_sections WHERE project_id = ? ORDER BY seq",
  ).bind(projectId).all<SectionRow>()).results;

  const cabins = (await c.env.DB.prepare(
    "SELECT id, number, floor, elevation, wing, position, dismantle_day, reinstall_date, storage_bay, token FROM qitp_cabins WHERE project_id = ? ORDER BY dismantle_day, position, number",
  ).bind(projectId).all<CabinRow>()).results;

  const recs = (await c.env.DB.prepare(
    "SELECT r.cabin_id, r.section_id, r.status FROM qitp_records r JOIN qitp_cabins c ON c.id = r.cabin_id WHERE c.project_id = ?",
  ).bind(projectId).all<RecRow>()).results;
  const recsByCabin = new Map<number, RecRow[]>();
  for (const r of recs) { const a = recsByCabin.get(r.cabin_id) ?? []; a.push(r); recsByCabin.set(r.cabin_id, a); }

  const signs = (await c.env.DB.prepare(
    "SELECT s.cabin_id, s.section_id, s.party FROM qitp_signoffs s JOIN qitp_cabins c ON c.id = s.cabin_id WHERE c.project_id = ?",
  ).bind(projectId).all<SignRow>()).results;
  const signsByCabin = new Map<number, SignRow[]>();
  for (const s of signs) { const a = signsByCabin.get(s.cabin_id) ?? []; a.push(s); signsByCabin.set(s.cabin_id, a); }

  // "Lifted" = the "Ready to Lift" hold point released (all parties signed) —
  // drives the dashboard lift-programme card. Pin to the exact section so the
  // lift-sequence sections (Initial Lift Test / Re Check Before Full Lift) can't
  // hijack the loose match; fall back to any /lift/ section for other projects.
  const liftSection =
    sections.find((s) => /^ready to lift$/i.test(s.title.trim())) ??
    sections.find((s) => /lift/i.test(s.title));
  const liftParties = liftSection ? parties(liftSection) : [];
  const out = cabins.map((c2) => {
    const cs = signsByCabin.get(c2.id) ?? [];
    const d = deriveCabin(sections, recsByCabin.get(c2.id) ?? [], cs);
    const liftSigned = liftSection ? new Set(cs.filter((s) => s.section_id === liftSection.id).map((s) => s.party)) : new Set<string>();
    const lifted = !!liftSection && liftParties.length > 0 && liftParties.every((p) => liftSigned.has(p));
    return {
      id: c2.id, number: c2.number, floor: c2.floor, elevation: c2.elevation, wing: c2.wing,
      dismantle_day: c2.dismantle_day, reinstall_date: c2.reinstall_date, token: c2.token, lifted, ...d,
    };
  });
  return c.json({ project, sections, cabins: out });
});

// Superadmin: clear a section's progress + sign-offs (for testing / corrections).
// Auth-gated on /api so the public QR token alone can't trigger it. Re-locks
// downstream sections when the cleared section is a HOLD point.
qitp.post("/unsign/:token/:sectionId", async (c) => {
  if (c.get("userRole") !== "superadmin") return c.json({ error: "Only a superadmin can clear a section." }, 403);
  const cab = await c.env.DB.prepare("SELECT id FROM qitp_cabins WHERE token = ?").bind(c.req.param("token")).first<{ id: number }>();
  if (!cab) return c.json({ error: "Cabin not found" }, 404);
  const sectionId = Number(c.req.param("sectionId"));
  await c.env.DB.prepare("DELETE FROM qitp_signoffs WHERE cabin_id = ? AND section_id = ?").bind(cab.id, sectionId).run();
  await c.env.DB.prepare(
    "UPDATE qitp_records SET status = 'not_started', checks = NULL, updated_at = ? WHERE cabin_id = ? AND section_id = ?",
  ).bind(new Date().toISOString(), cab.id, sectionId).run();
  return c.json({ ok: true });
});

// ── Client quality dashboard share link ──────────────────────────────────────
// The public, read-only client dashboard (rendered at /pub/quality/:token) is
// reached by an unguessable share token. GET returns the project's existing
// token (or null); POST mints one if absent (idempotent). Stored in `settings`
// as a token↔project pair, so no schema change is needed. Viewing the link
// needs delivery.edit (whoever runs quality); publishing it needs projects.edit
// (PM and up) since it exposes a read-only view to anyone with the link.
qitp.get("/:projectId/client-link", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(`quality_token:${c.req.param("projectId")}`).first<{ value: string }>();
  return c.json({ token: row?.value ?? null });
});

qitp.post("/:projectId/client-link", async (c) => {
  const denied = requirePermission(c, "projects.edit");
  if (denied) return denied;
  const projectId = c.req.param("projectId");
  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL").bind(projectId).first();
  if (!project) return c.json({ error: "Project not found" }, 404);
  const existing = await c.env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(`quality_token:${projectId}`).first<{ value: string }>();
  let token = existing?.value ?? null;
  if (!token) {
    token = crypto.randomUUID().replace(/-/g, "");
    await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(`quality_token:${projectId}`, token).run();
    await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(`quality_share:${token}`, projectId).run();
  }
  return c.json({ token });
});
