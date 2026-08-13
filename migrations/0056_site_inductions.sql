-- Per-project SITE induction: confirmed when an operative has been inducted
-- onto a specific site. Distinct from the operative-level COMPANY induction
-- (operatives.induction_done), which is recorded once when they join the system.
CREATE TABLE IF NOT EXISTS site_inductions (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operative_id  TEXT NOT NULL REFERENCES operatives(id) ON DELETE CASCADE,
  inducted_at   TEXT NOT NULL,
  inducted_by   TEXT,
  PRIMARY KEY (project_id, operative_id)
);
CREATE INDEX IF NOT EXISTS idx_site_inductions_op ON site_inductions(operative_id);
