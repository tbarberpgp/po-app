import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { can, type PermissionSubject } from "../../shared/permissions";
import {
  isAwaitingApproval, isInXero, isReadyToPush, needsApprovalBeforeRelease, readyForRelease,
  type ReleasableInvoice,
} from "../../shared/payment-release";
import { computeInvoiceMatch } from "../routes/invoices";

// Read-only lookups the helpdesk may run for the signed-in user.
//
// These never write, and they return less than the app's own screens would, not
// more: anything money-shaped is withheld from people who couldn't see the
// commercial position anyway. Every value that comes back is DATA the model
// reads — supplier names, PO notes and (for invoices) the subject line and
// sender of an email that arrived from outside the company — so nothing here is
// ever treated as an instruction.

/** The signed-in user as these lookups see them: the permission subject, plus
 *  the identity facts that decide whose queue is whose. Tools that don't ask
 *  "is this mine" need only the role, which is why the tests can still pass a
 *  bare `{ role }`. */
export type HelpdeskActor = PermissionSubject & {
  email?: string | null;
  approver_tiers?: string[] | null;
  can_release_payables?: boolean;
};

const PO_TOOLS: Anthropic.Tool[] = [
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
      "Full state of one purchase order: status, where it is in approval and who can approve it, whether it has been issued, how many deliveries have been checked in against it, the invoices billed against it, and Xero sync/paid state. Use it to answer 'why is this PO stuck / where is it up to'.",
    input_schema: {
      type: "object" as const,
      properties: {
        po_number: { type: "string", description: "Exact PO number, e.g. 'PO-26003-0038'." },
      },
      required: ["po_number"],
    },
  },
  {
    name: "my_work_queue",
    description:
      "What is currently waiting on THIS user: purchase orders they can approve, invoices they can sign off, and orders they raised that haven't cleared approval. Use it for 'what's waiting on me', 'do I need to approve anything', 'what happened to the order I raised'.",
    input_schema: { type: "object" as const, properties: {} },
  },
];

const INVOICE_TOOLS: Anthropic.Tool[] = [
  {
    name: "find_invoices",
    description:
      "Search supplier invoices in Accounts by supplier, invoice number, project, the PO they're billed against, or where they've got to. Returns up to 15 with a one-line state each. Use it when the user names an invoice or asks what's outstanding for a supplier.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Fragment of the invoice number or supplier name, e.g. 'INV2502383' or 'Alumasc'." },
        project_code: { type: "string", description: "Project code, e.g. '26004'." },
        po_number: { type: "string", description: "Only invoices billed against this PO, e.g. 'PO-26003-0038'." },
        stage: {
          type: "string",
          description:
            "Where it has got to: in_progress (still being coded/matched in the Inbox), awaiting_approval (committed, waiting on a release approver), ready_to_push (approved, Accounts hasn't sent it to Xero), in_xero (a bill exists in Xero), dismissed.",
          enum: ["in_progress", "awaiting_approval", "ready_to_push", "in_xero", "dismissed"],
        },
        overdue: { type: "boolean", description: "Only invoices past their due date that are not yet a bill in Xero." },
      },
    },
  },
  {
    name: "get_invoice",
    description:
      "Full state of one supplier invoice: what was billed, which PO it reconciles against, how the 3-way match came out (goods received, price and total variances), where it has got to between arriving and becoming a bill in Xero, who it is waiting on, and the audit trail of who committed/approved it and why. Use it to answer 'has this invoice been paid', 'why is this invoice held', 'what's wrong with this invoice'.",
    input_schema: {
      type: "object" as const,
      properties: {
        invoice_id: { type: "number", description: "The invoice's id, as returned by find_invoices. The most reliable way to ask." },
        invoice_number: { type: "string", description: "The supplier's own invoice number, if the id isn't known." },
        supplier: { type: "string", description: "Supplier name, to narrow an invoice number two suppliers both use." },
      },
    },
  },
];

/** The tools this user may run.
 *
 *  Invoices are the commercial position in its rawest form — what is owed, to
 *  whom, and what hasn't been paid yet — so the Accounts lookups are offered
 *  only to people the app already shows Accounts to. They're withheld rather
 *  than refused at call time so the model never offers a lookup it will then be
 *  told it can't run. Two variants means two cached prompt prefixes, not one;
 *  that is the cost of not having the helpdesk describe invoices to a site
 *  manager before discovering it can't read them. */
export function toolsFor(subject: HelpdeskActor): Anthropic.Tool[] {
  return canSeeInvoices(subject) ? [...PO_TOOLS, ...INVOICE_TOOLS] : PO_TOOLS;
}

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

