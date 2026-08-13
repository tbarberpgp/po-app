-- Track resolved unmatched lines on a draft AfP so a mis-assignment can be
-- undone (reverse its effect + send the item back to the unmatched list).
-- Each entry keeps the original extracted line plus a `resolution` record
-- ({action, afp_line_id, added_value}) describing what to reverse.
ALTER TABLE applications_for_payment ADD COLUMN resolved_lines_json TEXT;
