-- Mailbox pull: remember how far each mailbox has been read.
--
-- Eligibility used to be "unread" (isRead eq false), which made Outlook's read
-- flag the queue: anyone opening a supplier invoice in the Accounts inbox before
-- the hourly run removed it from the pull for good, with no retry and no trace.
-- Eligibility is now a timestamp the app owns — every message that ARRIVED since
-- the last clean run is considered, read or not — and graph_pulled_messages
-- (keyed on internetMessageId) stays the sole judge of what has already been done.
CREATE TABLE IF NOT EXISTS graph_pull_state (
  mailbox    TEXT PRIMARY KEY,
  watermark  TEXT NOT NULL,   -- ISO: consider mail received at or after this
  updated_at TEXT NOT NULL
);

-- A row in graph_pulled_messages used to mean, simply, "ingested". It now
-- carries the outcome: a message whose ingest threw is recorded as failed and
-- retried while the window still covers it (the watermark is held back to keep
-- it there), instead of relying on it staying unread for ever.
ALTER TABLE graph_pulled_messages ADD COLUMN status      TEXT NOT NULL DEFAULT 'ingested';
ALTER TABLE graph_pulled_messages ADD COLUMN attempts    INTEGER NOT NULL DEFAULT 1;
ALTER TABLE graph_pulled_messages ADD COLUMN last_error  TEXT;
ALTER TABLE graph_pulled_messages ADD COLUMN received_at TEXT;