/** Who may see the Accounts workpiece at all — the same permission that puts
 *  Accounts in the sidebar and gates every invoice route. */
function canSeeInvoices(subject: PermissionSubject): boolean {
  return can(subject, "commercial.view");
}

/** Overheads reveal the company cost base, so they stay admin-only here exactly
 *  as they do on GET /api/invoices. */
function canSeeOverheads(subject: PermissionSubject): boolean {
  return can(subject, "approvers.manage");
}

type InvoiceRow = ReleasableInvoice & {
  id: number;
  supplier_name: string | null;
  matched_supplier_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  net_amount: number | null;
  gross_amount: number | null;
  approved_by: string | null;
  released_by: string | null;
  xero_bill_number: string | null;
  xero_sync_status: string | null;
  matched_po_id: string | null;
  matched_po_number: string | null;
  extracted_po_ref: string | null;
  labour_afp_id: number | null;
  project_code: string | null;
  received_at: string | null;
  created_at: string;
};

const INVOICE_COLS = `i.id, i.status, i.kind, i.nominal_code, i.supplier_name, s.name AS matched_supplier_name,
  i.invoice_number, i.invoice_date, i.due_date, i.currency, i.net_amount, i.gross_amount,
  i.approved_at, i.approved_by, i.released_at, i.released_by,
  i.xero_bill_id, i.xero_bill_number, i.xero_sync_status,
  i.matched_po_id, i.extracted_po_ref, i.labour_afp_id,
  p.code AS project_code, po.po_number AS matched_po_number, i.received_at, i.created_at`;

const INVOICE_FROM = `FROM invoices i
  LEFT JOIN projects p ON p.id = i.project_id
  LEFT JOIN suppliers s ON s.id = i.supplier_id
  LEFT JOIN purchase_orders po ON po.id = i.matched_po_id`;

/**
 * Where an invoice has got to, named the way the Accounts tabs name it.
 *
 * Derived from the shared release predicates rather than from `status`, because
 * `status` reads a stage early: an invoice is 'ready' from the moment someone
 * commits it, long before anyone has signed it off. The words people see on the
 * screen come from the tabs, so they're the words used here.
 */
function invoiceStage(inv: ReleasableInvoice & { labour_afp_id?: number | null }): {
  stage: string; label: string; waiting_on: string;
} {
  if (inv.status === "dismissed") {
    return {
      stage: "dismissed",
      label: "Dismissed",
      waiting_on: inv.labour_afp_id
        ? "Nobody — it was handed to the labour pipeline as a subcontractor application."
        : "Nobody — it was dismissed, so it will not be paid from Accounts.",
    };
  }
  if (isInXero(inv)) {
    return {
      stage: "in_xero",
      label: "Pushed",
      waiting_on: "Nobody in this app — the bill exists in Xero, and Xero decides when it is paid.",
    };
  }
  if (isReadyToPush(inv)) {
    return { stage: "ready_to_push", label: "Ready to push", waiting_on: "Accounts, to push it to Xero." };
  }
  if (isAwaitingApproval(inv)) {
    return { stage: "awaiting_approval", label: "Awaiting approval", waiting_on: "A release approver, to sign it off." };
  }
  return {
    stage: "in_progress",
    label: "Inbox",
    waiting_on: !inv.kind
      ? "Accounts, to say whether it belongs to a job or to overheads."
      : needsApprovalBeforeRelease(inv)
        ? "Accounts, to match it to its PO and commit it for approval."
        : "An Admin, to code it to a nominal account.",
  };
}

/** The slim row every invoice lookup returns. */
function invoiceSummary(r: InvoiceRow) {
  const { stage, label, waiting_on } = invoiceStage(r);
  return {
    invoice_id: r.id,
    invoice_number: r.invoice_number,
    supplier: r.matched_supplier_name || r.supplier_name,
    project: r.project_code,
    kind: r.kind,
    invoice_date: r.invoice_date?.slice(0, 10) ?? null,
    due_date: r.due_date?.slice(0, 10) ?? null,
    currency: r.currency ?? "GBP",
    net: r.net_amount,
    gross: r.gross_amount,
    stage,
    stage_label: label,
    waiting_on,
    matched_po: r.matched_po_number,
    quoted_po_ref: r.matched_po_number ? null : r.extracted_po_ref,
  };
}

/** The stage filter, as SQL. Mirrors the predicates in shared/payment-release
 *  one for one — the same conditions the Accounts tabs count. */
