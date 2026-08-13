-- Tag a PO's spend to a cost category so prelim-type purchases (welfare, plant
-- hire, scaffolding, management) expend the Preliminaries budget rather than the
-- materials budget. Default keeps every existing PO as a materials cost.
ALTER TABLE purchase_orders ADD COLUMN category TEXT NOT NULL DEFAULT 'materials'; -- materials | prelims
