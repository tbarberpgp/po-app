-- Daily / weekly site reporting. Field updates (from WhatsApp groups, email, or
-- manual entry) are ingested per project into project_updates; a daily cron
-- summarises each project's day into a site_report, and a weekly cron combines
-- the week. The WhatsApp source is decoupled — anything that can POST to the
-- ingest webhook (a hosted WhatsApp API, a self-hosted connector, or manual)
-- feeds the same pipeline.

CREATE TABLE IF NOT EXISTS project_updates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source       TEXT NOT NULL DEFAULT 'whatsapp',   -- whatsapp | manual | email | dronedeploy
  external_id  TEXT,                               -- provider message id (for de-dupe)
  group_name   TEXT,                               -- WhatsApp group name, if provided
  sender       TEXT,                               -- sender name / number
  body         TEXT,                               -- message text
  media_url    TEXT,                               -- optional image / document URL
  occurred_at  TEXT NOT NULL,                      -- ISO timestamp the message was sent
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_updates_proj_day ON project_updates(project_id, occurred_at);
-- De-dupe re-delivered webhook messages (NULL external_id rows are always kept).
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_updates_ext ON project_updates(source, external_id);

CREATE TABLE IF NOT EXISTS site_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = portfolio-wide weekly
  period_type   TEXT NOT NULL,                     -- daily | weekly
  period_start  TEXT NOT NULL,                     -- YYYY-MM-DD (inclusive)
  period_end    TEXT NOT NULL,                     -- YYYY-MM-DD (inclusive)
  summary_md    TEXT,                              -- generated narrative (markdown)
  data_json     TEXT,                              -- structured sections (progress/deliveries/…)
  update_count  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'generated', -- generated | sent
  generated_at  TEXT NOT NULL,
  generated_by  TEXT
);
-- One report per project per period (project_id NULL = the portfolio weekly).
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_reports_period
  ON site_reports(project_id, period_type, period_start);
CREATE INDEX IF NOT EXISTS idx_site_reports_recent ON site_reports(period_type, period_start);
