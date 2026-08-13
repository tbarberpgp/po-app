-- Programme (construction works programme) — Gantt activities imported from
-- Excel, with baseline vs actual variance tracking and links to BOQ lines /
-- materials so material/stock demand can be tracked against the programme.

CREATE TABLE programme_activities (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Original line/ID from the imported file. Used to carry baseline + actuals
  -- forward across re-imports (we upsert by project_id + line_no) and to
  -- resolve predecessor references.
  line_no           INTEGER,
  level             INTEGER NOT NULL DEFAULT 0,   -- outline / WBS indent depth
  name              TEXT NOT NULL,
  is_milestone      INTEGER NOT NULL DEFAULT 0,
  is_summary        INTEGER NOT NULL DEFAULT 0,   -- a parent/summary bar
  -- Agreed baseline (set on first import, or via "set baseline").
  baseline_start    TEXT,
  baseline_finish   TEXT,
  -- Current plan (from the latest import / edit).
  planned_start     TEXT,
  planned_finish    TEXT,
  -- Recorded actuals (entered on site / by the planner).
  actual_start      TEXT,
  actual_finish     TEXT,
  pct_complete      REAL NOT NULL DEFAULT 0,      -- 0..1
  duration_days     REAL,
  predecessors      TEXT,                          -- raw string e.g. "3FS+2d, 5"
  display_order     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT,
  updated_by        TEXT
);
CREATE INDEX idx_prog_activities_project ON programme_activities(project_id, display_order);
CREATE INDEX idx_prog_activities_line ON programme_activities(project_id, line_no);

-- Links an activity to BOQ lines (contract_items) and/or materials, with the
-- quantity that activity consumes — the basis for material/stock demand.
CREATE TABLE programme_activity_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id       INTEGER NOT NULL REFERENCES programme_activities(id) ON DELETE CASCADE,
  contract_item_id  INTEGER REFERENCES contract_items(id) ON DELETE SET NULL,
  material_id       INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  description       TEXT,
  qty               REAL,
  unit              TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_prog_items_activity ON programme_activity_items(activity_id);

-- When the programme baseline was set (NULL = no baseline yet).
ALTER TABLE projects ADD COLUMN programme_baseline_set_at TEXT;
