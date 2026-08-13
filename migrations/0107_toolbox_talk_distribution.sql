-- Toolbox talks get the RAMS treatment: a gated section-by-section read on the
-- operative's own profile link, pushed out to the crew, tracked per operative.
-- The one deliberate difference from RAMS: talks are ACKNOWLEDGED, never
-- signed — no signature is captured.

-- Structured sections drive the gated reader (same shape as rams_documents).
-- Held on the template AND stamped onto each recorded talk, so editing or
-- removing a template never rewrites a talk already given.
ALTER TABLE toolbox_talk_templates ADD COLUMN sections_json TEXT;
ALTER TABLE site_notices ADD COLUMN sections_json TEXT;
ALTER TABLE site_notices ADD COLUMN html_content TEXT;
ALTER TABLE site_notices ADD COLUMN template_id TEXT;

-- Per-operative distribution + acknowledgement, mirroring operative_rams_signs.
-- requested_at = pushed to them; acked_at = they read it through and confirmed.
-- Distinct from site_notice_acks, which records the passive tick at sign-in.
CREATE TABLE IF NOT EXISTS operative_notice_acks (
  id           TEXT PRIMARY KEY,
  operative_id TEXT NOT NULL REFERENCES operatives(id) ON DELETE CASCADE,
  notice_id    INTEGER NOT NULL REFERENCES site_notices(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  requested_by TEXT,
  acked_at     TEXT,
  UNIQUE(operative_id, notice_id)
);
CREATE INDEX IF NOT EXISTS idx_op_notice_acks_op ON operative_notice_acks(operative_id, acked_at);
CREATE INDEX IF NOT EXISTS idx_op_notice_acks_notice ON operative_notice_acks(notice_id);
