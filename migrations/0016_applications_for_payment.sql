-- 0016_applications_for_payment.sql
--
-- The Application for Payment (AfP) workflow + the underlying contract item
-- list that AfPs claim against.
--
-- The same data model serves two directions:
--   - 'outgoing'        PowerGrid → Client. Rate = sell rate from Pricing tab.
--   - 'incoming_labour' Subcontractor → PowerGrid. Rate = labour rate from
--                       Costing Labour Only tab. Built in a follow-up step.
--
-- Workflow: draft → submitted → certified → paid.

-- A project's default retention rate. Snapshotted on each AfP so historical
-- documents stay correct if the project default changes.
ALTER TABLE projects ADD COLUMN retention_pct REAL NOT NULL DEFAULT 5.0;

-- The contract item list — one row per work item from the Pricing tab. The
-- AfP create flow seeds its lines from these rows. Both sell rate (Pricing)
-- and labour rate (Costing Labour Only) are captured so the same item list
-- serves both AfP directions.
CREATE TABLE contract_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id   INTEGER NOT NULL REFERENCES material_snapshots(id) ON DELETE CASCADE,
  item_no       INTEGER NOT NULL,        -- 1-based position in document order
  section       TEXT,                    -- col A section header above the item (e.g. "Roof")
  description   TEXT NOT NULL,           -- col A on the item row
  qty           REAL NOT NULL,           -- col D
  unit          TEXT,                    -- col E
  sell_rate     REAL NOT NULL,           -- col K from Pricing tab (£ per unit, ex VAT)
  sell_total    REAL NOT NULL,           -- col M from Pricing tab (= qty × sell_rate)
  labour_rate   REAL,                    -- col K from Costing Labour Only tab
  labour_total  REAL,                    -- col M from Costing Labour Only tab
  UNIQUE(snapshot_id, item_no)
);
CREATE INDEX idx_contract_items_snapshot ON contract_items(snapshot_id);

CREATE TABLE applications_for_payment (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  direction     TEXT NOT NULL DEFAULT 'outgoing', -- 'outgoing' | 'incoming_labour'
  app_number    INTEGER NOT NULL,                 -- sequential per (project, direction)
  period_end    TEXT NOT NULL,                    -- ISO date — "for works to date as of …"
  notes         TEXT,
  retention_pct REAL NOT NULL DEFAULT 5.0,
  vat_pct       REAL NOT NULL DEFAULT 20.0,
  -- Snapshotted totals (refreshed on each edit while draft, frozen on submit)
  contract_sum       REAL,
  cumulative_value   REAL,
  previous_certified REAL,
  this_period_net    REAL,
  retention_amount   REAL,
  amount_due         REAL,
  vat_amount         REAL,
  total_invoice      REAL,
  -- Workflow state
  status        TEXT NOT NULL DEFAULT 'draft',    -- 'draft'|'submitted'|'certified'|'paid'
  -- For incoming_labour, points to the subcontractor in the supplier register
  counterparty_supplier_id INTEGER REFERENCES suppliers(id),
  -- Audit trail
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  submitted_at  TEXT,
  submitted_by  TEXT,
  certified_at  TEXT,
  certified_by  TEXT,
  certified_amount REAL,            -- what the counterparty agreed (may differ from amount_due)
  paid_at       TEXT,
  paid_by       TEXT,
  payment_reference TEXT,
  UNIQUE(project_id, direction, app_number)
);
CREATE INDEX idx_afp_project   ON applications_for_payment(project_id);
CREATE INDEX idx_afp_status    ON applications_for_payment(status);
CREATE INDEX idx_afp_direction ON applications_for_payment(direction);

CREATE TABLE afp_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  afp_id        INTEGER NOT NULL REFERENCES applications_for_payment(id) ON DELETE CASCADE,
  -- BOQ-derived rows point at the source contract item. Variations / ad-hoc
  -- rows leave this null and set is_adhoc=1.
  contract_item_id INTEGER REFERENCES contract_items(id) ON DELETE SET NULL,
  section       TEXT,
  description   TEXT NOT NULL,
  unit          TEXT,
  qty           REAL,
  rate          REAL NOT NULL,                  -- frozen at create time (sell or labour rate)
  contract_value REAL NOT NULL,                 -- qty × rate
  percent_complete REAL NOT NULL DEFAULT 0,     -- 0..100
  cumulative_value REAL NOT NULL DEFAULT 0,     -- contract_value × percent_complete / 100
  is_adhoc      INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL,
  UNIQUE(afp_id, display_order)
);
CREATE INDEX idx_afp_lines_afp      ON afp_lines(afp_id);
CREATE INDEX idx_afp_lines_contract ON afp_lines(contract_item_id);
