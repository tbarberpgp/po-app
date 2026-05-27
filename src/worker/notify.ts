import type { Env } from "./env";
import type { ApprovalTier, PurchaseOrder } from "../shared/types";

const tierLabel: Record<ApprovalTier, string> = {
  line_manager: "Line Manager",
  commercial_manager: "Commercial Manager",
  director: "Director",
};

export async function emailApprovers(
  env: Env,
  po: PurchaseOrder,
  project: { code: string; name: string },
  approvers: Array<{ email: string; name: string | null }>,
) {
  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — skipping email notification");
    return;
  }
  if (approvers.length === 0) {
    console.warn(`No approvers configured for tier ${po.approval_tier}`);
    return;
  }
  const baseUrl = env.APP_BASE_URL ?? "";
  const link = `${baseUrl}/approvals/${po.id}`;
  const tier = po.approval_tier ? tierLabel[po.approval_tier] : "Approver";
  const reason =
    po.approval_reason === "unpriced"
      ? "contains materials not in the priced bill of quantities"
      : po.approval_reason === "over_budget"
        ? "exceeds the priced allowance for one or more materials"
        : "exceeds priced allowance and contains unpriced materials";

  const subject = `[${tier} approval] ${po.po_number} — ${project.code} ${project.name}`;
  const html = `
    <p>A purchase order needs your approval.</p>
    <table style="border-collapse:collapse">
      <tr><td><b>PO number</b></td><td>${po.po_number}</td></tr>
      <tr><td><b>Project</b></td><td>${project.code} — ${project.name}</td></tr>
      <tr><td><b>Supplier</b></td><td>${escapeHtml(po.supplier)}</td></tr>
      <tr><td><b>Total value</b></td><td>£${po.total_value.toFixed(2)}</td></tr>
      <tr><td><b>Raised by</b></td><td>${escapeHtml(po.created_by)}</td></tr>
      <tr><td><b>Reason</b></td><td>${reason}</td></tr>
    </table>
    <p><a href="${link}">Review and approve →</a></p>
  `;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: "PO App <po@notifications.powergridprojects.co.uk>",
      to: approvers.map((a) => a.email),
      subject,
      html,
    }),
  }).catch((err) => console.error("Resend error", err));
}

// ── AfP email notifications ─────────────────────────────────────────────

/** Email director approver(s) when an AfP enters pending_approval. */
export async function emailAfpApprovers(
  env: Env,
  args: {
    afp: { id: number; app_number: number; total_invoice: number | null; direction: string };
    project: { code: string; name: string };
    approvers: Array<{ email: string }>;
    raisedBy: string;
  },
) {
  if (!env.RESEND_API_KEY || args.approvers.length === 0) return;
  const link = `${env.APP_BASE_URL ?? ""}/applications/${args.afp.id}`;
  const direction = args.afp.direction === "incoming_labour" ? "Incoming labour AfP" : "Application for Payment";
  const subject = `[Director approval] ${direction} #${args.afp.app_number} — ${args.project.code}`;
  const html = `
    <p>An AfP needs director sign-off before it goes out.</p>
    <table style="border-collapse:collapse">
      <tr><td><b>${direction}</b></td><td>#${args.afp.app_number}</td></tr>
      <tr><td><b>Project</b></td><td>${args.project.code} — ${escapeHtml(args.project.name)}</td></tr>
      <tr><td><b>Total invoice</b></td><td>£${(args.afp.total_invoice ?? 0).toFixed(2)}</td></tr>
      <tr><td><b>Raised by</b></td><td>${escapeHtml(args.raisedBy)}</td></tr>
    </table>
    <p><a href="${link}">Review and approve →</a></p>`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: "AfP App <afp@notifications.powergridprojects.co.uk>",
      to: args.approvers.map((a) => a.email),
      subject,
      html,
    }),
  }).catch((err) => console.error("Resend error (AfP approve req)", err));
}

