-- 0013_project_quotes.sql
--
-- Project-scoped supplier quotes: when a quote is uploaded against a specific
-- project, we match each quote line against the project's BOQ materials
-- (instead of the master product catalogue). Cheaper lines apply
-- automatically and surface as "live prices" on the project; pricier lines
-- route through the existing approval tiers based on the £ overspend.
--
-- The Materials snapshot is intentionally never mutated — the BOQ stays as
-- the fixed-point-in-time baseline. The new material_live_prices table is a
-- separate layer that records every applied/pending price update with full
-- audit, joined back to the materials row at query time.

-- supplier_quotes can now be scoped to a project. Nullable: NULL = catalogue
-- quote (updates product_suppliers like before), set = project quote.
ALTER TABLE supplier_quotes ADD COLUMN project_id TEXT REFERENCES projects(id);
CREATE INDEX idx_supplier_quotes_project ON supplier_quotes(project_id);

-- supplier_quote_lines can match to a project material (alternative to the
-- existing matched_product_id which is catalogue-scoped). We also snapshot
-- the BOQ cost + qty at apply time so the delta is always visible against
-- the baseline, even if the materials sheet is later re-uploaded.
ALTER TABLE supplier_quote_lines ADD COLUMN matched_material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL;
ALTER TABLE supplier_quote_lines ADD COLUMN boq_unit_cost REAL;
ALTER TABLE supplier_quote_lines ADD COLUMN boq_qty REAL;
CREATE INDEX idx_supplier_quote_lines_material ON supplier_quote_lines(matched_material_id);

-- One row per applied/pending price update. We keep history (don't delete
-- superseded rows) so audit trails survive. The materials API joins to the
-- LATEST applied row per material to surface the "live" price; pending rows
-- are surfaced separately.
CREATE TABLE material_live_prices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id     INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  quote_line_id   INTEGER NOT NULL REFERENCES supplier_quote_lines(id) ON DELETE CASCADE,
  quote_id        INTEGER NOT NULL REFERENCES supplier_quotes(id) ON DELETE CASCADE,
  project_id      TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  unit_price      REAL    NOT NULL,
  boq_unit_cost   REAL,                                              -- snapshot of materials.cost at apply time
  boq_qty         REAL,                                              -- snapshot of quoted qty for delta calc
  over_amount     REAL    NOT NULL DEFAULT 0,                        -- (qty × (unit_price - boq_unit_cost)); 0 or negative = no overspend
  -- 'applied'          cheaper or equal to BOQ — auto-approved
  -- 'pending_approval' more expensive than BOQ — sitting in the inbox
  -- 'approved'         pending row that has now been approved
  -- 'rejected'         approver declined; price stays at BOQ
  status          TEXT    NOT NULL,
  approval_tier   TEXT,                                              -- 'line_manager' | 'commercial_manager' | 'director' when pending
  applied_at      TEXT    NOT NULL,
  applied_by      TEXT    NOT NULL,
  approved_at     TEXT,
  approved_by     TEXT,
  rejected_at     TEXT,
  rejected_by     TEXT,
  rejection_reason TEXT
);
CREATE INDEX idx_mlp_material  ON material_live_prices(material_id);
CREATE INDEX idx_mlp_project   ON material_live_prices(project_id);
CREATE INDEX idx_mlp_status    ON material_live_prices(status);
CREATE INDEX idx_mlp_tier      ON material_live_prices(approval_tier);
