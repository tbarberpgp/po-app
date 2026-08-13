-- Operations Phase 2 — file-backed site records. Binary (delivery-ticket
-- photos, RAMS documents, progress photos) lives in R2; metadata + R2 object
-- keys live here. R2 keys are prefixed (deliveries/ rams/ progress/) and
-- carry a uuid so they're unguessable.

-- Materials checked in on site: a photo of the delivery ticket + a sign-off.
CREATE TABLE IF NOT EXISTS site_deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  supplier      TEXT,
  description   TEXT,                 -- what arrived
  po_number     TEXT,                 -- optional cross-ref to a PO (free text)
  ticket_key    TEXT,                 -- R2 object key for the delivery-ticket photo
  ticket_type   TEXT,                 -- mime type of the ticket photo
  signed_by     TEXT,                 -- who received / signed for it
  signature     TEXT,                 -- PNG data-URL signature
  status        TEXT NOT NULL DEFAULT 'received', -- received | partial | rejected
  notes         TEXT,
  delivered_at  TEXT NOT NULL,        -- when it was delivered
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_deliveries_project ON site_deliveries(project_id, delivered_at);

-- RAMS / COSHH / permits and other site safety documents.
CREATE TABLE IF NOT EXISTS rams_documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'RAMS',  -- RAMS | COSHH | Permit | Other
  file_key    TEXT NOT NULL,          -- R2 object key
  file_name   TEXT,
  file_type   TEXT,
  file_size   INTEGER,
  version     TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rams_project ON rams_documents(project_id, active);

-- Daily progress photos.
CREATE TABLE IF NOT EXISTS progress_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_key    TEXT NOT NULL,          -- R2 object key
  file_type   TEXT,
  caption     TEXT,
  taken_on    TEXT,                   -- YYYY-MM-DD the photo represents
  lat         REAL,
  lng         REAL,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_progress_photos_project ON progress_photos(project_id, taken_on);
