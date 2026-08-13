-- Explicit WhatsApp group → project links, set via the Reports "Connect a group"
-- modal. A link wins over chat-name code matching at ingest, so a group whose
-- name doesn't lead with the project code (or lives inside a Community) still
-- feeds the right project, and the project reads as connected before any message.
CREATE TABLE IF NOT EXISTS whatsapp_group_links (
  chat_id    TEXT PRIMARY KEY,          -- Whapi group JID, e.g. "...@g.us"
  project_id TEXT NOT NULL,
  group_name TEXT,                       -- cached chat subject at link time
  linked_at  TEXT NOT NULL,
  linked_by  TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_wa_group_links_project ON whatsapp_group_links(project_id);
