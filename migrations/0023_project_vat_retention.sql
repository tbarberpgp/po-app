-- Per-direction commercial terms on projects. Client (outgoing) applications
-- and labour (incoming) applications often carry different VAT and retention:
--   • Client apps: standard 20% VAT, main-contract retention (often 5%).
--   • Labour apps: frequently CIS domestic reverse charge (0% VAT) and a
--     separate subcontractor retention rate.
-- We seed the new client_* retention from the existing project retention_pct
-- so behaviour doesn't change for in-flight projects.

ALTER TABLE projects ADD COLUMN client_vat_pct       REAL NOT NULL DEFAULT 20.0;
ALTER TABLE projects ADD COLUMN client_retention_pct REAL NOT NULL DEFAULT 5.0;
ALTER TABLE projects ADD COLUMN labour_vat_pct       REAL NOT NULL DEFAULT 20.0;
ALTER TABLE projects ADD COLUMN labour_retention_pct REAL NOT NULL DEFAULT 5.0;

-- Backfill from the legacy single retention_pct where it exists.
UPDATE projects SET client_retention_pct = retention_pct, labour_retention_pct = retention_pct
WHERE retention_pct IS NOT NULL;
