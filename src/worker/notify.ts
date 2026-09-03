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

/** £1,250.00 — grouped, because these figures are read at a glance on a phone. */
function money(n: number): string {
  return `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Quantities are packs, metres and each — trailing zeros just add noise. */
function qty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** How many line items to put in the email before deferring to the app. Long
 *  enough for the overwhelming majority of orders to be judged from the inbox,
 *  short enough that a 200-line framework doesn't become an unreadable email. */
const EMAIL_LINE_CAP = 25;

/**
 * The order's line items as an email-safe table: what is being bought, at what
 * rate, and — for anything that tripped the approval gate — the budget position
 * behind it.
 *
 * This is the actual substance of the decision. The email used to carry only
 * the PO number, supplier, total and reason, so every approval (including a
 * £400 one) meant opening the link on a phone and authenticating through
 * Access to read four lines of text. Approving a purchase order is mostly a
 * judgement about WHAT is being bought.
 *
 * Styles are inline: mail clients strip <style> blocks.
 */
function lineItemsTable(po: PurchaseOrder): string {
  const lines = po.lines ?? [];
  if (lines.length === 0) return "";

  const th = 'style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.04em"';
  const thR = 'style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.04em"';
  const td = 'style="padding:7px 8px;border-bottom:1px solid #f0f0f0;font-size:14px;vertical-align:top"';
  const tdR = 'style="padding:7px 8px;border-bottom:1px solid #f0f0f0;font-size:14px;text-align:right;white-space:nowrap;vertical-align:top"';

  const shown = lines.slice(0, EMAIL_LINE_CAP);
  const rows = shown.map((l) => {
    // Why this line needs a decision, in the same words the app uses on the PO
    // page ("Over priced allowance" / "Outside the priced BOQ").
    const tags: string[] = [];
    if (l.is_unpriced) tags.push('<span style="display:inline-block;background:#fdecd2;color:#8a5a10;font-size:11px;padding:1px 6px;border-radius:9px;margin-left:6px">outside the priced BOQ</span>');
    if (l.is_over_budget) tags.push('<span style="display:inline-block;background:#fbe4e0;color:#a3382a;font-size:11px;padding:1px 6px;border-radius:9px;margin-left:6px">over priced allowance</span>');

    // The allowance this line eats into. Only meaningful on a priced line that
    // went over — that is precisely the number the approver is being asked about.
    let budget = "";
    if (l.is_over_budget && l.priced_qty_at_order != null) {
      const before = l.committed_before ?? 0;
      const over = before + l.qty - l.priced_qty_at_order;
      const unit = l.unit ? ` ${escapeHtml(l.unit)}` : "";
      budget = `<div style="font-size:12px;color:#a3382a;margin-top:3px">`
        + `Allowance ${qty(l.priced_qty_at_order)}${unit} · ${qty(before)}${unit} already committed · this order ${qty(l.qty)}${unit}`
        + (over > 0 ? ` → <b>${qty(over)}${unit} over</b>` : "")
        + `</div>`;
    }

    const sub = [l.manufacturer, l.type].filter(Boolean).map((v) => escapeHtml(String(v))).join(" · ");
    return `<tr>`
      + `<td ${td}>${escapeHtml(l.item)}${tags.join("")}`
      + (sub ? `<div style="font-size:12px;color:#777;margin-top:2px">${sub}</div>` : "")
      + budget
      + `</td>`
      + `<td ${tdR}>${qty(l.qty)}${l.unit ? ` ${escapeHtml(l.unit)}` : ""}</td>`
      + `<td ${tdR}>${money(l.unit_cost)}</td>`
      + `<td ${tdR}>${money(l.line_total)}</td>`
      + `</tr>`;
  }).join("");

  const hidden = lines.length - shown.length;
  const more = hidden > 0
    ? `<tr><td colspan="4" style="padding:7px 8px;font-size:13px;color:#777">… and ${hidden} more line${hidden === 1 ? "" : "s"} — open the order to see them all.</td></tr>`
    : "";

  return `
    <p style="margin:18px 0 6px;font-size:13px;color:#666;text-transform:uppercase;letter-spacing:.06em">
      ${lines.length} line item${lines.length === 1 ? "" : "s"}
    </p>
    <table style="border-collapse:collapse;width:100%;max-width:640px">
      <thead><tr><th ${th}>Item</th><th ${thR}>Qty</th><th ${thR}>Unit cost</th><th ${thR}>Line total</th></tr></thead>
      <tbody>${rows}${more}</tbody>
      <tfoot><tr>
        <td colspan="3" style="padding:8px;text-align:right;font-size:14px;border-top:2px solid #ddd"><b>Total</b></td>
        <td style="padding:8px;text-align:right;font-size:14px;border-top:2px solid #ddd;white-space:nowrap"><b>${money(po.total_value)}</b></td>
      </tr></tfoot>
    </table>
    <p style="margin:6px 0 0;font-size:12px;color:#777">Figures are ex VAT.</p>`;
}

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

  // The project name may arrive equal to the code (callers that only had the
  // code to hand); printing it twice reads as a glitch, so collapse it.
  const projectLabel = project.name && project.name !== project.code
    ? `${project.code} — ${project.name}`
    : project.code;

  // Subject keeps the code and name space-separated (the label's own em-dash
  // would make a second one here); the value is on the end so a phone's
  // notification preview answers "how much" without opening anything.
  const projectSubject = project.name && project.name !== project.code
    ? `${project.code} ${project.name}`
    : project.code;
  const subject = `[${tier} approval] ${po.po_number} — ${projectSubject} · ${money(po.total_value)}`;
  const kv = 'style="padding:3px 14px 3px 0;font-size:14px;color:#555;white-space:nowrap"';
  const kvV = 'style="padding:3px 0;font-size:14px"';
  const html = `
    <p style="font-size:15px">A purchase order needs your approval.</p>
    <table style="border-collapse:collapse">
      <tr><td ${kv}><b>PO number</b></td><td ${kvV}>${escapeHtml(po.po_number)}</td></tr>
      <tr><td ${kv}><b>Project</b></td><td ${kvV}>${escapeHtml(projectLabel)}</td></tr>
      <tr><td ${kv}><b>Supplier</b></td><td ${kvV}>${escapeHtml(po.supplier)}</td></tr>
      <tr><td ${kv}><b>Total value</b></td><td ${kvV}>${money(po.total_value)}</td></tr>
      <tr><td ${kv}><b>Required by</b></td><td ${kvV}>${po.delivery_date ? escapeHtml(po.delivery_date) : "—"}</td></tr>
      <tr><td ${kv}><b>Raised by</b></td><td ${kvV}>${escapeHtml(po.created_by)}</td></tr>
      <tr><td ${kv}><b>Reason</b></td><td ${kvV}>${reason}</td></tr>
    </table>
    ${po.notes ? `<p style="margin:14px 0 0;font-size:14px"><b>Note from ${escapeHtml(po.created_by)}:</b> ${escapeHtml(po.notes)}</p>` : ""}
    ${lineItemsTable(po)}
    <p style="margin:22px 0 0"><a href="${link}" style="font-size:15px">Review and approve →</a></p>
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
 *  usual per-project manager resolution. */
export const FRAMEWORK_OVERDRAW_RECIPIENTS = [
  "tbarber@powergridprojects.net",
  "adouty@powergridprojects.net",
  "hgardner@powergridprojects.net",
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
    /** Set when this approval overturns an earlier rejection — the requester
     *  has already had the rejection email, so say so plainly. */
    overturns?: { rejectedBy: string | null; reason: string | null } | null;
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
  const overturnBlock = args.overturns
    ? `<p>This <b>replaces the earlier rejection</b>${
        args.overturns.rejectedBy ? ` by ${escapeHtml(args.overturns.rejectedBy)}` : ""
      }${
        args.overturns.reason ? ` (&ldquo;${escapeHtml(args.overturns.reason)}&rdquo;)` : ""
      } — the order is approved and can be issued.</p>`
    : "";
  const html = `
    <p>Your purchase order has been <b>${verb}</b> by <b>${escapeHtml(args.actorEmail)}</b>.</p>
    ${overturnBlock}
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
