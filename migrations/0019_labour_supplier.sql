-- Flag suppliers that supply labour (subcontractors). This is what the
-- incoming-labour Application-for-Payment subcontractor picker filters on,
-- so that only labour-trading suppliers show up in that dropdown rather
-- than the full materials register.
ALTER TABLE suppliers ADD COLUMN is_labour_supplier INTEGER NOT NULL DEFAULT 0;

-- Index speeds up the "only labour suppliers" lookup on the AfP create form.
CREATE INDEX IF NOT EXISTS idx_suppliers_labour ON suppliers (is_labour_supplier);
