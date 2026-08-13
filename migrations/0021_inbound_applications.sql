-- Holding tray for labour applications received by email that we couldn't
-- fully route — typically because no project code was found in the subject /
-- filename / body. We park the extracted lines here (the parse is
-- project-independent) so the user can assign a project (and subcontractor)
-- in the Applications workspace, at which point we run the BOQ match and
-- create the real draft AfP.
CREATE TABLE inbound_applications (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at              TEXT NOT NULL,
  sender_email             TEXT NOT NULL,
  subject                  TEXT,
  filename                 TEXT,
  -- Resolved at receive time when possible; assigned later otherwise.
  counterparty_supplier_id INTEGER REFERENCES suppliers(id),
  -- Project-independent parse: JSON array of ExtractedLabourLine.
  extracted_lines_json     TEXT NOT NULL,
  -- pending → awaiting assignment; resolved → AfP created; dismissed → discarded
  status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'resolved', 'dismissed')),
  resolved_afp_id          INTEGER REFERENCES applications_for_payment(id),
  note                     TEXT
);

CREATE INDEX idx_inbound_apps_status ON inbound_applications (status, received_at DESC);
