-- Microsoft Graph mailbox pull — ingest inbound invoice/labour/client emails by
-- READING the M365 mailboxes on a schedule, instead of relying on auto-forwarding
-- (which M365 blocks externally, error 550 5.7.520). See src/worker/graph.ts.

-- Dedupe: every message we've already ingested, keyed by its stable
-- internetMessageId, so a re-run (or a failed mark-as-read) never double-ingests.
CREATE TABLE IF NOT EXISTS graph_pulled_messages (
  message_id   TEXT PRIMARY KEY,   -- Graph internetMessageId
  mailbox      TEXT,               -- source mailbox it was read from
  kind         TEXT,               -- invoice | labour | client
  subject      TEXT,
  from_addr    TEXT,
  processed_at TEXT NOT NULL
);

-- Run log so the Admin page can show "last pulled at / N ingested / any error".
CREATE TABLE IF NOT EXISTS graph_pull_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at     TEXT NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 1,
  mailboxes  INTEGER NOT NULL DEFAULT 0,
  fetched    INTEGER NOT NULL DEFAULT 0,   -- new messages seen
  ingested   INTEGER NOT NULL DEFAULT 0,   -- fed into the ingest pipeline
  error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_graph_pull_runs_ran_at ON graph_pull_runs(ran_at);
