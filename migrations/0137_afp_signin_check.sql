-- 0137: days on site, recorded when a labour application is certified.
--
-- Paul Garbutt bills Blyth by the day ("N × £550"). Nothing in the app checked
-- N against the site sign-in register, and on 2026-10-12 Blyth had no sign-ins
-- at all — fifteen invoices certified or paid on nobody's evidence. The certify
-- panel now shows who from the subcontractor signed in over the period, asks
-- the QS for the days on the invoice, and wants a note when the two disagree.
-- These columns keep what the QS saw, so the approver and anyone auditing
-- later read the same thing.
--
--   invoiced_days  days (or person-days) on the invoice, as the QS read it
--   signin_days    person-days the register showed for the period at certify
--   signin_from/to the period the register was read over (YYYY-MM-DD, inclusive)
--   signin_note    the QS's explanation when the two disagree
--
-- Additive; existing rows read NULL (no check recorded).
ALTER TABLE applications_for_payment ADD COLUMN invoiced_days REAL;
ALTER TABLE applications_for_payment ADD COLUMN signin_days REAL;
ALTER TABLE applications_for_payment ADD COLUMN signin_from TEXT;
ALTER TABLE applications_for_payment ADD COLUMN signin_to TEXT;
ALTER TABLE applications_for_payment ADD COLUMN signin_note TEXT;
