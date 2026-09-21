-- "Send to labour". Some supplier invoices are really a subcontractor's own
-- application for payment — a day-work sheet with CIS deducted from the labour
-- element. Paid as an ordinary bill the CIS deduction is lost, because it has
-- no field on `invoices`; the labour pipeline already computes it (per the
-- supplier's cis_rate, excluding expenses) and pushes the right bill to Xero.
--
-- So Accounts can hand one over, and the row records which AfP it became —
-- without this it would sit in Dismissed looking like junk rather than like
-- something that moved on.
ALTER TABLE invoices ADD COLUMN labour_afp_id INTEGER;
