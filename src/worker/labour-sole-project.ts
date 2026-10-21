// The project a labour email is for, when the email doesn't say.
//
// Subbies rarely put a project code in the subject or on the invoice, so their
// emails parked in the inbound tray for someone to assign by hand — which is
// how hand uploads crept back in. Most subbies work one site at a time: when
// every application a subbie has sent recently is on the same live project,
// that's where this one goes. Two or more projects, or none, still park.
import type { Env } from "./env";

/** How far back "recently" reaches. Long enough to span a gap between invoices,
 *  short enough that a finished job stops counting. */
export const SOLE_PROJECT_DAYS = 120;

/** The distinct live projects a subcontractor has sent labour applications on
 *  since `?2` (an ISO date). Drafts don't count: nobody has confirmed them. */
export const SUBBIE_RECENT_PROJECTS = `
  SELECT DISTINCT p.id, p.code, p.name
    FROM applications_for_payment a
    JOIN projects p ON p.id = a.project_id
   WHERE a.direction = 'incoming_labour'
     AND a.counterparty_supplier_id = ?1
     AND a.status != 'draft'
     AND COALESCE(a.submitted_at, a.created_at) >= ?2
     AND p.deleted_at IS NULL`;

export type SoleProject = { id: string; code: string; name: string };

export async function soleLabourProject(env: Env, supplierId: number, now = new Date()): Promise<SoleProject | null> {
  const since = new Date(now.getTime() - SOLE_PROJECT_DAYS * 86_400_000).toISOString();
  const rows = await env.DB.prepare(SUBBIE_RECENT_PROJECTS).bind(supplierId, since).all<SoleProject>();
  return rows.results.length === 1 ? rows.results[0] : null;
}
