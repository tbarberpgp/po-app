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
