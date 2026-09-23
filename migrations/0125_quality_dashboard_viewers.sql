-- Who may open a project's client quality dashboard.
--
-- The dashboard used to be open to anyone holding its /pub/quality/:token
-- link. It now asks for an email address and sends a one-time code, and only
-- addresses listed here for that project get one. Superadmins manage the list
-- from the QITP screen. /pub/* stays Access-bypassed, so the check lives in the
-- worker rather than in Cloudflare Access: clients are outside Access's policy.
CREATE TABLE IF NOT EXISTS quality_dashboard_viewers (
  project_id TEXT NOT NULL,
  email      TEXT NOT NULL,           -- stored lower-cased
  added_by   TEXT NOT NULL,
  added_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, email)
);

-- One-time sign-in codes. Only a SHA-256 of the code is kept; a code lives
-- ten minutes and dies after five wrong guesses.
CREATE TABLE IF NOT EXISTS quality_dashboard_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qdc_lookup ON quality_dashboard_codes(project_id, email, created_at);

-- Signed-in browsers. The cookie carries a random token; only its SHA-256 is
-- stored. Every view re-checks that the email is still on the viewer list, so
-- removing someone cuts them off at once rather than when the session expires.
CREATE TABLE IF NOT EXISTS quality_dashboard_sessions (
  token_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  email      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
