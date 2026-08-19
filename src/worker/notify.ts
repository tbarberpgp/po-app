import type { Env } from "./env";
import type { ApprovalTier, PurchaseOrder } from "../shared/types";

/** Single configurable sender for all outbound email. Set the RESEND_FROM
 *  secret to a verified Resend domain; falls back to the legacy address. */
function resendFrom(env: Env): string {
  return env.RESEND_FROM || "PowerGrid Projects <afp@notifications.powergridprojects.co.uk>";
}

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
      <tr><td><b>PO number</b></td><td>${escapeHtml(po.po_number)}</td></tr>
      <tr><td><b>Project</b></td><td>${escapeHtml(project.code)} — ${escapeHtml(project.name)}</td></tr>
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
      from: resendFrom(env),
      to: approvers.map((a) => a.email),
      subject,
      html,
    }),
  }).catch((err) => console.error("Resend error", err));
}

/** Remind the PM + commercial manager that hired plant is due to be off-hired. */
export async function emailPlantOffHire(
  env: Env,
  to: string[],
  info: { projectCode: string; projectName: string; item: string; supplier: string | null; offHireDate: string; daysOut: number; poNumber: string | null; link: string },
) {
  if (!env.RESEND_API_KEY) { console.warn("RESEND_API_KEY not set — skipping plant off-hire email"); return; }
  const recipients = [...new Set(to.filter((e) => e && e.includes("@")))];
  if (recipients.length === 0) { console.warn("No off-hire recipients for plant on", info.projectCode); return; }
  const when = info.daysOut <= 0 ? "is due to be off-hired today" : `is due to be off-hired in ${info.daysOut} day${info.daysOut === 1 ? "" : "s"}`;
  const subject = `[Off-hire] ${escapeHtml(info.item)} — ${info.projectCode} ${info.daysOut <= 0 ? "due today" : `in ${info.daysOut}d`}`;
  const html = `
    <p><b>${escapeHtml(info.item)}</b> on <b>${info.projectCode} — ${escapeHtml(info.projectName)}</b> ${when}.</p>
    <table style="border-collapse:collapse">
      <tr><td><b>Item</b></td><td>${escapeHtml(info.item)}</td></tr>
      ${info.supplier ? `<tr><td><b>Supplier</b></td><td>${escapeHtml(info.supplier)}</td></tr>` : ""}
      <tr><td><b>Off-hire date</b></td><td>${escapeHtml(info.offHireDate)}</td></tr>
      ${info.poNumber ? `<tr><td><b>PO</b></td><td>${escapeHtml(info.poNumber)}</td></tr>` : ""}
    </table>
    <p>If it's no longer needed, arrange collection and mark it off-hired so the prelims accrual stops.</p>
    <p><a href="${info.link}">Open the project →</a></p>
  `;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: resendFrom(env), to: recipients, subject, html }),
  }).catch((err) => console.error("Resend error", err));
}

/** Fixed recipients for framework-overdraw alerts. None of these sit in the
 *  approvers table or as a project manager email, so there's no table lookup
 *  to drive this off — it's a deliberate, requested hardcode rather than the
 *  usual per-project manager resolution.
 *  TEMP: narrowed to nsantosa only for a one-off real-send test — revert to
 *  the full four-person list right after (see git history for the exact
 *  restore) so tbarber/adouty/hgardner still get Monday's real digest. */
export const FRAMEWORK_OVERDRAW_RECIPIENTS = [
  "nsantosa@powergridprojects.net",
];

/** A framework PO with one or more lines over their agreed quantity and/or
 *  cost. Sent both in real time — the call-off that tips a line over, the
 *  moment it happens (alertFrameworkOverdraw in pos.ts) — and from the weekly
 *  Monday digest (runFrameworkOverdrawDigest in cron.ts) for anything still
 *  unresolved. Qty and value are reported separately because a call-off can
 *  stay within the agreed qty but still blow the budget on a higher unit
 *  cost, or vice versa. */
