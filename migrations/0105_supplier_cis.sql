-- CIS (Construction Industry Scheme) deduction rate for labour subcontractors:
-- 20 (registered), 30 (unregistered), 0 (gross payment status). NULL = CIS
-- doesn't apply (materials suppliers etc.). The deduction applies to the
-- labour element of certified payments (expenses/materials lines excluded).
ALTER TABLE suppliers ADD COLUMN cis_rate REAL;
