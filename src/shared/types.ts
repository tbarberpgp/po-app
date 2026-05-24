export type Project = {
  id: string;
  code: string;
  name: string;
  client: string | null;
  currency: string;
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

export type CurrentUser = {
  email: string;
  is_approver: boolean;
  approver_tiers: ApprovalTier[];
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
