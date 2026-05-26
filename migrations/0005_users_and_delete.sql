-- Role-based access control + soft delete for POs.
--
-- Roles (highest to lowest privilege):
--   superadmin  — everything, incl. deleting POs and promoting other superadmins
--   admin       — manage users, approvers, projects, upload materials. No PO delete.
--   procurement — raise POs, mark them issued, edit project site details
--   viewer      — read-only across the app
--
-- Approver permission is orthogonal: anyone with a row in `approvers` can approve
-- POs at that tier, regardless of role. (A viewer can be an approver and still see
-- everything, for example.)

CREATE TABLE users (
  email      TEXT PRIMARY KEY,
  name       TEXT,
  role       TEXT NOT NULL DEFAULT 'viewer',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT,
  CHECK (role IN ('superadmin', 'admin', 'procurement', 'viewer'))
);

-- Soft delete fields on purchase_orders. Existing queries that filter
-- `status IN ('approved','issued','pending_approval')` already exclude
-- deleted POs from committed totals — no change needed there.
ALTER TABLE purchase_orders ADD COLUMN deleted_at      TEXT;
ALTER TABLE purchase_orders ADD COLUMN deleted_by      TEXT;
ALTER TABLE purchase_orders ADD COLUMN deletion_reason TEXT;

-- Seed: make the bootstrapping user a superadmin so they can promote others.
INSERT INTO users (email, name, role, created_at, created_by)
VALUES ('tbarber@powergridprojects.net', 'Thomas Barber', 'superadmin',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system');
