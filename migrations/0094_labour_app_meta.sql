-- 0094: sender details read off a labour application document (address, VAT,
-- UTR, contact, bank) — powers "add the subcontractor from the document" on
-- the AfP page, mirroring the invoice supplier-details capture. Additive only.
ALTER TABLE inbound_applications ADD COLUMN extracted_meta_json TEXT;
ALTER TABLE applications_for_payment ADD COLUMN extracted_meta_json TEXT;
