import type {
  AfpDetail,
  AfpDirection,
  ApplicationForPayment,
  AppUser,
  CreatePOInput,
  CurrentUser,
  Element,
  LabourByCostCode,
  MaterialWithCommitment,
  Product,
  ProductSupplier,
  Project,
  ProjectCommercial,
  PortfolioCalendarItem,
  PurchaseOrder,
  ValuationEntryType,
  ValuationScheduleEntry,
  ResourceType,
  Settings,
  Supplier,
  SupplierQuote,
  SupplierQuoteLine,
  SupplierStatus,
} from "../../shared/types";
import type { Role } from "../../shared/permissions";

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  me: () => jfetch<CurrentUser>("/api/me"),
  settings: () => jfetch<Settings>("/api/settings"),

  listProjects: () =>
    jfetch<Array<{ id: string; code: string; name: string; client: string | null; active_snapshot_id: number | null }>>(
      "/api/projects",
    ),
  getProject: (id: string) =>
    jfetch<{ project: Project; active_snapshot: { id: number; filename: string; uploaded_at: string } | null }>(
      `/api/projects/${id}`,
    ),
  updateProject: (
    id: string,
    input: Partial<Pick<Project, "name" | "client" | "client_email" | "client_contact_name" | "delivery_address" | "site_contact_name" | "site_contact_phone" | "delivery_instructions" | "retention_pct">>,
  ) => jfetch<{ ok: true }>(`/api/projects/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteProject: (id: string, reason: string) =>
    jfetch<{ ok: true }>(`/api/projects/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) }),
  listDeletedProjects: () =>
    jfetch<Array<Project & { po_count: number; deleted_at: string; deleted_by: string; deletion_reason: string }>>(
      "/api/projects/deleted",
    ),
  restoreProject: (id: string) =>
    jfetch<{ ok: true; code: string }>(`/api/projects/${id}/restore`, { method: "POST" }),
  getProjectSummary: (id: string) =>
    jfetch<{ unpriced_spend: number; by_status: Array<{ status: string; n: number; v: number }> }>(
      `/api/projects/${id}/summary`,
    ),
  createProject: (input: { code: string; name: string; client?: string }) =>
    jfetch<{ id: string }>("/api/projects", { method: "POST", body: JSON.stringify(input) }),

  listMaterials: (projectId: string) =>
    jfetch<MaterialWithCommitment[]>(`/api/materials/${projectId}`),
  listProjectCommercials: (projectId: string) =>
    jfetch<ProjectCommercial[]>(`/api/materials/${projectId}/commercials`),

  // Material substitutions ────────────────────────────────────────────────
  substituteMaterial: (
    materialId: number,
    body: {
      kind?: "like_for_like" | "equivalent_spec" | "variation";
      reason?: string | null;
      notes?: string | null;
      product_id?: number | null;
      quote_line_id?: number | null;
      replacement_item?: string;
      replacement_manufacturer?: string | null;
      replacement_supplier?: string | null;
      replacement_cost?: number | null;
      replacement_unit?: string | null;
      replacement_total_units?: number | null;
    },
  ) =>
    jfetch<{ id: number; ok: true }>(`/api/materials/${materialId}/substitute`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revertSubstitution: (id: number, reason?: string) =>
    jfetch<{ ok: true }>(`/api/materials/substitutions/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ reason }),
    }),
  listMaterialSubstitutions: (projectId: string) =>
    jfetch<Array<{
      id: number;
      material_id: number;
      kind: "like_for_like" | "equivalent_spec" | "variation";
      replacement_item: string;
      replacement_manufacturer: string | null;
      replacement_supplier: string | null;
      replacement_cost: number | null;
      replacement_unit: string | null;
      replacement_total_units: number | null;
      replacement_product_id: number | null;
      replacement_quote_line_id: number | null;
      reason: string | null;
      notes: string | null;
      active: 0 | 1;
      created_at: string; created_by: string;
      reverted_at: string | null; reverted_by: string | null; reverted_reason: string | null;
      original_item: string;
      original_manufacturer: string | null;
      original_cost: number | null;
      original_total_units: number | null;
      original_unit: string | null;
    }>>(`/api/materials/${projectId}/substitutions`),
  listLabourByCostCode: (projectId: string) =>
    jfetch<LabourByCostCode[]>(`/api/materials/${projectId}/labour-by-cost-code`),
  /**
   * Parse the workbook in the BROWSER and POST the resulting JSON to the
   * worker. The xlsx zip decode is heavy enough that doing it in a Cloudflare
   * Worker pushes against the 30s CPU / 128MB memory limits for larger files
   * — moving it to the user's browser side-steps both. The bytes never reach
   * the server.
   */
  uploadMaterials: async (projectId: string, file: File) => {
    const { parsePricingWorkbookClient } = await import("./materials-parser");
    const parsed = await parsePricingWorkbookClient(file);
    return jfetch<{ snapshot_id: number; rows: number; commercials: number; contract_items: number }>(
      `/api/materials/${projectId}/upload-parsed`,
      {
        method: "POST",
        body: JSON.stringify({
          filename: file.name,
          materials: parsed.materials,
          commercials: parsed.commercials,
          contract_items: parsed.contract_items,
        }),
      },
    );
  },

  listPOs: (q?: { project_id?: string; status?: string }) => {
    const usp = new URLSearchParams();
    if (q?.project_id) usp.set("project_id", q.project_id);
    if (q?.status) usp.set("status", q.status);
    return jfetch<Array<PurchaseOrder & { project_code: string; project_name: string }>>(
      `/api/pos${usp.toString() ? "?" + usp.toString() : ""}`,
    );
  },
  getPO: (id: string) =>
    jfetch<PurchaseOrder & { project_code: string; project_name: string }>(`/api/pos/${id}`),
  getPOActivity: (id: string) =>
    jfetch<Array<{ id: number; action: string; actor: string; details: string | null; created_at: string }>>(
      `/api/pos/${id}/activity`,
    ),
  createPO: (input: CreatePOInput) =>
    jfetch<{ id: string; po_number: string; status: string; requires_approval: boolean }>(
      "/api/pos",
      { method: "POST", body: JSON.stringify(input) },
    ),
  approvePO: (id: string) => jfetch<{ ok: true }>(`/api/pos/${id}/approve`, { method: "POST" }),
  rejectPO: (id: string, reason: string) =>
    jfetch<{ ok: true }>(`/api/pos/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  issuePO: (id: string) => jfetch<{ ok: true }>(`/api/pos/${id}/issue`, { method: "POST" }),

  listApprovers: (projectId?: string) =>
    jfetch<Array<{ id: number; project_id: string | null; tier: string; email: string; name: string | null }>>(
      `/api/approvers${projectId ? "?project_id=" + projectId : ""}`,
    ),
  addApprover: (input: { project_id?: string | null; tier: string; email: string; name?: string }) =>
    jfetch<{ id: number }>("/api/approvers", { method: "POST", body: JSON.stringify(input) }),
  updateApprover: (id: number, input: { email?: string; name?: string | null; tier?: string }) =>
    jfetch<{ ok: true }>(`/api/approvers/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  removeApprover: (id: number) =>
    jfetch<{ ok: true }>(`/api/approvers/${id}`, { method: "DELETE" }),

  // Users
  listUsers: () => jfetch<AppUser[]>("/api/users"),
  addUser: (input: { email: string; name?: string; role: Role }) =>
    jfetch<{ email: string }>("/api/users", { method: "POST", body: JSON.stringify(input) }),
  updateUser: (email: string, input: { name?: string; role?: Role; active?: boolean }) =>
    jfetch<{ ok: true }>(`/api/users/${encodeURIComponent(email)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  removeUser: (email: string) =>
    jfetch<{ ok: true }>(`/api/users/${encodeURIComponent(email)}`, { method: "DELETE" }),

  // Soft delete a PO (superadmin only).
  deletePO: (id: string, reason: string) =>
    jfetch<{ ok: true }>(`/api/pos/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ reason }),
    }),

  // Product library / taxonomy
  listElements: () => jfetch<Element[]>("/api/elements"),
  listResourceTypes: () => jfetch<ResourceType[]>("/api/resource-types"),
  listProducts: () => jfetch<Product[]>("/api/products"),
  addProduct: (input: {
    element_code: string;
    item_no?: number;
    variant?: string | null;
    description: string;
    manufacturer?: string | null;
    supplier?: string | null;
    unit?: string | null;
    unit_cost?: number | null;
    default_resource?: string;
    notes?: string | null;
  }) => jfetch<{ id: number; item_no: number; variant: string | null }>("/api/products", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  updateProduct: (
    id: number,
    input: Partial<Pick<Product, "element_code" | "item_no" | "variant" | "description" | "manufacturer" | "supplier" | "unit" | "unit_cost" | "default_resource" | "notes">>,
  ) => jfetch<{ ok: true }>(`/api/products/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }),
  removeProduct: (id: number) =>
    jfetch<{ ok: true }>(`/api/products/${id}`, { method: "DELETE" }),
  productSuggestions: () =>
    jfetch<Array<{
      key: string;
      sample_description: string;
      manufacturer: string | null;
      type: string;
      occurrences: number;
      avg_unit_cost: number | null;
      suppliers: string[];
      project_codes: string[];
      linked_product_id: number | null;
      material_ids: number[];
    }>>("/api/products/suggestions"),
  linkMaterialsToProduct: (productId: number, materialIds: number[], unlink = false) =>
    jfetch<{ ok: true; linked: number }>(`/api/products/${productId}/link-materials`, {
      method: "POST",
      body: JSON.stringify({ material_ids: materialIds, unlink }),
    }),
  researchProduct: (query: string) =>
    jfetch<{
      suggestion: {
        element_code?: string;
        manufacturer?: string;
        variant?: string;
        description?: string;
        unit?: string;
        estimated_unit_cost_gbp?: number;
        confidence?: "high" | "medium" | "low";
        notes?: string;
      };
      usage: { input_tokens: number; output_tokens: number };
    }>("/api/products/research", { method: "POST", body: JSON.stringify({ query }) }),

  // Alternate suppliers per product
  listProductSuppliers: (productId: number) =>
    jfetch<ProductSupplier[]>(`/api/products/${productId}/suppliers`),
  addProductSupplier: (productId: number, input: {
    supplier_name: string;
    unit_cost?: number | null;
    supplier_sku?: string | null;
    lead_time_days?: number | null;
    notes?: string | null;
    is_preferred?: boolean;
  }) =>
    jfetch<{ id: number }>(`/api/products/${productId}/suppliers`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateProductSupplier: (productId: number, supplierId: number, input: Partial<{
    supplier_name: string;
    unit_cost: number | null;
    supplier_sku: string | null;
    lead_time_days: number | null;
    notes: string | null;
    is_preferred: boolean;
  }>) =>
    jfetch<{ ok: true }>(`/api/products/${productId}/suppliers/${supplierId}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  removeProductSupplier: (productId: number, supplierId: number) =>
    jfetch<{ ok: true }>(`/api/products/${productId}/suppliers/${supplierId}`, {
      method: "DELETE",
    }),

  // Approved suppliers register
  listSuppliers: () => jfetch<Supplier[]>("/api/suppliers"),
  getSupplier: (id: number) => jfetch<Supplier>(`/api/suppliers/${id}`),
  addSupplier: (input: {
    name: string;
    status?: SupplierStatus;
    scope_notes?: string | null;
    payment_terms?: string | null;
    contact_name?: string | null;
    contact_email?: string | null;
    contact_phone?: string | null;
    address?: string | null;
    vat_number?: string | null;
    credit_limit_gbp?: number | null;
    notes?: string | null;
    approved_elements?: string[];
  }) => jfetch<{ id: number }>("/api/suppliers", { method: "POST", body: JSON.stringify(input) }),
  updateSupplier: (id: number, input: Partial<{
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
    approved_elements: string[];
  }>) => jfetch<{ ok: true }>(`/api/suppliers/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  removeSupplier: (id: number) =>
    jfetch<{ ok: true }>(`/api/suppliers/${id}`, { method: "DELETE" }),

  // Xero
  xeroStatus: () =>
    jfetch<{
      configured: boolean;
      connected: boolean;
      connection: {
        tenant_id: string;
        tenant_name: string | null;
        tenant_type: string | null;
        expires_at: string;
        scopes: string | null;
        connected_at: string;
        connected_by: string;
      } | null;
    }>("/api/xero/status"),
  xeroConnectUrl: () => "/api/xero/connect",
  xeroDisconnect: () => jfetch<{ ok: true }>("/api/xero/disconnect", { method: "POST" }),
  xeroSyncSuppliers: () =>
    jfetch<{ created: number; updated: number; skipped: number; total_from_xero: number }>(
      "/api/xero/sync-suppliers",
      { method: "POST" },
    ),
  xeroPushPO: (id: string) =>
    jfetch<{ ok: true; xero_po_id: string; xero_po_number: string }>(
      `/api/xero/push-po/${id}`,
      { method: "POST" },
    ),
  xeroPendingCount: () =>
    jfetch<{ pending: number }>("/api/xero/pending-count"),
  xeroBulkPush: () =>
    jfetch<{
      total: number;
      pushed: number;
      failed: number;
      results: Array<{
        po_number: string;
        supplier: string;
        ok: boolean;
        xero_po_number?: string;
        error?: string;
      }>;
    }>("/api/xero/bulk-push", { method: "POST" }),

  // Supplier quote upload pipeline ────────────────────────────────────────
  listSupplierQuotes: (supplierId: number) =>
    jfetch<SupplierQuote[]>(`/api/quotes/${supplierId}`),
  /**
   * Upload a PDF quote. Claude detects the supplier from the letterhead and
   * matches against the approved register. If `supplierId` is provided (e.g.
   * after the user confirmed which supplier to use following a 422), it skips
   * auto-detection and uses that supplier directly.
   */
  uploadQuote: (file: File, opts?: { supplierId?: number; notes?: string; projectId?: string }) => {
    const fd = new FormData();
    fd.append("file", file);
    if (opts?.notes) fd.append("notes", opts.notes);
    if (opts?.supplierId != null) fd.append("supplier_id", String(opts.supplierId));
    if (opts?.projectId) fd.append("project_id", opts.projectId);
    return jfetch<{
      quote_id: number;
      supplier_id: number;
      supplier_name: string;
      project_id: string | null;
      detected_name: string | null;
      auto_matched: boolean;
      extracted_lines: number;
    }>("/api/quotes/upload", { method: "POST", body: fd });
  },
  reassignQuoteSupplier: (quoteId: number, supplierId: number) =>
    jfetch<{ ok: true; supplier_id: number; supplier_name: string }>(
      `/api/quotes/${quoteId}/supplier`,
      { method: "PATCH", body: JSON.stringify({ supplier_id: supplierId }) },
    ),
  getQuote: (quoteId: number) =>
    jfetch<{ quote: SupplierQuote; lines: SupplierQuoteLine[] }>(
      `/api/quotes/detail/${quoteId}`,
    ),
  rematchQuoteLine: (lineId: number, product_id: number | null) =>
    jfetch<{ ok: true }>(`/api/quotes/lines/${lineId}/match`, {
      method: "PATCH",
      body: JSON.stringify({ product_id }),
    }),
  skipQuoteLine: (lineId: number, reason?: string) =>
    jfetch<{ ok: true }>(`/api/quotes/lines/${lineId}/skip`, {
      method: "PATCH",
      body: JSON.stringify({ reason }),
    }),
  applyQuote: (quoteId: number) =>
    jfetch<{
      scope: "catalogue" | "project";
      applied: number;
      total_applied_value: number;
      total_old_value: number;
      delta_value: number;
      // project-scope only
      pending_approval?: number;
      savings?: number;
      pending_overspend?: number;
    }>(`/api/quotes/${quoteId}/apply`, { method: "POST" }),
  listPendingPriceApprovals: (opts?: { project_id?: string; tier?: string }) => {
    const q = new URLSearchParams();
    if (opts?.project_id) q.set("project_id", opts.project_id);
    if (opts?.tier) q.set("tier", opts.tier);
    const qs = q.toString();
    return jfetch<import("../../shared/types").PendingPriceApproval[]>(
      `/api/quotes/_pending-prices${qs ? `?${qs}` : ""}`,
    );
  },
  decidePendingPrice: (id: number, action: "approve" | "reject", reason?: string) =>
    jfetch<{ ok: true }>(`/api/quotes/_pending-prices/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ action, reason }),
    }),

  // Applications for Payment ─────────────────────────────────────────────
  listAfps: (projectId: string, direction: AfpDirection = "outgoing") =>
    jfetch<ApplicationForPayment[]>(
      `/api/applications/project/${projectId}?direction=${direction}`,
    ),
  getAfp: (id: number) => jfetch<AfpDetail>(`/api/applications/${id}`),
  createAfp: (
    projectId: string,
    body: { period_end: string; notes?: string; direction?: AfpDirection; counterparty_supplier_id?: number | null },
  ) =>
    jfetch<{ id: number; app_number: number }>(`/api/applications/project/${projectId}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAfp: (id: number, body: { period_end?: string; notes?: string; retention_pct?: number; vat_pct?: number }) =>
    jfetch<{ ok: true }>(`/api/applications/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  updateAfpLine: (
    lineId: number,
    body: { percent_complete?: number; description?: string; qty?: number; unit?: string; rate?: number },
  ) =>
    jfetch<{ ok: true }>(`/api/applications/lines/${lineId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  addAfpLine: (
    afpId: number,
    body: { description: string; qty: number; unit?: string; rate: number; section?: string },
  ) =>
    jfetch<{ ok: true }>(`/api/applications/${afpId}/lines`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteAfpLine: (lineId: number) =>
    jfetch<{ ok: true }>(`/api/applications/lines/${lineId}`, { method: "DELETE" }),
  submitAfp: (id: number) =>
    jfetch<{ ok: true }>(`/api/applications/${id}/submit`, { method: "POST" }),
  certifyAfp: (id: number, body?: { certified_amount?: number; notes?: string }) =>
    jfetch<{ ok: true; certified_amount: number }>(`/api/applications/${id}/certify`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  markAfpPaid: (id: number, payment_reference?: string) =>
    jfetch<{ ok: true }>(`/api/applications/${id}/mark-paid`, {
      method: "POST",
      body: JSON.stringify({ payment_reference }),
    }),
  deleteAfp: (id: number) =>
    jfetch<{ ok: true }>(`/api/applications/${id}`, { method: "DELETE" }),
  approveAfp: (id: number) =>
    jfetch<{ ok: true }>(`/api/applications/${id}/approve`, { method: "POST" }),
  rejectAfp: (id: number, reason?: string) =>
    jfetch<{ ok: true }>(`/api/applications/${id}/reject`, {
      method: "POST", body: JSON.stringify({ reason }),
    }),
  listPendingAfps: () =>
    jfetch<Array<{
      id: number; app_number: number; period_end: string; direction: string;
      total_invoice: number | null; contract_sum: number | null;
      cumulative_value: number | null; submitted_at: string;
      submitted_by: string; project_code: string; project_name: string;
    }>>(`/api/applications/_pending-approval`),

  // Valuation schedule + portfolio calendar ──────────────────────────────
  listValuationEntries: (projectId: string) =>
    jfetch<ValuationScheduleEntry[]>(`/api/valuations/project/${projectId}`),
  addValuationEntry: (projectId: string, body: { app_number?: number | null; entry_type: ValuationEntryType; date: string; notes?: string }) =>
    jfetch<{ id: number }>(`/api/valuations/project/${projectId}`, {
      method: "POST", body: JSON.stringify(body),
    }),
  deleteValuationEntry: (id: number) =>
    jfetch<{ ok: true }>(`/api/valuations/entries/${id}`, { method: "DELETE" }),
  recordValuationUpload: (projectId: string, filename: string) =>
    jfetch<{ ok: true }>(`/api/valuations/project/${projectId}/upload-meta`, {
      method: "POST", body: JSON.stringify({ filename }),
    }),
  uploadValuationSchedule: (projectId: string, file: File, opts?: { replace?: boolean }) => {
    const fd = new FormData();
    fd.append("file", file);
    if (opts?.replace === false) fd.append("replace", "false");
    return jfetch<{ ok: true; parsed: boolean; entries_created: number; filename: string }>(
      `/api/valuations/project/${projectId}/upload`,
      { method: "POST", body: fd },
    );
  },
  portfolioCalendar: (opts?: { from?: string; to?: string }) => {
    const q = new URLSearchParams();
    if (opts?.from) q.set("from", opts.from);
    if (opts?.to) q.set("to", opts.to);
    return jfetch<PortfolioCalendarItem[]>(
      `/api/valuations/_portfolio${q.toString() ? `?${q}` : ""}`,
    );
  },
  discardQuote: (quoteId: number) =>
    jfetch<{ ok: true }>(`/api/quotes/${quoteId}`, { method: "DELETE" }),
  searchProductsForQuote: (q: string) =>
    jfetch<Array<{ id: number; product_code: string; description: string; manufacturer: string | null; unit: string | null; unit_cost: number | null }>>(
      `/api/quotes/_search/products?q=${encodeURIComponent(q)}`,
    ),
};

export function fmtMoney(n: number, currency = "GBP") {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);
}
export function fmtDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
