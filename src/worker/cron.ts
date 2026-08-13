import type { Env } from "./env";
import { emailPlantOffHire } from "./notify";
import { isSandboxId } from "./sandbox";

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Daily job: email the project + commercial manager when hired plant is 3 days
 *  from — or on — its planned off-hire date. Each milestone ("soon" at −3 days,
 *  "due" on the day) is sent once per item; sent milestones are recorded in
 *  plant_logs.offhire_alerts_sent so the job never double-sends. Items already
 *  marked off-hired (off_hire_to set) are skipped. */
export async function runOffHireReminders(env: Env): Promise<void> {
  if (!env.RESEND_API_KEY) { console.warn("off-hire reminders: no RESEND_API_KEY"); return; }
  const today = ymd(new Date());
  const soon = ymd(new Date(Date.now() + 3 * DAY));
  let rows: { results: Array<{
    id: number; item: string; supplier: string | null; expected_off_hire: string;
    offhire_alerts_sent: string | null; po_number: string | null;
    project_id: string; project_code: string; project_name: string;
    project_manager_email: string | null; commercial_manager_email: string | null; site_manager_email: string | null;
  }> };
  try {
    rows = await env.DB.prepare(
    `SELECT pl.id, pl.item, pl.supplier, pl.expected_off_hire, pl.offhire_alerts_sent,
            po.po_number AS po_number,
            p.id AS project_id, p.code AS project_code, p.name AS project_name,
            p.project_manager_email, p.commercial_manager_email, p.site_manager_email
       FROM plant_logs pl
       JOIN projects p ON p.id = pl.project_id
       LEFT JOIN purchase_orders po ON po.id = pl.po_id
      WHERE pl.off_hire_to IS NULL
        AND pl.expected_off_hire IN (?, ?)
        AND p.deleted_at IS NULL`,
    ).bind(today, soon).all<{
      id: number; item: string; supplier: string | null; expected_off_hire: string;
      offhire_alerts_sent: string | null; po_number: string | null;
      project_id: string; project_code: string; project_name: string;
      project_manager_email: string | null; commercial_manager_email: string | null; site_manager_email: string | null;
    }>();
  } catch (e) {
    // Pre-migration (0045): plant_logs.expected_off_hire / project email columns
    // don't exist yet. Nothing to remind on until the migration runs.
    console.warn("off-hire reminders skipped (pre-0045):", e instanceof Error ? e.message : e);
    return;
  }

  const base = env.APP_BASE_URL ?? "";
  for (const r of rows.results) {
    if (isSandboxId(r.project_id)) continue; // sandbox plant never emails real managers
    const milestone = r.expected_off_hire === today ? "due" : "soon";
    const sent = (r.offhire_alerts_sent ?? "").split(",").filter(Boolean);
    if (sent.includes(milestone)) continue;
    const to = [r.project_manager_email || r.site_manager_email, r.commercial_manager_email]
      .filter((x): x is string => !!x);
    if (to.length === 0) continue;
    await emailPlantOffHire(env, to, {
      projectCode: r.project_code, projectName: r.project_name, item: r.item, supplier: r.supplier,
      offHireDate: r.expected_off_hire, daysOut: milestone === "due" ? 0 : 3,
      poNumber: r.po_number, link: `${base}/projects/${r.project_id}`,
    });
    await env.DB.prepare("UPDATE plant_logs SET offhire_alerts_sent = ? WHERE id = ?")
      .bind([...sent, milestone].join(","), r.id).run();
  }
}
