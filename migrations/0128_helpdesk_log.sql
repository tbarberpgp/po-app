-- One row per helpdesk question. Doubles as the per-user daily cap (count of
-- today's rows) and as the record of what people ask, so the knowledge base can
-- be fixed where the answers were weak. `answer` is the model's reply, not a
-- transcript — earlier turns of a conversation live only in the user's browser.
CREATE TABLE IF NOT EXISTS helpdesk_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL,
  page        TEXT,
  question    TEXT NOT NULL,
  answer      TEXT,
  tools_used  TEXT,            -- comma-separated tool names, NULL when none ran
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_helpdesk_log_email_day ON helpdesk_log(email, created_at);
