-- AP Phase 2/3: put labour on the same "approve for payment → DRAFT bill in
-- Xero" rails as materials, and let the source document ride along to Xero.
--
-- 1. Labour pay-approval gate. After a labour certificate is CERTIFIED (the QS
--    agrees the value), a commercial user must explicitly approve it FOR PAYMENT
--    before it pushes to Xero — mirroring the materials-invoice approval gate.
--    Certification no longer auto-pushes to Xero, and the labour bill now goes as
--    a DRAFT (not straight into the pay run). pay_approval_note captures why it
--    was approved despite any variance (flag-don't-block).
ALTER TABLE applications_for_payment ADD COLUMN pay_approved_at TEXT;
ALTER TABLE applications_for_payment ADD COLUMN pay_approved_by TEXT;
ALTER TABLE applications_for_payment ADD COLUMN pay_approval_note TEXT;

-- 2. Source document. Persist an uploaded labour-application file in R2 so it can
--    be attached to the Xero bill (materials invoices already keep their file in
--    R2). Manually-built AfPs have no upload and simply carry nothing to attach.
ALTER TABLE applications_for_payment ADD COLUMN source_file_key TEXT;
ALTER TABLE applications_for_payment ADD COLUMN source_file_name TEXT;
ALTER TABLE applications_for_payment ADD COLUMN source_file_type TEXT;
