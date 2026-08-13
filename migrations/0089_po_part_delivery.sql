-- 0089: mark a PO as "arriving in parts" — ordered as one drop but the supplier
-- is delivering it piecemeal. Set from the PO page (or when a partial check-in
-- lands); read wherever delivery state is shown so a part-filled order is
-- visibly expected rather than looking overdue/incomplete.
ALTER TABLE purchase_orders ADD COLUMN part_delivery INTEGER NOT NULL DEFAULT 0;
