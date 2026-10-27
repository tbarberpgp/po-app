-- Blyth 26004, section 13 "Re-site & Reinstall": item 6 reworded from
-- "Downpipes reinstalled and connected to drainage" to "Downpipes reinstalled"
-- (requested 2026-10-27).
-- Text only: the item keeps its position, so every captured check, entry and
-- photo (keyed by index) stays aligned. A re-run is a no-op.
UPDATE qitp_sections
   SET items = replace(items, '"Downpipes reinstalled and connected to drainage"', '"Downpipes reinstalled"')
 WHERE project_id = (SELECT id FROM projects WHERE code = '26004')
   AND title = 'Re-site & Reinstall'
   AND instr(items, '"Downpipes reinstalled and connected to drainage"') > 0;
