-- 0093: client payment terms per project/contract (e.g. "45 days from
-- application") — shown on the project header and the grouped-site header.
-- Additive only.
ALTER TABLE projects ADD COLUMN payment_terms TEXT;
