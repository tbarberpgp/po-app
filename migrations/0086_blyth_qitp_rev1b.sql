-- 0086: Blyth (26004) Cabin QITP — Rev 1b lift-sequence sections.
-- Source: 'PGP Cabin QITP - sections Rev 1.xlsx' (13 sections). Adds the three
-- crane lift-sequence HOLD points (Initial Lift Test, 5 Minute Hold, Re Check
-- Before Full Lift) between Bolt Release and Ready to Lift, and re-sequences the
-- later sections accordingly.
--
-- SAFETY: sections 1-3 (Pre-Strip Survey / Internal Strip / External Strip) hold
-- ALL captured QA data (records, sign-offs, photos) and are NOT touched. Sections
-- 4+ carry no captured data, so their template is reset in-place to match Rev 1
-- (UPDATE by title -> stable section_id -> no CASCADE delete of any record/photo).
-- The three new sections are INSERTed. No section is ever DELETEd; no cabin row or
-- QR token is touched.
--
-- Only content change to an existing section: Pre-Bolt Release item 1 wording
-- ('Ratchet straps...' -> 'A frame...'); everything else is re-sequencing + inserts.

-- Re-sequence + reset the existing (zero-data) sections to the Rev 1 template.
UPDATE qitp_sections SET seq=4, point_type=NULL, responsible='["Durata", "Bradden"]', items='[{"text": "A frame in place away from the leading edge to act as a hand rail", "hold": false, "photo": "none"}, {"text": "Lifting points checked; certified lift plan in place", "hold": false, "photo": "none"}, {"text": "Pre lift checks complete", "hold": false, "photo": "none"}, {"text": "All 4 lifting points connected to crane", "hold": false, "photo": "none"}, {"text": "Banksman in place", "hold": false, "photo": "none"}]' WHERE project_id=(SELECT id FROM projects WHERE code='26004') AND title='Pre-Bolt Release Actions';
UPDATE qitp_sections SET seq=5, point_type='HOLD', responsible='["Durata"]', items='[{"text": "All bolts released", "hold": false, "photo": "none"}]' WHERE project_id=(SELECT id FROM projects WHERE code='26004') AND title='Bolt Release';
UPDATE qitp_sections SET seq=9, point_type='HOLD', responsible='["Durata", "Bradden"]', items='[{"text": "Ready to lift", "hold": true, "photo": "none"}]' WHERE project_id=(SELECT id FROM projects WHERE code='26004') AND title='Ready to Lift';
UPDATE qitp_sections SET seq=10, point_type=NULL, responsible='["Durata", "Bradden", "Rhino Wrap"]', items='[{"text": "Lift completed without damage", "hold": false, "photo": "none"}, {"text": "Transport to laydown / storage complete", "hold": false, "photo": "none"}, {"text": "Condition on arrival recorded (photo)", "hold": false, "photo": "optional"}, {"text": "Cabin wrapped", "hold": false, "photo": "none"}]' WHERE project_id=(SELECT id FROM projects WHERE code='26004') AND title='Wrap, Lift & Transport';
UPDATE qitp_sections SET seq=11, point_type='HOLD', responsible='["Durata", "Rhino Wrap"]', items='[{"text": "Storage location / bay recorded against cabin ID", "hold": false, "photo": "none"}, {"text": "Set down level and packed / supported correctly", "hold": false, "photo": "none"}, {"text": "Weather protection in place", "hold": false, "photo": "none"}, {"text": "Condition while stored checked (no ingress / damage)", "hold": false, "photo": "none"}, {"text": "HOLD: Ready-to-reinstall confirmation before lift back", "hold": true, "photo": "none"}]' WHERE project_id=(SELECT id FROM projects WHERE code='26004') AND title='Storage / Receipt';
UPDATE qitp_sections SET seq=12, point_type='HOLD', responsible='["Durata"]', items='[{"text": "HOLD: Foundations / base ready and level checked (critical gate)", "hold": true, "photo": "none"}, {"text": "Cabin positioned and levelled to setting-out", "hold": false, "photo": "none"}, {"text": "Links / inter-cabin connections made", "hold": false, "photo": "none"}, {"text": "Flashings reinstalled (correct cabin set)", "hold": false, "photo": "none"}, {"text": "Gutters reinstalled and falls checked", "hold": false, "photo": "none"}, {"text": "Downpipes reinstalled and connected to drainage", "hold": false, "photo": "none"}, {"text": "Weathertightness / water test completed", "hold": false, "photo": "none"}]' WHERE project_id=(SELECT id FROM projects WHERE code='26004') AND title='Re-site & Reinstall';
UPDATE qitp_sections SET seq=13, point_type='HOLD', responsible='["Durata"]', items='[{"text": "Snagging complete; defects closed out", "hold": false, "photo": "none"}, {"text": "As-built / completion photos taken", "hold": false, "photo": "optional"}, {"text": "QA records for this cabin complete", "hold": false, "photo": "none"}, {"text": "HOLD: Client (Durata) sign-off obtained", "hold": true, "photo": "none"}, {"text": "Handover accepted", "hold": false, "photo": "none"}]' WHERE project_id=(SELECT id FROM projects WHERE code='26004') AND title='Final Inspection & Handover';

