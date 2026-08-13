-- Contract page (Commercials → Contract): risk register + key contract items.

CREATE TABLE IF NOT EXISTS project_risks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  category      TEXT,                       -- commercial | programme | design | site | client | other
  likelihood    INTEGER NOT NULL DEFAULT 3, -- 1 (rare) … 5 (almost certain)
  impact        INTEGER NOT NULL DEFAULT 3, -- 1 (negligible) … 5 (severe)
  mitigation    TEXT,
  owner         TEXT,
  cost_exposure REAL,                       -- potential £ if it lands (optional)
  status        TEXT NOT NULL DEFAULT 'open',  -- open | closed
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  closed_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_project_risks_project ON project_risks(project_id, status);

-- Key contract items: obligations, notice periods, insurances, LADs, warranty
-- requirements — the clauses you need in front of you, with a due date where
-- one applies.
CREATE TABLE IF NOT EXISTS project_key_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  detail      TEXT,
  due_date    TEXT,                         -- YYYY-MM-DD (optional)
  status      TEXT NOT NULL DEFAULT 'open', -- open | done
  created_at  TEXT NOT NULL,
  created_by  TEXT,
  done_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_project_key_items_project ON project_key_items(project_id, status);
