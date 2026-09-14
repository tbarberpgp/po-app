-- Two element codes the pricing workbooks have always used, but which were
-- never seeded into the taxonomy in 0007 — so they existed on materials while
-- being unknown to everything that reads `elements`.
--
-- 37 materials across 26001/2/3, 26004, 26008 and DEMO carry them:
--   25 → 27 materials, all typed "Roofing - Torch on felt"
--   81 → 10 materials, all typed "Deliveries / haulage"
--
-- The numbering is the workbooks' own and slots into the existing families
-- (roofing 20-24, plant/logistics 80), which is why they are added rather than
-- remapped onto an existing code: torch-on felt is not built-up metal (22) and
-- a delivery is not plant hire (80), so remapping would misfile both in every
-- element report.
--
-- What this unblocks: supplier_scopes.element_code is a FOREIGN KEY onto
-- elements(code), so no supplier could ever be approved for either code — the
-- insert was rejected outright. That put every one of these 37 materials
-- outside every supplier's approved scope, which is what kept them out of the
-- "Additional items" picker when raising a PO. Alumasc supplies the whole
-- torch-on family (Euroroof cap sheet, underlay, AVCL, Impertene primer) and
-- had no way to be marked as such.
--
-- OR IGNORE so this is safe to re-run, and safe if the rows were already added
-- by hand against a live database before this migration reached it.
INSERT OR IGNORE INTO elements (code, name, notes) VALUES
  ('25', 'Roofing - Torch on felt',  'Torch-applied reinforced bitumen membrane (built-up felt) systems'),
  ('81', 'Deliveries / haulage',     'Carriage, delivery and pallet charges billed by suppliers');
