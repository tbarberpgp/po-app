-- 0014_project_commercials.sql
--
-- Each pricing workbook ships a "Summary Cost Sheet" tab with the project's
-- commercials: value (sell price), cost, gross profit £, gross profit %.
-- We parse that on upload and persist the rows here so the project Overview
-- can show profitability without re-parsing the xlsx on every page load.
--
-- One snapshot = one set of commercial rows (Total + per-category breakdown).

CREATE TABLE project_commercials (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id      INTEGER NOT NULL REFERENCES material_snapshots(id) ON DELETE CASCADE,
  -- 'Total' is the headline row; everything else is a category beneath it
  -- (Preliminaries, Measured Works, Ancillary Items, Directors Adjustment, etc.)
  category         TEXT    NOT NULL,
  value            REAL,                 -- sell price (£)
  cost             REAL,                 -- cost (£)
  gross_profit     REAL,                 -- value − cost (£)
  gross_profit_pct REAL,                 -- 0..1 fraction (0.13 = 13% GP)
  is_total         INTEGER NOT NULL DEFAULT 0,
  display_order    INTEGER NOT NULL
);
CREATE INDEX idx_project_commercials_snap ON project_commercials(snapshot_id);
