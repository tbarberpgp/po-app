-- Per-line certified percentage. The applied (claimed) % stays in
-- percent_complete; certified_percent is what PowerGrid / the client certifies.
-- Null until certified — the money falls back to the applied % via COALESCE.
ALTER TABLE afp_lines ADD COLUMN certified_percent REAL;
