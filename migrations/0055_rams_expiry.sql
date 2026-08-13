-- Per-document expiry for the site Documents hub (RAMS, certs, permits…). Drives
-- the EXPIRY column (amber ≤14 days, red expired) and the Expiring/Expired KPIs.
-- Nullable: signable RAMS/method docs usually have no expiry; certs/permits do.
ALTER TABLE rams_documents ADD COLUMN expiry_date TEXT;
