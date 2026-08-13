-- Operations module — Phase 1 (site-team basics).
-- Public site sign-in (operatives who aren't app users), daily briefings &
-- toolbox talks acknowledged at sign-in (with geolocation), and a
-- plant-on-site time log. Mobile-first; the public side is reached via a
-- per-project QR/link at /site/:token and the /pub/* API (no auth).

-- A per-project public token backing the QR/sign-in link (/site/:token).
-- One active token per project; rotating it inserts a new row and deactivates
-- the old one (which revokes the old QR).
CREATE TABLE IF NOT EXISTS site_tokens (
  token       TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_tokens_project ON site_tokens(project_id, active);

-- Each operative sign-in / sign-out. Operatives are not app users; they
-- identify by name + company + trade and sign with a finger/mouse signature
-- (PNG data-URL). Geolocation is captured on sign-in.
CREATE TABLE IF NOT EXISTS site_signins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  company       TEXT,
  trade         TEXT,
  phone         TEXT,
  signature     TEXT,            -- PNG data-URL of the drawn signature
  lat           REAL,
  lng           REAL,
  accuracy      REAL,            -- metres (GeolocationCoordinates.accuracy)
  signed_in_at  TEXT NOT NULL,
  signed_out_at TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_signins_project ON site_signins(project_id, signed_in_at);

-- Daily briefings & toolbox talks. Operatives acknowledge active notices when
-- they sign in (geolocation captured on acknowledgement too).
CREATE TABLE IF NOT EXISTS site_notices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,           -- 'briefing' | 'toolbox'
  title       TEXT NOT NULL,
  content     TEXT,
  notice_date TEXT NOT NULL,           -- the day it applies (YYYY-MM-DD)
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_notices_project ON site_notices(project_id, active, notice_date);

-- An operative's acknowledgement of a notice at sign-in.
CREATE TABLE IF NOT EXISTS site_notice_acks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id  INTEGER NOT NULL REFERENCES site_notices(id) ON DELETE CASCADE,
  signin_id  INTEGER REFERENCES site_signins(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  lat        REAL,
  lng        REAL,
  acked_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_notice_acks_notice ON site_notice_acks(notice_id);

-- Plant-on-site time log. When an item of plant arrived / left, so we can
-- compute days on hire and (Phase 3) reconcile against hire POs.
CREATE TABLE IF NOT EXISTS plant_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item          TEXT NOT NULL,
  supplier      TEXT,
  on_hire_from  TEXT,                  -- YYYY-MM-DD
  off_hire_to   TEXT,                  -- YYYY-MM-DD (null = still on site)
  day_rate      REAL,
  notes         TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plant_logs_project ON plant_logs(project_id);