-- Insert the three new lift-sequence HOLD sections (idempotent; only if 26004 exists).
INSERT INTO qitp_sections (project_id, seq, title, point_type, responsible, items, created_at)
  SELECT p.id, 6, 'Initial Lift Test', 'HOLD', '["Bradden"]', '[{"text": "Building raised slightly off supports", "hold": true, "photo": "none"}, {"text": "No unexpected movement or distortion observed", "hold": false, "photo": "none"}, {"text": "No snagging on fixings, services, or ground", "hold": false, "photo": "none"}, {"text": "Sling tension is equal and stable", "hold": false, "photo": "none"}, {"text": "Crane computer showing correct load and no alarms", "hold": true, "photo": "none"}]', '2026-07-08T00:00:00.000Z'
  FROM projects p WHERE p.code='26004'
    AND NOT EXISTS (SELECT 1 FROM qitp_sections x WHERE x.project_id=p.id AND x.title='Initial Lift Test');
INSERT INTO qitp_sections (project_id, seq, title, point_type, responsible, items, created_at)
  SELECT p.id, 7, '5 Minute Hold', 'HOLD', '["Bradden"]', '[{"text": "Stopwatch started", "hold": false, "photo": "none"}, {"text": "Crane held steady with no creep or drift", "hold": false, "photo": "none"}, {"text": "Building stable with no rotation or sway", "hold": false, "photo": "none"}, {"text": "Lifting accessories seated correctly", "hold": false, "photo": "none"}, {"text": "Outriggers stable with no ground settlement", "hold": false, "photo": "none"}, {"text": "Exclusion zone remains clear", "hold": false, "photo": "none"}, {"text": "Screenshot taken of timer", "hold": true, "photo": "none"}]', '2026-07-08T00:00:00.000Z'
  FROM projects p WHERE p.code='26004'
    AND NOT EXISTS (SELECT 1 FROM qitp_sections x WHERE x.project_id=p.id AND x.title='5 Minute Hold');
INSERT INTO qitp_sections (project_id, seq, title, point_type, responsible, items, created_at)
  SELECT p.id, 8, 'Re Check Before Full Lift', 'HOLD', '["Bradden"]', '[{"text": "Supervisor confirms stability", "hold": false, "photo": "none"}, {"text": "All lifting points are secure and no signs of stress, tearing or failure", "hold": false, "photo": "none"}, {"text": "All personnel in safe positions", "hold": false, "photo": "none"}, {"text": "Communication confirmed ready to proceed", "hold": true, "photo": "none"}]', '2026-07-08T00:00:00.000Z'
  FROM projects p WHERE p.code='26004'
    AND NOT EXISTS (SELECT 1 FROM qitp_sections x WHERE x.project_id=p.id AND x.title='Re Check Before Full Lift');
