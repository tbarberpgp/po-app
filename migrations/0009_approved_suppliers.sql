-- Approved suppliers register. Distinct from `product_suppliers` (per-product
-- pricing offers): this is the org-level "who are we allowed to buy from,
-- and on what terms" list. Used for approvals, audit, and onboarding new
-- merchants.
--
-- Status meanings:
--   approved   — default; can be used on POs without flagging
--   preferred  — visually highlighted; pick this one first when multiple suppliers can fulfil
--   suspended  — in dispute / on hold; PO raising should warn
--   pending    — onboarding / awaiting credit check; warn

CREATE TABLE suppliers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'approved',
  scope_notes       TEXT,                     -- free-text scope description
  payment_terms     TEXT,                     -- e.g. "Net 30", "Net 60", "Pro forma", "COD"
  contact_name      TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  address           TEXT,
  vat_number        TEXT,
  credit_limit_gbp  REAL,
  notes             TEXT,
  created_at        TEXT NOT NULL,
  created_by        TEXT,
  CHECK (status IN ('approved', 'preferred', 'suspended', 'pending'))
);

-- Which elements this supplier is approved to provide (e.g. Alumasc → roofing
-- elements only; SIG → broader range). Many-to-many with the elements table.
CREATE TABLE supplier_scopes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id    INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  element_code   TEXT NOT NULL REFERENCES elements(code),
  UNIQUE(supplier_id, element_code)
);
CREATE INDEX idx_supplier_scopes_supplier  ON supplier_scopes(supplier_id);
CREATE INDEX idx_supplier_scopes_element   ON supplier_scopes(element_code);
