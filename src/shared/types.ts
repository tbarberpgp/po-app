import type { VarianceReport } from "./delivery-variance";
export type { VarianceReport, VarianceIssue } from "./delivery-variance";
import type { MatchIssue, MatchSummary } from "./line-match";

export type Project = {
  /** Client payment terms for this contract, e.g. "45 days from application". */
  payment_terms?: string | null;
  /** How often we apply for payment: weekly | biweekly | monthly. */
  application_cadence?: string | null;
  id: string;
  code: string;
  name: string;
  client: string | null;
  client_email: string | null;
  client_contact_name: string | null;
  site_manager_email?: string | null;
  /** Recipients for plant off-hire reminders. PM falls back to site_manager_email. */
  project_manager_email?: string | null;
  commercial_manager_email?: string | null;
  currency: string;
  retention_pct?: number;
  // Per-direction commercial terms for Applications for Payment.
  client_vat_pct?: number;
  client_retention_pct?: number;
  labour_vat_pct?: number;
  labour_retention_pct?: number;
  delivery_address: string | null;
  site_contact_name: string | null;
  site_contact_phone: string | null;
  delivery_instructions: string | null;
  valuation_schedule_filename: string | null;
  valuation_schedule_uploaded_at: string | null;
  valuation_schedule_uploaded_by: string | null;
  // Lifecycle: non-null when the project has been marked complete (still editable).
  completed_at?: string | null;
  completed_by?: string | null;
  /** 1 for the walled-off demo/sandbox project (derived from id, never persisted). */
  is_sandbox?: number;
  created_at: string;
  created_by: string;
};

export type ValuationEntryType = "application" | "due" | "notice" | "final_payment";

export type ValuationScheduleEntry = {
  id: number;
  app_number: number | null;
  entry_type: ValuationEntryType;
  date: string;
  notes: string | null;
  created_at: string;
  created_by: string;
};

export type PortfolioCalendarItem = {
  date: string;
  project_id: string;
  project_code: string;
  project_name: string;
  kind: string;             // "scheduled-<type>" | "afp-period-end"
  label: string;
  app_number: number | null;
  afp_id?: number;
  status?: string;
};

export type Material = {
  id: number;
  snapshot_id: number;
  item: string;
  type: string;                       // human-readable element/section label
  element_code: string | null;        // numeric code from new-format pricing sheets (col B)
  manufacturer: string | null;
  pack_qty: number | null;
  pack_unit: string | null;
  cost: number | null;
  cost_unit: string | null;
  coverage_qty: number | null;
  coverage_unit: string | null;
  waste_pct: number | null;
  unit_rate: number | null;
  rate_unit: string | null;
  total_qty: number | null;
  total_qty_unit: string | null;
  total_units: number | null;
  total_units_unit: string | null;
  material_total_cost: number | null;
  labour_unit_cost: number | null;   // agreed labour £ per unit (col S in v2)
  labour_total_cost: number | null;  // agreed labour £ for the whole line (col Z in v2)
};

export type MaterialSubstitutionKind = "like_for_like" | "equivalent_spec" | "variation";

/** Joined onto a material row when an active substitution exists. */
export type MaterialActiveSubstitution = {
  sub_id: number;
  sub_kind: MaterialSubstitutionKind;
  sub_item: string;
  sub_manufacturer: string | null;
  sub_supplier: string | null;
  sub_cost: number | null;
  sub_unit: string | null;
  sub_total_units: number | null;
  sub_product_id: number | null;
  sub_quote_line_id: number | null;
  sub_reason: string | null;
  sub_created_at: string;
  sub_created_by: string;
};

export type MaterialWithCommitment = Material & {
  committed_qty: number;          // reserved: frameworks + standard POs (excludes call-offs) + unit-equivalent of coded costs (£ / rate)
  /** Raw £ of PO lines coded to this budget line after the fact (retro POs)
   *  under different wording. Informational — its unit-equivalent is already
   *  folded into committed_qty. */
  assigned_committed_value?: number;
  called_off_qty?: number;        // of the reserved amount, how much is actually called off
  framework_reserved_qty?: number; // how much of committed_qty sits on framework orders
  delivered_qty?: number;         // received on site to date (apportioned from PO deliveries)
  /** Whole line omitted from this job — excluded from rollups, hidden by default. */
  omitted?: number | boolean;
  /** Partial omission: this many units removed from the budgeted quantity
   *  (line stays visible; budget figures use total_units − omitted_qty). */
  omitted_qty?: number | null;
  remaining_qty: number | null;
  product_id?: number | null;
  product_element_code?: string | null;  // when linked to a master product
  /** Joined from elements table when element_code is set — canonical name for display. */
  element_name?: string | null;
  /** When the pricing workbook behind this line was uploaded — the only "added"
   *  date a priced material has, since materials rows carry no timestamp. */
  snapshot_uploaded_at?: string | null;
  /** Last order raised against this line, dated by the PO (po_lines has no
   *  timestamp, so an amendment reads as its order's date). */
  last_ordered_at?: string | null;
  /** When a quote price was last applied to this line. */
  live_price_applied_at?: string | null;
  /** Latest applied/approved quote-driven unit price for this material on this project. */
  live_unit_price?: number | null;
  /** Supplier name behind the live price, when applicable. */
  live_supplier_name?: string | null;
  /** Number of pending price approvals for this material — surfaced on the row. */
  pending_price_count?: number;
  /** Joined fields from the active substitution, if any. Null when no swap is in effect. */
  sub_id?: number | null;
  sub_kind?: MaterialSubstitutionKind | null;
  sub_item?: string | null;
  sub_manufacturer?: string | null;
  sub_supplier?: string | null;
  sub_cost?: number | null;
  sub_unit?: string | null;
  sub_total_units?: number | null;
  /** Quantity substituted (part-sub). null/equal-to-total = whole swap. */
  sub_units?: number | null;
  sub_product_id?: number | null;
  sub_quote_line_id?: number | null;
  sub_reason?: string | null;
  sub_created_at?: string | null;
  sub_created_by?: string | null;
  /** A PART substitution proposed for this material, awaiting approval (not yet effective). */
  pending_sub_id?: number | null;
  pending_sub_item?: string | null;
  pending_sub_manufacturer?: string | null;
  pending_sub_supplier?: string | null;
  pending_sub_cost?: number | null;
  pending_sub_unit?: string | null;
  pending_sub_units?: number | null;
  pending_sub_kind?: MaterialSubstitutionKind | null;
  pending_sub_tier?: ApprovalTier | null;
  pending_sub_by?: string | null;
};

/** A material that exists only on this project's purchase orders — ordered
 *  against the job but absent from the priced BOQ, so the pricing-snapshot
 *  list can't show it. Aggregated per item across every live PO, which is why
 *  it carries its own quantities rather than reusing MaterialWithCommitment:
 *  there is no budget line behind it, and its £ is already reported once as
 *  the project's unpriced spend. */
