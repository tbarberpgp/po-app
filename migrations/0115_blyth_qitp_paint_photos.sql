-- 0115: Blyth (26004) Paint Repairs — a photo against every item, per Rev 2.
-- Source: 'PGP Cabin QITP - sections Rev 2(QITP Sections).numbers', section key
-- 'paint'. That sheet marks the Photo column YES on all 20 paint items; the
-- live template (0113/0114) only opened the camera on the five visual-state
-- items (Before Repairs, Mechanical Prep, Primer, Midcoat, Top Coat) and left
-- photo:"none" on the 15 reading items. Site therefore has no way to evidence
-- the gauge behind a number — the dew-point meter, the DFT gauge, the surface
-- profile tape. This flips those 15 to photo:"optional", so every item shows
-- both its reading box and its camera button.
--
-- The 15 opened here are exactly the 15 that already carry entry:"optional",
-- i.e. Rev 2's "Text Entry" and "Photo" columns agree item for item:
--   1 Surface Profile | 3-6, 9-12, 15-18 Steel/Air temp, RH, Dew Point
--   8 Primer Dry Film Thickness | 14 Midcoat Dry Film Thickness
--
-- SAFETY: this rewrites ONE column on ONE template row. It does not touch
-- qitp_records, qitp_signoffs or qitp_photos, and no record is read or moved.
-- The item list keeps its length (20), its order and its text, so every
-- item_index already recorded against this section — 496 photos and the
-- entries/checks arrays at the time of writing — stays pointing at the same
-- item. Nothing is DELETEd; no cabin row or QR token is touched.
--
-- "optional" (not "required") is deliberate: 25 cabins are mid-inspection and
-- one has already passed. A required photo would retroactively block a section
-- that was legitimately passed under the old template. Optional matches every
-- other evidence item in this QITP — it offers the camera without gating Pass.
--
-- The WHERE guard pins the template we are editing (20 items, known first and
-- last). If the list has since been re-cut, this updates nothing rather than
-- overwriting a newer revision — and re-running it is a no-op.
UPDATE qitp_sections
   SET items = '[{"text": "Before Repairs", "hold": false, "photo": "optional", "entry": "none"}, {"text": "Surface Profile", "hold": false, "photo": "optional", "entry": "optional"}, {"text": "Mechanical Prep", "hold": false, "photo": "optional", "entry": "none"}, {"text": "Steel Temperature", "hold": false, "photo": "optional", "entry": "optional"}, {"text": "Air Temperature", "hold": false, "photo": "optional", "entry": "optional"}, {"text": "Relative Humidity", "hold": false, "photo": "optional", "entry": "optional"}, {"text": "Dew Point", "hold": false, "photo": "optional", "entry": "optional"}, {"text": "Primer", "hold": false, "photo": "optional", "entry": "none"}, {"text": "Primer Dry Film Thickness", "hold": false, "photo": "optional", "entry": "optional"}, {"text": "Steel Temperature", "hold": false, "photo": "optional", "entry": "optional"}, {"text": "Air Temperature", "hold": false, "photo": "optional", "entry": "optional"}, {"text": "Relative Humidity", "hold": false, "photo": "optional", "entry": "optional"}, {"text": "Dew Point", "hold": false, "photo": "optional", "entry": "optional"}, {"text": "Midcoat", "hold": false, "photo": "optional", "entry": "none"}, {"text": "Midcoat Dry Film Thickness", "hold": false, "photo": "optional", "entry": "optional"}, {"text": "Steel Temperature", "hold": false, "photo": "optional", "entry": "optional"}, {"text": "Air Temperature", "hold": false, "photo": "optional", "entry": "optional"}, {"text": "Relative Humidity", "hold": false, "photo": "optional", "entry": "optional"}, {"text": "Dew Point", "hold": false, "photo": "optional", "entry": "optional"}, {"text": "Top Coat", "hold": false, "photo": "optional", "entry": "none"}]'
 WHERE project_id = (SELECT id FROM projects WHERE code='26004')
   AND title = 'Paint Repairs'
   AND json_valid(items)
   AND json_array_length(items) = 20
   AND json_extract(items, '$[0].text')  = 'Before Repairs'
   AND json_extract(items, '$[19].text') = 'Top Coat';
