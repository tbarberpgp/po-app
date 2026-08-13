-- 0096: keep the counterparty's returned payment certificate on the AfP.
-- source_file_* is the application as it went out; cert_file_* is the client's
-- (or QS's, for labour) certificate that came back and set the certified
-- figures — so the paper trail behind a certification is openable from the
-- AfP page. Additive only.
ALTER TABLE applications_for_payment ADD COLUMN cert_file_key TEXT;
ALTER TABLE applications_for_payment ADD COLUMN cert_file_name TEXT;
ALTER TABLE applications_for_payment ADD COLUMN cert_file_type TEXT;
