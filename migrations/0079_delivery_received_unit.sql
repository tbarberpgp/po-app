-- Scheme-type PO lines are ordered as one bundle (e.g. "Tapered Insulation
-- Scheme", 1 scheme / 210 m²) but delivered in parts in a different unit (packs,
-- pallets). We can't convert packs → m², so a line burns down as a running tally
-- of what's landed in its own unit, completed manually. This stores the unit for
-- each drop's received_qty so the tally reads "57 packs across 3 drops".
ALTER TABLE site_deliveries ADD COLUMN received_unit TEXT;