export async function emailFrameworkOverdraw(
  env: Env,
  to: string[],
  info: {
    projectCode: string;
    projectName: string;
    frameworkPoNumber: string;
    supplier: string;
    triggeredByPoNumber: string | null;
    lines: Array<{
      item: string; unit: string;
      frameworkQty: number; drawnQty: number; overQty: boolean;
      frameworkValue: number; drawnValue: number; overValue: boolean;
    }>;
    link: string;
  },
) {
  if (!env.RESEND_API_KEY) { console.warn("RESEND_API_KEY not set — skipping framework overdraw email"); return; }
  const recipients = [...new Set(to.filter((e) => e && e.includes("@")))];
  if (recipients.length === 0) return;
  const plural = info.lines.length === 1 ? "line has" : "lines have";
  const kind = info.lines.every((l) => l.overValue && !l.overQty) ? "cost"
    : info.lines.every((l) => l.overQty && !l.overValue) ? "qty"
    : "qty/cost";
  const subject = `[Overdrawn] ${info.frameworkPoNumber} — ${info.projectCode} ${info.lines.length} framework ${plural} exceeded its agreed ${kind}`;
  const rows = info.lines
    .map((l) => {
      const qtyCell = l.overQty
        ? `<td style="color:#b91c1c">${l.frameworkQty} ${escapeHtml(l.unit)} → <b>${l.drawnQty} ${escapeHtml(l.unit)}</b></td>`
        : `<td>${l.frameworkQty} ${escapeHtml(l.unit)} → ${l.drawnQty} ${escapeHtml(l.unit)}</td>`;
      const valueCell = l.overValue
        ? `<td style="color:#b91c1c">£${l.frameworkValue.toFixed(2)} → <b>£${l.drawnValue.toFixed(2)}</b></td>`
        : `<td>£${l.frameworkValue.toFixed(2)} → £${l.drawnValue.toFixed(2)}</td>`;
      return `<tr><td>${escapeHtml(l.item)}</td>${qtyCell}${valueCell}</tr>`;
    })
    .join("");
  const html = `
    <p>${info.lines.length} line${info.lines.length === 1 ? "" : "s"} on framework <b>${escapeHtml(info.frameworkPoNumber)}</b>
       (${escapeHtml(info.projectCode)} — ${escapeHtml(info.projectName)}, supplier ${escapeHtml(info.supplier)})
       ${info.lines.length === 1 ? "has" : "have"} been called off past the agreed allowance.</p>
    ${info.triggeredByPoNumber ? `<p>Triggered by call-off <b>${escapeHtml(info.triggeredByPoNumber)}</b>.</p>` : ""}
    <table style="border-collapse:collapse" border="1" cellpadding="4">
      <tr><th>Item</th><th>Qty: agreed → called off</th><th>Value: agreed → spent</th></tr>
      ${rows}
    </table>
    <p style="color:#666;font-size:13px">Red highlights the dimension(s) actually over — an item can be within qty but over on cost (a higher unit price than the framework line), or vice versa.</p>
    <p><a href="${info.link}">Open the framework →</a></p>
  `;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: resendFrom(env), to: recipients, subject, html }),
  }).catch((err) => console.error("Resend error (framework overdraw)", err));
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
      <tr><td><b>Project</b></td><td>${escapeHtml(args.project.code)} — ${escapeHtml(args.project.name)}</td></tr>
      <tr><td><b>Total invoice</b></td><td>£${(args.afp.total_invoice ?? 0).toFixed(2)}</td></tr>
      <tr><td><b>Raised by</b></td><td>${escapeHtml(args.raisedBy)}</td></tr>
    </table>
    <p><a href="${link}">Review and approve →</a></p>`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: resendFrom(env),
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
      <tr><td><b>Project</b></td><td>${escapeHtml(args.project.code)} — ${escapeHtml(args.project.name)}</td></tr>
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
      from: resendFrom(env),
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
      from: resendFrom(env),
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
      <tr><td><b>PO number</b></td><td>${escapeHtml(args.po.po_number)}</td></tr>
      <tr><td><b>Project</b></td><td>${escapeHtml(args.project.code)} — ${escapeHtml(args.project.name)}</td></tr>
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
      from: resendFrom(env),
      to: [args.requesterEmail],
      subject,
      html,
    }),
  }).catch((err) => console.error("Resend error", err));
}