const IN_XERO_SQL = "(i.status = 'pushed' OR i.xero_bill_id IS NOT NULL)";
const COMMITTED_SQL = "(i.approved_at IS NOT NULL OR (i.kind = 'overhead' AND TRIM(COALESCE(i.nominal_code,'')) != ''))";
const STAGE_SQL: Record<string, string> = {
  dismissed: "i.status = 'dismissed'",
  in_xero: `i.status != 'dismissed' AND ${IN_XERO_SQL}`,
  ready_to_push: `i.status != 'dismissed' AND NOT ${IN_XERO_SQL} AND i.released_at IS NOT NULL`,
  awaiting_approval: `i.status != 'dismissed' AND NOT ${IN_XERO_SQL} AND i.released_at IS NULL AND ${COMMITTED_SQL}`,
  in_progress: `i.status != 'dismissed' AND NOT ${IN_XERO_SQL} AND i.released_at IS NULL AND NOT ${COMMITTED_SQL}`,
};

export async function runTool(
  env: Env,
  subject: HelpdeskActor,
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

    // What has been billed against the order, for the question the delivery
    // count on its own can't answer: the order is delivered, so why is the
    // supplier still chasing?
    let billed: unknown = undefined;
    if (canSeeInvoices(subject)) {
      const rows = await env.DB.prepare(
        `SELECT ${INVOICE_COLS} ${INVOICE_FROM}
          WHERE i.matched_po_id = ? AND i.status != 'dismissed'
            ${canSeeOverheads(subject) ? "" : "AND (i.kind IS NULL OR i.kind != 'overhead')"}
          ORDER BY COALESCE(i.invoice_date, i.received_at, i.created_at) DESC LIMIT 15`,
      ).bind(po.id).all<InvoiceRow>();
      billed = rows.results.map(invoiceSummary);
    }

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
      ...(billed === undefined ? {} : { invoices_billed_against_it: billed }),
      xero: { sync_status: po.xero_sync_status, sync_error: po.xero_sync_error, paid_on: po.paid_at?.slice(0, 10) ?? null },
    };
  }

  if (name === "my_work_queue") {
    const email = (subject.email ?? "").toLowerCase();
    const tiers = subject.approver_tiers ?? [];
    const isSuper = subject.role === "superadmin";
    const out: Record<string, unknown> = {};

    // Approvals waiting on this user. A superadmin sees every tier, which is
    // what the sidebar badge counts.
    if (tiers.length || isSuper) {
      // Filtered in SQL, not after the fact: a page of the 25 oldest pending
      // orders can be all one tier, which would report "nothing waiting on you"
      // to someone with three orders in their own tier behind them.
      const tierSql = isSuper ? "" : ` AND po.approval_tier IN (${tiers.map(() => "?").join(",")})`;
      const rows = await env.DB.prepare(
        `SELECT ${PO_COLS} FROM purchase_orders po JOIN projects p ON p.id = po.project_id
          WHERE po.status = 'pending_approval' AND p.deleted_at IS NULL${tierSql}
          ORDER BY po.created_at ASC LIMIT 25`,
      ).bind(...(isSuper ? [] : tiers)).all<PoRow>();
      out.purchase_orders_i_can_approve = rows.results
        .filter((r) => isSuper || (r.approval_tier && tiers.includes(r.approval_tier)))
        .map((r) => ({
          po_number: r.po_number, project: r.project_code, supplier: r.supplier,
          tier: r.approval_tier, reason: r.approval_reason, waiting_since: r.created_at.slice(0, 10),
          ...(money ? { total_value_gbp: r.total_value } : {}),
        }));
    } else {
      out.purchase_orders_i_can_approve = "Not an approver — PO sign-offs don't come to this user.";
    }

    // Invoices waiting on a release signature. Shown to everyone who can see
    // Accounts, not only to the releasers: knowing what the queue is waiting on
    // is how Accounts chases it.
    if (canSeeInvoices(subject)) {
      const rows = await env.DB.prepare(
        `SELECT ${INVOICE_COLS} ${INVOICE_FROM}
          WHERE ${STAGE_SQL.awaiting_approval}
            ${canSeeOverheads(subject) ? "" : "AND (i.kind IS NULL OR i.kind != 'overhead')"}
          ORDER BY i.approved_at ASC LIMIT 25`,
      ).all<InvoiceRow>();
      out.invoices_awaiting_release_approval = {
        can_i_sign_these_off: !!subject.can_release_payables,
        count: rows.results.length,
        invoices: rows.results.map(invoiceSummary),
      };
    }

    // The other half of "what's waiting on me": what this user set in motion
    // and hasn't cleared.
    if (email) {
      const mine = await env.DB.prepare(
        `SELECT ${PO_COLS} FROM purchase_orders po JOIN projects p ON p.id = po.project_id
          WHERE lower(po.created_by) = ? AND po.status IN ('draft', 'pending_approval', 'rejected')
            AND p.deleted_at IS NULL
          ORDER BY po.created_at DESC LIMIT 25`,
      ).bind(email).all<PoRow>();
      out.purchase_orders_i_raised_not_yet_cleared = mine.results.map((r) => ({
        po_number: r.po_number, project: r.project_code, supplier: r.supplier, status: r.status,
        tier: r.approval_tier, rejection_reason: r.rejection_reason, raised_on: r.created_at.slice(0, 10),
        ...(money ? { total_value_gbp: r.total_value } : {}),
      }));
    }
    return out;
  }

  if (name === "find_invoices" || name === "get_invoice") {
    // Defence in depth: `toolsFor` already withholds these, so reaching here
    // means the model invented the call.
    if (!canSeeInvoices(subject)) {
      return { error: "Invoices are part of the commercial workspace, and this user doesn't have access to it." };
    }
  }

  if (name === "find_invoices") {
    const where: string[] = [];
    const binds: unknown[] = [];
    const q = str("query");
    if (q) {
      where.push("(i.invoice_number LIKE ? OR i.supplier_name LIKE ? OR s.name LIKE ?)");
      binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (str("project_code")) { where.push("p.code = ?"); binds.push(str("project_code")); }
    if (str("po_number")) {
      where.push("(upper(po.po_number) = upper(?) OR upper(COALESCE(i.extracted_po_ref, '')) LIKE upper(?))");
      binds.push(str("po_number"), `%${str("po_number")}%`);
    }
    const stage = str("stage");
    if (stage && STAGE_SQL[stage]) where.push(STAGE_SQL[stage]);
    else if (!stage) where.push("i.status != 'dismissed'");
    if (input.overdue === true) {
      where.push(`i.due_date IS NOT NULL AND i.due_date < date('now') AND NOT ${IN_XERO_SQL}`);
    }
    if (!canSeeOverheads(subject)) where.push("(i.kind IS NULL OR i.kind != 'overhead')");
    const rows = await env.DB.prepare(
      `SELECT ${INVOICE_COLS} ${INVOICE_FROM}
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY COALESCE(i.invoice_date, i.received_at, i.created_at) DESC LIMIT 15`,
    ).bind(...binds).all<InvoiceRow>();
    return rows.results.map(invoiceSummary);
  }

  if (name === "get_invoice") {
    const id = typeof input.invoice_id === "number" ? input.invoice_id : null;
    const num = str("invoice_number");
    if (id == null && !num) return { error: "Give either an invoice_id or an invoice_number." };

    const where: string[] = [];
    const binds: unknown[] = [];
    if (id != null) { where.push("i.id = ?"); binds.push(id); }
    else {
      where.push("upper(COALESCE(i.invoice_number, '')) = upper(?)");
      binds.push(num);
      if (str("supplier")) {
        where.push("(i.supplier_name LIKE ? OR s.name LIKE ?)");
        binds.push(`%${str("supplier")}%`, `%${str("supplier")}%`);
      }
    }
    const found = await env.DB.prepare(
      `SELECT ${INVOICE_COLS}, i.project_id, i.sender_email, i.subject, i.source, i.notes,
              i.approval_note, i.release_note, i.lines_json, i.extract_error,
              i.vat_amount, i.xero_sync_error, s.payment_terms AS supplier_payment_terms
         ${INVOICE_FROM}
        WHERE ${where.join(" AND ")}
        ORDER BY COALESCE(i.invoice_date, i.received_at, i.created_at) DESC LIMIT 5`,
    ).bind(...binds).all<InvoiceRow & Record<string, unknown>>();

    const visible = found.results.filter((r) => canSeeOverheads(subject) || r.kind !== "overhead");
    if (!visible.length) {
      if (found.results.length) return { error: "That invoice is an overhead, and overheads are admin-only." };
      return { error: id != null ? `No invoice with id ${id}.` : `No invoice numbered ${num}.` };
    }
    if (visible.length > 1) {
      return {
        ambiguous: `${visible.length} invoices carry that number — ask which supplier, then look it up by invoice_id.`,
        candidates: visible.map(invoiceSummary),
      };
    }
    const inv = visible[0];
    const { stage, label, waiting_on } = invoiceStage(inv);

    // Who signs it off, named, when that's what it's waiting for. The release
    // list is identity, not a role, so there is nothing else to point at.
    let releasers: string[] = [];
    if (stage === "awaiting_approval") {
      try {
        const rows = await env.DB.prepare(
          "SELECT COALESCE(name, email) AS who FROM release_approvers ORDER BY name",
        ).all<{ who: string }>();
        releasers = rows.results.map((r) => r.who);
      } catch { /* migration 0118 not applied here; say nothing rather than guess */ }
    }

    // The 3-way match, for a project invoice that hasn't already become a bill.
    // This is the expensive lookup in the file (it ranks every live order), so
    // it runs only where its answer can still change anything.
    let match: unknown = null;
    if (inv.kind === "project" && !isInXero(inv)) {
      try {
        const m = await computeInvoiceMatch(env, inv as unknown as Record<string, unknown>);
        const flags = new Map<string, number>();
        for (const l of m.lines) for (const f of l.flags) flags.set(f, (flags.get(f) ?? 0) + 1);
        const crossJob = m.matched_po && inv.project_code && m.matched_po.project_code !== inv.project_code
          ? `Coded to job ${inv.project_code} but ${m.matched_po.po_number} is an order on job ${m.matched_po.project_code}.`
          : null;
        match = {
          status: m.match_status,
          matched_po: m.matched_po?.po_number ?? null,
          matched_po_project: m.matched_po?.project_code ?? null,
          po_is_confirmed_by_a_person: !!inv.matched_po_id,
          lines_total: m.lines.length,
          lines_not_linked_to_a_po_line: m.lines.filter((l) => !l.po_line_id).length,
          flag_counts: Object.fromEntries(flags),
          deliveries_logged_against_the_po: m.deliveries.length,
          also_billed_on_this_po_by_other_invoices: "po_billed_other" in m ? m.po_billed_other : 0,
          // The one thing a typed reason can't clear: the invoice is coded to
          // one job and its order lives on another, so approving would post the
          // cost to the wrong job in Xero. The gate reads the STORED match, so
          // a merely suggested order is a warning about a choice nobody has
          // made yet — not a refusal anyone is currently hitting.
          cross_job_block: crossJob
            ? (inv.matched_po_id
              ? `${crossJob} Approval is refused until one of them is corrected — no typed reason clears this.`
              : `${crossJob} It isn't blocking anything yet because nobody has confirmed that order as the match.`)
            : null,
        };
      } catch (e) {
        console.error("helpdesk invoice match failed", inv.id, e);
        match = { error: "The 3-way match couldn't be worked out for this invoice." };
      }
    }

    const history = await env.DB.prepare(
      `SELECT action, actor, created_at, details FROM audit_log
        WHERE entity_type = 'invoice' AND entity_id = ? ORDER BY created_at DESC, id DESC LIMIT 12`,
    ).bind(String(inv.id)).all<{ action: string; actor: string; created_at: string; details: string | null }>();

    let lineCount: number | null = null;
    try { lineCount = inv.lines_json ? (JSON.parse(String(inv.lines_json)) as unknown[]).length : 0; } catch { lineCount = null; }

    return {
      ...invoiceSummary(inv),
      vat: (inv as Record<string, unknown>).vat_amount ?? null,
      lines_on_the_invoice: lineCount,
      arrived: {
        how: inv.source,
        from: inv.sender_email ?? null,
        email_subject: inv.subject ?? null,
        received_on: (inv.received_at ?? inv.created_at)?.slice(0, 10) ?? null,
        extraction_problem: inv.extract_error ?? null,
      },
      supplier_payment_terms: inv.supplier_payment_terms ?? null,
      stage_detail: { stage, label, waiting_on, ...(releasers.length ? { who_signs_it_off: releasers } : {}) },
      progress: {
        committed_for_approval_by: inv.approved_by,
        committed_on: inv.approved_at?.slice(0, 10) ?? null,
        // Why it was committed despite flags, when a reason was typed. This is
        // the field that explains most "it went through anyway" questions.
        reason_given_when_committing: inv.approval_note ?? null,
        approved_for_payment_by: inv.released_by,
        approved_on: inv.released_at?.slice(0, 10) ?? null,
        approval_note: inv.release_note ?? null,
        still_needs: readyForRelease(inv) ? null
          : (needsApprovalBeforeRelease(inv) ? "matching and committing for approval" : "a nominal code"),
      },
      match,
      notes: inv.notes ?? null,
      xero: { bill_number: inv.xero_bill_number, sync_status: inv.xero_sync_status, sync_error: (inv as Record<string, unknown>).xero_sync_error ?? null },
      history: history.results.map((h) => ({
        action: h.action, by: h.actor, on: h.created_at.slice(0, 10),
        details: h.details?.slice(0, 200) ?? null,
      })),
    };
  }

  return { error: `Unknown tool ${name}.` };
}
