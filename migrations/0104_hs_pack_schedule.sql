-- Scheduled Health & Safety pack release: one PDF per period with the sign-in
-- register (briefing acceptance + signatures), the briefing texts, toolbox
-- talks given (tagged, full copy, acknowledgements) and operative
-- qualification details. Emailed to the configured recipients by the hourly
-- cron; one schedule per project (site base).
CREATE TABLE IF NOT EXISTS hs_pack_schedules (
  project_id       TEXT PRIMARY KEY,
  frequency        TEXT NOT NULL DEFAULT 'weekly',   -- weekly | monthly
  weekday          INTEGER NOT NULL DEFAULT 1,       -- 1=Mon … 7=Sun (weekly only)
  send_hour        INTEGER NOT NULL DEFAULT 7,       -- UK local hour 0-23
  recipients       TEXT,                             -- comma-separated emails
  include_managers INTEGER NOT NULL DEFAULT 1,       -- also send to PM/site/commercial
  active           INTEGER NOT NULL DEFAULT 1,
  last_sent_at     TEXT,
  updated_at       TEXT,
  updated_by       TEXT
);
