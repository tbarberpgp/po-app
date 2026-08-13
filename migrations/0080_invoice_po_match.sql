-- Accounts-payable 3-way match: an invoice is reconciled against the PO it
-- relates to and the deliveries logged against that PO before it's approved for
-- payment. matched_po_id links the invoice to its PO; per-line matches (which
-- invoice line ↔ which po_line) are stored inside lines_json. approval_note
-- captures why an invoice with variances was still approved (flag-don't-block).
ALTER TABLE invoices ADD COLUMN matched_po_id TEXT;
ALTER TABLE invoices ADD COLUMN approval_note TEXT;
CREATE INDEX IF NOT EXISTS idx_invoices_matched_po ON invoices(matched_po_id);
