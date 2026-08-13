-- A PO can be delivered across several drops. Until now, any delivery linked to
-- a PO marked the whole PO delivered (dropped it off the "awaiting" list). This
-- flag lets a delivery be logged as a part-load: the PO stays open until a
-- delivery marks it complete. Existing rows default to complete (1) so nothing
-- that was fully delivered suddenly reappears.
ALTER TABLE site_deliveries ADD COLUMN completes_po INTEGER NOT NULL DEFAULT 1;