/** Notify the counterparty when an AfP is approved + sent. */
export async function emailAfpCounterparty(
  env: Env,
  args: {
    afp: { id: number; app_number: number; total_invoice: number | null; period_end: string; direction: string };
    project: { code: string; name: string };
    to: string;
    contactName: string | null;
  },
) {
  if (!env.RESEND_API_KEY) return;
  const link = `${env.APP_BASE_URL ?? ""}/applications/${args.afp.id}`;
  const isOutgoing = args.afp.direction === "outgoing";
  const subject = `${isOutgoing ? "Application for Payment" : "Subcontractor Payment Application acknowledged"} #${args.afp.app_number} — ${args.project.code}`;
  const greeting = args.contactName ? `Dear ${escapeHtml(args.contactName)},` : "Hello,";
  const html = `
    <p>${greeting}</p>
    <p>${isOutgoing
      ? "Please find our Application for Payment for the period ending below."
      : "We acknowledge receipt of your payment application and confirm the recorded values below."}</p>
    <table style="border-collapse:collapse">
      <tr><td><b>Project</b></td><td>${args.project.code} — ${escapeHtml(args.project.name)}</td></tr>
      <tr><td><b>Application No.</b></td><td>#${args.afp.app_number}</td></tr>
      <tr><td><b>Period ending</b></td><td>${args.afp.period_end}</td></tr>
      <tr><td><b>Total invoice</b></td><td>£${(args.afp.total_invoice ?? 0).toFixed(2)}</td></tr>
    </table>
    <p><a href="${link}">View AfP →</a></p>
    <p>— Power Grid Projects Ltd</p>`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: "PowerGrid Projects <afp@notifications.powergridprojects.co.uk>",
      to: [args.to],
      subject,
      html,
    }),
  }).catch((err) => console.error("Resend error (AfP send)", err));
}

/** Notify the AfP raiser when the counterparty certifies. */
export async function emailAfpCertified(
  env: Env,
  args: {
    afp: { id: number; app_number: number; certified_amount: number | null };
    project: { code: string; name: string };
    to: string;
    actor: string;
  },
) {
  if (!env.RESEND_API_KEY) return;
  const link = `${env.APP_BASE_URL ?? ""}/applications/${args.afp.id}`;
  const subject = `AfP #${args.afp.app_number} certified — ${args.project.code}`;
  const html = `
    <p>AfP #${args.afp.app_number} has been certified by ${escapeHtml(args.actor)} at <b>£${(args.afp.certified_amount ?? 0).toFixed(2)}</b>.</p>
    <p><a href="${link}">Open AfP →</a></p>`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: "AfP App <afp@notifications.powergridprojects.co.uk>",
      to: [args.to],
      subject,
      html,
    }),
  }).catch((err) => console.error("Resend error (AfP certified)", err));
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function emailRequesterDecision(
  env: Env,
  args: {
    decision: "approved" | "rejected";
    po: { id: string; po_number: string; supplier: string; total_value: number };
    project: { code: string; name: string };
    requesterEmail: string;
    actorEmail: string;
    reason?: string | null;
  },
) {
  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — skipping requester notification");
    return;
  }
  const baseUrl = env.APP_BASE_URL ?? "";
  const link = `${baseUrl}/pos/${args.po.id}`;
  const verb = args.decision === "approved" ? "approved" : "rejected";
  const subject = `[${verb.toUpperCase()}] ${args.po.po_number} — ${args.project.code} ${args.project.name}`;
  const reasonBlock =
    args.decision === "rejected" && args.reason
      ? `<p><b>Reason:</b> ${escapeHtml(args.reason)}</p>`
      : "";
  const html = `
    <p>Your purchase order has been <b>${verb}</b> by <b>${escapeHtml(args.actorEmail)}</b>.</p>
    <table style="border-collapse:collapse">
      <tr><td><b>PO number</b></td><td>${args.po.po_number}</td></tr>
      <tr><td><b>Project</b></td><td>${args.project.code} — ${args.project.name}</td></tr>
      <tr><td><b>Supplier</b></td><td>${escapeHtml(args.po.supplier)}</td></tr>
      <tr><td><b>Total value</b></td><td>£${args.po.total_value.toFixed(2)}</td></tr>
    </table>
    ${reasonBlock}
    <p><a href="${link}">Open the PO →</a></p>
  `;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: "PO App <po@notifications.powergridprojects.co.uk>",
      to: [args.requesterEmail],
      subject,
      html,
    }),
  }).catch((err) => console.error("Resend error", err));
}
