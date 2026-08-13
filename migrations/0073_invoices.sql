-- Accounts / invoices workpiece — a Dext-style inbox. Invoices arrive by email
-- (invoices@pgpprojects.com) or manual upload, get read by Claude, sit in a
-- review queue, then are routed to a PROJECT (job-costed) or to OVERHEADS
-- (nominal-coded, admin-only) and pushed to Xero as a Bill (ACCPAY).
CREATE TABLE invoices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- inbox → in review; ready → coded & confirmed; pushed → in Xero; dismissed.
  status         TEXT NOT NULL DEFAULT 'inbox',
  -- 'project' (costed to a job) | 'overhead' (company nominal, admin-only) | null until routed.
  kind           TEXT,
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  nominal_code   TEXT,                 -- Xero account code when kind='overhead'

  supplier_id    INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_name  TEXT,                 -- as extracted, before matching to a supplier

  invoice_number TEXT,
  invoice_date   TEXT,
  due_date       TEXT,
  currency       TEXT DEFAULT 'GBP',
  net_amount     REAL,
  vat_amount     REAL,
  gross_amount   REAL,
  lines_json     TEXT,                 -- extracted line items [{description, qty, unit_price, amount, account_code}]

  file_key       TEXT,                 -- R2 key of the original invoice (pdf/word/xlsx/image)
  file_type      TEXT,
  file_name      TEXT,

  source         TEXT NOT NULL DEFAULT 'upload',  -- 'email' | 'upload'
  sender_email   TEXT,
  subject        TEXT,
  notes          TEXT,
  extract_error  TEXT,

  -- Overhead invoices over a threshold (or any, per settings) need admin sign-off.
  needs_approval INTEGER NOT NULL DEFAULT 0,
  approved_by    TEXT,
  approved_at    TEXT,

  xero_bill_id     TEXT,
  xero_bill_number TEXT,
  xero_sync_status TEXT,               -- 'pushed' | 'failed' | null
  xero_sync_error  TEXT,

  received_at    TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT
);
CREATE INDEX idx_invoices_status  ON invoices(status);
CREATE INDEX idx_invoices_kind    ON invoices(kind);
CREATE INDEX idx_invoices_project ON invoices(project_id);
