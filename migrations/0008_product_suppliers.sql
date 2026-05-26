-- Alternate suppliers per product. A product still has a primary supplier
-- (products.supplier — often the same as the manufacturer), but generic
-- items like fixings, fasteners, and consumables routinely come from
-- multiple builders' merchants at different prices. Each row here is one
-- supplier's offering of the product, with its own price / SKU / lead time.

CREATE TABLE product_suppliers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_name   TEXT NOT NULL,
  unit_cost       REAL,
  supplier_sku    TEXT,
  lead_time_days  INTEGER,
  notes           TEXT,
  is_preferred    INTEGER NOT NULL DEFAULT 0,  -- the "use this one by default" flag
  created_at      TEXT NOT NULL,
  created_by      TEXT,
  UNIQUE(product_id, supplier_name)
);
CREATE INDEX idx_product_suppliers_product   ON product_suppliers(product_id);
CREATE INDEX idx_product_suppliers_supplier  ON product_suppliers(supplier_name);
