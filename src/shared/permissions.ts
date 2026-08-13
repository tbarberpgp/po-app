// Role / permission model. Imported by both the worker (for authorization checks)
// and the client (for showing/hiding UI elements). Keep this in sync — one
// source of truth means an action can't be allowed on the server but hidden in
// the UI by accident, or vice versa.
//
// Two orthogonal overlays sit on top of roles and are NOT role-based:
//   – approver tiers (line_manager / commercial_manager / director) drive money
//     sign-offs (PO approvals, AfP certification, labour-rate increases,
//     prelim overspend) via the `approvers` table;
//   – a couple of superadmin-only special cases (instant pricing-upload
//     activation, hard deletes) are checked by role string where they apply.

export type Role = "superadmin" | "admin" | "commercial" | "pm" | "site" | "viewer";

export const ROLES: Role[] = ["superadmin", "admin", "commercial", "pm", "site", "viewer"];

export const ROLE_LABELS: Record<Role, string> = {
  superadmin: "Superadmin",
  admin: "Admin",
  commercial: "Commercial",
  pm: "Project Manager",
  site: "Site",
  viewer: "Viewer",
};

/** Legacy role strings still present in the users table map onto the new
 *  model here — saves a production data migration. "procurement" was renamed
 *  to "commercial" when the delivery/commercial split landed (Jun 2026). */
export function normalizeRole(raw: string | null | undefined): Role {
  if (raw === "procurement") return "commercial";
  return (ROLES as string[]).includes(raw ?? "") ? (raw as Role) : "viewer";
}

/** Higher rank = more privilege. Used for "can act on a user of role X" checks. */
const RANK: Record<Role, number> = {
  superadmin: 6,
  admin: 5,
  commercial: 4,
  pm: 3,
  site: 2,
  viewer: 1,
};

export function outranks(actor: Role, target: Role): boolean {
  return RANK[normalizeRole(actor)] > RANK[normalizeRole(target)];
}

export type Permission =
  | "users.read"
  | "users.write"
  | "users.promote_superadmin"
  | "masterdata.read"      // view reference lists: operatives, plant, products, suppliers — every signed-in user
  | "projects.create"
  | "projects.edit"        // the project record itself (details, terms, site info)
  | "projects.delete"
  | "delivery.edit"        // operations, operatives, plant, programme, site reports
  | "delivery.checkin_manual" // mark goods delivered with NO ticket — bypasses the paper trail, admins only
  | "commercial.view"      // see Commercials/Applications/Calendar in the UI
  | "commercial.edit"      // author AfPs, variations, valuations, contingency
  | "materials.upload"     // pricing workbooks + labour-rate schedules
  | "pos.create"
  | "pos.issue"
  | "pos.edit"             // amend an existing PO (header + lines) — admin/superadmin only
  | "pos.delete"
  | "pos.push_to_xero"
  | "approvers.manage"
  | "suppliers.manage";    // edit register + upload supplier quotes

// What each role is allowed to do. Approval (approve/reject) is granted
// separately via the `approvers` table and isn't role-based.
const MATRIX: Record<Role, Set<Permission>> = {
  superadmin: new Set<Permission>([
    "users.read", "users.write", "users.promote_superadmin",
    "projects.create", "projects.edit", "projects.delete",
    "delivery.edit", "delivery.checkin_manual", "commercial.view", "commercial.edit",
    "materials.upload",
    "pos.create", "pos.issue", "pos.edit", "pos.delete", "pos.push_to_xero",
    "approvers.manage",
    "suppliers.manage",
  ]),
  admin: new Set<Permission>([
    "users.read", "users.write",
    "projects.create", "projects.edit",
    "delivery.edit", "delivery.checkin_manual", "commercial.view", "commercial.edit",
    "materials.upload",
    "pos.create", "pos.issue", "pos.edit", "pos.push_to_xero",
    "approvers.manage",
    "suppliers.manage",
  ]),
  // QS / commercial manager: owns the commercial workspace, uploads pricing and
  // labour-rate workbooks, raises + pushes POs, manages the supplier register.
  // No delivery-ops editing (site reports, operatives, plant).
  commercial: new Set<Permission>([
    "projects.edit",
    "commercial.view", "commercial.edit",
    "materials.upload",
    "pos.create", "pos.issue", "pos.push_to_xero",
    "suppliers.manage",
  ]),
  // Project Manager: runs delivery (operations, quality, programme, materials,
  // site reports, operatives, plant) and raises + issues POs. Deliberately has
  // NO commercial.view — PMs don't see the commercial position (contract value,
  // forecast, applications, variations).
  pm: new Set<Permission>([
    "projects.edit",
    "delivery.edit",
    "pos.create", "pos.issue",
  ]),
  // Site manager / foreman: delivery operations only.
  site: new Set<Permission>([
    "delivery.edit",
  ]),
  viewer: new Set<Permission>(),
};

// Permissions every signed-in user has regardless of role. These are read-only
// views of reference data (operatives, plant register, product library, approved
// suppliers) that the whole team needs to see; the matching mutations stay gated
// by the matrix above, and the worker still enforces this per-route.
const UNIVERSAL: Set<Permission> = new Set(["masterdata.read"]);

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  if (UNIVERSAL.has(permission)) return true;
  return MATRIX[normalizeRole(role)].has(permission);
}
