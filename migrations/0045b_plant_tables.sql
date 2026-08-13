-- Idempotent recovery half of 0045 — safe to run regardless of how far the
-- original 0045 got. Creates the owned-plant tables/indexes only (the ALTERs
-- are handled separately because SQLite has no ADD COLUMN IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS owned_plant (
  id TEXT PRIMARY KEY,
  asset_no TEXT,
  name TEXT NOT NULL,
  category TEXT,
  supplier TEXT,
  notes TEXT,
  assigned_project_id TEXT REFERENCES projects(id),
  assigned_at TEXT,
  assigned_by TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_owned_plant_project ON owned_plant(assigned_project_id);

CREATE TABLE IF NOT EXISTS owned_plant_tests (
  id TEXT PRIMARY KEY,
  plant_id TEXT NOT NULL,
  test_type TEXT NOT NULL,
  tested_on TEXT,
  expiry_date TEXT,
  file_key TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_owned_plant_tests_plant ON owned_plant_tests(plant_id);
