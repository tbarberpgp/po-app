import type {
  AfpDetail,
  AfpDirection,
  ApplicationForPayment,
  AppUser,
  CreatePOInput,
  UpdatePOInput,
  CurrentUser,
  Element,
  LabourByCostCode,
  MaterialWithCommitment,
  OffBoqMaterial,
  OpsSite,
  OwnedPlant,
  PlantLog,
  Product,
  ProductSupplier,
  ProgressPhoto,
  HsPackSchedule,
  Project,
  ProjectKeyItem,
  ProjectRisk,
  ProjectSiteGroup,
  PublicSite,
  RamsDocument,
  SiteBriefing,
  SiteDelivery,
  PoDeliveryStatus,
  DeliveryTicketCandidate,
  SiteGroup,
  SiteNotice,
  SiteSignin,
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
import type { RamsDoc } from "../../shared/rams";

/** Programme rows from an upload: PDFs go through the worker's Claude
 *  extraction; Excel files parse in the browser as before. Both return the
 *  same ParsedProgrammeActivity[] shape, so /import and /progress are shared. */
async function programmeActivitiesFrom(projectId: string, file: File) {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    const form = new FormData();
    form.append("file", file);
    const r = await jfetch<{ activities: import("../../shared/parse-programme").ParsedProgrammeActivity[] }>(
      `/api/programme/${projectId}/extract-pdf`,
      { method: "POST", body: form },
    );
    return r.activities;
  }
  const { parseProgrammeClient } = await import("./programme-parser");
  return parseProgrammeClient(file);
}

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
    // Worker errors come back as JSON like {"error":"…"} — unwrap so the UI
    // shows a clean message instead of the raw JSON blob. Only unwrap when
    // the payload has *just* an `error` field; callers that expect structured
    // errors (e.g. supplier_unmatched on quote upload, which carries
    // detected_name + candidates) JSON.parse the message themselves and we
    // must preserve the original body for them.
    let msg = body || `Request failed: ${res.status}`;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
        const keys = Object.keys(parsed);
        if (keys.length === 1) msg = parsed.error;
      }
    } catch { /* not JSON — keep raw */ }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  me: () => jfetch<CurrentUser>("/api/me"),
  settings: () => jfetch<Settings>("/api/settings"),

  listProjects: () =>
    jfetch<Array<{ id: string; code: string; name: string; client: string | null; active_snapshot_id: number | null; completed_at?: string | null; is_sandbox?: number }>>(
      "/api/projects",
    ),
  /** Create / re-seed the walled-off demo project (admin). Also runs nightly. */
  resetSandbox: () => jfetch<{ ok: true }>("/api/sandbox/reset", { method: "POST" }),
  getProject: (id: string) =>
    jfetch<{ project: Project; active_snapshot: { id: number; filename: string; uploaded_at: string } | null }>(
      `/api/projects/${id}`,
    ),
  updateProject: (
    id: string,
    input: Partial<Pick<Project, "name" | "client" | "client_email" | "client_contact_name" | "site_manager_email" | "delivery_address" | "site_contact_name" | "site_contact_phone" | "delivery_instructions" | "retention_pct" | "client_vat_pct" | "client_retention_pct" | "labour_vat_pct" | "labour_retention_pct" | "payment_terms" | "application_cadence">>,
  ) => jfetch<{ ok: true }>(`/api/projects/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  /** Read a contract / client-PO PDF and return its commercial particulars
   *  (nothing is applied — the UI offers them field by field). */
  extractContract: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return jfetch<{ extracted: {
      client_name?: string | null; client_contact_name?: string | null; client_email?: string | null;
      reference?: string | null; contract_sum?: number | null; payment_terms?: string | null;
      application_cadence?: string | null; retention_pct?: number | null; site_address?: string | null;
      start_date?: string | null; completion_date?: string | null;
    } }>(`/api/projects/${id}/extract-contract`, { method: "POST", body: form });
  },
  // Contract register (Commercials → Contract): risk register + key items.
  contractRegister: (projectId: string) =>
    jfetch<{ risks: ProjectRisk[]; key_items: ProjectKeyItem[] }>(`/api/projects/${projectId}/contract-register`),
  addRisk: (projectId: string, body: { title: string; category?: string; likelihood?: number; impact?: number; mitigation?: string; owner?: string; cost_exposure?: number | null }) =>
    jfetch<ProjectRisk>(`/api/projects/${projectId}/risks`, { method: "POST", body: JSON.stringify(body) }),
  updateRisk: (riskId: number, body: Partial<{ title: string; category: string | null; likelihood: number; impact: number; mitigation: string | null; owner: string | null; cost_exposure: number | null; status: "open" | "closed" }>) =>
    jfetch<ProjectRisk>(`/api/projects/risks/${riskId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteRisk: (riskId: number) =>
    jfetch<{ ok: true }>(`/api/projects/risks/${riskId}`, { method: "DELETE" }),
  addKeyItem: (projectId: string, body: { title: string; detail?: string; due_date?: string }) =>
    jfetch<ProjectKeyItem>(`/api/projects/${projectId}/key-items`, { method: "POST", body: JSON.stringify(body) }),
  updateKeyItem: (itemId: number, body: Partial<{ title: string; detail: string | null; due_date: string | null; status: "open" | "done" }>) =>
    jfetch<ProjectKeyItem>(`/api/projects/key-items/${itemId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteKeyItem: (itemId: number) =>
    jfetch<{ ok: true }>(`/api/projects/key-items/${itemId}`, { method: "DELETE" }),
  deleteProject: (id: string, reason: string) =>
    jfetch<{ ok: true }>(`/api/projects/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) }),
  listDeletedProjects: () =>
    jfetch<Array<Project & { po_count: number; deleted_at: string; deleted_by: string; deletion_reason: string }>>(
      "/api/projects/deleted",
    ),
  restoreProject: (id: string) =>
    jfetch<{ ok: true; code: string }>(`/api/projects/${id}/restore`, { method: "POST" }),
  completeProject: (id: string) =>
    jfetch<{ ok: true; completed_at: string }>(`/api/projects/${id}/complete`, { method: "POST" }),
  reopenProject: (id: string) =>
    jfetch<{ ok: true }>(`/api/projects/${id}/reopen`, { method: "POST" }),
  getProjectSummary: (id: string) =>
    jfetch<{
      unpriced_spend: number;
      unpriced_lines: Array<{ po_id: string; line_id: number; po_number: string; supplier: string | null; item: string; qty: number | null; unit: string | null; line_total: number; status: string; category?: string }>;
      by_status: Array<{ status: string; n: number; v: number }>;
      overdrawn_framework_lines: Array<{
        po_id: string; line_id: number; po_number: string; supplier: string | null; item: string; unit: string;
        framework_qty: number; framework_value: number; drawn_qty: number; drawn_value: number;
      }>;
    }>(
      `/api/projects/${id}/summary`,
    ),
  createProject: (input: { code: string; name: string; client?: string }) =>
    jfetch<{ id: string }>("/api/projects", { method: "POST", body: JSON.stringify(input) }),

  listMaterials: (projectId: string) =>
    jfetch<MaterialWithCommitment[]>(`/api/materials/${projectId}`),
  /** Materials ordered on this project's POs that aren't in the priced BOQ.
   *  Kept separate from listMaterials so the budget rollups (which read that
   *  array) can't accidentally count spend already reported as unpriced. */
  listOffBoqMaterials: (projectId: string) =>
    jfetch<OffBoqMaterial[]>(`/api/materials/${projectId}/off-boq`),
  listProjectCommercials: (projectId: string) =>
    jfetch<ProjectCommercial[]>(`/api/materials/${projectId}/commercials`),
  getContingency: (projectId: string) =>
    jfetch<{ contingency: number }>(`/api/materials/${projectId}/contingency`),
  setContingency: (projectId: string, contingency: number) =>
    jfetch<{ ok: true; contingency: number }>(`/api/materials/${projectId}/contingency`, {
      method: "POST",
      body: JSON.stringify({ contingency }),
    }),

  // Material substitutions ────────────────────────────────────────────────
  /** Mark a BOQ material as not needed for this job (name-keyed; survives
   *  workbook re-uploads). qty omits only part of the line's quantity;
   *  without it the whole line goes. Restore undoes either. */
  omitMaterial: (projectId: string, item: string, qty?: number) =>
    jfetch<{ ok: true }>(`/api/materials/${projectId}/omit`, { method: "POST", body: JSON.stringify(qty != null ? { item, qty } : { item }) }),
  restoreOmittedMaterial: (projectId: string, item: string) =>
    jfetch<{ ok: true }>(`/api/materials/${projectId}/restore-omitted`, { method: "POST", body: JSON.stringify({ item }) }),
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
      /** Quantity to substitute (part-sub). Omit/null/full = whole swap. */
      sub_units?: number | null;
    },
  ) =>
    jfetch<{ id: number; ok: true; pending?: boolean; approval_tier?: string }>(`/api/materials/${materialId}/substitute`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revertSubstitution: (id: number, reason?: string) =>
    jfetch<{ ok: true }>(`/api/materials/substitutions/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ reason }),
    }),
  /** Pending part-substitutions awaiting approval (Approvals inbox). */
  listPendingSubstitutions: (opts?: { project_id?: string; tier?: string }) => {
    const q = new URLSearchParams();
    if (opts?.project_id) q.set("project_id", opts.project_id);
    if (opts?.tier) q.set("tier", opts.tier);
    const qs = q.toString();
    return jfetch<import("../../shared/types").PendingSubstitution[]>(
      `/api/materials/substitutions/_pending${qs ? `?${qs}` : ""}`,
    );
  },
  decideSubstitution: (id: number, action: "approve" | "reject", reason?: string) =>
    jfetch<{ ok: true }>(`/api/materials/substitutions/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ action, reason }),
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
  listContractItems: (projectId: string) =>
    jfetch<import("../../shared/types").ContractItem[]>(`/api/materials/${projectId}/contract-items`),

  // ── Live labour rates (Savings from Labour) ─────────────────────────────
  listLabourRates: (projectId: string) =>
    jfetch<import("../../shared/types").LabourLiveRate[]>(`/api/materials/${projectId}/labour-rates`),
  // Parse the labour schedule in the browser (the Worker's 10ms CPU budget
  // can't decode a multi-MB cost workbook → Cloudflare 1102), then send rows.
  uploadLabourRates: async (projectId: string, file: File) => {
    const { parseLabourRatesClient } = await import("./materials-parser");
    const lines = await parseLabourRatesClient(file);
    return jfetch<{
      applied: number;
      pending: number;
      unmatched: number;
      savings: number;
      applied_lines: Array<{ contract_item_id: number; description: string; boq_rate: number; live_rate: number; qty: number; saving: number }>;
      pending_lines: Array<{ contract_item_id: number; description: string; boq_rate: number; live_rate: number; qty: number; saving: number }>;
      unmatched_lines: Array<{ description: string; rate: number; unit: string | null }>;
    }>(`/api/materials/${projectId}/labour-rates/upload-parsed`, {
      method: "POST",
      body: JSON.stringify({ filename: file.name, lines }),
    });
  },
  approveLabourRate: (projectId: string, id: number) =>
    jfetch<{ ok: true }>(`/api/materials/${projectId}/labour-rates/${id}/approve`, { method: "POST" }),
  allocateLabourRate: (projectId: string, id: number, contractItemId: number) =>
    jfetch<{ ok: true; status: string }>(`/api/materials/${projectId}/labour-rates/${id}/allocate`, {
      method: "POST",
      body: JSON.stringify({ contract_item_id: contractItemId }),
    }),
  deleteLabourRate: (projectId: string, id: number) =>
    jfetch<{ ok: true }>(`/api/materials/${projectId}/labour-rates/${id}`, { method: "DELETE" }),
  clearLabourRates: (projectId: string) =>
    jfetch<{ ok: true }>(`/api/materials/${projectId}/labour-rates`, { method: "DELETE" }),

  // ── Variations register ─────────────────────────────────────────────────
  listVariations: (projectId: string) =>
    jfetch<import("../../shared/types").Variation[]>(`/api/variations/${projectId}`),
  createVariation: (projectId: string, body: {
    description: string;
    sell_value: number;
    notes?: string;
    materials: Array<{ product_id?: number | null; material_id?: number | null; description: string; manufacturer?: string | null; qty: number; unit?: string | null; unit_rate: number }>;
    labour: Array<{ description: string; qty: number; unit_rate: number }>;
    labour_absorbed?: boolean;
  }) =>
    jfetch<{ id: number; variation_no: number }>(`/api/variations/${projectId}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateVariation: (id: number, body: {
    description?: string;
    sell_value?: number;
    status?: string;
    materials?: Array<{ product_id?: number | null; material_id?: number | null; description: string; manufacturer?: string | null; qty: number; unit?: string | null; unit_rate: number }>;
    labour?: Array<{ description: string; qty: number; unit_rate: number }>;
    labour_absorbed?: boolean;
  }) =>
    jfetch<{ ok: true }>(`/api/variations/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteVariation: (id: number) =>
    jfetch<{ ok: true }>(`/api/variations/${id}`, { method: "DELETE" }),
  approveVariation: (id: number) =>
    jfetch<{ ok: true; approved_at: string; approved_by: string }>(`/api/variations/${id}/approve`, { method: "POST" }),
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
    return jfetch<{ snapshot_id: number; pending: boolean; rows: number; commercials: number; contract_items: number }>(
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
  // Pricing-upload approval (non-superadmin uploads park as pending).
  getPendingUpload: (projectId: string) =>
    jfetch<{ snapshot_id: number; filename: string; uploaded_at: string; uploaded_by: string; rows?: number } | null>(`/api/materials/${projectId}/pending-upload`),
  approvePendingUpload: (projectId: string) =>
    jfetch<{ ok: true }>(`/api/materials/${projectId}/pending-upload/approve`, { method: "POST" }),
  rejectPendingUpload: (projectId: string) =>
    jfetch<{ ok: true }>(`/api/materials/${projectId}/pending-upload/reject`, { method: "POST" }),
  listPendingUploads: () =>
    jfetch<Array<{ project_id: string; project_code: string | null; project_name: string | null; filename: string; uploaded_at: string; uploaded_by: string; rows?: number }>>(`/api/materials/_pending/uploads`),

  listPOs: (q?: { project_id?: string; status?: string }) => {
    const usp = new URLSearchParams();
    if (q?.project_id) usp.set("project_id", q.project_id);
    if (q?.status) usp.set("status", q.status);
    return jfetch<Array<PurchaseOrder & { project_code: string; project_name: string }>>(
      `/api/pos${usp.toString() ? "?" + usp.toString() : ""}`,
    );
  },
  getPO: (id: string) =>
    jfetch<PurchaseOrder & {
      project_code: string; project_name: string;
      call_offs?: Array<{ id: string; po_number: string; status: string; total_value: number; created_at: string }>;
      parent?: { id: string; po_number: string } | null;
    }>(`/api/pos/${id}`),
  /** Frameworks a call-off may draw against — every framework across the site
   *  group, so a grouped site can buy once and call off per block. */
  groupFrameworks: (projectId: string) =>
    jfetch<Array<{ id: string; po_number: string; supplier: string; project_id: string; project_code: string }>>(
      `/api/pos/group/frameworks?project_id=${encodeURIComponent(projectId)}`),
  makeFramework: (id: string) => jfetch<{ ok: true }>(`/api/pos/${id}/make-framework`, { method: "POST" }),
  calloffLines: (frameworkId: string) =>
    jfetch<{
      framework: { id: string; po_number: string; supplier: string; order_type: string | null };
      lines: Array<{
        material_id: number | null; item: string; manufacturer: string | null; type: string | null;
        unit: string; unit_cost: number; framework_qty: number; called_off_qty: number; available_qty: number;
      }>;
    }>(`/api/pos/${frameworkId}/calloff-lines`),
  setPoCategory: (id: string, category: "materials" | "prelims") =>
    jfetch<{ ok: true; category: string }>(`/api/pos/${id}/category`, { method: "POST", body: JSON.stringify({ category }) }),
  prelimsSummary: (projectId: string) =>
    jfetch<{
      budget: number; po_committed: number; po_count: number;
      plant_accrued: number; plant_count: number;
      by_type: Array<{ type: string; committed: number; po_count: number }>;
      headings: Array<{ name: string; budget: number; committed: number; po_count: number; remaining: number }>;
    }>(`/api/materials/${projectId}/prelims`),
  getPOActivity: (id: string) =>
    jfetch<Array<{ id: number; action: string; actor: string; details: string | null; created_at: string }>>(
      `/api/pos/${id}/activity`,
    ),
  createPO: (input: CreatePOInput) =>
    jfetch<{ id: string; po_number: string; status: string; requires_approval: boolean }>(
      "/api/pos",
      { method: "POST", body: JSON.stringify(input) },
    ),
  /** Code EVERY line of a PO to one budget line (whole-order coding). */
  assignPoBudget: (poId: string, materialId: number | null) =>
    jfetch<{ ok: true; material_id: number | null; lines: number }>(`/api/pos/${poId}/assign-budget`, {
      method: "POST", body: JSON.stringify({ material_id: materialId }),
    }),
  /** Code a PO line to a budget line after the fact (retro POs → costs within the budget). */
  assignPoLineBudget: (poId: string, lineId: number, materialId: number | null) =>
    jfetch<{ ok: true; material_id: number | null }>(`/api/pos/${poId}/lines/${lineId}/assign-budget`, {
      method: "POST", body: JSON.stringify({ material_id: materialId }),
    }),
  updatePO: (id: string, input: UpdatePOInput) =>
    jfetch<{ id: string; total: number; requires_approval: boolean; xero?: { ok: boolean; error?: string } }>(
      `/api/pos/${id}`,
      { method: "PUT", body: JSON.stringify(input) },
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
  mergeProduct: (id: number, targetId: number) =>
    jfetch<{ ok: true; target_id: number; moved_offers: number; relinked_materials: number }>(
      `/api/products/${id}/merge-into`, { method: "POST", body: JSON.stringify({ target_id: targetId }) }),
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
      substitution_ids: number[];
    }>>("/api/products/suggestions"),
  dismissSuggestion: (key: string, projectCodes: string[]) =>
    jfetch<{ ok: true; dismissed: number }>("/api/products/suggestions/dismiss", {
      method: "POST",
      body: JSON.stringify({ key, project_codes: projectCodes }),
    }),
  restoreSuggestions: () =>
    jfetch<{ ok: true }>("/api/products/suggestions/restore", { method: "POST" }),
  linkMaterialsToProduct: (
    productId: number,
    materialIds: number[],
    opts: { substitutionIds?: number[]; unlink?: boolean } = {},
  ) =>
    jfetch<{ ok: true; linked: number }>(`/api/products/${productId}/link-materials`, {
      method: "POST",
      body: JSON.stringify({
        material_ids: materialIds,
        substitution_ids: opts.substitutionIds ?? [],
        unlink: opts.unlink ?? false,
      }),
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
  /** Mark a PO as arriving in parts (ordered whole, delivered piecemeal). */
  setPoPartDelivery: (id: string, part: boolean) =>
    jfetch<{ ok: true; part_delivery: boolean }>(`/api/pos/${id}/part-delivery`, { method: "POST", body: JSON.stringify({ part_delivery: part }) }),
  /** Create (or link) a labour supplier from an AfP's extracted sender details
   *  and assign them as the application's counterparty. */
  createSupplierFromAfp: (afpId: number, name?: string) =>
    jfetch<{ id: number; linked_existing: boolean; captured: string[] }>(`/api/applications/${afpId}/create-supplier`, {
      method: "POST", body: JSON.stringify({ name }),
    }),
  /** Create (or link) an approved supplier from an invoice's extracted details
   *  (address, VAT no, terms, contact, bank) and link the invoice to it. */
  createSupplierFromInvoice: (id: number, name?: string) =>
    jfetch<{ id: number; linked_existing: boolean; captured: string[] }>(`/api/invoices/${id}/create-supplier`, {
      method: "POST", body: JSON.stringify({ name }),
    }),
  addSupplier: (input: {
    name: string;
    status?: SupplierStatus;
    is_labour_supplier?: boolean;
    scope_notes?: string | null;
    payment_terms?: string | null;
    contact_name?: string | null;
    contact_email?: string | null;
    contact_phone?: string | null;
    address?: string | null;
    vat_number?: string | null;
    utr?: string | null;
    credit_limit_gbp?: number | null;
    notes?: string | null;
    approved_elements?: string[];
  }) => jfetch<{ id: number; xero_pushed?: boolean }>("/api/suppliers", { method: "POST", body: JSON.stringify(input) }),
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
    utr: string | null;
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
  // Microsoft Graph mailbox pull (inbound email ingestion without forwarding).
  mailboxPullStatus: () =>
    jfetch<{
      configured: boolean;
      mailboxes: Array<{ mailbox: string; as: string; folder: string }>;
      last_runs: Array<{ ran_at: string; ok: number; mailboxes: number; fetched: number; ingested: number; error: string | null }>;
      total_ingested: number;
    }>("/api/mailbox-pull/status"),
  mailboxPullRun: () =>
    jfetch<{ ran: boolean; mailboxes: number; fetched: number; ingested: number; errors: string[] }>(
      "/api/mailbox-pull/run", { method: "POST" }),
  xeroRecheckPaid: () =>
    jfetch<{ client_checked: number; client_marked_paid: number; bills_scanned: number; bills_marked_paid: number }>(
      "/api/xero/recheck-paid",
      { method: "POST" },
    ),
  xeroSyncSuppliers: () =>
    jfetch<{ created: number; updated: number; skipped: number; total_from_xero: number; pushed?: number; push_failed?: string[] }>(
      "/api/xero/sync-suppliers",
      { method: "POST" },
    ),
  xeroPushPO: (id: string) =>
    jfetch<{ ok: true; xero_po_id: string; xero_po_number: string }>(
      `/api/xero/push-po/${id}`,
      { method: "POST" },
    ),
  xeroPushSupplier: (id: number) =>
    jfetch<{ ok: true; created?: boolean; synced?: boolean; xero_contact_id: string; name?: string }>(
      `/api/xero/push-supplier/${id}`,
      { method: "POST" },
    ),
  /** Push a certified labour certificate to Xero as a draft PO to the subbie. */
  xeroPushAfp: (id: number) =>
    jfetch<{ ok: true; xero_po_id: string; xero_po_number: string }>(
      `/api/xero/push-afp/${id}`,
      { method: "POST" },
    ),
  /** Raise a live ACCREC sales invoice in Xero for a certified client application. */
  xeroPushInvoice: (id: number) =>
    jfetch<{ ok: true; xero_invoice_id: string; xero_invoice_number: string; tracked: boolean }>(
      `/api/xero/push-invoice/${id}`,
      { method: "POST" },
    ),
  xeroInvoiceConfig: () =>
    jfetch<{
      sales_account_code: string | null;
      po_account_code: string | null;
      labour_account_code: string | null;
      cis_account_code: string | null;
    }>("/api/xero/invoice-config"),
  xeroSetAccounts: (input: {
    sales_account_code?: string;
    po_account_code?: string;
    labour_account_code?: string;
    cis_account_code?: string;
  }) =>
    jfetch<{
      sales_account_code: string | null;
      po_account_code: string | null;
      labour_account_code: string | null;
      cis_account_code: string | null;
    }>("/api/xero/invoice-config", { method: "POST", body: JSON.stringify(input) }),
  /** Live chart of accounts from Xero for the Admin account-code selects. */
  xeroAccounts: () =>
    jfetch<{ accounts: Array<{ code: string; name: string; type: string; class: string }>; error?: string }>("/api/xero/accounts"),

  /* ── Accounts / invoices workpiece ──────────────────────────────────── */
  listInvoices: (status?: string) =>
    jfetch<import("../../shared/types").Invoice[]>(`/api/invoices${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  getInvoice: (id: number) =>
    jfetch<import("../../shared/types").Invoice>(`/api/invoices/${id}`),
  uploadInvoice: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return jfetch<{ id: number; extracted: boolean }>("/api/invoices/upload", { method: "POST", body: fd });
  },
  updateInvoice: (id: number, body: Partial<{
    kind: "project" | "overhead"; project_id: string | null; nominal_code: string | null;
    supplier_id: number | null; supplier_name: string | null; invoice_number: string | null;
    invoice_date: string | null; due_date: string | null;
    net_amount: number | null; vat_amount: number | null; gross_amount: number | null;
    notes: string | null; status: string;
  }>) => jfetch<{ ok: true }>(`/api/invoices/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  dismissInvoice: (id: number) =>
    jfetch<{ ok: true }>(`/api/invoices/${id}/dismiss`, { method: "POST" }),
  pushInvoiceXero: (id: number) =>
    jfetch<{ ok: true; xero_bill_id: string; xero_bill_number?: string }>(`/api/invoices/${id}/push-xero`, { method: "POST" }),
  invoiceFileUrl: (id: number) => `/api/invoices/${id}/file`,
  /** Re-run extraction on the stored file (e.g. to pick up the PO number). */
  reextractInvoice: (id: number) =>
    jfetch<{ ok: true; po_number: string | null }>(`/api/invoices/${id}/reextract`, { method: "POST" }),
  /** 3-way match: reconcile an invoice against its PO and logged deliveries. */
  invoiceMatch: (id: number) =>
    jfetch<import("../../shared/types").InvoiceMatch>(`/api/invoices/${id}/match`),
  saveInvoiceMatch: (id: number, body: { po_id: string | null; line_po_ids?: Array<number | null> }) =>
    jfetch<{ ok: true }>(`/api/invoices/${id}/match`, { method: "POST", body: JSON.stringify(body) }),
  /** Goods collected from the merchant (no ticket) — log receipt against the PO. */
  markInvoiceCollected: (id: number) =>
    jfetch<{ ok: true; lines: number }>(`/api/invoices/${id}/mark-collected`, { method: "POST" }),
  approveInvoice: (id: number, note?: string) =>
    jfetch<{ ok: true; approved_at: string; pushed?: boolean; xero_bill_number?: string | null; xero_error?: string; attach_warning?: string }>(`/api/invoices/${id}/approve`, { method: "POST", body: JSON.stringify({ note: note ?? "" }) }),
  unapproveInvoice: (id: number) =>
    jfetch<{ ok: true }>(`/api/invoices/${id}/approve`, { method: "POST", body: JSON.stringify({ unapprove: true }) }),
  /** Raise a PO retrospectively from an invoice that arrived without one.
   *  `replace` re-points an invoice that's already matched to the wrong PO. */
  createPoFromInvoice: (id: number, opts?: { replace?: boolean }) =>
    jfetch<{ ok: true; po_id: string; po_number: string; status: string }>(`/api/invoices/${id}/create-po`, { method: "POST", body: JSON.stringify({ replace: opts?.replace === true }) }),
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
  /** Portfolio-wide list of all applications across projects (Applications workspace). */
  listAllApplications: (filters?: { direction?: AfpDirection; status?: string; unassigned?: boolean }) => {
    const qs = new URLSearchParams();
    if (filters?.direction) qs.set("direction", filters.direction);
    if (filters?.status) qs.set("status", filters.status);
    if (filters?.unassigned) qs.set("unassigned", "1");
    const q = qs.toString();
    return jfetch<import("../../shared/types").ApplicationListItem[]>(
      `/api/applications${q ? `?${q}` : ""}`,
    );
  },
  getAfp: (id: number) => jfetch<AfpDetail>(`/api/applications/${id}`),
  createAfp: (
    projectId: string,
    body: { period_end: string; notes?: string; direction?: AfpDirection; counterparty_supplier_id?: number | null },
  ) =>
    jfetch<{ id: number; app_number: number }>(`/api/applications/project/${projectId}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /**
   * Upload a subcontractor's labour application (PDF, Word .docx or XLSX). Claude extracts
   * the priced lines, fuzzy-matches them to BOQ contract items, and creates a
   * draft incoming_labour AfP with the matched lines pre-populated. Unmatched
   * lines are stored on the AfP for review on the detail page.
   */
  uploadLabourApp: (
    projectId: string,
    file: File,
    body: { counterparty_supplier_id: number; period_end: string; notes?: string; period_mode?: boolean },
  ) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("counterparty_supplier_id", String(body.counterparty_supplier_id));
    fd.append("period_end", body.period_end);
    if (body.notes) fd.append("notes", body.notes);
    if (body.period_mode) fd.append("period_mode", "1");
    return jfetch<{ id: number; app_number: number; extracted_count: number; matched_count: number; unmatched_count: number }>(
      `/api/applications/project/${projectId}/upload-labour`,
      { method: "POST", body: fd },
    );
  },
  /** Upload ONE combined workbook (a tab per block) → one draft AfP per block. */
  uploadCombinedLabourApp: (
    file: File,
    body: { counterparty_supplier_id: number; period_end: string; notes?: string; period_mode?: boolean },
  ) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("counterparty_supplier_id", String(body.counterparty_supplier_id));
    fd.append("period_end", body.period_end);
    if (body.notes) fd.append("notes", body.notes);
    if (body.period_mode) fd.append("period_mode", "1");
    return jfetch<{
      created: Array<{ code: string; project_id: string; afp_id: number; app_number: number; extracted: number; matched: number; unmatched: number }>;
      skipped: Array<{ code: string; reason: string }>;
    }>("/api/applications/upload-combined-labour", { method: "POST", body: fd });
  },
  /** Upload OUR combined application to the client (one workbook, a tab per
   *  block) → ONE outgoing draft AfP on the group's base project carrying
   *  every block's BOQ. */
  uploadCombinedClientApp: (
    file: File,
    body: { period_end: string; notes?: string },
  ) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("period_end", body.period_end);
    if (body.notes) fd.append("notes", body.notes);
    return jfetch<{ id: number; app_number: number; extracted_count: number; matched_count: number; unmatched_count: number }>(
      "/api/applications/upload-combined-client",
      { method: "POST", body: fd },
    );
  },
  /* ── Labour supplier ↔ bill-item allocations ──────────────────────── */
  labourAllocations: (projectId: string) =>
    jfetch<Array<{ id: number; contract_item_id: number; supplier_id: number; allocated_value: number | null; item_no: number; description: string; labour_total: number | null; supplier_name: string }>>(
      `/api/applications/project/${projectId}/labour-allocations`),
  addLabourAllocation: (projectId: string, body: { contract_item_id: number; supplier_id: number; allocated_value?: number | null }) =>
    jfetch<{ ok: true }>(`/api/applications/project/${projectId}/labour-allocations`, { method: "POST", body: JSON.stringify(body) }),
  deleteLabourAllocation: (id: number) =>
    jfetch<{ ok: true }>(`/api/applications/labour-allocations/${id}`, { method: "DELETE" }),

  /** Inbound tray — emails parked without a resolvable project. */
  listInboundApplications: () =>
    jfetch<import("../../shared/types").InboundApplication[]>("/api/applications/inbound"),
  resolveInboundApplication: (id: number, body: { project_id: string; counterparty_supplier_id?: number | null; period_mode?: boolean }) =>
    jfetch<{ id: number; app_number: number; extracted_count: number; matched_count: number; unmatched_count: number }>(
      `/api/applications/inbound/${id}/resolve`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  dismissInboundApplication: (id: number) =>
    jfetch<{ ok: true }>(`/api/applications/inbound/${id}/dismiss`, { method: "POST" }),
  /** Resolve one of the unmatched lines on a draft AfP. */
  resolveUnmatchedLine: (
    afpId: number,
    rawLineNo: number,
    body: {
      action: "assign" | "assign_split" | "dismiss" | "add_as_variation" | "add_as_expense" | "add_as_adjustment";
      contract_item_id?: number;
      /** assign_split: the line's cost portioned over several BOQ lines. */
      parts?: Array<{ contract_item_id: number; value: number }>;
      mode?: "add" | "set";
    },
  ) =>
    jfetch<{ ok: true; remaining: number }>(
      `/api/applications/${afpId}/unmatched/${rawLineNo}/resolve`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Undo a resolved unmatched line — reverse its effect + send it back to unmatched. */
  undoResolvedLine: (afpId: number, rawLineNo: number) =>
    jfetch<{ ok: true }>(`/api/applications/${afpId}/resolved/${rawLineNo}/undo`, { method: "POST" }),
  updateAfp: (id: number, body: { period_end?: string; notes?: string; retention_pct?: number; vat_pct?: number; counterparty_supplier_id?: number | null; prelim_heading?: string | null }) =>
    jfetch<{ ok: true }>(`/api/applications/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  updateAfpLine: (
    lineId: number,
    body: { percent_complete?: number; certified_percent?: number; description?: string; qty?: number; unit?: string; rate?: number },
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
  /** Re-read a stored application file with the current parser (uncertified only). */
  rereadAfpSource: (id: number) =>
    jfetch<{ ok: true; extracted: number; matched: number; unmatched: number; cumulative_value: number; amount_due: number }>(
      `/api/applications/${id}/reread-source`, { method: "POST" }),
  unsubmitAfp: (id: number) =>
    jfetch<{ ok: true }>(`/api/applications/${id}/unsubmit`, { method: "POST" }),
  submitAfp: (id: number) =>
    jfetch<{ ok: true }>(`/api/applications/${id}/submit`, { method: "POST" }),
  certifyAfp: (id: number, body?: { certified_amount?: number; notes?: string }) =>
    jfetch<{ ok: true; certified_amount: number }>(`/api/applications/${id}/certify`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  /** Approve a certified labour certificate for payment (flag-don't-block); a
   *  note is required when paying over the budgeted labour. Gates the Xero push. */
  approveAfpPayment: (id: number, note?: string) =>
    jfetch<{ ok: true; pay_approved_at?: string }>(`/api/applications/${id}/approve-payment`, {
      method: "POST",
      body: JSON.stringify({ note: note ?? "" }),
    }),
  unapproveAfpPayment: (id: number) =>
    jfetch<{ ok: true }>(`/api/applications/${id}/approve-payment`, {
      method: "POST",
      body: JSON.stringify({ unapprove: true }),
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
  /** Re-rate flagged labour line(s) to the agreed live/BOQ rate. Omit lineId to
   *  re-rate every flagged line. */
  rerateAfp: (id: number, lineId?: number) =>
    jfetch<{ ok: true; updated: number }>(`/api/applications/${id}/rerate`, {
      method: "POST",
      body: JSON.stringify(lineId != null ? { line_id: lineId } : {}),
    }),
  /** Director sign-off of a labour rate variance (reason required). */
  rateOverrideAfp: (id: number, reason: string) =>
    jfetch<{ ok: true; rate_override_at: string; rate_override_by: string }>(
      `/api/applications/${id}/rate-override`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),
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
  /** Wipe a project's entire payment schedule (all valuation dates). */
  clearValuationSchedule: (projectId: string) =>
    jfetch<{ ok: true; deleted: number }>(`/api/valuations/project/${projectId}`, { method: "DELETE" }),
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

  // ── Operations (Phase 1) ──────────────────────────────────────────────────
  opsSites: () => jfetch<OpsSite[]>("/api/operations/sites"),
  opsGetSiteLink: (projectId: string) =>
    jfetch<{ token: string | null }>(`/api/operations/${projectId}/site-link`),
  opsEnsureSiteLink: (projectId: string) =>
    jfetch<{ token: string }>(`/api/operations/${projectId}/site-link`, { method: "POST" }),
  opsRotateSiteLink: (projectId: string) =>
    jfetch<{ token: string }>(`/api/operations/${projectId}/site-link/rotate`, { method: "POST" }),
  /** Sign-ins + recorded briefing/toolbox acknowledgements for a date range. */
  opsAttendanceExport: (projectId: string, from: string, to: string) =>
    jfetch<{
      from: string; to: string;
      signins: Array<{ id: number; name: string; company: string | null; trade: string | null; phone: string | null; signature: string | null; signed_in_at: string; signed_out_at: string | null; signed_out_auto: number; briefing_tag: string | null }>;
      acks: Array<{ signin_id: number | null; name: string; acked_at: string; notice_type: string; title: string; notice_date: string; company: string | null; trade: string | null }>;
      /** Every daily-briefing version accepted in the range, tagged B1, B2, … */
      briefings: Array<{ tag: string; title: string; content: string | null; effective_from: string }>;
    }>(`/api/operations/${projectId}/attendance/export?from=${from}&to=${to}`),
  /** Correct a sign-out time (HH:MM, applied on the sign-in's UK calendar day). */
  opsEditSignoutTime: (projectId: string, signinId: number, time: string) =>
    jfetch<{ ok: true; signed_out_at: string }>(`/api/operations/${projectId}/attendance/${signinId}/signout-time`, {
      method: "PATCH", body: JSON.stringify({ time }),
    }),
  /** Preformed toolbox talks — org-level library, reusable on every site. */
  opsToolboxTemplates: () =>
    jfetch<Array<{ id: string; title: string; content: string | null; file_name: string | null; file_type: string | null; required: number; display_order: number | null; has_doc: number }>>(
      "/api/operations/toolbox-templates"),
  opsToolboxTemplate: (id: string) =>
    jfetch<{ id: string; title: string; content: string | null; html_content: string | null; file_key: string | null; file_name: string | null; file_type: string | null; required: number }>(
      `/api/operations/toolbox-templates/${id}`),
  opsUploadToolboxTemplate: (fd: FormData) =>
    jfetch<{ id: string; title: string }>("/api/operations/toolbox-templates", { method: "POST", body: fd }),
  opsDeleteToolboxTemplate: (id: string) =>
    jfetch<{ ok: true }>(`/api/operations/toolbox-templates/${id}`, { method: "DELETE" }),
  /** Admin-only: log a delivery that arrived with NO ticket against a PO —
   *  whole order, or received quantities per line. Flagged as manual. */
  manualDeliveryCheckIn: (projectId: string, body: {
    po_id: string; whole_order?: boolean; delivered_at?: string; notes?: string;
    lines?: Array<{ po_line_id: number; po_line_desc?: string; received_qty: number; received_unit?: string }>;
  }) =>
    jfetch<{ ok: true; ids: number[] }>(`/api/operations/${projectId}/deliveries/manual-check-in`, {
      method: "POST", body: JSON.stringify(body),
    }),
  /** H&S pack data: the attendance export payload plus toolbox talks (full
   *  copy) and the crew's qualification register. */
  opsHsPackData: (projectId: string, from: string, to: string) =>
    jfetch<Awaited<ReturnType<typeof api.opsAttendanceExport>> & {
      /** `doc` is the parsed talk — the pack reproduces it with its headings,
       *  bullets and tables. Declare it or the next edit here silently drops it
       *  and the pack quietly falls back to a wall of plain text. */
      talks: Array<{
        id: number; title: string; content: string | null; notice_date: string; created_by: string | null;
        doc: RamsDoc | null;
      }>;
      quals: Array<{ operative: string; company: string | null; trade: string | null; qual_type: string | null; card_no: string | null; expiry_date: string | null; verified_at: string | null; source: string | null }>;
    }>(`/api/operations/${projectId}/hs-pack?from=${from}&to=${to}`),
  opsHsPackSchedule: (projectId: string) =>
    jfetch<HsPackSchedule | null>(`/api/operations/${projectId}/hs-pack/schedule`),
  opsSaveHsPackSchedule: (projectId: string, body: { frequency: string; weekday: number; send_hour: number; recipients: string; include_managers: boolean; active: boolean }) =>
    jfetch<HsPackSchedule>(`/api/operations/${projectId}/hs-pack/schedule`, { method: "PUT", body: JSON.stringify(body) }),
  opsHsPackSendNow: (projectId: string, from: string, to: string) =>
    jfetch<{ ok: true; sent_to: string[] }>(`/api/operations/${projectId}/hs-pack/send-now`, {
      method: "POST", body: JSON.stringify({ from, to }),
    }),
  opsAttendance: (projectId: string, date?: string) =>
    jfetch<SiteSignin[]>(`/api/operations/${projectId}/attendance${date ? `?date=${date}` : ""}`),
  /** Manager signs a single operative out (closes their open sign-in). */
  opsSignOut: (projectId: string, signinId: number) =>
    jfetch<{ ok: true; signed_out: boolean }>(`/api/operations/${projectId}/attendance/${signinId}/signout`, { method: "POST" }),
  /** Manager signs everyone still on site out at once (end of day). */
  opsSignOutAll: (projectId: string) =>
    jfetch<{ ok: true; count: number }>(`/api/operations/${projectId}/attendance/signout-all`, { method: "POST" }),
  /** DEMO PROJECT ONLY — sign an operative in by hand to walk the sign-in →
   *  briefing → toolbox-talk flow through without being at a real site. The
   *  worker rejects this for any other project: a live register has to be the
   *  operative's own act, not something a manager can type in. */
  opsManualSignIn: (projectId: string, operativeId: string) =>
    jfetch<{ ok: true; id: number | null; already_on_site: boolean }>(
      `/api/operations/${projectId}/attendance/manual-signin`,
      { method: "POST", body: JSON.stringify({ operative_id: operativeId }) }),
  opsNotices: (projectId: string) =>
    jfetch<SiteNotice[]>(`/api/operations/${projectId}/notices`),
  opsGetBriefing: (projectId: string) =>
    jfetch<SiteBriefing | null>(`/api/operations/${projectId}/briefing`),
  opsSetBriefing: (projectId: string, input: { title: string; content: string }) =>
    jfetch<SiteBriefing | null>(`/api/operations/${projectId}/briefing`, { method: "PUT", body: JSON.stringify(input) }),
  opsClearBriefing: (projectId: string) =>
    jfetch<{ ok: true }>(`/api/operations/${projectId}/briefing`, { method: "DELETE" }),
  opsDraftBriefing: (projectId: string, prompt: string) =>
    jfetch<{ title: string; content: string }>(`/api/operations/${projectId}/briefing/draft`, { method: "POST", body: JSON.stringify({ prompt }) }),
  opsCreateNotice: (projectId: string, input: { type: SiteNotice["type"]; title: string; content?: string; notice_date?: string; template_id?: string }) =>
    jfetch<{ id: number }>(`/api/operations/${projectId}/notices`, { method: "POST", body: JSON.stringify(input) }),
  /** Push a recorded talk to the crew — email + SMS their profile link, and
   *  track sent/acknowledged per operative (the RAMS-distribute equivalent). */
  opsDistributeToolboxTalk: (body: { notice_id: number; project_id: string; operative_ids: string[] }) =>
    jfetch<{
      ok: true; sent: number; emailed: number; texted: number;
      /** How many pushes were suppressed by the 3-minute invite de-dupe. */
      cooldown: number;
    }>("/api/operatives/toolbox/distribute", {
      method: "POST", body: JSON.stringify(body),
    }),
  opsToolboxRecipients: (noticeId: number) =>
    jfetch<Array<{
      operative_id: string; name: string; company: string | null;
      requested_at: string; acked_at: string | null;
      /** The evidence: their signature, and where they were when they signed.
       *  geo_status 'denied'/'unavailable' = signed, location not recorded. */
      signature: string | null; lat: number | null; lng: number | null;
      accuracy: number | null; geo_status: "ok" | "denied" | "unavailable" | null;
    }>>(`/api/operations/notices/${noticeId}/recipients`),
  opsUpdateNotice: (id: number, input: Partial<Pick<SiteNotice, "type" | "title" | "content" | "notice_date" | "active">>) =>
    jfetch<{ ok: true }>(`/api/operations/notices/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  opsDeleteNotice: (id: number) =>
    jfetch<{ ok: true }>(`/api/operations/notices/${id}`, { method: "DELETE" }),
  opsPlant: (projectId: string) =>
    jfetch<PlantLog[]>(`/api/operations/${projectId}/plant`),
  opsAddPlant: (projectId: string, input: { item: string; supplier?: string; on_hire_from?: string; off_hire_to?: string; day_rate?: number; rate_unit?: "day" | "week"; notes?: string; po_id?: string; expected_weeks?: number; expected_off_hire?: string }) =>
    jfetch<{ id: number }>(`/api/operations/${projectId}/plant`, { method: "POST", body: JSON.stringify(input) }),
  opsUpdatePlant: (id: number, input: Partial<Pick<PlantLog, "item" | "supplier" | "on_hire_from" | "off_hire_to" | "day_rate" | "rate_unit" | "notes" | "expected_weeks" | "expected_off_hire">>) =>
    jfetch<{ ok: true }>(`/api/operations/plant/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  opsDeletePlant: (id: number) =>
    jfetch<{ ok: true }>(`/api/operations/plant/${id}`, { method: "DELETE" }),

  // ── Site groups (bundle contracts that are areas of one physical site) ────
  opsSiteGroups: () => jfetch<SiteGroup[]>("/api/operations/site-groups"),
  opsCreateSiteGroup: (input: { name: string; project_ids: string[]; base_project_id?: string }) =>
    jfetch<{ id: string; base_project_id: string }>("/api/operations/site-groups", { method: "POST", body: JSON.stringify(input) }),
  opsUpdateSiteGroup: (id: string, input: { name?: string; project_ids?: string[]; base_project_id?: string }) =>
    jfetch<{ ok: true }>(`/api/operations/site-groups/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  opsDeleteSiteGroup: (id: string) =>
    jfetch<{ ok: true }>(`/api/operations/site-groups/${id}`, { method: "DELETE" }),
  /** The site group a project belongs to (members + base), or null if ungrouped. */
  opsProjectSiteGroup: (projectId: string) =>
    jfetch<ProjectSiteGroup | null>(`/api/operations/${projectId}/site-group`),

  // ── Owned / purchased plant (master register, transferred between sites) ──
  ownedPlant: () => jfetch<OwnedPlant[]>("/api/owned-plant"),
  ownedPlantByProject: (projectId: string) => jfetch<OwnedPlant[]>(`/api/owned-plant/by-project/${projectId}`),
  addOwnedPlant: (input: { name: string; asset_no?: string; category?: string; supplier?: string; notes?: string; assigned_project_id?: string | null }) =>
    jfetch<{ id: string }>("/api/owned-plant", { method: "POST", body: JSON.stringify(input) }),
  updateOwnedPlant: (id: string, input: Partial<Pick<OwnedPlant, "name" | "asset_no" | "category" | "supplier" | "notes">>) =>
    jfetch<{ ok: true }>(`/api/owned-plant/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  assignOwnedPlant: (id: string, projectId: string | null) =>
    jfetch<{ ok: true }>(`/api/owned-plant/${id}/assign`, { method: "POST", body: JSON.stringify({ project_id: projectId }) }),
  deleteOwnedPlant: (id: string) =>
    jfetch<{ ok: true }>(`/api/owned-plant/${id}`, { method: "DELETE" }),
  addOwnedPlantTest: (id: string, input: { test_type: string; tested_on?: string; expiry_date?: string; notes?: string }) =>
    jfetch<{ id: string }>(`/api/owned-plant/${id}/tests`, { method: "POST", body: JSON.stringify(input) }),
  deleteOwnedPlantTest: (testId: string) =>
    jfetch<{ ok: true }>(`/api/owned-plant/tests/${testId}`, { method: "DELETE" }),

  // ── Public operative sign-in (no auth; token is the capability) ───────────
  pubGetSite: (token: string) => jfetch<PublicSite>(`/pub/site/${token}`),
  pubSignIn: (token: string, input: {
    operative_id?: string;
    name: string; company?: string; trade?: string; phone?: string;
    signature?: string; lat?: number; lng?: number; accuracy?: number;
    ack_notice_ids?: number[]; briefing_ack?: boolean;
  }) => jfetch<{ id: number }>(`/pub/site/${token}/signin`, { method: "POST", body: JSON.stringify(input) }),
  pubSignOut: (token: string, signinId: number) =>
    jfetch<{ ok: true }>(`/pub/site/${token}/signout`, { method: "POST", body: JSON.stringify({ signin_id: signinId }) }),

  // ── Operations Phase 2 — files (deliveries, RAMS, progress photos) ────────
  /** URL for an R2-backed file; pass download=true for an attachment. */
  opsFileUrl: (key: string, download = false) =>
    `/api/operations/file?key=${encodeURIComponent(key)}${download ? "&download=1" : ""}`,

  opsDeliveries: (projectId: string) =>
    jfetch<SiteDelivery[]>(`/api/operations/${projectId}/deliveries`),
  /** Per-line delivery burn-down for the site's open POs. */
  opsPoDeliveryStatus: (projectId: string) =>
    jfetch<PoDeliveryStatus[]>(`/api/operations/${projectId}/deliveries/po-status`),
  opsAddDelivery: (projectId: string, form: FormData) =>
    jfetch<{ id: number }>(`/api/operations/${projectId}/deliveries`, { method: "POST", body: form }),
  /** Scan a delivery ticket (photo/PDF) → extract fields + match to a project PO. */
  opsScanDelivery: (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return jfetch<{
      extracted: { po_number: string; supplier_name: string; delivery_note_number: string; delivery_date: string; summary: string; items: Array<{ description: string; qty: number | null; unit: string | null }> };
      matched_po: { id: string; po_number: string; supplier: string | null; order_type: string | null; project_id: string; project_code: string; matched_by: "po_number" | "supplier" } | null;
      candidates: Array<{ id: string; po_number: string; supplier: string | null; order_type: string | null; project_id: string; project_code: string; score: number }>;
    }>(`/api/operations/${projectId}/deliveries/scan`, { method: "POST", body: fd });
  },
  /** Cross-project scan (Projects workspace): extract fields + find which live
   *  project's PO the ticket belongs to, by PO number. */
  opsScanDeliveryGlobal: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return jfetch<{
      extracted: { po_number: string; supplier_name: string; delivery_note_number: string; delivery_date: string; summary: string; items: Array<{ description: string; qty: number | null; unit: string | null }> };
      matched_po: { id: string; po_number: string; supplier: string | null; order_type: string | null; project_id: string; project_code: string; project_name: string; matched_by: "po_number" } | null;
      candidates: Array<{ id: string; po_number: string; supplier: string | null; order_type: string | null; project_id: string; project_code: string; project_name: string; score: number }>;
    }>(`/api/operations/deliveries/scan`, { method: "POST", body: fd });
  },
  opsDeleteDelivery: (id: number) =>
    jfetch<{ ok: true }>(`/api/operations/deliveries/${id}`, { method: "DELETE" }),
  /** Move a delivery to another site / reassign its supplier or PO. */
  opsReassignDelivery: (id: number, body: Record<string, string>) =>
    jfetch<{ ok: true }>(`/api/operations/deliveries/${id}/reassign`, {
      method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
    }),

  // ── WhatsApp delivery tickets ─────────────────────────────────────────────
  /** Scan a batch of un-scanned WhatsApp site photos for delivery tickets. */
  opsScanWhatsappTickets: (projectId: string, limit = 8) =>
    jfetch<{ scanned: number; tickets: number; remaining: number }>(
      `/api/operations/${projectId}/deliveries/scan-whatsapp`,
      { method: "POST", body: JSON.stringify({ limit }), headers: { "content-type": "application/json" } },
    ),
  /** Pending WhatsApp ticket candidates + how many photos are still unscanned. */
  /** Cross-project deliveries inbox: every pending ticket + the KPI strip. */
  opsDeliveriesInbox: () =>
    jfetch<{
      kpi: { expected_today: number; overdue: number; checked_in_today: number; needs_po: number };
      candidates: import("../../shared/types").DeliveryTicketCandidate[];
      checked_in: import("../../shared/types").CheckedInTicket[];
    }>("/api/operations/deliveries-inbox"),
  opsTicketCandidates: (projectId: string) =>
    jfetch<{ unscanned: number; candidates: DeliveryTicketCandidate[] }>(
      `/api/operations/${projectId}/deliveries/ticket-candidates`),
  opsDismissTicketCandidate: (projectId: string, id: number) =>
    jfetch<{ ok: true }>(`/api/operations/${projectId}/deliveries/ticket-candidates/${id}/dismiss`, { method: "POST" }),
  /** Turn a candidate into one or more logged deliveries (optional overrides,
   *  incl. a `lines` array for a multi-line note). */
  opsCheckInTicketCandidate: (projectId: string, id: number, overrides?: Record<string, unknown>) =>
    jfetch<{ id: number | null; ids?: number[] }>(`/api/operations/${projectId}/deliveries/ticket-candidates/${id}/check-in`, {
      method: "POST", body: JSON.stringify(overrides || {}), headers: { "content-type": "application/json" },
    }),
  /** Re-read pending ticket candidates with the latest extractor (one bounded pass). */
  opsRescanTicketCandidates: (projectId: string, before: string, limit = 5) =>
    jfetch<{ rescanned: number; still_tickets: number; remaining: number }>(
      `/api/operations/${projectId}/deliveries/rescan`,
      { method: "POST", body: JSON.stringify({ before, limit }), headers: { "content-type": "application/json" } },
    ),
  /** Suggest which PO a ticket belongs to from its item product codes. */
  opsSuggestPoForCandidate: (projectId: string, id: number) =>
    jfetch<{ suggested_po_id: string | null; item_codes?: string[]; ranked: Array<{ id: string; po_number: string; supplier: string | null; order_type: string | null; project_id: string; project_code: string; hits: number }> }>(
      `/api/operations/${projectId}/deliveries/ticket-candidates/${id}/suggest`),
  /** Full reconciliation of a ticket against a chosen (or best-guess) PO — the
   *  PO's lines with ordered qty + cumulative prior receipts, and the ticket's
   *  items matched to those lines. `poId` overrides which PO to reconcile. */
  opsReconcileTicket: (projectId: string, id: number, poId?: string) =>
    jfetch<import("../../shared/types").TicketReconciliation>(
      `/api/operations/${projectId}/deliveries/ticket-candidates/${id}/reconcile${poId ? `?po_id=${encodeURIComponent(poId)}` : ""}`),

  opsRams: (projectId: string) =>
    jfetch<{ documents: RamsDocument[]; operative_certs: import("../../shared/types").OperativeCert[] }>(`/api/operations/${projectId}/rams`),
  opsUploadRams: (projectId: string, form: FormData) =>
    jfetch<{ id: number }>(`/api/operations/${projectId}/rams`, { method: "POST", body: form }),
  opsUpdateRams: (id: number, input: { active?: boolean; title?: string; category?: string; version?: string; expiry_date?: string | null }) =>
    jfetch<{ ok: true }>(`/api/operations/rams/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  opsDeleteRams: (id: number) =>
    jfetch<{ ok: true }>(`/api/operations/rams/${id}`, { method: "DELETE" }),

  opsPhotos: (projectId: string) =>
    jfetch<ProgressPhoto[]>(`/api/operations/${projectId}/photos`),
  opsUploadPhoto: (projectId: string, form: FormData) =>
    jfetch<{ id: number }>(`/api/operations/${projectId}/photos`, { method: "POST", body: form }),
  opsDeletePhoto: (id: number) =>
    jfetch<{ ok: true }>(`/api/operations/photos/${id}`, { method: "DELETE" }),

  // ── Operatives register (manager-facing) ──────────────────────────────────
  operatives: () =>
    jfetch<Array<import("../../shared/types").Operative & { qual_count: number; rams_pending: number; qual_worst: string; quals_pending: number; assigned_project_code: string | null }>>(
      "/api/operatives",
    ),
  /** Operatives currently assigned to one site, for the project's Operatives tab. */
  operativesByProject: (projectId: string) =>
    jfetch<Array<{
      id: string; name: string; company: string | null; trade: string | null;
      phone: string | null; email: string | null; induction_done: number;
      assigned_at: string | null; qual_count: number; rams_pending: number;
      qual_worst: string; quals_pending: number; on_site: boolean;
      /** Signed in today at all, even if they've since signed out — the crew a
       *  toolbox talk delivered today covers. `on_site` is only who's here now. */
      signed_in_today: boolean;
      site_inducted: number; site_inducted_at: string | null;
      quals: Array<{ type: string; status: string }>;
    }>>(`/api/operatives/by-project/${projectId}`),
  /** Confirm/clear an operative's SITE induction for a project. */
  setSiteInduction: (id: string, projectId: string, done: boolean) =>
    jfetch<{ ok: true; site_inducted: boolean }>(`/api/operatives/${id}/site-induction`, {
      method: "POST", body: JSON.stringify({ project_id: projectId, done }),
    }),
  /** Assign/reassign an operative to a single site. Reassigning notifies the old site. */
  assignOperative: (id: string, projectId: string) =>
    jfetch<{ ok: true; reassigned: boolean; notified: boolean }>(`/api/operatives/${id}/assign`, {
      method: "POST", body: JSON.stringify({ project_id: projectId }),
    }),
  unassignOperative: (id: string) =>
    jfetch<{ ok: true }>(`/api/operatives/${id}/unassign`, { method: "POST" }),
  operative: (id: string) =>
    jfetch<{
      operative: import("../../shared/types").Operative;
      quals: import("../../shared/types").OperativeQual[];
      rams: import("../../shared/types").OperativeRamsRow[];
    }>(`/api/operatives/${id}`),
  createOperative: (input: { name: string; phone?: string; company?: string; trade?: string; email?: string; emergency_contact?: string; induction_done?: boolean }) =>
    jfetch<{ id: string; token: string; invited: { email: boolean; sms: boolean } }>("/api/operatives", { method: "POST", body: JSON.stringify(input) }),
  /** Import validated bulk-upload rows. Matched (by mobile) operatives are only
   *  updated when `overwrite` is set; error rows are skipped server-side too. */
  bulkImportOperatives: (rows: import("../../shared/operatives-import").OperativeImportRow[], overwrite = false) =>
    jfetch<{ added: number; updated: number; skipped: number; new_ids: string[] }>(
      "/api/operatives/bulk-import", { method: "POST", body: JSON.stringify({ rows, overwrite }) }),
  bulkInviteOperatives: (ids: string[]) =>
    jfetch<{ sent: number; failed: number; failures: Array<{ id: string; name: string; email: string | null; reason: string }> }>(
      "/api/operatives/bulk-invite", { method: "POST", body: JSON.stringify({ ids }) }),
  updateOperative: (id: string, input: { name?: string; phone?: string; company?: string; trade?: string; email?: string; emergency_contact?: string; notes?: string; induction_done?: boolean }) =>
    jfetch<{ ok: true }>(`/api/operatives/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  archiveOperative: (id: string) =>
    jfetch<{ ok: true }>(`/api/operatives/${id}/archive`, { method: "POST" }),
  /** Re-send the profile link to the operative on every channel we have (email + SMS). */
  emailOperativeLink: (id: string) =>
    jfetch<{ ok: true; email: boolean; sms: boolean }>(`/api/operatives/${id}/email-link`, { method: "POST" }),

  // ── Admin reporting dashboard ─────────────────────────────────────────────
  reportDashboard: (opts?: { project_id?: string; months?: number }) => {
    const q = new URLSearchParams();
    if (opts?.project_id) q.set("project_id", opts.project_id);
    if (opts?.months) q.set("months", String(opts.months));
    const qs = q.toString();
    return jfetch<{
      filter: { project_id: string | null; months: number };
      projects: { active: number; completed: number; with_boq: number };
      pos: {
        committed_value: number; paid_value: number; paid_count: number; outstanding_value: number;
        pending_approval: number;
        by_status: Array<{ status: string; n: number; value: number }>;
        monthly: Array<{ month: string; count: number; value: number }>;
      };
      prelims: { budget: number; committed: number; po_count: number; plant_accrued: number };
      applications: { client: { applied: number; certified: number; paid: number }; labour: { applied: number; certified: number; paid: number } };
      operations: { on_site_now: number; signins_today: number; plant_on_site: number; daily: Array<{ date: string; signins: number }> };
      compliance: { operatives: number; inducted: number; cards: { valid: number; expiring: number; expired: number; pending: number; worst_label: string | null }; rams: { signed: number; awaiting: number }; plant_tests: { valid: number; expiring: number; expired: number } };
      xero: { connected: boolean; tenant: string | null; pos_synced: number; pos_unsynced: number; pos_failed: number; invoices_raised: number };
      signals: { variations_pending: number; afp_awaiting_cert: number; framework_overdrawn: number };
      by_project: Array<{
        id: string; code: string; name: string; completed_at: string | null; client_retention_pct: number;
        committed: number; paid: number; pending: number; applied: number; certified: number; on_site: number;
        contract_value: number; contract_cost: number; ffa: number; ffc: number;
        contract_gp_pct: number | null; forecast_gp_pct: number | null;
        labour_budget: number; labour_expended: number;
        prelim_budget: number; prelim_committed: number;
      }>;
      key_dates: Array<{ date: string; entry_type: string; app_number: number | null; project_code: string; project_name: string }>;
      cash_monthly: Array<{ month: string; cash_in: number; cash_out: number; invoices_due: number; labour_due?: number; labour_applied?: number; receivables_due?: number; revenue: number }>;
    }>(`/api/reports/dashboard${qs ? `?${qs}` : ""}`);
  },
  /** Row-level contributors behind one month of the dashboard cash charts. */
  reportCashDetail: (month: string, project_id?: string) => {
    const q = new URLSearchParams({ month });
    if (project_id) q.set("project_id", project_id);
    return jfetch<{ month: string; rows: Array<{ kind: string; detail: string; date: string | null; amount: number }> }>(
      `/api/reports/cash-detail?${q}`);
  },
  /** Derived future cash projection (applications / labour / materials). */
  reportCashOutlook: (project_id?: string, months_fwd = 6) => {
    const q = new URLSearchParams({ months_fwd: String(months_fwd) });
    if (project_id) q.set("project_id", project_id);
    return jfetch<{
      from: string;
      months: Array<{ month: string; projected_in: number; projected_out: number }>;
      basis: Array<{ month: string; kind: string; detail: string; date: string | null; amount: number; adj_id?: number }>;
      assumptions: string[];
    }>(`/api/reports/cash-outlook?${q}`);
  },
  /** Manual outlook adjustment: a user-entered projected line (−£ reduces). */
  addCashAdjustment: (input: { project_id?: string | null; month: string; direction: "in" | "out"; amount: number; label: string }) =>
    jfetch<{ id: number }>("/api/reports/cash-adjustments", { method: "POST", body: JSON.stringify(input) }),
  deleteCashAdjustment: (id: number) =>
    jfetch<{ ok: true }>(`/api/reports/cash-adjustments/${id}`, { method: "DELETE" }),
  addOperativeQual: (id: string, form: FormData) =>
    jfetch<{ id: string }>(`/api/operatives/${id}/quals`, { method: "POST", body: form }),
  verifyOperativeQual: (qid: string) =>
    jfetch<{ ok: true }>(`/api/operatives/quals/${qid}/verify`, { method: "POST" }),
  deleteOperativeQual: (qid: string) =>
    jfetch<{ ok: true }>(`/api/operatives/quals/${qid}`, { method: "DELETE" }),
  ramsOptions: () =>
    jfetch<Array<{ rams_id: number; title: string; project_id: string; project_code: string }>>("/api/operatives/rams/options"),
  assignRams: (id: string, input: { rams_id: number; project_id: string }) =>
    jfetch<{ ok: true }>(`/api/operatives/${id}/rams`, { method: "POST", body: JSON.stringify(input) }),
  /** Bulk-distribute one RAMS doc to many operatives (Operations → RAMS → Distribute). */
  distributeRams: (input: { rams_id: number; project_id: string; operative_ids: string[] }) =>
    jfetch<{ ok: true; sent: number; emailed: number; texted: number }>("/api/operatives/rams/distribute", { method: "POST", body: JSON.stringify(input) }),
  operativeFileUrl: (key: string) => `/api/operatives/file?key=${encodeURIComponent(key)}`,

  // ── Public operative profile (no auth; token is the capability) ───────────
  pubOperative: (token: string) =>
    jfetch<{
      operative: { name: string; company: string | null; trade: string | null; phone: string | null; email: string | null; induction_done: boolean; induction_at: string | null };
      site_induction: { project_code: string; inducted_at: string | null } | null;
      company_induction: { available: boolean; has_html: boolean; filename: string | null };
      quals: Array<{ id: string; qual_type: string; card_no: string | null; expiry_date: string | null; status: string; file_url: string | null }>;
      rams: Array<{ id: string; title: string; project_code: string; signed_at: string | null; has_html: boolean; doc_url: string; content_url: string }>;
      /** Toolbox talks pushed to this operative — read through, then acknowledge (never signed). */
      toolbox_talks?: Array<{ id: string; title: string; project_code: string; notice_date: string; acked_at: string | null; has_doc: boolean; content_url: string }>;
    }>(`/pub/operative/${token}`),
  /** One talk's readable content — structured sections drive the gated reader. */
  pubToolboxContent: (token: string, id: string) =>
    jfetch<{ title: string; project_code: string; notice_date: string; acked_at: string | null; doc: unknown; html: string | null; text: string | null }>(
      `/pub/operative/${token}/toolbox-content/${id}`),
  /** Sign off a talk: the operative's finger signature, plus where they were.
   *  Location is best-effort — geo_status carries why it's missing so the record
   *  says "not recorded" rather than silently looking like it wasn't asked for. */
  pubAckToolbox: (token: string, id: string, body: {
    signature: string;
    lat: number | null; lng: number | null; accuracy: number | null;
    geo_status: "ok" | "denied" | "unavailable" | null;
  }) =>
    jfetch<{ ok: true; acked_at: string }>(`/pub/operative/${token}/toolbox-ack/${id}`, {
      method: "POST", body: JSON.stringify(body),
    }),
  /** The published company induction document, for the operative to read. */
  pubCompanyInduction: () =>
    jfetch<{ available: boolean; filename?: string; html?: string | null; file_url?: string | null }>("/pub/company-induction"),
  pubConfirmInduction: (token: string) =>
    jfetch<{ ok: true; inducted_at?: string; already?: boolean }>(`/pub/operative/${token}/confirm-induction`, { method: "POST" }),
  // ── Company induction (admin: set the standard induction document) ─────────
  getCompanyInduction: () =>
    jfetch<{ filename: string | null; has_html: boolean; has_file: boolean; file_type: string | null; updated_at: string | null; updated_by: string | null }>("/api/company-induction"),
  setCompanyInduction: (form: FormData) =>
    jfetch<{ ok: true }>("/api/company-induction", { method: "POST", body: form }),
  /** Lazy-load a RAMS's phone-readable HTML for the inline scroll-to-sign reader. */
  pubRamsContent: (token: string, signId: string) =>
    jfetch<{ title: string; project_code: string; html: string | null; sections: import("../../shared/rams").RamsDoc | null }>(`/pub/operative/${token}/rams-content/${signId}`),
  pubSignRams: (token: string, input: { sign_id: string; signature: string }) =>
    jfetch<{ ok: true }>(`/pub/operative/${token}/sign-rams`, { method: "POST", body: JSON.stringify(input) }),
  pubAddOperativeQual: (token: string, form: FormData) =>
    jfetch<{ ok: true }>(`/pub/operative/${token}/quals`, { method: "POST", body: form }),

  // ── Cabin QITP ───────────────────────────────────────────────────────────
  qitpDashboard: (projectId: string) =>
    jfetch<import("../../shared/types").QitpDashboard>(`/api/qitp/${projectId}/dashboard`),
  pubCabin: (token: string) =>
    jfetch<import("../../shared/types").QitpCabinDetail>(`/pub/cabin/${token}`),
  pubCabinSetSection: (token: string, sectionId: number, input: { status?: string; notes?: string; photo_ref?: string; inspector?: string; company?: string; checks?: boolean[]; entries?: string[] }) =>
    jfetch<{ ok: true }>(`/pub/cabin/${token}/section/${sectionId}`, { method: "POST", body: JSON.stringify(input) }),
  pubCabinSign: (token: string, sectionId: number, input: { party: string; name: string; signature: string }) =>
    jfetch<{ ok: true; signed_at: string }>(`/pub/cabin/${token}/section/${sectionId}/sign`, { method: "POST", body: JSON.stringify(input) }),
  pubCabinPhoto: (token: string, sectionId: number, form: FormData) =>
    jfetch<{ ok: true; photos: Array<{ id: number; section_id: number; item_index: number | null; caption: string | null }> }>(`/pub/cabin/${token}/section/${sectionId}/photo`, { method: "POST", body: form }),
  pubCabinPhotoCaption: (token: string, photoId: number, caption: string) =>
    jfetch<{ ok: true; caption: string | null }>(`/pub/cabin/${token}/photo/${photoId}/caption`, { method: "POST", body: JSON.stringify({ caption }) }),
  pubCabinDeletePhoto: (token: string, photoId: number) =>
    jfetch<{ ok: true }>(`/pub/cabin/${token}/photo/${photoId}`, { method: "DELETE" }),
  qitpUnsign: (token: string, sectionId: number) =>
    jfetch<{ ok: true }>(`/api/qitp/unsign/${token}/${sectionId}`, { method: "POST" }),
  qitpClientLink: (projectId: string) =>
    jfetch<{ token: string | null }>(`/api/qitp/${projectId}/client-link`),
  qitpCreateClientLink: (projectId: string) =>
    jfetch<{ token: string }>(`/api/qitp/${projectId}/client-link`, { method: "POST" }),

  // ── Programme (works programme / Gantt) ──────────────────────────────────
  listProgramme: (projectId: string) =>
    jfetch<import("../../shared/types").ProgrammeActivity[]>(`/api/programme/${projectId}`),
  importProgramme: async (projectId: string, file: File) => {
    const activities = await programmeActivitiesFrom(projectId, file);
    return jfetch<{ ok: true; activities: number; baseline_was_set: boolean; tagged?: number; billItems?: number; components?: number; pendingBill?: boolean }>(
      `/api/programme/${projectId}/import`,
      { method: "POST", body: JSON.stringify({ filename: file.name, activities }) },
    );
  },
  updateProgrammeProgress: async (projectId: string, file: File) => {
    const activities = await programmeActivitiesFrom(projectId, file);
    return jfetch<{ ok: true; updated: number; skipped: number; total: number }>(
      `/api/programme/${projectId}/progress`,
      { method: "POST", body: JSON.stringify({ filename: file.name, activities }) },
    );
  },
  autoTagProgramme: (projectId: string) =>
    jfetch<{ ok: true; tagged: number; billItems: number; components: number; pendingBill: boolean }>(`/api/programme/${projectId}/auto-tag`, { method: "POST" }),
  updateProgrammeActivity: (
    projectId: string,
    id: number,
    patch: { pct_complete?: number; actual_start?: string | null; actual_finish?: string | null; planned_start?: string | null; planned_finish?: string | null },
  ) => jfetch<{ ok: true }>(`/api/programme/${projectId}/activities/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  setProgrammeBaseline: (projectId: string) =>
    jfetch<{ ok: true }>(`/api/programme/${projectId}/baseline`, { method: "POST" }),
  clearProgramme: (projectId: string) =>
    jfetch<{ ok: true }>(`/api/programme/${projectId}`, { method: "DELETE" }),
  // Programme ↔ BOQ/material links + stock demand
  listActivityItems: (projectId: string, activityId: number) =>
    jfetch<Array<{ id: number; contract_item_id: number | null; material_id: number | null; qty: number | null; unit: string | null; description: string | null; bill_name: string | null; bill_qty: number | null; bill_unit: string | null; component_count: number }>>(
      `/api/programme/${projectId}/activities/${activityId}/items`),
  addActivityItem: (projectId: string, activityId: number, body: { contract_item_id?: number; material_id?: number; qty?: number; description?: string; unit?: string }) =>
    jfetch<{ ok: true; id: number }>(`/api/programme/${projectId}/activities/${activityId}/items`, { method: "POST", body: JSON.stringify(body) }),
  deleteActivityItem: (projectId: string, itemId: number) =>
    jfetch<{ ok: true }>(`/api/programme/${projectId}/items/${itemId}`, { method: "DELETE" }),
  programmeStockDemand: (projectId: string) =>
    jfetch<Array<{ block_id: string; block: string | null; item: string; unit: string | null; required_qty: number; needed_by: string | null; on_order: number; delivered: number; installed: number; substituted_from?: string | null }>>(
      `/api/programme/${projectId}/stock-demand`),
  programmePortfolio: () =>
    jfetch<Array<{ id: string; project_id: string; title: string; subtitle: string | null; is_block: boolean; activities: number; pct_complete: number; planned_finish: string | null; baseline_finish: string | null; slip_days: number | null; active_this_week: number; overdue: number }>>(
      `/api/programme/_portfolio/summary`),

  // ── Daily / weekly site reports (WhatsApp → reports) ──────────────────────
  listSiteReports: (opts?: { project?: string; period?: "daily" | "weekly" }) => {
    const q = new URLSearchParams();
    if (opts?.project) q.set("project", opts.project);
    if (opts?.period) q.set("period", opts.period);
    const qs = q.toString();
    return jfetch<Array<{ id: number; project_id: string | null; period_type: "daily" | "weekly"; period_start: string; period_end: string; update_count: number; status: string; generated_at: string; project_code: string | null; project_name: string | null; from_whatsapp: number }>>(
      `/api/site-reports${qs ? `?${qs}` : ""}`);
  },
  getSiteReport: (id: number) =>
    jfetch<{ id: number; project_id: string | null; period_type: "daily" | "weekly"; period_start: string; period_end: string; summary_md: string | null; data_json: string | null; update_count: number; status: string; generated_at: string; generated_by: string | null; project_code: string | null; project_name: string | null }>(
      `/api/site-reports/${id}`),
  generateSiteReport: (body: { project_id: string; period_type: "daily" | "weekly"; date?: string }) =>
    jfetch<{ id: number }>(`/api/site-reports/generate`, { method: "POST", body: JSON.stringify(body) }),
  whatsappStatus: () =>
    jfetch<Array<{ project_id: string; code: string; name: string; connected: boolean; group_name: string | null; last_at: string | null; wa_count: number; email_count: number; updates: number }>>(
      `/api/site-reports/whatsapp-status`),
  whatsappGroups: () =>
    jfetch<{ configured: boolean; connected: boolean; error: string | null; groups: Array<{ chat_id: string; name: string; members: number | null; last_at: string | null; suggested: { project_id: string; code: string; name: string } | null }> }>(
      `/api/site-reports/whatsapp-groups`),
  linkWhatsappGroup: (input: { chat_id: string; group_name: string; project_id: string }) =>
    jfetch<{ ok: true; rerouted: number }>(`/api/site-reports/whatsapp-groups/link`, { method: "POST", body: JSON.stringify(input) }),
  pendingCorrespondence: () =>
    jfetch<Array<{ id: number; sender: string; subject: string; body: string; received_at: string }>>(`/api/site-reports/correspondence`),
  allocateCorrespondence: (id: number, project_id: string) =>
    jfetch<{ ok: true }>(`/api/site-reports/correspondence/${id}/allocate`, { method: "POST", body: JSON.stringify({ project_id }) }),
  dismissCorrespondence: (id: number) =>
    jfetch<{ ok: true }>(`/api/site-reports/correspondence/${id}/dismiss`, { method: "POST" }),
  sendSiteReport: (id: number, to?: string[]) =>
    jfetch<{ ok: true; sent_to: string[] }>(`/api/site-reports/${id}/send`, { method: "POST", body: JSON.stringify({ to }) }),
  listReportPhotos: (id: number) =>
    jfetch<Array<{ id: number; url: string; caption: string; taken_on: string }>>(`/api/site-reports/${id}/photos`),
  saveReportPhotos: (id: number, photos: Array<{ url: string; caption?: string }>) =>
    jfetch<{ ok: true; count: number }>(`/api/site-reports/${id}/photos`, { method: "PATCH", body: JSON.stringify({ photos }) }),
  saveReport: (id: number, sections: unknown) =>
    jfetch<{ ok: true }>(`/api/site-reports/${id}`, { method: "PATCH", body: JSON.stringify({ sections }) }),
  listProjectUpdates: (projectId: string, start: string, end: string) =>
    jfetch<Array<{ id: number; source: string; sender: string | null; body: string | null; media_url: string | null; occurred_at: string }>>(
      `/api/site-reports/${projectId}/updates?start=${start}&end=${end}`),
  addProjectUpdate: (projectId: string, body: { body: string; sender?: string; occurred_at?: string }) =>
    jfetch<{ ok: true }>(`/api/site-reports/${projectId}/updates`, { method: "POST", body: JSON.stringify(body) }),

  // ── Auto-distribute rules ──────────────────────────────────────────────────
  listDistributionRules: () =>
    jfetch<Array<{ id: number; project_id: string | null; name: string | null; frequency: "daily" | "weekly" | "both" | "monthly"; format: "pdf" | "link" | "pdf_link"; recipients: string; send_time: string | null; only_if: "always" | "skip_quiet"; enabled: number; include_managers: number; project_code: string | null; project_name: string | null;
      /** 'report' = site reports; 'hs_pack' = the site's H&S pack release (0109). */
      content: "report" | "hs_pack"; weekday: number | null; last_sent_at: string | null }>>(
      "/api/site-reports/distribution-rules"),
  saveDistributionRule: (rule: { id?: number; project_id?: string | null; name?: string; content?: "report" | "hs_pack"; frequency: string; format: string; recipients: string[]; send_time?: string; only_if?: string; enabled?: boolean; include_managers?: boolean; weekday?: number | null }) =>
    rule.id
      ? jfetch<{ ok: true }>(`/api/site-reports/distribution-rules/${rule.id}`, { method: "PUT", body: JSON.stringify(rule) })
      : jfetch<{ id: number }>("/api/site-reports/distribution-rules", { method: "POST", body: JSON.stringify(rule) }),
  deleteDistributionRule: (id: number) =>
    jfetch<{ ok: true }>(`/api/site-reports/distribution-rules/${id}`, { method: "DELETE" }),
};

export function fmtMoney(n: number, currency = "GBP") {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);
}
export function fmtDate(iso: string | null | undefined) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
/** Quantities (pack/area units): thousands separators, max 2dp — keeps parsed
 *  float noise (226.9999998) and long fractions out of every table. */
export function fmtQty(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
}
