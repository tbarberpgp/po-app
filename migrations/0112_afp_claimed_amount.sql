-- Prelim allowance drawdown: a prelim-tagged application (prelim_heading set)
-- carries a single claimed £ amount instead of line matching — management/PM
-- time invoices never match BOQ lines, which is why prelim apps read £0.
-- The claimed amount becomes the application's value and draws the prelim
-- heading's allowance down. Additive.
ALTER TABLE applications_for_payment ADD COLUMN claimed_amount REAL;
