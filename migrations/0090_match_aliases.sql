-- 0090: match memory — learned aliases from human corrections. When someone
-- maps a supplier's wording ("VIEO 38-525-1050 0.7MM GAUGE…") onto our PO line
-- or contract item ("MS-B36 METShield Bars @ 3.6m"), the pair is recorded here;
-- the matchers consult it BEFORE the code/token heuristics, so the same
-- correction never has to be made twice. One row per (kind, supplier, alias),
-- the latest correction winning.
--   kind: 'delivery_item' (ticket item → PO line)
--         'invoice_line'  (invoice line → PO line)
--         'afp_line'      (application line → contract item)
CREATE TABLE IF NOT EXISTS match_aliases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,
  supplier_norm TEXT NOT NULL DEFAULT '',    -- normalized supplier ('' = any)
  alias_norm    TEXT NOT NULL,               -- normalized source wording
  target_norm   TEXT NOT NULL,               -- normalized target wording
  alias_text    TEXT,                        -- human-readable, for the audit trail
  target_text   TEXT,
  hits          INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  last_used_at  TEXT,
  UNIQUE(kind, supplier_norm, alias_norm)
);
CREATE INDEX IF NOT EXISTS idx_match_aliases_lookup ON match_aliases(kind, supplier_norm);