export type OffBoqMaterial = {
  /** Lowercased item wording + supplier, NUL-separated — what the rows are
   *  grouped by, and a stable key. The supplier is part of it because an item
   *  name alone is not an identity: every supplier bills "Carriage". */
  item_key: string;
  /** Wording from the most recent order. */
  item: string;
  type: string | null;
  /** The PO line's manufacturer, falling back to the PO's supplier. */
  manufacturer: string | null;
  unit: string | null;
  /** Rate actually paid, weighted across the orders below. */
  unit_cost: number;
  /** Ordered on standard + framework POs (call-offs excluded, as on a BOQ row). */
  committed_qty: number;
  called_off_qty: number;
  framework_reserved_qty: number;
  committed_value: number;
  called_off_value: number;
  last_ordered_at: string | null;
  /** Newest first. Each order is kept — the row aggregates the quantity, but
   *  who ordered what and when still has to be answerable from the list. */
  orders: Array<{
    po_id: string; po_number: string; status: string; order_type: string;
    line_id: number; qty: number; line_total: number; ordered_at: string | null;
  }>;
};

export type ApprovalTier = "line_manager" | "commercial_manager" | "director";

/** A pending part-substitution awaiting approval (Approvals inbox row). */
export type PendingSubstitution = {
  id: number;
  material_id: number;
  project_id: string;
  kind: MaterialSubstitutionKind;
  reason: string | null;
  replacement_item: string;
  replacement_manufacturer: string | null;
  replacement_supplier: string | null;
  replacement_cost: number | null;
  replacement_unit: string | null;
  sub_units: number | null;
  approval_tier: ApprovalTier | null;
  created_at: string;
  created_by: string;
  // joined
  material_item: string;
  material_element_code: string | null;
  original_cost: number | null;
  original_total_units: number | null;
  original_unit: string | null;
  project_code: string;
  project_name: string;
};
export type ApprovalReason = "over_budget" | "unpriced" | "both";
// "deleted" is the soft-delete state: hidden from lists, but the detail view
// still renders it (with a banner) via direct link.
export type POStatus = "draft" | "pending_approval" | "approved" | "rejected" | "issued" | "deleted";

export type POLine = {
  id?: number;
  material_id: number | null;     // null → unpriced/ad-hoc
  item: string;
  type: string | null;
  manufacturer: string | null;
  qty: number;
  unit: string;
  unit_cost: number;
  line_total: number;
  is_unpriced: boolean;
  is_over_budget: boolean;
  priced_qty_at_order: number | null;
  committed_before: number | null;
  // Derived at query time: PRJ.ELE.RES if the material links to a master product.
  cost_code?: string | null;
  // Framework orders only: how much of this line its live call-offs have drawn
  // down, and what's left — on qty and on cost (a call-off can stay within
  // qty but still overspend on a higher unit cost). Set by GET /api/pos/:id
  // when order_type='framework'.
  called_off_qty?: number;
  available_qty?: number;
  called_off_value?: number;
  available_value?: number;
  // Every receipt logged against this line, oldest first — which delivery note
  // (or "manual", for a check-in with no ticket) each portion of `received_qty`
  // actually came from. Set by GET /api/pos/:id.
  received_qty?: number;
  deliveries?: Array<{ dn: string | null; qty: number; unit: string | null; date: string; by: string | null }>;
};

export type OrderType = "standard" | "framework" | "call_off";

export type PurchaseOrder = {
  id: string;
  po_number: string;
  project_id: string;
  supplier: string;
  status: POStatus;
  requires_approval: boolean;
  approval_tier: ApprovalTier | null;
  approval_reason: ApprovalReason | null;
  total_value: number;
  notes: string | null;
  delivery_date: string | null;
  created_at: string;
  created_by: string;
  approved_at: string | null;
  approved_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  issued_at: string | null;
  // Xero push state
  xero_po_id?: string | null;
  xero_po_number?: string | null;
  xero_synced_at?: string | null;
  xero_sync_status?: "synced" | "failed" | "pending" | null;
  xero_sync_error?: string | null;
  // Payment state — set when the Xero Bill this PO becomes is fully paid
  // (matched from the Invoice webhook by Reference == po_number).
  paid_at?: string | null;
  paid_reference?: string | null;
  xero_bill_id?: string | null;
  // Framework / call-off
  order_type?: OrderType;
  /** Ordered whole but the supplier is delivering it piecemeal. */
  part_delivery?: number;
  parent_po_id?: string | null;
  // Cost category — 'prelims' expends the Preliminaries budget, not materials.
  category?: "materials" | "prelims";
  // Soft delete
  deleted_at?: string | null;
  deleted_by?: string | null;
  deletion_reason?: string | null;
  // Framework orders only: true when a live call-off has drawn past the
  // agreed qty or cost on one or more of this framework's lines. Set by
  // GET /api/pos (the PO list) so it can flag the row without a per-PO
  // round trip; not present on the single-PO GET (that shows it per-line).
  is_overdrawn?: boolean;
  lines: POLine[];
};

export type Approver = {
  id: number;
  project_id: string | null;
  tier: ApprovalTier;
  email: string;
  name: string | null;
};

import type { Role } from "./permissions";

export type CurrentUser = {
  email: string;
  name: string | null;
  role: Role;
  active: boolean;
  is_approver: boolean;
  approver_tiers: ApprovalTier[];
};

export type AppUser = {
  email: string;
  name: string | null;
  role: Role;
  active: boolean;
  created_at: string;
  created_by: string | null;
};

export type Element = {
  code: string;
  name: string;
  notes: string | null;
};

export type ResourceType = {
  code: "M" | "L" | "P" | "S" | "O" | "X";
  name: string;
  usage: string | null;
};

export type Product = {
  id: number;
  element_code: string;
  item_no: number;
  variant: string | null;
  description: string;
  manufacturer: string | null;
  supplier: string | null;        // primary supplier — defaults to manufacturer if blank
  unit: string | null;
  unit_cost: number | null;
  default_resource: string | null;
  notes: string | null;
  created_at: string;
  created_by: string | null;
  // Computed/derived on read
  product_code: string;
  element_name: string;
  usage_count: number;
  alternate_supplier_count: number;
};

/** An alternate supplier offering the product at its own price / SKU / lead time. */
export type ProductSupplier = {
  id: number;
  product_id: number;
  supplier_name: string;
  unit_cost: number | null;
  supplier_sku: string | null;
  lead_time_days: number | null;
  notes: string | null;
  is_preferred: boolean;
  created_at: string;
  created_by: string | null;
};

export type SupplierStatus = "approved" | "preferred" | "suspended" | "pending";

