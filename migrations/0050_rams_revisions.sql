-- RAMS revision control. Each document belongs to a "revision family" (rev_group)
-- and carries an auto-incrementing revision number. Uploading a new revision adds
-- a new row at revision+1 and supersedes the previous one (active = 0) — operators
-- never type a version, and the latest revision is the one crews re-sign.
ALTER TABLE rams_documents ADD COLUMN rev_group TEXT;
ALTER TABLE rams_documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

-- Existing documents each become their own family at revision 1.
UPDATE rams_documents SET rev_group = CAST(id AS TEXT) WHERE rev_group IS NULL;

CREATE INDEX IF NOT EXISTS idx_rams_revgroup ON rams_documents(rev_group);
