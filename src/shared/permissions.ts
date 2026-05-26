// Role / permission model. Imported by both the worker (for authorization checks)
// and the client (for showing/hiding UI elements). Keep this in sync — one
// source of truth means an action can't be allowed on the server but hidden in
// the UI by accident, or vice versa.

export type Role = "superadmin" | "admin" | "procurement" | "viewer";

export const ROLES: Role[] = ["superadmin", "admin", "procurement", "viewer"];

export const ROLE_LABELS: Record<Role, string> = {
  superadmin: "Superadmin",
  admin: "Admin",
  procurement: "Procurement",
  viewer: "Viewer",
};

/** Higher rank = more privilege. Used for "can act on a user of role X" checks. */
const RANK: Record<Role, number> = {
  superadmin: 4,
  admin: 3,
  procurement: 2,
  viewer: 1,
};

export function outranks(actor: Role, target: Role): boolean {
  return RANK[actor] > RANK[target];
}

export type Permission =
  | "users.read"
  | "users.write"
  | "users.promote_superadmin"
  | "projects.create"
  | "projects.edit"
  | "materials.upload"
  | "pos.create"
  | "pos.issue"
  | "pos.delete"
  | "approvers.manage";

// What each role is allowed to do. Approval (approve/reject) is granted
// separately via the `approvers` table and isn't role-based.
const MATRIX: Record<Role, Set<Permission>> = {
  superadmin: new Set<Permission>([
    "users.read", "users.write", "users.promote_superadmin",
    "projects.create", "projects.edit",
    "materials.upload",
    "pos.create", "pos.issue", "pos.delete",
    "approvers.manage",
  ]),
  admin: new Set<Permission>([
    "users.read", "users.write",
    "projects.create", "projects.edit",
    "materials.upload",
    "pos.create", "pos.issue",
    "approvers.manage",
  ]),
  procurement: new Set<Permission>([
    "projects.edit",
    "pos.create", "pos.issue",
  ]),
  viewer: new Set<Permission>(),
};

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return MATRIX[role].has(permission);
}
