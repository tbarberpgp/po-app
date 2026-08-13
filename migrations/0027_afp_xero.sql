-- A certified labour application (incoming_labour AfP) is pushed to Xero as a
-- draft Purchase Order to the subcontractor. Mirror the cross-reference columns
-- used on purchase_orders so we can show sync status and avoid double-pushing.
ALTER TABLE applications_for_payment ADD COLUMN xero_po_id       TEXT;
ALTER TABLE applications_for_payment ADD COLUMN xero_po_number   TEXT;
ALTER TABLE applications_for_payment ADD COLUMN xero_synced_at   TEXT;
ALTER TABLE applications_for_payment ADD COLUMN xero_sync_status TEXT;  -- 'synced' | 'failed' | NULL
ALTER TABLE applications_for_payment ADD COLUMN xero_sync_error  TEXT;
