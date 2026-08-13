-- Delivery tickets that arrive via the site WhatsApp group land as progress
-- photos (created_by = 'whatsapp'). This table records the result of scanning
-- each one for a PO number so genuine tickets can be surfaced as ready-to-
-- confirm delivery check-ins — and so we never pay to re-scan the same image.
CREATE TABLE IF NOT EXISTS delivery_ticket_scans (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id            TEXT NOT NULL,          -- base site project the photo belongs to
  photo_id              INTEGER,                -- progress_photos.id (if sourced from there)
  photo_key             TEXT NOT NULL,          -- R2 object key of the image
  is_ticket             INTEGER NOT NULL DEFAULT 0,
  po_number             TEXT,
  supplier_name         TEXT,
  delivery_note_number  TEXT,
  delivery_date         TEXT,
  summary               TEXT,
  extracted_json        TEXT,                   -- full ExtractedDelivery JSON
  matched_po_id         TEXT,                   -- purchase_orders.id if a PO matched
  matched_by            TEXT,                   -- 'po_number' | 'supplier' | null
  status                TEXT NOT NULL DEFAULT 'pending', -- pending | checked_in | dismissed
  delivery_id           INTEGER,                -- site_deliveries.id once checked in
  occurred_at           TEXT,                   -- when the photo was taken/received
  scanned_at            TEXT NOT NULL,
  scanned_by            TEXT,
  UNIQUE (photo_key)
);
CREATE INDEX IF NOT EXISTS idx_dts_project_status ON delivery_ticket_scans(project_id, status);
