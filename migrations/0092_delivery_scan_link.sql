-- 0092: exact link from a delivery row back to the ticket scan it was checked
-- in from. Deleting the LAST row of a check-in reopens the ticket into the
-- inbox regardless of deletion order (the old link only knew the first row).
-- Additive only; legacy rows stay NULL and use the ticket-file fallback.
ALTER TABLE site_deliveries ADD COLUMN scan_id INTEGER;
