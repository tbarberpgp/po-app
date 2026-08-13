-- Operative profiles: an org-level register of site operatives. Site sign-ins
-- match to an operative by phone number. Each operative has a company-induction
-- status, uploaded qualification cards (with expiry → status), and the RAMS
-- they've signed from their own profile page (reached via a personal token link).
CREATE TABLE IF NOT EXISTS operatives (
  id             TEXT PRIMARY KEY,
  token          TEXT NOT NULL UNIQUE,        -- personal profile-link token
  name           TEXT NOT NULL,
  phone          TEXT,                         -- match key for site sign-ins
  phone_norm     TEXT,                         -- digits-only normalised phone (matching)
  company        TEXT,
  trade          TEXT,
  email          TEXT,
  induction_done INTEGER NOT NULL DEFAULT 0,
  induction_at   TEXT,
  induction_by   TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  archived_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_operatives_phone ON operatives(phone_norm);

-- Qualification / competency cards (CSCS, ECS, IPAF, first aid, …).
CREATE TABLE IF NOT EXISTS operative_quals (
  id            TEXT PRIMARY KEY,
  operative_id  TEXT NOT NULL REFERENCES operatives(id) ON DELETE CASCADE,
  qual_type     TEXT NOT NULL,                 -- CSCS | ECS | IPAF | First aid | …
  card_no       TEXT,
  file_key      TEXT,                          -- R2 object key for the card image
  file_type     TEXT,
  expiry_date   TEXT,                          -- ISO date; null = no expiry
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operative_quals_op ON operative_quals(operative_id);

-- RAMS signatures. A manager assigns a project's RAMS to an operative (pending);
-- the operative signs it from their profile. signed_at NULL = pending/awaiting.
CREATE TABLE IF NOT EXISTS operative_rams_signs (
  id            TEXT PRIMARY KEY,
  operative_id  TEXT NOT NULL REFERENCES operatives(id) ON DELETE CASCADE,
  rams_id       INTEGER NOT NULL,              -- rams_documents.id
  project_id    TEXT NOT NULL,
  signature     TEXT,                          -- PNG data-URL; null until signed
  signed_at     TEXT,                          -- null = pending
  requested_at  TEXT NOT NULL,
  requested_by  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_op_rams_op ON operative_rams_signs(operative_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_op_rams_unique ON operative_rams_signs(operative_id, rams_id);
