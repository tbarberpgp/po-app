-- Preformed toolbox talks, uploaded as Word docs and reusable across every
-- site (org-level master data, like the product library — not per project).
-- Mirrors the RAMS model: the .docx is converted to a phone-readable page and
-- stored alongside the original. Unlike RAMS there is NO signature/sign-off —
-- a talk is acknowledged at sign-in via site_notice_acks, nothing to sign.
CREATE TABLE IF NOT EXISTS toolbox_talk_templates (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  content       TEXT,                     -- plain-text body: prefills the recorded talk
  html_content  TEXT,                     -- sanitized HTML from the .docx (read view)
  file_key      TEXT,                     -- R2 key of the original document
  file_name     TEXT,
  file_type     TEXT,
  required      INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  created_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tbt_templates_active ON toolbox_talk_templates(active, display_order, title);
