-- PowerGrid Purchase Orders — initial schema

CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,           -- e.g. BNC001
  name         TEXT NOT NULL,
  client       TEXT,
  currency     TEXT NOT NULL DEFAULT 'GBP',
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL
);

CREATE TABLE material_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploaded_at  TEXT NOT NULL,
  uploaded_by  TEXT NOT NULL,
  filename     TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_snapshots_project ON material_snapshots(project_id, is_active);

CREATE TABLE materials (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id         INTEGER NOT NULL REFERENCES material_snapshots(id) ON DELETE CASCADE,
  item                TEXT NOT NULL,           -- col A — full descriptor
  type                TEXT NOT NULL,           -- col B
  manufacturer        TEXT,                    -- col C  (acts as supplier)
  pack_qty            REAL,
  pack_unit           TEXT,
  cost                REAL,                    -- per pack (col F)
  cost_unit           TEXT,
  coverage_qty        REAL,
  coverage_unit       TEXT,
  waste_pct           REAL,
  unit_rate           REAL,                    -- col O — cost per coverage unit incl waste
  rate_unit           TEXT,
  total_qty           REAL,                    -- col T — priced/allowed qty for this job
  total_qty_unit      TEXT,
  material_total_cost REAL                     -- col X — priced material budget for this line
);
CREATE INDEX idx_materials_snapshot ON materials(snapshot_id);
CREATE INDEX idx_materials_type ON materials(snapshot_id, type);

CREATE TABLE purchase_orders (
  id                TEXT PRIMARY KEY,
  po_number         TEXT NOT NULL UNIQUE,      -- e.g. PO-BNC001-0007
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  supplier          TEXT NOT NULL,
  status            TEXT NOT NULL,             -- draft | pending_approval | approved | rejected | issued
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approval_tier     TEXT,                      -- line_manager | commercial_manager | director
  approval_reason   TEXT,                      -- over_budget | unpriced | both
  total_value       REAL NOT NULL,
  notes             TEXT,
  delivery_date     TEXT,
  created_at        TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  approved_at       TEXT,
  approved_by       TEXT,
  rejected_at       TEXT,
  rejected_by       TEXT,
  rejection_reason  TEXT,
  issued_at         TEXT
);
CREATE INDEX idx_pos_project ON purchase_orders(project_id);
CREATE INDEX idx_pos_status ON purchase_orders(status);

CREATE TABLE po_lines (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id               TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  material_id         INTEGER REFERENCES materials(id),  -- null when unpriced (ad-hoc)
  item                TEXT NOT NULL,                     -- snapshot of descriptor at PO time
  type                TEXT,
  manufacturer        TEXT,
  qty                 REAL NOT NULL,
  unit                TEXT NOT NULL,
  unit_cost           REAL NOT NULL,
  line_total          REAL NOT NULL,
  is_unpriced         INTEGER NOT NULL DEFAULT 0,
  is_over_budget      INTEGER NOT NULL DEFAULT 0,
  priced_qty_at_order REAL,                              -- snapshot of allowance at PO time
  committed_before    REAL                               -- already-committed qty before this PO
);
CREATE INDEX idx_po_lines_po ON po_lines(po_id);
CREATE INDEX idx_po_lines_material ON po_lines(material_id);

CREATE TABLE approvers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE, -- null = global default
  tier        TEXT NOT NULL,                                  -- line_manager | commercial_manager | director
  email       TEXT NOT NULL,
  name        TEXT
);
CREATE INDEX idx_approvers_project_tier ON approvers(project_id, tier);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type  TEXT NOT NULL,           -- po | project | snapshot | approver
  entity_id    TEXT NOT NULL,
  action       TEXT NOT NULL,           -- created | updated | approved | rejected | issued | uploaded
  actor        TEXT NOT NULL,           -- email
  details      TEXT,                    -- JSON
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

-- Default settings (thresholds in pounds)
INSERT INTO settings (key, value) VALUES
  ('tier_threshold_line_manager', '2000'),
  ('tier_threshold_commercial_manager', '10000'),
  ('tier_threshold_director', '50000'),
  ('currency', 'GBP');
