-- A certified OUTGOING (client) application is invoiced to the client by
-- creating a live (AUTHORISED) ACCREC sales invoice in Xero, tagged to the
-- matching Xero tracking option (project code). These columns are distinct
-- from the labour PO columns (0027) so the two flows never collide and the UI
-- can show the right cross-reference (invoice vs PO).
ALTER TABLE applications_for_payment ADD COLUMN xero_invoice_id        TEXT;
ALTER TABLE applications_for_payment ADD COLUMN xero_invoice_number    TEXT;
ALTER TABLE applications_for_payment ADD COLUMN xero_invoice_synced_at TEXT;
ALTER TABLE applications_for_payment ADD COLUMN xero_invoice_status    TEXT;  -- 'synced' | 'failed' | NULL
ALTER TABLE applications_for_payment ADD COLUMN xero_invoice_error     TEXT;
