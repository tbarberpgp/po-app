-- Live subcontractor labour rates — the labour analogue of material_live_prices.
-- A subbie's labour rate schedule is uploaded (PDF/XLSX), Claude extracts the
-- rates and matches them to the BOQ labour lines (contract_items), and the
-- agreed rate is stored here per line. Savings from Labour = Σ (BOQ labour rate
-- − live rate) × qty over the matched lines (mirrors material quote savings).
CREATE TABLE IF NOT EXISTS labour_live_rates (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       TEXT NOT NULL,
  snapshot_id      INTEGER,
  contract_item_id INTEGER NOT NULL,
  description      TEXT,
  qty              REAL,
  boq_rate         REAL,           -- snapshot of the BOQ labour rate at apply time
  live_rate        REAL NOT NULL,  -- agreed / quoted subcontractor labour rate
  supplier_id      INTEGER,
  source           TEXT,           -- uploaded filename / note
  status           TEXT NOT NULL DEFAULT 'applied',  -- 'applied' | 'approved' | 'rejected'
  applied_at       TEXT NOT NULL,
  applied_by       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_labour_live_rates_item    ON labour_live_rates(contract_item_id);
CREATE INDEX IF NOT EXISTS idx_labour_live_rates_project ON labour_live_rates(project_id);
