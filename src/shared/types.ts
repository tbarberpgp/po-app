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
  type: string;
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
  committed_qty: number;       // sum of approved/issued PO line qty for this item
  remaining_qty: number | null; // total_qty - committed_qty (null if not priced)
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
  supplier: string | null;
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
