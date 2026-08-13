-- 0095: an incoming labour application can be tagged as PRELIMS spend (e.g. a
-- subcontract project manager's time). Non-null = tagged; the value is the
-- prelim heading it expends (matching the Prelims tab headings). Additive.
ALTER TABLE applications_for_payment ADD COLUMN prelim_heading TEXT;