/** Org-level approved supplier register. */
export type Supplier = {
  id: number;
  name: string;
  status: SupplierStatus;
  scope_notes: string | null;
  payment_terms: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  address: string | null;
  vat_number: string | null;
  utr: string | null;
  credit_limit_gbp: number | null;
  // Remittance / payment details — the bank account PGP pays this supplier into.
  bank_account_name: string | null;
  bank_sort_code: string | null;
  bank_account_number: string | null;
  bank_name: string | null;
  notes: string | null;
  // True when this supplier is approved to supply labour (subcontractor).
  // Filters the incoming-labour AfP subcontractor picker.
  is_labour_supplier: boolean;
  /** CIS deduction rate for a labour subcontractor: 30 (unverified), 20
   *  (registered), 0 (gross payment status). null = CIS doesn't apply. */
  cis_rate: number | null;
  created_at: string;
  created_by: string | null;
  // Xero sync — populated when this supplier maps to a Xero Contact
  xero_contact_id?: string | null;
  xero_last_synced_at?: string | null;
  // computed on read
  approved_elements: string[];           // array of element codes
  product_supplier_count: number;        // # of products listing them as an alternate supplier
};

/** Derive ELE.ITM[.VAR] from the pieces. */
export function buildProductCode(element_code: string, item_no: number, variant: string | null): string {
  const item = String(item_no).padStart(2, "0");
  const v = variant?.trim() ? `.${variant.trim()}` : "";
  return `${element_code}.${item}${v}`;
}

/** Derive PRJ.ELE.RES from a project number, element and resource code. */
export function buildCostCode(project_number: string | number, element_code: string, resource: string): string {
  const prj = String(project_number).padStart(4, "0");
  return `${prj}.${element_code}.${resource}`;
}

/**
 * Pull a 4-digit project number out of an arbitrary project code.
 *   "BNC001"   → "0001"
 *   "BNC042"   → "0042"
 *   "PGP-2604" → "2604"
 *   "ABC"      → "0000"
 * Codes longer than 4 digits keep the trailing 4 (rare; spec says 4 digits).
 */
export function derivedProjectNumber(projectCode: string): string {
  const digits = projectCode.replace(/\D/g, "");
  if (!digits) return "0000";
  return digits.slice(-4).padStart(4, "0");
}

/** A single work item from the Pricing/Costing-Labour-Only tabs. */
export type ContractItem = {
  id: number;
  snapshot_id: number;
  item_no: number;
  /** Which value section: Prelims, Measured works, or Ancil Items. */
  category: "prelims" | "measured" | "ancil";
  section: string | null;
  description: string;
  qty: number;
  unit: string | null;
  sell_rate: number;
  sell_total: number;
  labour_rate: number | null;
  labour_total: number | null;
  /** Latest applied/approved live (quoted) labour rate for this line, if any.
   *  Drives Savings from Labour = (labour_rate − live_labour_rate) × qty. */
  live_labour_rate?: number | null;
};

export type AfpDirection = "outgoing" | "incoming_labour";
export type AfpStatus = "draft" | "pending_approval" | "submitted" | "certified" | "paid";

/**
 * What to call an AfP document. Client (outgoing) AfPs are always
 * "Application for Payment". A labour (incoming) AfP is the subcontractor's
 * "Application" while it's being processed, and becomes a "Payment Certificate"
 * once PowerGrid has approved/certified it (status submitted → paid).
 */
export function afpDocLabel(direction: AfpDirection, status: AfpStatus): string {
  if (direction === "outgoing") return "Application for Payment";
  return status === "submitted" || status === "certified" || status === "paid"
    ? "Payment Certificate"
    : "Labour Application";
}

/** One Application for Payment — outgoing (PowerGrid → client) or incoming
 *  labour (subcontractor → PowerGrid). */
export type ApplicationForPayment = {
  id: number;
  project_id: string;
  direction: AfpDirection;
  app_number: number;
  period_end: string;
  notes: string | null;
  retention_pct: number;
  vat_pct: number;
  contract_sum: number | null;
  cumulative_value: number | null;
  previous_certified: number | null;
  this_period_net: number | null;
  retention_amount: number | null;
  amount_due: number | null;
  vat_amount: number | null;
  total_invoice: number | null;
  status: AfpStatus;
  counterparty_supplier_id: number | null;
  created_at: string;
  created_by: string;
  submitted_at: string | null;
  submitted_by: string | null;
  certified_at: string | null;
  certified_by: string | null;
  certified_amount: number | null;
  paid_at: string | null;
  paid_by: string | null;
  payment_reference: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  approval_rejected_at?: string | null;
  approval_rejected_by?: string | null;
  approval_rejection_reason?: string | null;
  // Rate-variance sign-off (labour only): a director has accepted line rates
  // that differ from the agreed live rate, clearing them for certification.
  rate_override_at?: string | null;
  rate_override_by?: string | null;
  rate_override_reason?: string | null;
  /** Lines extracted from an uploaded subcontractor application that we could
   *  not auto-match to a contract_item — shown as a review banner. */
  unmatched_lines_json?: string | null;
  /** Lines that WERE unmatched but got resolved (assign / variation / expense /
   *  dismiss), kept with a `resolution` record so the action can be undone. */
  resolved_lines_json?: string | null;
  // Xero push (certified labour certificate → draft PO to the subbie)
  xero_po_id?: string | null;
  xero_po_number?: string | null;
  xero_synced_at?: string | null;
  xero_sync_status?: string | null;
  xero_sync_error?: string | null;
  // Xero invoice (certified client application → live ACCREC sales invoice)
  xero_invoice_id?: string | null;
  xero_invoice_number?: string | null;
  xero_invoice_synced_at?: string | null;
  xero_invoice_status?: string | null;
  xero_invoice_error?: string | null;
  // Approve-for-payment gate (labour certificates): the financial go-ahead,
  // separate from certification, required before the labour bill pushes to Xero.
  pay_approved_at?: string | null;
  pay_approved_by?: string | null;
  pay_approval_note?: string | null;
  // Source application document persisted in R2, attached to the Xero bill.
  source_file_key?: string | null;
  source_file_name?: string | null;
  source_file_type?: string | null;
  // The counterparty's returned payment certificate (set the certified figures).
  cert_file_key?: string | null;
  cert_file_name?: string | null;
  cert_file_type?: string | null;
  /** Sender company details read off the document (JSON). */
  extracted_meta_json?: string | null;
  /** Non-null = this labour application expends the PRELIMS budget under this heading. */
  prelim_heading?: string | null;
  /** Prelim-tagged apps only: the single claimed £ (no line matching) that
   *  becomes the application's value and draws the heading's allowance down. */
  claimed_amount?: number | null;
  // joined fields
  line_count?: number;
  project_code?: string;
  project_name?: string;
  project_client?: string | null;
  project_retention_pct?: number;
};

