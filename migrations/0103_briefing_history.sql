-- Standing-briefing version history. The settings blob only holds the CURRENT
-- briefing, so exports couldn't say which text past sign-ins accepted. Every
-- save now appends a row here; exports attribute each sign-in to the version
-- in force at that instant and print all versions given in the range.
CREATE TABLE IF NOT EXISTS site_briefing_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',  -- '' = briefing cleared (none in force)
  content        TEXT,
  effective_from TEXT NOT NULL,
  created_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_briefing_history ON site_briefing_history(project_id, effective_from);
