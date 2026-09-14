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

/** Every permission, in the order the grants editor lists them. */
export const ALL_PERMISSIONS: Permission[] = [
  "users.read", "users.write", "users.promote_superadmin",
  "masterdata.read",
  "projects.create", "projects.edit", "projects.delete",
  "delivery.edit", "delivery.checkin_manual",
  "commercial.view", "commercial.edit",
  "materials.upload",
  "pos.create", "pos.issue", "pos.edit", "pos.delete", "pos.push_to_xero",
  "approvers.manage",
  "suppliers.manage",
];

/** How each permission reads to whoever is handing it out. The matrix speaks in
 *  dotted keys; the person ticking a box does not. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  "users.read": "View users",
  "users.write": "Manage users",
  "users.promote_superadmin": "Promote superadmins",
  "masterdata.read": "View reference data",
  "projects.create": "Create projects",
  "projects.edit": "Edit projects",
  "projects.delete": "Delete projects",
  "delivery.edit": "Site operations (inductions, operatives, plant, reports)",
  "delivery.checkin_manual": "Check in deliveries with no ticket",
  "commercial.view": "View commercials",
  "commercial.edit": "Edit commercials",
  "materials.upload": "Upload pricing / labour workbooks",
  "pos.create": "Raise POs",
  "pos.issue": "Issue POs",
  "pos.edit": "Amend POs",
  "pos.delete": "Delete POs",
  "pos.push_to_xero": "Push POs to Xero",
  "approvers.manage": "Manage approvers",
  "suppliers.manage": "Manage suppliers",
};

/** Permissions that may never be handed to one person on their own.
 *
 *  Promoting superadmins is the one thing that lets a grant escalate into the
 *  power to rewrite the model itself, so it stays a role change, made by
 *  someone who already outranks the target. A grant list carrying it is
 *  ignored rather than rejected — the check below simply never honours it. */
export const NON_GRANTABLE: Set<Permission> = new Set(["users.promote_superadmin"]);

/** Permissions that can actually be ticked in the grants editor. */
export const GRANTABLE_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter((p) => !NON_GRANTABLE.has(p));

/** A user as an authorization decision sees them: the role they hold, plus any
 *  permissions granted to them individually. */
export type PermissionSubject = {
  role: Role | null | undefined;
  grants?: Permission[] | null;
};

/**
 * Whether a subject may do something.
 *
 * Roles answer this for almost everyone. Per-user grants exist for the case a
 * role can't express: one person who needs exactly one more capability than
 * their role carries, where the alternative is promoting them to a role that
 * hands over a great deal more. A grant is purely ADDITIVE — it can only ever
 * turn a `false` into a `true`, never take a role's permission away — so the
 * matrix stays the floor for everybody holding a role.
 *
 * Still accepts a bare role string: most call sites only ever have a role, and
 * a grant can only widen the answer, so reading one as "no grants" is right
 * rather than merely convenient.
 */
export function can(
  subject: Role | PermissionSubject | null | undefined,
  permission: Permission,
): boolean {
  const bare = typeof subject === "string" || subject == null;
  const role = bare ? (subject as Role | null | undefined) : subject.role;
  const grants = bare ? null : subject.grants;
  // No role is no user: nothing is granted to someone who isn't signed in.
  // Checked before the grants branch as well as the matrix, so a stale grant row
  // left behind by a removed user can't authorize anything on its own. (The
  // worker never reaches here without a role — every authenticated request is
  // auto-provisioned at least `viewer` — so this costs nothing and closes the
  // case where some future caller assembles a subject by hand.)
  if (!role) return false;
  if (UNIVERSAL.has(permission)) return true;
  if (MATRIX[normalizeRole(role)].has(permission)) return true;
  return !!grants && !NON_GRANTABLE.has(permission) && grants.includes(permission);
}
