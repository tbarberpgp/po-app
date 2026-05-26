-- 0011_materials_element_code.sql
--
-- Pricing workbooks (from MCR007 onward) put a numeric Element Code in col B
-- and the descriptive Element Name in col Z. Older workbooks just had a
-- free-text "type" in col B. Store the code separately so we can:
--   - auto-link materials to the elements table (for cost coding / product
--     suggestions) without parsing the descriptive name back to a code, and
--   - keep `materials.type` as the human-readable label that the UI already
--     renders in filters and tables.
--
-- Nullable so existing snapshots (old format) stay valid.

ALTER TABLE materials ADD COLUMN element_code TEXT;

CREATE INDEX IF NOT EXISTS idx_materials_element_code ON materials(element_code);
