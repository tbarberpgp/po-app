-- Widen users.role CHECK to the current role model.
--
-- Migration 0005 baked the original four roles into a CHECK constraint, so
-- INSERTs with the new roles (commercial / pm / site) fail with
-- SQLITE_CONSTRAINT. SQLite can't alter a CHECK in place — rebuild the table.
--
-- 'procurement' stays in the list so legacy rows copy across untouched;
-- normalizeRole() maps them to 'commercial' at the app boundary.

PRAGMA defer_foreign_keys = on;

CREATE TABLE users_new (
  email      TEXT PRIMARY KEY,
  name       TEXT,
  role       TEXT NOT NULL DEFAULT 'viewer',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT,
  CHECK (role IN ('superadmin', 'admin', 'commercial', 'pm', 'site', 'viewer', 'procurement'))
);

INSERT INTO users_new (email, name, role, active, created_at, created_by)
  SELECT email, name, role, active, created_at, created_by FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;
