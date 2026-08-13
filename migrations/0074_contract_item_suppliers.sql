-- Assign labour subcontractors to specific bill items (contract_items) on a
-- project, so a supplier's application only shows the items allocated to them.
-- One bill item can be split across several suppliers by £ value (allocated_value);
-- NULL allocated_value = the whole line is that supplier's.
CREATE TABLE contract_item_suppliers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contract_item_id INTEGER NOT NULL REFERENCES contract_items(id) ON DELETE CASCADE,
  supplier_id      INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  allocated_value  REAL,          -- £ of this bill item allocated to this supplier (NULL = whole line)
  created_at       TEXT NOT NULL,
  created_by       TEXT,
  UNIQUE(contract_item_id, supplier_id)
);
CREATE INDEX idx_cis_project  ON contract_item_suppliers(project_id);
CREATE INDEX idx_cis_item     ON contract_item_suppliers(contract_item_id);
CREATE INDEX idx_cis_supplier ON contract_item_suppliers(supplier_id);
