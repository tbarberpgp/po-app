-- Manual cash-outlook adjustments (Phase 2 of the cash projection): user-entered
-- projected in/out lines that layer on top of the derived projection. Positive
-- amounts add to the projected series for that month; negative amounts reduce it.
-- These are forecast annotations, not commercial records.
CREATE TABLE IF NOT EXISTS cash_forecast_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id),
  month TEXT NOT NULL,                                   -- YYYY-MM
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  amount REAL NOT NULL,
  label TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cfa_month ON cash_forecast_adjustments (month);
