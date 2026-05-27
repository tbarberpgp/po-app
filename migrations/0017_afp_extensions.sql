-- 0017_afp_extensions.sql
--
-- Adds the supporting fields and tables for four AfP-adjacent features:
--   1. Email notifications:   client email + contact name per project so we
--                              can ping them on submit / certify.
--   2. Approval gating:       a new 'pending_approval' status flows through
--                              the existing status column (TEXT, so no schema
--                              change required there) + approved_at/by audit
--                              fields tied to the AfP submission gate.
--   3. Incoming labour AfPs:  already work via the existing direction field;
--                              no migration needed here.
--   4. Valuation schedule:    project-level file metadata + a structured
--                              entries table powering the portfolio calendar.

ALTER TABLE projects ADD COLUMN client_email TEXT;
ALTER TABLE projects ADD COLUMN client_contact_name TEXT;

-- Filename + last-uploaded timestamp for the per-project valuation schedule.
-- File contents stored client-side or as a URL link; we just track the
-- metadata here for display ("uploaded 12 May 2026 — schedule.pdf").
ALTER TABLE projects ADD COLUMN valuation_schedule_filename TEXT;
ALTER TABLE projects ADD COLUMN valuation_schedule_uploaded_at TEXT;
ALTER TABLE projects ADD COLUMN valuation_schedule_uploaded_by TEXT;

-- Pre-planned valuation cadence per project. Lets the portfolio calendar
-- show "AfP #3 due on 30 Apr" even before a draft AfP exists.
CREATE TABLE valuation_schedule_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  app_number   INTEGER,             -- planned AfP this entry corresponds to (1-based)
  -- 'cutoff'         valuation date (last day of measurement)
  -- 'submission'     date the AfP must be submitted to the client
  -- 'certification'  date the client should certify by
  -- 'payment'        expected payment date (final payment due)
  entry_type   TEXT NOT NULL,
  date         TEXT NOT NULL,       -- ISO date
  notes        TEXT,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL
);
CREATE INDEX idx_vse_project ON valuation_schedule_entries(project_id);
CREATE INDEX idx_vse_date    ON valuation_schedule_entries(date);

-- AfP director-sign-off audit fields. Approval happens between the user
-- pressing "Send for approval" (draft → pending_approval) and the director
-- pressing Approve (pending_approval → submitted).
ALTER TABLE applications_for_payment ADD COLUMN approved_at TEXT;
ALTER TABLE applications_for_payment ADD COLUMN approved_by TEXT;
ALTER TABLE applications_for_payment ADD COLUMN approval_rejected_at TEXT;
ALTER TABLE applications_for_payment ADD COLUMN approval_rejected_by TEXT;
ALTER TABLE applications_for_payment ADD COLUMN approval_rejection_reason TEXT;
