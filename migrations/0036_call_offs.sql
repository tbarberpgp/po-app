-- Framework/blanket POs + call-offs that draw down against them, and a link
-- from a checked-in delivery to the PO (or call-off) it was booked against.
ALTER TABLE purchase_orders ADD COLUMN order_type   TEXT NOT NULL DEFAULT 'standard'; -- standard | framework | call_off
ALTER TABLE purchase_orders ADD COLUMN parent_po_id TEXT;   -- for a call_off → its framework PO id
ALTER TABLE site_deliveries ADD COLUMN po_id        TEXT;   -- PO/call-off this booking-in was made against
CREATE INDEX IF NOT EXISTS idx_po_parent ON purchase_orders(parent_po_id);
