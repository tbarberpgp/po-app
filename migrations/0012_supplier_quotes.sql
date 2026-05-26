-- 0012_supplier_quotes.sql
--
-- Supplier quote upload pipeline. A PM drops a supplier's PDF quote on the
-- supplier's detail page; Claude extracts line items into supplier_quote_lines;
-- the PM reviews each line and matches it to a product in the catalogue;
-- applying writes the new unit_cost to product_suppliers and snapshots the
-- previous price on the quote line so the savings/losses summary survives.

CREATE TABLE supplier_quotes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  uploaded_at   TEXT NOT NULL,
  uploaded_by   TEXT NOT NULL,
  -- 'extracting'  Claude API is parsing the PDF
  -- 'ready'       extraction succeeded, awaiting review/apply
  -- 'applied'     the PM applied (some or all) lines to the catalogue
  -- 'discarded'   PM threw it away
  -- 'failed'      extraction errored — see extraction_error
  status        TEXT NOT NULL DEFAULT 'extracting',
  extraction_error TEXT,
  -- Free-form notes the PM jotted on upload (quote reference, valid-until, etc.)
  notes         TEXT,
  -- Set on apply: aggregate delta across applied lines, in pence/£.
  total_applied_value REAL,
  total_old_value     REAL,
  applied_at    TEXT,
  applied_by    TEXT
);
CREATE INDEX idx_supplier_quotes_supplier ON supplier_quotes(supplier_id);
CREATE INDEX idx_supplier_quotes_status   ON supplier_quotes(status);

CREATE TABLE supplier_quote_lines (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id          INTEGER NOT NULL REFERENCES supplier_quotes(id) ON DELETE CASCADE,
  line_no           INTEGER NOT NULL,                 -- 1-based position from the PDF
  -- Raw extracted fields as Claude returned them.
  raw_description   TEXT NOT NULL,
  raw_sku           TEXT,
  raw_qty           REAL,
  raw_unit          TEXT,
  unit_price        REAL,                             -- the new price (£ per unit)
  -- Matching state: which product+supplier row will this overwrite when applied.
  matched_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  matched_product_supplier_id INTEGER REFERENCES product_suppliers(id) ON DELETE SET NULL,
  match_confidence  REAL,                             -- 0..1 score; informational
  -- Captured at apply time so the delta summary survives later price changes.
  old_unit_price    REAL,
  is_applied        INTEGER NOT NULL DEFAULT 0,
  skip_reason       TEXT,                             -- when intentionally skipped
  UNIQUE(quote_id, line_no)
);
CREATE INDEX idx_supplier_quote_lines_quote   ON supplier_quote_lines(quote_id);
CREATE INDEX idx_supplier_quote_lines_product ON supplier_quote_lines(matched_product_id);