/** One row in the portfolio-wide Applications workspace (GET /api/applications). */
export type ApplicationListItem = {
  id: number;
  project_id: string;
  project_code: string;
  project_name: string;
  direction: AfpDirection;
  app_number: number;
  period_end: string;
  status: AfpStatus;
  counterparty_supplier_id: number | null;
  supplier_name: string | null;
  total_invoice: number | null;
  certified_amount: number | null;
  amount_due: number | null;
  cumulative_value: number | null;
  created_at: string;
  created_by: string;
  has_unmatched: number;   // 0/1 from SQLite
};

/** A labour application received by email that couldn't be auto-routed to a
 *  project — parked in the inbound tray for manual project/supplier assignment. */
export type InboundApplication = {
  id: number;
  received_at: string;
  sender_email: string;
  subject: string | null;
  filename: string | null;
  direction: AfpDirection;
  counterparty_supplier_id: number | null;
  supplier_name: string | null;
  note: string | null;
  line_count: number;
};

/** A variation — project-level cost-centre, separate from the contract. */
export type VariationMaterial = {
  id: number;
  variation_id: number;
  product_id: number | null;
  material_id: number | null;
  description: string;
  manufacturer: string | null;
  qty: number;
  unit: string | null;
  unit_rate: number;
  value: number;
};
export type VariationLabour = {
  id: number;
  variation_id: number;
  description: string;
  qty: number;
  unit_rate: number;
  value: number;
};
export type Variation = {
  id: number;
  variation_no: number;
  description: string;
  status: string;
  sell_value: number;
  notes: string | null;
  created_at: string;
  created_by: string;
  /** Director sign-off authorising the variation's budget for expenditure.
   *  NULL until approved; cleared when the variation's financials are edited. */
  approved_at: string | null;
  approved_by: string | null;
  materials: VariationMaterial[];
  labour: VariationLabour[];
  material_budget: number;
  /** Labour cost to the project. Zero when `labour_absorbed` is set — the labour
   *  is done within the existing contract allowance, so it adds no cost. */
  labour_budget: number;
  /** When true, the variation's labour lines are recorded for scope but treated
   *  as absorbed in the existing contract labour allowance: £0 additional cost
   *  to the project (labour_budget, margin and Forecast Final Cost all count 0). */
  labour_absorbed?: boolean;
  /** Committed PO value linked to this variation (material spend to date). */
  material_spent: number;
  /** Certified revenue attributed to this variation, from the client's latest
   *  certified (outgoing) application. The actual-margin numerator. */
  revenue_certified: number;
  /** Applied revenue attributed to this variation, from the latest non-draft
   *  outgoing application (claimed, certified or not). */
  revenue_applied: number;
  /** Certified labour cost attributed to this variation, from each subbie's
   *  latest certified labour application. */
  labour_spent: number;
};

/** Shape of one entry inside applications_for_payment.unmatched_lines_json. */
export type AfpUnmatchedLine = {
  raw_line_no: number;
  description: string;
  qty: number | null;
  unit: string | null;
  cumulative_value: number | null;
  cumulative_pct: number | null;
  this_period_value: number | null;
  /** Present on entries in resolved_lines_json — how it was resolved, for undo. */
  resolution?: { action: "assign" | "add_as_variation" | "add_as_expense" | "dismiss"; afp_line_id?: number; contract_item_id?: number } | null;
};

/** One line on an AfP — BOQ-derived (links to contract_item) or ad-hoc. */
export type AfpLine = {
  id: number;
  afp_id: number;
  contract_item_id: number | null;
  /** prelims | measured | ancil — null for ad-hoc variation lines. */
  category: string | null;
  section: string | null;
  description: string;
  unit: string | null;
  qty: number | null;
  rate: number;
  contract_value: number;
  percent_complete: number;        // applied / claimed %
  certified_percent: number | null; // certified % (null until certified)
  cumulative_value: number;
  is_adhoc: 0 | 1;
  display_order: number;
  // Rate-variance flag (labour AfPs only; attached by GET /:id). expected_rate
  // is the agreed live rate (or BOQ rate) we'd expect to pay; rate_flagged is 1
  // when this line's frozen rate differs from it to the penny.
  expected_rate?: number | null;
  rate_source?: "live" | "boq" | null;
  rate_flagged?: 0 | 1;
  /** £ certified for this bill line on PRIOR apps (attached by GET /:id). Lets
   *  the UI show this period = cumulative − previously certified per line. */
  previously_certified?: number | null;
};

/** Bundle returned by GET /api/applications/:id — the AfP, its lines, and the
 *  prior AfPs so the UI can show the previously-certified column. */
/** The CIS deduction a labour certificate will carry when pushed to Xero.
 *  null on the detail payload = no CIS (client AfP, no subbie, or a 0%/unset
 *  rate). Computed from the labour element only — expenses sit outside CIS. */
export type AfpCisPreview = {
  supplier_name: string;
  rate: number;
  /** Certified net this period (what the labour line bills at). */
  certified_net: number;
  /** The CIS-liable part of that net — certified less this period's expenses. */
  labour_base: number;
  deduction: number;
  net_payable: number;
};

export type AfpDetail = {
  afp: ApplicationForPayment;
  lines: AfpLine[];
  prior_apps: Array<{
    app_number: number;
    period_end: string;
    status: AfpStatus;
    certified_amount: number | null;
    cumulative_value: number | null;
    total_invoice: number | null;
  }>;
  cis: AfpCisPreview | null;
};

/** One labour-by-cost-code row aggregated from the materials table. */
/** A live (quoted) subcontractor labour rate applied to a BOQ labour line. */
export type LabourLiveRate = {
  id: number;
  contract_item_id: number;
  description: string;
  qty: number;
  boq_rate: number;
  live_rate: number;
  source: string | null;
  /** 'applied' | 'approved' = effective; 'pending_approval' = a budget increase awaiting director sign-off. */
  status: string;
  applied_at: string;
  applied_by: string;
  /** (boq_rate − live_rate) × qty — positive is a saving. */
  saving: number;
};

export type LabourByCostCode = {
  /** BOQ section (e.g. "Roof", "Wall Cladding") — the dimension both the labour
   *  BOQ and the certified labour lines share, so % expended is real per row. */
  section: string;
  line_count: number;
  labour_total: number;
  /** Gross labour value certified to subcontractors against this section via
   *  incoming-labour applications (sum of line cumulative_value). */
  expended: number;
};

/** A row from the workbook's Summary Cost Sheet — value / cost / GP per category. */
export type ProjectCommercial = {
  id: number;
  snapshot_id: number;
  category: string;
  value: number | null;
  cost: number | null;
  gross_profit: number | null;
  gross_profit_pct: number | null;  // 0..1 fraction (0.131 = 13.1%)
  is_total: 0 | 1;
  display_order: number;
};

