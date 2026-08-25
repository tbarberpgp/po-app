-- 0114: Blyth (26004) Paint Repairs — 'Mechanical Prep' was listed three times
-- in the Rev 2 sheet; it belongs only once, before the primer coat. Drops the
-- two later repeats (before Midcoat and before Top Coat), 22 items -> 20.
--
-- Removed old item indices 9 and 16. Everything after them shifts down, so the
-- captured-data reindex below keeps any evidence aligned to the right item:
--   old 0-8 -> same | old 10-15 -> -1 | old 17-21 -> -2
--
-- At apply time the section held one record (all-false ticks, no readings), no
-- photos and no sign-offs, so there was nothing to move — but site is actively
-- inspecting, so the reindex runs anyway for anything captured in between. It
-- is length-guarded (only arrays built against the 22-item template) so it
-- cannot touch a record already written against the corrected list.

-- 1. The corrected 20-item checklist.
UPDATE qitp_sections SET items='[{"text": "Before Repairs", "hold": false, "photo": "optional", "entry": "none"}, {"text": "Surface Profile", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Mechanical Prep", "hold": false, "photo": "optional", "entry": "none"}, {"text": "Steel Temperature", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Air Temperature", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Relative Humidity", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Dew Point", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Primer", "hold": false, "photo": "optional", "entry": "none"}, {"text": "Primer Dry Film Thickness", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Steel Temperature", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Air Temperature", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Relative Humidity", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Dew Point", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Midcoat", "hold": false, "photo": "optional", "entry": "none"}, {"text": "Midcoat Dry Film Thickness", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Steel Temperature", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Air Temperature", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Relative Humidity", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Dew Point", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Top Coat", "hold": false, "photo": "optional", "entry": "none"}]'
WHERE project_id=(SELECT id FROM projects WHERE code='26004') AND title='Paint Repairs';

-- 2. Re-point per-item photos. A photo taken against a now-deleted Mechanical
--    Prep is kept as section-level evidence (item_index NULL) rather than
--    dropped — losing site evidence is worse than an unlabelled photo. Single
--    CASE so each row is judged on its original index, never shifted twice.
UPDATE qitp_photos SET item_index = CASE
    WHEN item_index IN (9, 16)          THEN NULL
    WHEN item_index BETWEEN 10 AND 15   THEN item_index - 1
    WHEN item_index >= 17               THEN item_index - 2
    ELSE item_index END
  WHERE section_id=(SELECT id FROM qitp_sections WHERE project_id=(SELECT id FROM projects WHERE code='26004') AND title='Paint Repairs')
    AND item_index IS NOT NULL;

-- 3. Drop the two removed slots from any ticks/readings recorded against the
--    22-item template. json_remove applies paths left to right, so the higher
--    index goes first — removing $[9] first would shift $[16] before it is read.
UPDATE qitp_records SET
    checks  = CASE WHEN checks  IS NOT NULL AND json_valid(checks)  AND json_array_length(checks)  = 22 THEN json_remove(checks,  '$[16]', '$[9]') ELSE checks  END,
    entries = CASE WHEN entries IS NOT NULL AND json_valid(entries) AND json_array_length(entries) = 22 THEN json_remove(entries, '$[16]', '$[9]') ELSE entries END
  WHERE section_id=(SELECT id FROM qitp_sections WHERE project_id=(SELECT id FROM projects WHERE code='26004') AND title='Paint Repairs');
