-- Project-scoped Cabin QITP (Quality Inspection & Test Plan).
-- Generic schema (any project can have a QITP template), shipped with the Blyth
-- 26004 strip-out template seeded in 0063. A project has many cabins; the
-- template is an ordered set of sections (same per cabin); each cabin × section
-- has an inspection record (status, notes, sign-off) created lazily on first
-- write — an absent record means "not started". Evidence photos hang off the
-- cabin+section so they exist before any record row does.

-- The ordered section template for a project (title + optional hold/witness point).
CREATE TABLE IF NOT EXISTS qitp_sections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,              -- 1-based display order
  title       TEXT NOT NULL,
  point_type  TEXT,                          -- 'HOLD' | 'WITNESS' | NULL
  items       TEXT,                          -- JSON array of checklist item strings
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qitp_sections_proj ON qitp_sections(project_id, seq);

-- The cabins (one QR token each, for the phone inspection journey).
CREATE TABLE IF NOT EXISTS qitp_cabins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number        TEXT NOT NULL,               -- 'T1', 'M12', 'G48'
  floor         TEXT NOT NULL,               -- Top | Middle | Ground (drives colour band)
  elevation     TEXT,                        -- East | West
  wing          TEXT,                        -- North | South
  position      INTEGER,
  dismantle_day INTEGER,                     -- pyramid strip-out day
  storage_bay   TEXT,
  token         TEXT NOT NULL UNIQUE,        -- QR / public-link capability token
  created_at    TEXT NOT NULL,
  UNIQUE(project_id, number)
);
CREATE INDEX IF NOT EXISTS idx_qitp_cabins_proj ON qitp_cabins(project_id);

-- Per cabin × section inspection state. Lazily upserted on first write.
CREATE TABLE IF NOT EXISTS qitp_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cabin_id    INTEGER NOT NULL REFERENCES qitp_cabins(id) ON DELETE CASCADE,
  section_id  INTEGER NOT NULL REFERENCES qitp_sections(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'not_started',  -- not_started | pass | in_progress | fail | na
  checks      TEXT,                          -- JSON array of booleans, one per section item
  inspector   TEXT,                          -- inspector name (typed)
  company     TEXT,                          -- PGP / Durata / …
  notes       TEXT,
  photo_ref   TEXT,                          -- free-text "paste a link / file ref"
  signed_name TEXT,
  signature   TEXT,                          -- PNG data-URL of the finger signature
  signed_at   TEXT,
  updated_at  TEXT,
  UNIQUE(cabin_id, section_id)
);
CREATE INDEX IF NOT EXISTS idx_qitp_records_cabin ON qitp_records(cabin_id);

-- Evidence photos (multiple per cabin+section), bytes in R2.
CREATE TABLE IF NOT EXISTS qitp_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cabin_id    INTEGER NOT NULL REFERENCES qitp_cabins(id) ON DELETE CASCADE,
  section_id  INTEGER NOT NULL REFERENCES qitp_sections(id) ON DELETE CASCADE,
  file_key    TEXT NOT NULL,                 -- R2 object key
  file_type   TEXT,
  created_at  TEXT NOT NULL,
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_qitp_photos_cs ON qitp_photos(cabin_id, section_id);
