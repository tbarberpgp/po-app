export type Project = {
  id: string;
  code: string;
  name: string;
  client: string | null;
  currency: string;
  delivery_address: string | null;
  site_contact_name: string | null;
  site_contact_phone: string | null;
  delivery_instructions: string | null;
  created_at: string;
  created_by: string;
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
};

export type MaterialWithCommitment = Material & {
  committed_qty: number;
  remaining_qty: number | null;
  product_id?: number | null;
  product_element_code?: string | null;  // when linked to a master product
  /** Joined from elements table when element_code is set — canonical name for display. */
  element_name?: string | null;
  /** Latest applied/approved quote-driven unit price for this material on this project. */
  live_unit_price?: number | null;
  /** Supplier name behind the live price, when applicable. */
  live_supplier_name?: string | null;
  /** Number of pending price approvals for this material — surfaced on the row. */
  pending_price_count?: number;
};

export type ApprovalTier = "line_manager" | "commercial_manager" | "director";
export type ApprovalReason = "over_budget" | "unpriced" | "both";
export type POStatus = "draft" | "pending_approval" | "approved" | "rejected" | "issued";

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
};

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
  // Soft delete
  deleted_at?: string | null;
  deleted_by?: string | null;
  deletion_reason?: string | null;
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
  credit_limit_gbp: number | null;
  notes: string | null;
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
  section: string | null;
  description: string;
  qty: number;
  unit: string | null;
  sell_rate: number;
  sell_total: number;
  labour_rate: number | null;
  labour_total: number | null;
};

export type AfpDirection = "outgoing" | "incoming_labour";
export type AfpStatus = "draft" | "submitted" | "certified" | "paid";

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
  // joined fields
  line_count?: number;
  project_code?: string;
  project_name?: string;
  project_client?: string | null;
  project_retention_pct?: number;
};

/** One line on an AfP — BOQ-derived (links to contract_item) or ad-hoc. */
export type AfpLine = {
  id: number;
  afp_id: number;
  contract_item_id: number | null;
  section: string | null;
  description: string;
  unit: string | null;
  qty: number | null;
  rate: number;
  contract_value: number;
  percent_complete: number;
  cumulative_value: number;
  is_adhoc: 0 | 1;
  display_order: number;
};

/** Bundle returned by GET /api/applications/:id — the AfP, its lines, and the
 *  prior AfPs so the UI can show the previously-certified column. */
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
};

/** One labour-by-cost-code row aggregated from the materials table. */
export type LabourByCostCode = {
  element_code: string;
  element_name: string | null;
  cost_code: string;          // PRJ.ELE.L derived server-side
  line_count: number;
  labour_total: number;
  material_total: number;
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

export type Settings = {
  tier_threshold_line_manager: number;
  tier_threshold_commercial_manager: number;
  tier_threshold_director: number;
  currency: string;
};
