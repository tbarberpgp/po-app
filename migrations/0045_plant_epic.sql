-- Plant epic: hired plant raises a PO + off-hire reminders; owned/purchased
-- plant becomes a master register transferred between sites (like operatives)
-- with statutory test/retest dates.

-- Off-hire reminder recipients per project. PM falls back to site_manager_email
-- when unset; commercial manager is the second recipient.
ALTER TABLE projects ADD COLUMN project_manager_email TEXT;
ALTER TABLE projects ADD COLUMN commercial_manager_email TEXT;

-- Hired plant: the PO it raised, expected duration (drives the PO value), the
-- PLANNED off-hire date (distinct from off_hire_to, which stays NULL until the
-- item is actually marked off-hired), and which reminder milestones we've
-- already emailed (comma-joined, e.g. "soon,due") so the daily cron never
-- double-sends.
ALTER TABLE plant_logs ADD COLUMN po_id TEXT;
ALTER TABLE plant_logs ADD COLUMN expected_weeks REAL;
ALTER TABLE plant_logs ADD COLUMN expected_off_hire TEXT;
ALTER TABLE plant_logs ADD COLUMN offhire_alerts_sent TEXT;

-- Owned / purchased plant: a master register. An item is on at most one site at
-- a time (assigned_project_id), transferred between sites like an operative.
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

-- Statutory / service test records for owned plant (LOLER, PAT, service,
-- insurance, etc.). expiry_date is the retest-due date; status (valid/expiring/
-- expired) is computed in the API exactly like operative qualification cards.
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
