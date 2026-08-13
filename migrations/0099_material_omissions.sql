-- Materials omitted from a project (not needed for the job): excluded from
-- budget / remaining / committed rollups and hidden from the main materials
-- list. Keyed by item NAME per project so re-uploading the pricing workbook
-- (which mints new material ids) keeps the omission — same pattern as live
-- prices.
CREATE TABLE IF NOT EXISTS material_omissions (
  project_id TEXT NOT NULL REFERENCES projects(id),
  item_key   TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, item_key)
);