/** A pending price approval surfaced on the approvals inbox. */
export type PendingPriceApproval = {
  id: number;
  material_id: number;
  quote_id: number;
  project_id: string;
  unit_price: number;
  boq_unit_cost: number | null;
  boq_qty: number | null;
  over_amount: number;
  status: "pending_approval";
  approval_tier: ApprovalTier | null;
  applied_at: string;
  applied_by: string;
  // joined
  material_item: string;
  material_element_code: string | null;
  project_code: string;
  project_name: string;
  supplier_name: string;
  quote_filename: string;
};

/** A supplier quote uploaded as a PDF and parsed by Claude. */
export type SupplierQuote = {
  id: number;
  supplier_id: number;
  supplier_name?: string;
  project_id?: string | null;
  filename: string;
  uploaded_at: string;
  uploaded_by: string;
  status: "extracting" | "ready" | "applied" | "discarded" | "failed";
  extraction_error: string | null;
  notes: string | null;
  total_applied_value: number | null;
  total_old_value: number | null;
  applied_at: string | null;
  applied_by: string | null;
  // present on list responses
  line_count?: number;
  applied_count?: number;
};

/** One row Claude extracted from the quote PDF, joined to the matched product context. */
export type SupplierQuoteLine = {
  id: number;
  quote_id: number;
  line_no: number;
  raw_description: string;
  raw_sku: string | null;
  raw_qty: number | null;
  raw_unit: string | null;
  unit_price: number | null;
  matched_product_id: number | null;
  matched_product_supplier_id: number | null;
  matched_material_id: number | null;
  boq_unit_cost: number | null;
  boq_qty: number | null;
  match_confidence: number | null;
  old_unit_price: number | null;
  is_applied: 0 | 1;
  skip_reason: string | null;
  // joined fields (catalogue-quote context)
  product_code?: string | null;
  product_description?: string | null;
  product_unit?: string | null;
  product_primary_cost?: number | null;
  supplier_current_cost?: number | null;
  supplier_current_sku?: string | null;
  // joined fields (project-quote context)
  material_item?: string | null;
  material_boq_cost?: number | null;
  material_total_units?: number | null;
  material_total_units_unit?: string | null;
  material_element_code?: string | null;
  live_status?: "applied" | "pending_approval" | "approved" | "rejected" | null;
  live_over_amount?: number | null;
  live_approval_tier?: ApprovalTier | null;
};

export type CreatePOInput = {
  project_id: string;
  supplier: string;
  notes?: string;
  delivery_date?: string;
  /** Optional: link this PO to a project variation (its value counts as that
   *  variation's material spend). */
  variation_id?: number | null;
  /** 'framework' to raise a blanket order, or set parent_po_id to raise a call-off against one. */
  order_type?: OrderType;
  /** Ordered whole but the supplier is delivering it piecemeal. */
  part_delivery?: number;
  parent_po_id?: string | null;
  /** 'prelims' tags the PO's spend to the Preliminaries budget. */
  category?: "materials" | "prelims";
  lines: Array<{
    material_id: number | null;
    item: string;
    type?: string | null;
    manufacturer?: string | null;
    qty: number;
    unit: string;
    unit_cost: number;
  }>;
};

/** Admin/superadmin edit of an existing PO (header + lines). Project and the
 *  framework/call-off relationship are fixed; status is preserved server-side. */
export type UpdatePOInput = {
  supplier: string;
  notes?: string | null;
  delivery_date?: string | null;
  category?: "materials" | "prelims";
  lines: CreatePOInput["lines"];
};

export type Settings = {
  tier_threshold_line_manager: number;
  tier_threshold_commercial_manager: number;
  tier_threshold_director: number;
  currency: string;
};

// ── Operations (Phase 1 — site-team basics) ─────────────────────────────────

/** A live project as it appears on the Operations landing list. */
export type OpsSite = {
  id: string;
  code: string;
  name: string;
  client: string | null;
  on_site_now: number;
  signins_today: number;
  plant_on_site: number;
  token: string | null;
};

export type SiteNoticeType = "briefing" | "toolbox";

/** A daily briefing or toolbox talk. `ack_count` is populated on the app side. */
export type SiteNotice = {
  id: number;
  project_id: string;
  type: SiteNoticeType;
  title: string;
  content: string | null;
  notice_date: string;
  active: number;
  created_at: string;
  created_by: string;
  ack_count?: number;
  /** How many operatives it was actually sent to. The acknowledgement
   *  denominator: a talk delivered to the crew who were on site that day can
   *  never be acknowledged by the ones who weren't, so counting against the
   *  site's whole crew would leave it permanently short. */
  sent_count?: number;
  /** The library talk this was delivered from, if any — pairs the delivery back
   *  to its template so a site shows one row per talk rather than per delivery. */
  template_id?: string | null;
};

/** An operative's sign-in (and optional sign-out) for a day. */
export type SiteSignin = {
  id: number;
  name: string;
  company: string | null;
  trade: string | null;
  phone: string | null;
  signature: string | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  signed_in_at: string;
  signed_out_at: string | null;
  /** 1 = closed automatically at 19:00 UK time (no sign-out recorded); cleared on manual edit. */
  signed_out_auto?: number;
  ack_notice_ids: number[];
  /** Standing daily briefing acknowledged at sign-in (mandatory). null = no briefing set. */
  briefing_ack: boolean | null;
  /** All active site RAMS signed (within the last month) by the matched operative. null = no active RAMS. */
  rams_signed: boolean | null;
};

/** An item of hired plant tracked on site (raises a PO on add). */
export type PlantLog = {
  id: number;
  project_id: string;
  item: string;
  supplier: string | null;
  on_hire_from: string | null;
  off_hire_to: string | null;
  day_rate: number | null;
  rate_unit: "day" | "week";
  notes: string | null;
  /** The purchase order this hire raised. */
  po_id: string | null;
  expected_weeks: number | null;
  /** Planned off-hire date (drives reminders); off_hire_to is the actual one. */
  expected_off_hire: string | null;
  created_at: string;
  created_by: string;
  /** Joined for display — the linked PO's number. */
  po_number?: string | null;
};

/** A company-owned plant item in the master register, transferred between sites. */
export type OwnedPlant = {
  id: string;
  asset_no: string | null;
  name: string;
  category: string | null;
  supplier: string | null;
  notes: string | null;
  assigned_project_id: string | null;
  assigned_at: string | null;
  assigned_by: string | null;
  archived_at: string | null;
  created_at: string;
  created_by: string | null;
  /** Joined for display. */
  assigned_project_code?: string | null;
  tests?: OwnedPlantTest[];
  /** Worst test status across this item's tests. */
  test_status?: "valid" | "expiring" | "expired" | "none";
};

