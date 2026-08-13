-- Holding tray for project emails (projects@pgpprojects.com) that couldn't be
-- matched to a project automatically — no project code in the subject/body and
-- no unique name hit (e.g. subcontractor threads like Durata's). Instead of
-- silently dropping them, they land here for manual allocation in Reports,
-- which then files them as a project update (source='email') into the reports.
CREATE TABLE IF NOT EXISTS inbound_correspondence (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    TEXT,                              -- internet Message-ID (dedupe)
  sender        TEXT,
  subject       TEXT,
  body          TEXT,                              -- cleaned excerpt
  received_at   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | allocated | dismissed
  project_id    TEXT,                              -- set when allocated
  allocated_at  TEXT,
  allocated_by  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbound_corr_status ON inbound_correspondence(status, received_at);
