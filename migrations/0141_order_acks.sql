-- Supplier order acknowledgements (SORs) and delivery notices — the "before it
-- arrives" half of delivery tracking. Each row is one email read from the
-- accounts@ › SOR folder, from projects@ when a supplier thread carries one, or
-- a date someone was told on the phone and typed in (source = 'manual').
--
-- A PO's promised date is its latest MATCHED row's promised_date; with none, the
-- tracker falls back to the PO's own required-by (purchase_orders.delivery_date).
CREATE TABLE IF NOT EXISTS order_acks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key         TEXT NOT NULL UNIQUE,      -- message-id (or manual:<uuid>)
  source             TEXT NOT NULL,             -- sor_folder | projects_email | manual
  kind               TEXT NOT NULL DEFAULT 'acknowledgement', -- acknowledgement | delivery_notice | other
  sender             TEXT,
  subject            TEXT,
  received_at        TEXT,
  file_key           TEXT,                      -- R2 key of the attached acknowledgement (sor/…)
  file_name          TEXT,
  supplier_name      TEXT,
  supplier_order_ref TEXT,                      -- their SOR / order / acknowledgement number
  our_po_ref         TEXT,                      -- what they printed where our PO number goes
  ack_date           TEXT,                      -- YYYY-MM-DD
  promised_date      TEXT,                      -- YYYY-MM-DD; NULL when none or a placeholder
  promised_note      TEXT,                      -- time window, "placeholder date ignored", phone note…
  delivery_address   TEXT,
  goods_total        REAL,
  carriage           REAL,
  total_ex_vat       REAL,
  extracted_json     TEXT,
  po_id              TEXT REFERENCES purchase_orders(id),
  matched_by         TEXT,                      -- po_number | supplier_ref | manual
  suggested_po_id    TEXT,
  suggest_reason     TEXT,
  status             TEXT NOT NULL DEFAULT 'pending', -- matched | pending | dismissed
  dismiss_reason     TEXT,
  actioned_by        TEXT,
  actioned_at        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_acks_po ON order_acks(po_id, status);
CREATE INDEX IF NOT EXISTS idx_order_acks_status ON order_acks(status, received_at);
CREATE INDEX IF NOT EXISTS idx_order_acks_ref ON order_acks(supplier_order_ref);

-- Orders we fetch ourselves (trade counters, Toolstation, Screwfix) never get a
-- supplier delivery date — they belong on the "To collect" list instead.
ALTER TABLE purchase_orders ADD COLUMN collect_by_us INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN collector TEXT;