export type OwnedPlantTest = {
  id: string;
  plant_id: string;
  test_type: string;
  tested_on: string | null;
  expiry_date: string | null;
  file_key: string | null;
  notes: string | null;
  status?: "valid" | "expiring" | "expired" | "none";
};

/** A per-site standing daily briefing, shown + acknowledged at every sign-in. */
export type SiteBriefing = {
  title: string;
  content: string;
  updated_at: string;
  updated_by: string;
};

/** Public payload returned to the operative sign-in page (/pub/site/:token). */
/** Minimal operative record exposed on the (un-authenticated) site sign-in
 *  page so an operative can pick themselves from a searchable list. No phone,
 *  email or token — just enough to identify and disambiguate by name. */
export type PublicOperative = { id: string; name: string; company: string | null; trade: string | null };

export type PublicSite = {
  project: { code: string; name: string };
  /** When the contract is part of a multi-contract site, the shared site name. */
  site_group_name?: string | null;
  briefing: { title: string; content: string } | null;
  notices: Array<Pick<SiteNotice, "id" | "type" | "title" | "content" | "notice_date">>;
  /** Active operatives for the sign-in picker (replaces freeform name entry). */
  operatives: PublicOperative[];
};

// ── Operations Phase 2 — file-backed records ────────────────────────────────

export type DeliveryStatus = "received" | "partial" | "rejected";

/** A materials delivery checked in on site (ticket photo + sign-off). */
export type SiteDelivery = {
  id: number;
  supplier: string | null;
  description: string;
  po_number: string | null;
  po_id: string | null;
  /** Optional specific PO line this delivery is against (+ snapshot of its text). */
  po_line_id?: number | null;
  po_line_desc?: string | null;
  ticket_key: string | null;
  ticket_type: string | null;
  signed_by: string | null;
  signature: string | null;
  status: DeliveryStatus;
  notes: string | null;
  delivered_at: string;
  /** Reconciliation totals: units the ticket said vs units actually received. */
  expected_qty: number | null;
  received_qty: number | null;
  /** Unit for received_qty when this drop is a part of a scheme line (e.g. "packs"). */
  received_unit?: string | null;
  /** On a grouped site, which contract this delivery belongs to (else null). */
  contract_project_id?: string | null;
  contract_code?: string | null;
  /** 1 = this delivery completes its PO; 0 = a part-load, PO stays open. */
  completes_po?: number;
  created_at: string;
  created_by: string;
};

/** An open PO with per-line delivery burn-down — which line items have been
 *  delivered / part-delivered, derived from the deliveries logged against them. */
export type PoDeliveryStatus = {
  id: string;
  po_number: string;
  supplier: string | null;
  order_type: string | null;
  project_id: string;
  project_code: string;
  fully_delivered: boolean;
  lines_delivered: number;
  lines_total: number;
  lines: Array<{ id: number; item: string; qty: number; unit: string; delivered: boolean; in_progress: boolean; drops: number; delivered_qty: number | null; delivered_unit: string | null }>;
};

/** A WhatsApp-group photo that was scanned and looks like a delivery ticket,
 *  waiting to be confirmed as a delivery check-in. */
/** A ticket already actioned from the inbox, with the delivery rows it created. */
export type CheckedInTicket = {
  id: number;
  project_id: string;
  project_code: string | null;
  supplier_name: string | null;
  delivery_note_number: string | null;
  delivery_date: string | null;
  summary: string | null;
  occurred_at: string | null;
  delivery_id: number | null;
  ticket_url: string;
  deliveries: Array<{
    id: number;
    description: string | null;
    received_qty: number | null;
    received_unit: string | null;
    po_id: string | null;
    po_number: string | null;
    po_line_desc: string | null;
    delivered_at: string | null;
    project_id: string;
    project_code: string | null;
    contract_code: string | null;
  }>;
};

export type DeliveryTicketCandidate = {
  id: number;
  /** Present on the cross-project deliveries inbox — which site the scan lives on. */
  project_id?: string;
  project_code?: string;
  project_name?: string;
  photo_key: string;
  ticket_url: string;
  po_number: string | null;
  supplier_name: string | null;
  delivery_note_number: string | null;
  delivery_date: string | null;
  summary: string | null;
  matched_po_id: string | null;
  matched_by: string | null;
  matched_po_number: string | null;
  matched_po_supplier: string | null;
  matched_order_type: string | null;
  matched_project_id: string | null;
  matched_project_code: string | null;
  occurred_at: string | null;
  /** Quantity + unit the reader saw on the ticket, to pre-fill "delivered this drop". */
  scanned_qty?: number | null;
  scanned_unit?: string | null;
  /** Each line the reader saw on the ticket, for matching to PO line items. */
  items?: Array<{ description: string; qty: number | null; unit: string | null }>;
  /** Clockwise degrees to rotate the photo so its text reads upright — site
   *  photos are routinely shot sideways. 0 on anything scanned before this
   *  was captured (and on tickets that were already the right way up). */
  rotation_degrees?: 0 | 90 | 180 | 270;
  /** Approximate read-regions on the photo (normalized 0-1 boxes) — where the
   *  vision pass saw each field. Absent on tickets scanned before regions. */
  regions?: {
    po_number?: { x: number; y: number; w: number; h: number } | null;
    supplier_name?: { x: number; y: number; w: number; h: number } | null;
    delivery_note_number?: { x: number; y: number; w: number; h: number } | null;
    delivery_date?: { x: number; y: number; w: number; h: number } | null;
  } | null;
  item_regions?: Array<{ x: number; y: number; w: number; h: number } | null>;
  /** Headline match state for the inbox row (set by the ticket-candidates list):
   *  'po' = matched to a PO, 'line' = inferred from item codes (has a guess),
   *  'none' = nothing matched. `conf` is 0–100. When inferred, guess_* name the
   *  best-guess PO. */
  method?: "po" | "line" | "none";
  conf?: number;
  guess_po_id?: string | null;
  guess_po_number?: string | null;
  guess_project_code?: string | null;
  /** Whether the GOODS match the order, as opposed to the order number — the
   *  match above compares only the reference printed on the ticket. Absent when
   *  the ticket points at no PO at all. */
  variance?: VarianceReport;
};

/** Full reconciliation of one scanned ticket against a chosen (or best-guess) PO:
 *  the PO's lines with ordered qty + cumulative prior receipts, the ticket's items
 *  matched to those lines with confidence, and ranked alternative POs. Drives the
 *  delivery check-in's per-line remaining-quantity math. */
