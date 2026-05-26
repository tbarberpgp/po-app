-- Xero accounting integration.
--
-- Stores the OAuth connection to a single Xero organisation (tenant) plus the
-- cross-reference IDs Xero uses for Contacts and Purchase Orders, so we can:
--   1. Pull supplier contacts FROM Xero into our suppliers register
--   2. Push our approved POs INTO Xero as draft purchase orders for AP matching

CREATE TABLE xero_connection (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL UNIQUE,    -- the Xero org's UUID
  tenant_name     TEXT,                    -- friendly org name (e.g. "Power Grid Projects Ltd")
  tenant_type     TEXT,                    -- ORGANISATION | PRACTICE
  access_token    TEXT NOT NULL,
  refresh_token   TEXT NOT NULL,
  expires_at      TEXT NOT NULL,           -- ISO timestamp; access_token expires every ~30min
  scopes          TEXT,                    -- space-separated OAuth scopes granted
  connected_at    TEXT NOT NULL,
  connected_by    TEXT NOT NULL            -- email of the admin who authorised
);

-- Per-supplier link to Xero Contact
ALTER TABLE suppliers ADD COLUMN xero_contact_id     TEXT;
ALTER TABLE suppliers ADD COLUMN xero_last_synced_at TEXT;
CREATE INDEX idx_suppliers_xero ON suppliers(xero_contact_id);

-- Per-PO link to Xero Purchase Order
ALTER TABLE purchase_orders ADD COLUMN xero_po_id        TEXT;
ALTER TABLE purchase_orders ADD COLUMN xero_po_number    TEXT;  -- Xero's auto-generated PO# for cross-reference
ALTER TABLE purchase_orders ADD COLUMN xero_synced_at    TEXT;
ALTER TABLE purchase_orders ADD COLUMN xero_sync_status  TEXT;  -- 'synced' | 'failed' | 'pending' | NULL
ALTER TABLE purchase_orders ADD COLUMN xero_sync_error   TEXT;
CREATE INDEX idx_pos_xero ON purchase_orders(xero_po_id);
