-- Add pack-unit columns from the Materials tab.
--   col V → total_units      (qty to purchase in pack units, e.g. number of Rolls)
--   col W → total_units_unit (the pack unit, e.g. Roll/Box/ea — what suppliers sell)
--
-- POs are raised in pack units (qty × pack cost from col F), so budget tracking
-- happens against total_units rather than total_qty (which is in measurement units
-- like m²/lm and is useful for QSing but not for purchasing).

ALTER TABLE materials ADD COLUMN total_units REAL;
ALTER TABLE materials ADD COLUMN total_units_unit TEXT;
