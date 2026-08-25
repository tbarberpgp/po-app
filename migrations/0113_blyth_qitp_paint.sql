-- 0113: Blyth (26004) Cabin QITP — Rev 2 adds the paint process.
-- Source: 'PGP Cabin QITP - sections Rev 2.xlsx' (section key 'paint').
--
-- Two parts:
--   1. Per-item TEXT ENTRY. Paint QA is recorded as readings, not just ticks
--      (surface profile, steel/air temperature, relative humidity, dew point,
--      dry film thickness). Items gain an "entry" mode alongside the existing
--      "photo" mode, and the typed values are stored on qitp_records.entries as
--      a JSON array of strings parallel to `checks` — same shape, same lazy
--      upsert, no new table and nothing to migrate for existing records
--      (absent = no readings, which is exactly right for sections 1-11).
--   2. The 'Paint Repairs' section itself at seq 12 — a HOLD point signed by
--      NE Site Coatings, sitting after Storage / Receipt and before the cabin
--      goes back (Re-site & Reinstall), per the Rev 2 sheet.
--
-- SAFETY: sections 1-11 hold ALL captured QA data (records, sign-offs, photos)
-- and are NOT touched. Only the two zero-data tail sections are re-sequenced
-- (UPDATE seq by title -> stable section_id -> no CASCADE delete of anything).
-- No section is DELETEd; no cabin row or QR token is touched (the printed
-- stickers stay valid). The insert is guarded by NOT EXISTS, so re-running is
-- a no-op.

-- 1. Per-item typed readings, parallel to qitp_records.checks.
ALTER TABLE qitp_records ADD COLUMN entries TEXT;

-- 2. Make room at seq 12 (both target sections have zero captured data).
UPDATE qitp_sections SET seq=14 WHERE project_id=(SELECT id FROM projects WHERE code='26004') AND title='Final Inspection & Handover';
UPDATE qitp_sections SET seq=13 WHERE project_id=(SELECT id FROM projects WHERE code='26004') AND title='Re-site & Reinstall';

-- 3. Paint Repairs — 22 items in sheet order: three prep → conditions → coat
--    cycles (primer, midcoat, top coat). Photo items carry the visual evidence;
--    entry items carry the reading. Both are 'optional' so a missing one flags
--    on the item without blocking the section pass, matching every other
--    evidence item in this QITP.
INSERT INTO qitp_sections (project_id, seq, title, point_type, responsible, items, created_at)
  SELECT p.id, 12, 'Paint Repairs', 'HOLD', '["NE Site Coatings"]',
    '[{"text": "Before Repairs", "hold": false, "photo": "optional", "entry": "none"}, {"text": "Surface Profile", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Mechanical Prep", "hold": false, "photo": "optional", "entry": "none"}, {"text": "Steel Temperature", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Air Temperature", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Relative Humidity", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Dew Point", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Primer", "hold": false, "photo": "optional", "entry": "none"}, {"text": "Primer Dry Film Thickness", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Mechanical Prep", "hold": false, "photo": "optional", "entry": "none"}, {"text": "Steel Temperature", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Air Temperature", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Relative Humidity", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Dew Point", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Midcoat", "hold": false, "photo": "optional", "entry": "none"}, {"text": "Midcoat Dry Film Thickness", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Mechanical Prep", "hold": false, "photo": "optional", "entry": "none"}, {"text": "Steel Temperature", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Air Temperature", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Relative Humidity", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Dew Point", "hold": false, "photo": "none", "entry": "optional"}, {"text": "Top Coat", "hold": false, "photo": "optional", "entry": "none"}]',
    '2026-08-17T00:00:00.000Z'
  FROM projects p WHERE p.code='26004'
    AND NOT EXISTS (SELECT 1 FROM qitp_sections x WHERE x.project_id=p.id AND x.title='Paint Repairs');
