-- 0015_materials_labour.sql
--
-- The pricing workbook's Materials sheet carries a labour rate and labour
-- total per material row (the labour portion of the build-up). Store them
-- alongside the material cost columns so we can surface labour grouped by
-- cost code (PRJ.ELE.L) on a dedicated tab without re-parsing the xlsx.

ALTER TABLE materials ADD COLUMN labour_unit_cost  REAL;  -- labour £ per unit (col S in v2)
ALTER TABLE materials ADD COLUMN labour_total_cost REAL;  -- labour £ for the whole line (col Z in v2)