export type TicketReconciliation = {
  ticket: { id: number; dn: string | null; date: string | null; supplier: string | null; po_number: string | null };
  method: "po" | "line" | "none";
  conf: number;
  matched_po: { id: string; po_number: string; supplier: string | null; project_id: string; project_code: string; is_stored: boolean } | null;
  suggested: Array<{ id: string; po_number: string; supplier: string | null; project_code: string; hits: number }>;
  variance: VarianceReport;
  items: Array<{ desc: string; qty: number | null; unit: string | null; po_line_id: number | null; lc: number }>;
  po_lines: Array<{ id: number; desc: string; unit: string; ordered: number; received: number; remaining: number; prior: Array<{ date: string; qty: number; dn: string | null }> }>;
};

/** A site that bundles multiple contracts (projects) sharing the operational
 *  layer — sign-in, RAMS, notices, deliveries — while commercials stay separate. */
export type SiteGroupMember = { id: string; code: string; name: string };
export type SiteGroup = {
  id: string;
  name: string;
  base_project_id: string | null;
  created_at: string;
  members: SiteGroupMember[];
};
/** The group a single project belongs to (for the Operations tab banner + tag). */
export type ProjectSiteGroup = { id: string; name: string; base_project_id: string; members: SiteGroupMember[] };

/** A RAMS / COSHH / permit document stored in R2. */
export type RamsDocument = {
  id: number;
  title: string;
  category: string;
  file_key: string;
  file_name: string | null;
  file_type: string | null;
  file_size: number | null;
  version: string | null;
  /** Revision family — all revisions of one document share this. */
  rev_group?: string | null;
  /** Auto-incrementing revision number within the family (1, 2, 3…). */
  revision?: number | null;
  active: number;
  /** Optional expiry (certs, permits). Drives the expiry column + KPIs. */
  expiry_date?: string | null;
  created_at: string;
  created_by: string;
  /** Operatives currently assigned to the site (denominator for signed). */
  crew_count?: number;
  /** Assigned operatives who've signed this doc within the last month. */
  signed_count?: number;
  /** True once the doc has been distributed for signature at least once. */
  distributed?: boolean;
};

/** A verified operative qualification card, surfaced read-only as a
 *  "Certificate" row in the site Documents hub. */
export type OperativeCert = {
  id: string;
  qual_type: string;
  card_no: string | null;
  file_key: string | null;
  file_type: string | null;
  expiry_date: string | null;
  verified_at: string | null;
  operative_name: string;
  operative_company: string | null;
};

/** A daily progress photo stored in R2. */
export type ProgressPhoto = {
  id: number;
  file_key: string;
  file_type: string | null;
  caption: string | null;
  taken_on: string | null;
  lat: number | null;
  lng: number | null;
  created_at: string;
  created_by: string;
};

// ── Operatives (register: induction, qualification cards, RAMS) ─────────────
export type QualStatus = "pending" | "valid" | "expiring" | "expired" | "none";

export type Operative = {
  id: string;
  token: string;
  name: string;
  phone: string | null;
  company: string | null;
  trade: string | null;
  email: string | null;
  emergency_contact: string | null;
  induction_done: number;
  induction_at: string | null;
  induction_by: string | null;
  notes: string | null;
  created_at: string;
  created_by: string;
  archived_at: string | null;
  // Current site assignment — an operative is on at most one site at a time.
  assigned_project_id: string | null;
  assigned_at: string | null;
  assigned_by: string | null;
};

export type OperativeQual = {
  id: string;
  qual_type: string;
  card_no: string | null;
  file_key: string | null;
  file_type?: string | null;
  expiry_date: string | null;
  created_at?: string;
  source?: string;            // 'manager' | 'self' | 'operative'
  verified_at?: string | null; // null = pending verification
  status: QualStatus;
};

export type OperativeRamsRow = {
  id: string;
  rams_id: number;
  project_id: string;
  signed_at: string | null;
  requested_at: string;
  rams_title: string;
  project_code: string;
};

export type ProgrammeActivity = {
  id: number;
  project_id: string;
  line_no: number | null;
  level: number;
  name: string;
  is_milestone: number;       // 0 | 1
  is_summary: number;         // 0 | 1
  baseline_start: string | null;
  baseline_finish: string | null;
  planned_start: string | null;
  planned_finish: string | null;
  actual_start: string | null;
  actual_finish: string | null;
  pct_complete: number;       // 0..1
  duration_days: number | null;
  predecessors: string | null;
  display_order: number;
  updated_at?: string | null;
  updated_by?: string | null;
};

/* ── Cabin QITP (project-scoped) ─────────────────────────────────────────── */
export type CabinState = "not_started" | "in_progress" | "held" | "failed" | "complete";
export type QitpSectionStatus = "not_started" | "pass" | "in_progress" | "fail" | "na";

export type QitpPhotoMode = "none" | "optional" | "required";
/** Whether an item takes a typed reading (paint QA: temperatures, humidity,
 *  dew point, dry film thickness) alongside its tick. Same tri-state as photo. */
export type QitpEntryMode = "none" | "optional" | "required";
export type QitpItem = { text: string; hold: boolean; photo: QitpPhotoMode; entry?: QitpEntryMode };

export type QitpSection = {
  id: number;
  seq: number;
  title: string;
  point_type: "HOLD" | "WITNESS" | null;
  responsible?: string[];        // companies that must each sign to release the section
  items?: QitpItem[];            // checklist items (present on the cabin detail, omitted on the dashboard)
};

/** Dashboard card: a cabin with its derived headline state + progress. */
export type QitpCabinCard = {
  id: number;
  number: string;
  floor: "Top" | "Middle" | "Ground" | string;
  elevation: string | null;
  wing: string | null;
  dismantle_day: number | null;
  reinstall_date: string | null;   // ISO date the cabin returns to site (build-up sequence)
  token: string;
  status: CabinState;
  done: number;
  total: number;
  lifted: boolean;               // Section 3 (Wrap, Lift & Transport) passed
};

export type QitpDashboard = {
  project: { code: string; name: string };
  sections: QitpSection[];
  cabins: QitpCabinCard[];
};

export type QitpRecord = {
  section_id: number;
  status: QitpSectionStatus;
  checks: boolean[];             // one per section item
  entries: string[];             // typed reading per item (blank where not applicable)
  inspector: string | null;
  company: string | null;
  notes: string | null;
  photo_ref: string | null;
};

/** One responsible party's sign-off for a cabin × section. */
export type QitpSignoff = {
  section_id: number;
  party: string;
  signed_name: string;
  signed_at: string;
};

export type QitpCabinDetail = {
  cabin: { id: number; project_id: string; number: string; floor: string; elevation: string | null; wing: string | null; dismantle_day: number | null; reinstall_date: string | null };
  project: { code: string; name: string };
  sections: QitpSection[];
  records: QitpRecord[];
  signoffs: QitpSignoff[];
  photos: Array<{ id: number; section_id: number; item_index: number | null; caption: string | null }>;
};

