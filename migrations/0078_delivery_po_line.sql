-- A delivery can be against a specific line item of a PO (e.g. a multi-material
-- PO where this drop is just the Kingspan boards). Store the line id plus a
-- snapshot of its description so the deliveries list reads well without a join.
ALTER TABLE site_deliveries ADD COLUMN po_line_id INTEGER;
ALTER TABLE site_deliveries ADD COLUMN po_line_desc TEXT;
