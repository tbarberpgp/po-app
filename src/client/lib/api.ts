import type {
  AppUser,
  CreatePOInput,
  CurrentUser,
  Element,
  MaterialWithCommitment,
  Product,
  Project,
  PurchaseOrder,
  ResourceType,
  Settings,
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
    input: Partial<Pick<Project, "name" | "client" | "delivery_address" | "site_contact_name" | "site_contact_phone" | "delivery_instructions">>,
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
  uploadMaterials: (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return jfetch<{ snapshot_id: number; rows: number }>(`/api/materials/${projectId}/upload`, {
      method: "POST",
      body: fd,
    });
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
};

export function fmtMoney(n: number, currency = "GBP") {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);
}
export function fmtDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