/** An invoice/bill in the Accounts workpiece (invoices@ inbox or manual upload). */
export type Invoice = {
  id: number;
  status: string;                 // inbox | ready | pushed | dismissed
  kind: string | null;            // project | overhead | null (unrouted)
  project_id: string | null;
  project_code: string | null;
  project_name: string | null;
  nominal_code: string | null;
  supplier_id: number | null;
  supplier_name: string | null;
  matched_supplier_name: string | null;
  /** Account payment terms from the matched supplier ("Net 60 days EOM"). */
  supplier_payment_terms?: string | null;
  /** Due date the account terms imply (invoice_date + terms). */
  expected_due_date?: string | null;
  /** True when the invoice's own due date disagrees with the account terms. */
  terms_mismatch?: boolean;
  invoice_number: string | null;
  extracted_po_ref: string | null;   // OUR PO number as printed on the invoice (for matching)
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  net_amount: number | null;
  vat_amount: number | null;
  gross_amount: number | null;
  lines_json: string | null;
  file_key: string | null;
  file_type: string | null;
  file_name: string | null;
  source: string;                 // email | upload
  sender_email: string | null;
  subject: string | null;
  notes: string | null;
  extract_error: string | null;
  xero_bill_id: string | null;
  xero_bill_number: string | null;
  xero_sync_status: string | null;
  xero_sync_error: string | null;
  matched_po_id: string | null;   // 3-way match: the PO this invoice bills against
  approved_at: string | null;     // approved-for-payment gate (project invoices)
  approved_by: string | null;
  approval_note: string | null;   // required when approved despite match flags
  /** Price/quantity reconciliation against the matched PO. Computed on read, so
   *  it stays visible after approval — a mismatch that's been approved anyway
   *  still needs chasing with the supplier. Absent for overhead invoices, which
   *  have no order to reconcile against. */
  match?: MatchSummary | null;
  received_at: string | null;
  created_at: string;
  created_by: string | null;
};

// The price/quantity reconciliation shapes live with the scan that produces them.
export type { MatchIssue, MatchSummary };

/** One invoice line reconciled against a PO line and its logged deliveries. */
export type InvoiceMatchLine = {
  description: string;
  qty: number | null;
  unit_price: number | null;
  amount: number | null;
  po_line_id: number | null;
  po_line_item: string | null;
  po_qty: number | null;
  po_unit: string | null;
  po_unit_cost: number | null;
  delivered_qty: number | null;
  // Line totals both sides — the honest comparison for scheme/lump-sum lines
  // (1 Each billed vs a measured PO line), where per-unit deltas are noise.
  po_line_total?: number | null;
  invoice_line_total?: number | null;
  flags: string[];                // no_po_line | not_delivered | price_variance | total_variance | over_qty
};

/** Result of GET /invoices/:id/match — the chosen PO, ranked alternatives and
 *  per-line 3-way reconciliation (invoice ↔ PO line ↔ delivered qty). */
export type InvoiceMatch = {
  matched_po: { id: string; po_number: string; supplier: string | null; project_id: string; project_code: string; total: number | null; is_stored: boolean } | null;
  /** Every live PO, best guesses first. `group` says which bucket each came from —
   *  the heuristics order the list, they don't limit what the user can pick. */
  suggested: Array<{ id: string; po_number: string; supplier: string | null; project_code: string; hits: number; group?: "quoted" | "likely" | "project" | "other" }>;
  lines: InvoiceMatchLine[];
  /** Delivery records logged against the chosen PO — the tickets behind the
   *  delivered quantities, so the invoice view can show what actually arrived. */
  deliveries: Array<{
    id: number;
    description: string | null;
    po_line_id: number | null;
    received_qty: number | null;
    received_unit: string | null;
    delivered_at: string | null;
    created_by: string | null;
    ticket_key: string | null;
    ticket_url: string | null;
    /** The line this receipt names no longer exists, so it counts toward nothing.
     *  Caused by pre-#10 PO amendments, which replaced lines instead of updating
     *  them. Needs a person to say which current line it belongs to — the app
     *  deliberately doesn't guess, because a receipt saying "19 packs of Kingspan
     *  Therma TT44" and a line called "CTF/SCHEME/1 Tapered Insulation Scheme"
     *  may or may not be the same material, and only site staff know. */
    orphaned?: boolean;
  }>;
  // The chosen PO's own line items — options for manually re-pointing an invoice
  // line at the right PO line when the auto-match got it wrong or missed.
  po_lines?: Array<{ id: number; item: string; qty: number | null; unit: string | null; unit_cost: number | null }>;
  // Net £ already billed to the chosen PO by OTHER invoices (over-billing check).
  po_billed_other?: number;
  match_status: "no_po" | "partial" | "unmatched" | "flagged" | "ok";
  /** The PO number printed on the invoice, and whether it resolved to an order we
   *  can bill against. `framework` marks the case where it resolved to a framework
   *  — a live order, but one you bill via a call-off or a job order rather than
   *  directly, so it pins the job without being the match itself. */
  // PO number on the invoice + whether it resolved to a live order. `superseded`
  // means the number IS one of ours but was deleted; `successor` names the order
  // raised to replace it, when one was.
  po_ref: {
    quoted: string; matched: boolean; framework?: boolean; framework_project?: string;
    superseded?: boolean; superseded_at?: string | null;
    successor?: string | null; successor_type?: string | null;
  } | null;
};

// ── Contract register (Commercials → Contract) ──────────────────────────────

export type ProjectRisk = {
  id: number;
  project_id: string;
  title: string;
  category: string | null;      // commercial | programme | design | site | client | other
  likelihood: number;           // 1 (rare) … 5 (almost certain)
  impact: number;               // 1 (negligible) … 5 (severe)
  mitigation: string | null;
  owner: string | null;
  cost_exposure: number | null; // potential £ if it lands
  status: "open" | "closed";
  created_at: string;
  created_by: string | null;
  closed_at: string | null;
};

export type ProjectKeyItem = {
  id: number;
  project_id: string;
  title: string;
  detail: string | null;
  due_date: string | null;      // YYYY-MM-DD
  status: "open" | "done";
  created_at: string;
  created_by: string | null;
  done_at: string | null;
};

/** Scheduled Health & Safety pack release (one per project/site base). */
export type HsPackSchedule = {
  project_id: string;
  frequency: "weekly" | "monthly";
  weekday: number;          // 1=Mon … 7=Sun (weekly only)
  send_hour: number;        // UK local hour 0-23
  recipients: string | null;
  include_managers: number;
  active: number;
  last_sent_at: string | null;
  updated_at: string | null;
  updated_by: string | null;
};
