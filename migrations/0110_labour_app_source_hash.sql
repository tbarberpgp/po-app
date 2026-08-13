-- Duplicate-document detection for labour/client applications: a SHA-256 of
-- the source attachment lets the email ingest recognise a re-forward of a
-- document that already exists (as an AfP or parked in the inbound tray) and
-- skip creating a shadow draft.
ALTER TABLE applications_for_payment ADD COLUMN source_file_hash TEXT;
ALTER TABLE inbound_applications ADD COLUMN source_file_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_afp_source_hash ON applications_for_payment(source_file_hash);
