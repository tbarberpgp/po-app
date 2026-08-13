-- Rate-variance sign-off on a labour Application for Payment. A line is
-- "off-rate" when it's valued at a rate that differs from the agreed live rate
-- (or, where no live rate exists, the original BOQ budget rate). Such an
-- application is held from certification until either the flagged lines are
-- re-rated to the agreed rate, or a director signs off the variance here —
-- recorded with a reason, mirroring the over-budget approved_at sign-off.
ALTER TABLE applications_for_payment ADD COLUMN rate_override_at     TEXT;
ALTER TABLE applications_for_payment ADD COLUMN rate_override_by     TEXT;
ALTER TABLE applications_for_payment ADD COLUMN rate_override_reason TEXT;
