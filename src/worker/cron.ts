import type { Env } from "./env";
import { emailPlantOffHire, emailFrameworkOverdraw, FRAMEWORK_OVERDRAW_RECIPIENTS } from "./notify";
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

/** Daily sweep for framework lines a call-off has drawn past its agreed qty.
 *  Real-time alerts (in pos.ts) catch the call-off that tips a line over the
 *  moment it happens; this catches anything from before that check existed,
 *  or that somehow still slips through. Dedup mirrors off-hire reminders —
 *  po_lines.framework_overdraw_alerted_qty records the drawn qty at the last
 *  alert, so a line already reported at (say) 47-of-36 doesn't re-alert every
 *  day it stays at 47; it only re-alerts if the draw gets worse. */
export async function runFrameworkOverdrawAlerts(env: Env): Promise<void> {
  if (!env.RESEND_API_KEY) { console.warn("framework overdraw sweep: no RESEND_API_KEY"); return; }
  const rows = await env.DB.prepare(
    `SELECT * FROM (
       SELECT pl.id AS line_id, pl.item, pl.unit, pl.qty AS framework_qty,
              pl.framework_overdraw_alerted_qty AS alerted_qty,
              po.id AS po_id, po.po_number, po.supplier,
              p.id AS project_id, p.code AS project_code, p.name AS project_name,
              COALESCE((
                SELECT SUM(cl.qty) FROM po_lines cl JOIN purchase_orders cp ON cp.id = cl.po_id
                 WHERE cp.parent_po_id = po.id AND cp.status IN ('approved','issued','pending_approval')
                   AND lower(cl.item) = lower(pl.item)
              ), 0) AS drawn_qty
         FROM po_lines pl
         JOIN purchase_orders po ON po.id = pl.po_id
         JOIN projects p ON p.id = po.project_id
        WHERE po.order_type = 'framework' AND po.status != 'deleted'
          AND p.deleted_at IS NULL
     ) WHERE drawn_qty > framework_qty + 0.0001`,
  ).all<{
    line_id: number; item: string; unit: string; framework_qty: number; alerted_qty: number | null;
    po_id: string; po_number: string; supplier: string;
    project_id: string; project_code: string; project_name: string; drawn_qty: number;
  }>();

  const base = env.APP_BASE_URL ?? "";
  const byFramework = new Map<string, typeof rows.results>();
  for (const r of rows.results) {
    if (isSandboxId(r.project_id)) continue;
    if (r.alerted_qty != null && r.drawn_qty <= r.alerted_qty + 0.0001) continue; // unchanged since last alert
    byFramework.set(r.po_id, [...(byFramework.get(r.po_id) ?? []), r]);
  }

  for (const [poId, lines] of byFramework) {
    const first = lines[0];
    await emailFrameworkOverdraw(env, FRAMEWORK_OVERDRAW_RECIPIENTS, {
      projectCode: first.project_code, projectName: first.project_name,
      frameworkPoNumber: first.po_number, supplier: first.supplier,
      triggeredByPoNumber: null,
      lines: lines.map((l) => ({ item: l.item, unit: l.unit, frameworkQty: l.framework_qty, drawnQty: l.drawn_qty })),
      link: `${base}/pos/${poId}`,
    });
    await env.DB.batch(
      lines.map((l) => env.DB.prepare("UPDATE po_lines SET framework_overdraw_alerted_qty = ? WHERE id = ?").bind(l.drawn_qty, l.line_id)),
    );
  }
}
