-- Contract items now span all three value sections of the cost workbook, not
-- just the measured-works Pricing tab:
--   prelims  → Prelims tab (Management, Design, Plant…)
--   measured → Pricing tab (the main BOQ)
--   ancil    → Ancil Items tab (fall arrest, rooflights, LPS…)
-- Existing rows were all measured-works, so default accordingly.
ALTER TABLE contract_items
  ADD COLUMN category TEXT NOT NULL DEFAULT 'measured'
    CHECK (category IN ('prelims', 'measured', 'ancil'));
