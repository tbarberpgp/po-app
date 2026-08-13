-- Auto-distribute rules: email generated site reports to clients/teams the
-- moment they're produced by the daily/weekly cron. Each rule targets a project
-- (or the portfolio roll-up when project_id IS NULL), a frequency and a set of
-- recipients. Honoured by runDailyReports / runWeeklyReports in site-reports.ts.
CREATE TABLE IF NOT EXISTS distribution_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,                               -- NULL = portfolio roll-up
  name TEXT,                                     -- optional label
  frequency TEXT NOT NULL DEFAULT 'daily',       -- 'daily' | 'weekly' | 'both'
  format TEXT NOT NULL DEFAULT 'pdf_link',       -- 'pdf' | 'link' | 'pdf_link'
  recipients TEXT NOT NULL DEFAULT '[]',         -- JSON array of email addresses
  send_time TEXT DEFAULT '07:30',                -- HH:MM (indicative; cron runs 07:00)
  only_if TEXT NOT NULL DEFAULT 'always',        -- 'always' | 'skip_quiet'
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_distribution_rules_project ON distribution_rules(project_id);
