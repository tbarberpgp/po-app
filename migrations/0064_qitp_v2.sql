-- QITP v2: per-section responsible parties, multi-party sign-off to release, and
-- per-item photos (optional or required). Section "items" become JSON objects
-- { text, hold, photo: "none"|"optional"|"required" }. Sign-off moves from a
-- single signature on qitp_records to one row per (cabin, section, party) in
-- qitp_signoffs — a section is "released" when every responsible party has signed.

-- Responsible parties for a section (JSON array of company names, e.g. ["Durata","PGP"]).
ALTER TABLE qitp_sections ADD COLUMN responsible TEXT;

-- Per-item photos: NULL = the section-level evidence gallery; an integer = that
-- checklist item's index.
ALTER TABLE qitp_photos ADD COLUMN item_index INTEGER;

-- One sign-off per responsible party, per cabin × section.
CREATE TABLE IF NOT EXISTS qitp_signoffs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cabin_id    INTEGER NOT NULL REFERENCES qitp_cabins(id) ON DELETE CASCADE,
  section_id  INTEGER NOT NULL REFERENCES qitp_sections(id) ON DELETE CASCADE,
  party       TEXT NOT NULL,                 -- responsible company that signed
  signed_name TEXT NOT NULL,
  signature   TEXT NOT NULL,                 -- PNG data-URL
  signed_at   TEXT NOT NULL,
  UNIQUE(cabin_id, section_id, party)
);
CREATE INDEX IF NOT EXISTS idx_qitp_signoffs_cabin ON qitp_signoffs(cabin_id);
