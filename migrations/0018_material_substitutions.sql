-- 0018_material_substitutions.sql
--
-- Lets a project swap one material on the BOQ for a different supplier / brand
-- / spec WITHOUT disturbing the original BOQ snapshot. The original's
-- budget allowance still draws down — POs raised after the swap just inherit
-- the replacement's item description / manufacturer / cost as defaults so
-- the right product gets ordered.
--
-- Three replacement sources are supported (any combination):
--   * master product library  →  replacement_product_id
--   * project-scoped supplier quote line  →  replacement_quote_line_id
--   * freeform                →  no FK, just the typed fields
--
-- "kind" captures the procurement intent so reporting can distinguish a
-- brand swap from a real variation:
--   like_for_like       same allowance, same role, different supplier/brand
--   equivalent_spec     different unit/pack but achieves the same outcome
--   variation           wholesale replacement (kept on the BOQ as the
--                       cost cap, but treat as a contract variation)

CREATE TABLE material_substitutions (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id                 INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  project_id                  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Replacement source — may be null when the replacement is freeform.
  replacement_product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
  replacement_quote_line_id   INTEGER REFERENCES supplier_quote_lines(id) ON DELETE SET NULL,

  -- Frozen replacement details (always populated, even when sourced from a
  -- product/quote — so a later product edit doesn't silently change what we
  -- subbed in).
  replacement_item            TEXT NOT NULL,
  replacement_manufacturer    TEXT,
  replacement_supplier        TEXT,
  replacement_cost            REAL,                -- £ per unit
  replacement_unit            TEXT,                -- "ea", "m2", "Roll", etc.
  replacement_total_units     REAL,                -- expected qty (defaults to original)

  kind                        TEXT NOT NULL DEFAULT 'like_for_like',
  reason                      TEXT,
  notes                       TEXT,

  -- Only one substitution is active per material at any time. Reverts and
  -- replacements set this to 0 so the audit trail of past swaps survives.
  active                      INTEGER NOT NULL DEFAULT 1,

  created_at                  TEXT NOT NULL,
  created_by                  TEXT NOT NULL,
  reverted_at                 TEXT,
  reverted_by                 TEXT,
  reverted_reason             TEXT
);
CREATE INDEX idx_msub_material ON material_substitutions(material_id);
CREATE INDEX idx_msub_project  ON material_substitutions(project_id);
CREATE INDEX idx_msub_active   ON material_substitutions(active);

-- Enforce "only one active per material" at the database level. Two active
-- rows for the same material would let two replacements compete; this index
-- makes that an error.
CREATE UNIQUE INDEX idx_msub_one_active_per_material
  ON material_substitutions(material_id) WHERE active = 1;
