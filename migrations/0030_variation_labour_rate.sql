-- Variation labour lines now carry a qty and a unit rate (value = qty × rate),
-- mirroring material lines, so labour shows as a rate and then a value.
-- Backfill existing rows: treat the stored value as one unit at that rate.
ALTER TABLE variation_labour ADD COLUMN qty REAL NOT NULL DEFAULT 1;
ALTER TABLE variation_labour ADD COLUMN unit_rate REAL NOT NULL DEFAULT 0;
UPDATE variation_labour SET unit_rate = value, qty = 1;
