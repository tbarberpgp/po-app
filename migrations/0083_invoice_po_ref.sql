-- Capture the customer PO number the supplier prints on their invoice, so the
-- 3-way match can associate the invoice to that PO directly (the most reliable
-- signal) instead of relying only on item-code + supplier-name heuristics.
ALTER TABLE invoices ADD COLUMN extracted_po_ref TEXT;
