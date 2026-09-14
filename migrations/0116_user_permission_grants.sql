-- Permissions granted to one person, on top of whatever their role carries.
--
-- Roles answer this for almost everyone. This table exists for the case a role
-- can't express: one person needing exactly one more capability than their role
-- holds, where the alternative is promoting them into a role that hands over a
-- great deal more. jtong is the worked example — a commercial (QS) who needs to
-- amend POs and run site operations, neither of which `commercial` carries, and
-- where the nearest role that does (`admin`) would also hand over user
-- management.
--
-- Grants are additive only: `can()` ORs them with the role matrix, so a row here
-- can never take a permission away, and the matrix stays the floor for everyone.
-- users.promote_superadmin is refused in code (NON_GRANTABLE) rather than by a
-- constraint — the rule belongs beside the check that honours it.
--
-- The composite primary key is what makes writing a grant set idempotent: the
-- handler deletes the user's rows and re-inserts, so a double submit can't
-- duplicate a grant.
--
-- Applied to production on 2026-09-09, ahead of this file existing — see the
-- note in 0115_users_po_requires_approval.sql about the out-of-sequence number.
CREATE TABLE user_permission_grants (
  email       TEXT NOT NULL,
  permission  TEXT NOT NULL,
  granted_at  TEXT NOT NULL,
  granted_by  TEXT,
  PRIMARY KEY (email, permission)
);

CREATE INDEX idx_user_grants_email ON user_permission_grants(email);
