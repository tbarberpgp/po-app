-- Variations register — SEPARATE from the contract. Forecast Final Account =
-- contract value + sum(variation sell_value). Each variation is a cost-centre:
-- a sell value to the client, material line items (pulled from the project
-- Materials list or the global Product Library), and labour line items. POs and
-- application lines link back to a variation so spend and profit margin can be
-- tracked per variation, and variation budgets sit alongside (but separate
-- from) the base-contract material/labour budgets.

CREATE TABLE variations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  variation_no  INTEGER NOT NULL,            -- sequential per project (VO1, VO2…)
  description   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open', -- open | closed
  sell_value    REAL NOT NULL DEFAULT 0,      -- value to the client
  notes         TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL
);
CREATE INDEX idx_variations_project ON variations(project_id);

-- Material line items for a variation. Either references a project material
-- (material_id) or a global product (product_id); description/rate are snapshotted.
CREATE TABLE variation_materials (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  variation_id  INTEGER NOT NULL REFERENCES variations(id) ON DELETE CASCADE,
  product_id    INTEGER,                      -- global Product Library ref (nullable)
  material_id   INTEGER,                      -- project Materials list ref (nullable)
  description   TEXT NOT NULL,
  manufacturer  TEXT,
  qty           REAL NOT NULL DEFAULT 0,
  unit          TEXT,
  unit_rate     REAL NOT NULL DEFAULT 0,
  value         REAL NOT NULL DEFAULT 0       -- qty * unit_rate
);
CREATE INDEX idx_variation_materials_var ON variation_materials(variation_id);

-- Labour line items for a variation (expendable per-line or as a lump).
CREATE TABLE variation_labour (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  variation_id  INTEGER NOT NULL REFERENCES variations(id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  value         REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_variation_labour_var ON variation_labour(variation_id);

-- Link purchase orders and application lines to a variation (spend / margin).
ALTER TABLE purchase_orders ADD COLUMN variation_id INTEGER;
ALTER TABLE afp_lines ADD COLUMN variation_id INTEGER;
