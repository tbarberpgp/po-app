-- Persist parsed lines from a subcontractor's labour application that
-- couldn't be auto-matched to a contract_item, so the user can review
-- them on the AfP detail page and either match them to a BOQ line or
-- add them as ad-hoc variation lines.
--
-- Stored as JSON of: [{ description, qty, unit, this_period_value,
--                       cumulative_pct, raw_line_no }, ...]
-- Cleared once the user has resolved each entry.
ALTER TABLE applications_for_payment
  ADD COLUMN unmatched_lines_json TEXT;
