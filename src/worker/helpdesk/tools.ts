import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { can, type PermissionSubject } from "../../shared/permissions";

// Read-only lookups the helpdesk may run for the signed-in user.
//
// These never write, and they return less than the app's own screens would, not
// more: anything money-shaped is withheld from people who couldn't see the
// commercial position anyway. Every value that comes back is DATA the model
// reads — supplier names and PO notes are typed by outsiders — so nothing here
// is ever treated as an instruction.

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "find_purchase_orders",
    description:
      "Search purchase orders by PO number fragment, supplier name, project code and/or status. Returns up to 15 most recent matches with a one-line state each. Use it when the user describes an order without giving its exact number.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Fragment of the PO number or supplier name, e.g. '26004-012' or 'Alumasc'." },
        project_code: { type: "string", description: "Project code, e.g. '26004'." },
        status: {
          type: "string",
          enum: ["draft", "pending_approval", "approved", "rejected", "issued"],
        },
      },
    },
  },
  {
    name: "get_purchase_order",
    description:
      "Full state of one purchase order: status, where it is in approval and who can approve it, whether it has been issued, how many deliveries have been checked in against it, and Xero sync/paid state. Use it to answer 'why is this PO stuck / where is it up to'.",
    input_schema: {
      type: "object" as const,
      properties: {
        po_number: { type: "string", description: "Exact PO number, e.g. 'PO-26003-0038'." },
      },
      required: ["po_number"],
    },
  },
];

type PoRow = {
  id: string;
  po_number: string;
  supplier: string;
  status: string;
  order_type: string | null;
  category: string | null;
  requires_approval: number;
  approval_tier: string | null;
  approval_reason: string | null;
  total_value: number;
  created_at: string;
  created_by: string;
  approved_at: string | null;
  approved_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  issued_at: string | null;
  paid_at: string | null;
  xero_sync_status: string | null;
  xero_sync_error: string | null;
  project_code: string;
  project_name: string;
};

const PO_COLS = `po.id, po.po_number, po.supplier, po.status, po.order_type, po.category,
  po.requires_approval, po.approval_tier, po.approval_reason, po.total_value,
  po.created_at, po.created_by, po.approved_at, po.approved_by, po.rejected_at,
  po.rejected_by, po.rejection_reason, po.issued_at, po.paid_at,
  po.xero_sync_status, po.xero_sync_error, p.code AS project_code, p.name AS project_name`;

/** Who may see order values. Tighter than GET /api/pos, which shows totals to
 *  every signed-in user: a chat answer is easy to paste around. */
function canSeeMoney(subject: PermissionSubject): boolean {
  return can(subject, "commercial.view") || can(subject, "pos.create");
}

export async function runTool(
  env: Env,
  subject: PermissionSubject,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const money = canSeeMoney(subject);
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string).trim() : "");

  if (name === "find_purchase_orders") {
    const where = ["po.status != 'deleted'", "p.deleted_at IS NULL"];
    const binds: unknown[] = [];
    const q = str("query");
    if (q) {
      where.push("(po.po_number LIKE ? OR po.supplier LIKE ?)");
      binds.push(`%${q}%`, `%${q}%`);
    }
    if (str("project_code")) { where.push("p.code = ?"); binds.push(str("project_code")); }
    if (str("status")) { where.push("po.status = ?"); binds.push(str("status")); }
    const rows = await env.DB.prepare(
      `SELECT ${PO_COLS} FROM purchase_orders po JOIN projects p ON p.id = po.project_id
        WHERE ${where.join(" AND ")} ORDER BY po.created_at DESC LIMIT 15`,
    ).bind(...binds).all<PoRow>();
    return rows.results.map((r) => ({
      po_number: r.po_number,
      project: r.project_code,
      supplier: r.supplier,
      status: r.status,
      created_at: r.created_at.slice(0, 10),
      ...(money ? { total_value_gbp: r.total_value } : {}),
    }));
  }

  if (name === "get_purchase_order") {
    const ref = str("po_number");
    const po = await env.DB.prepare(
      `SELECT ${PO_COLS} FROM purchase_orders po JOIN projects p ON p.id = po.project_id
        WHERE upper(po.po_number) = upper(?) AND po.status != 'deleted' AND p.deleted_at IS NULL`,
    ).bind(ref).first<PoRow>();
    if (!po) return { error: `No purchase order numbered ${ref}.` };

    // The approve route accepts anyone holding the PO's tier, on any project;
    // the project's own approvers are only who gets the email. So "who can
    // approve" is the whole tier.
    let approvers: string[] = [];
    if (po.status === "pending_approval" && po.approval_tier) {
      const rows = await env.DB.prepare(
        "SELECT DISTINCT COALESCE(name, email) AS who FROM approvers WHERE tier = ?",
      ).bind(po.approval_tier).all<{ who: string }>();
      approvers = rows.results.map((r) => r.who);
    }

    const del = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(delivered_at) AS latest, MAX(completes_po) AS any_complete
         FROM site_deliveries WHERE po_id = ? OR po_number = ?`,
    ).bind(po.id, po.po_number).first<{ n: number; latest: string | null; any_complete: number | null }>();

    return {
      po_number: po.po_number,
      project: `${po.project_code} ${po.project_name}`,
      supplier: po.supplier,
      status: po.status,
      order_type: po.order_type,
      category: po.category,
      raised_by: po.created_by,
      raised_on: po.created_at.slice(0, 10),
      ...(money ? { total_value_gbp: po.total_value } : {}),
      approval: {
        needed: !!po.requires_approval,
        tier: po.approval_tier,
        reason: po.approval_reason,
        can_approve: approvers,
        approved_by: po.approved_by,
        approved_on: po.approved_at?.slice(0, 10) ?? null,
        rejected_by: po.rejected_by,
        rejection_reason: po.rejection_reason,
      },
      issued_on: po.issued_at?.slice(0, 10) ?? null,
      deliveries: {
        checked_in: del?.n ?? 0,
        latest: del?.latest?.slice(0, 10) ?? null,
        marked_complete: !!del?.any_complete,
      },
      xero: { sync_status: po.xero_sync_status, sync_error: po.xero_sync_error, paid_on: po.paid_at?.slice(0, 10) ?? null },
    };
  }

  return { error: `Unknown tool ${name}.` };
}
