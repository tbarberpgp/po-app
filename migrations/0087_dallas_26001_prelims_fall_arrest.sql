-- 0087: Dallas Rd Block B (26001) — add the missing Prelims section to the
-- contract BOQ (snapshot 79) and price the Fall Arrest ancil line.
--
-- The 26001 pricing snapshot was parsed without a Prelims section, so the
-- outgoing AfP #1 (id 48) seeded no prelim lines and the unmatched-line
-- "assign to BOQ line" picker had nowhere to put the applied-for prelims.
-- Values come from the filed contract application workbook
-- ('26001-2-3 Dallas Rd Roofing Application 1.xlsx', 26001 Block B tab):
--   Project Manager               1   wks  3000      3000
--   Site Manager                  6   wks  2040      12240
--   Site Manager: Overlap Reduction -3 wks 2040      -6120
--   Quantity Surveyor             0.5 wks  3000      1500
--   Health and Safety Visiting    6   days 600       3600
--   Design Details and Plan Drawings 1 nr  1968.528  1968.528
-- and Fall Arrest (Fall Arrest tab, 26001 Block B row): 1 nr @ 11643.75.
--
-- The draft AfP 48 gets matching zero-progress lines so the picker offers a
-- Prelims group; nothing gains any applied/cumulative value, so the AfP's
-- amount due is unchanged (only contract_sum grows). Prelims are inserted at
-- item_no/display_order 1-6 (document order) by shifting existing rows up
-- temporarily; every statement is guarded so a re-run is a no-op.

-- ── contract_items (snapshot 79): make room, insert Prelims at 1-6 ──────────
UPDATE contract_items SET item_no = item_no + 100
 WHERE snapshot_id = 79 AND item_no <= 50
   AND NOT EXISTS (SELECT 1 FROM contract_items WHERE snapshot_id = 79 AND section = 'Prelims');

INSERT INTO contract_items (snapshot_id, item_no, section, description, qty, unit, sell_rate, sell_total, labour_rate, labour_total, category)
SELECT 79, 1, 'Prelims', 'Project Manager', 1, 'wks', 3000, 3000, NULL, NULL, 'prelims'
 WHERE EXISTS (SELECT 1 FROM contract_items WHERE snapshot_id = 79 AND item_no > 100)
   AND NOT EXISTS (SELECT 1 FROM contract_items WHERE snapshot_id = 79 AND section = 'Prelims' AND description = 'Project Manager');
INSERT INTO contract_items (snapshot_id, item_no, section, description, qty, unit, sell_rate, sell_total, labour_rate, labour_total, category)
SELECT 79, 2, 'Prelims', 'Site Manager', 6, 'wks', 2040, 12240, NULL, NULL, 'prelims'
 WHERE EXISTS (SELECT 1 FROM contract_items WHERE snapshot_id = 79 AND item_no > 100)
   AND NOT EXISTS (SELECT 1 FROM contract_items WHERE snapshot_id = 79 AND section = 'Prelims' AND description = 'Site Manager');
INSERT INTO contract_items (snapshot_id, item_no, section, description, qty, unit, sell_rate, sell_total, labour_rate, labour_total, category)
SELECT 79, 3, 'Prelims', 'Site Manager: Overlap Reduction', -3, 'wks', 2040, -6120, NULL, NULL, 'prelims'
 WHERE EXISTS (SELECT 1 FROM contract_items WHERE snapshot_id = 79 AND item_no > 100)
   AND NOT EXISTS (SELECT 1 FROM contract_items WHERE snapshot_id = 79 AND section = 'Prelims' AND description = 'Site Manager: Overlap Reduction');
INSERT INTO contract_items (snapshot_id, item_no, section, description, qty, unit, sell_rate, sell_total, labour_rate, labour_total, category)
SELECT 79, 4, 'Prelims', 'Quantity Surveyor', 0.5, 'wks', 3000, 1500, NULL, NULL, 'prelims'
 WHERE EXISTS (SELECT 1 FROM contract_items WHERE snapshot_id = 79 AND item_no > 100)
   AND NOT EXISTS (SELECT 1 FROM contract_items WHERE snapshot_id = 79 AND section = 'Prelims' AND description = 'Quantity Surveyor');
INSERT INTO contract_items (snapshot_id, item_no, section, description, qty, unit, sell_rate, sell_total, labour_rate, labour_total, category)
SELECT 79, 5, 'Prelims', 'Health and Safety Visiting', 6, 'days', 600, 3600, NULL, NULL, 'prelims'
 WHERE EXISTS (SELECT 1 FROM contract_items WHERE snapshot_id = 79 AND item_no > 100)
   AND NOT EXISTS (SELECT 1 FROM contract_items WHERE snapshot_id = 79 AND section = 'Prelims' AND description = 'Health and Safety Visiting');
INSERT INTO contract_items (snapshot_id, item_no, section, description, qty, unit, sell_rate, sell_total, labour_rate, labour_total, category)
SELECT 79, 6, 'Prelims', 'Design Details and Plan Drawings', 1, 'nr', 1968.528, 1968.528, NULL, NULL, 'prelims'
 WHERE EXISTS (SELECT 1 FROM contract_items WHERE snapshot_id = 79 AND item_no > 100)
   AND NOT EXISTS (SELECT 1 FROM contract_items WHERE snapshot_id = 79 AND section = 'Prelims' AND description = 'Design Details and Plan Drawings');

UPDATE contract_items SET item_no = item_no - 94
 WHERE snapshot_id = 79 AND item_no > 100;

-- ── Fall Arrest ancil: price per the contract (was parsed at £0) ────────────
UPDATE contract_items SET sell_rate = 11643.75, sell_total = 11643.75
 WHERE id = 1803 AND snapshot_id = 79 AND sell_total = 0;

-- ── draft AfP 48: seed the new lines so the resolve picker offers them ──────
UPDATE afp_lines SET display_order = display_order + 100
 WHERE afp_id = 48
   AND (SELECT status FROM applications_for_payment WHERE id = 48) = 'draft'
   AND NOT EXISTS (SELECT 1 FROM afp_lines WHERE afp_id = 48 AND section = 'Prelims');

INSERT INTO afp_lines (afp_id, contract_item_id, category, section, description, unit, qty, rate, contract_value, percent_complete, cumulative_value, is_adhoc, display_order)
SELECT 48, ci.id, 'prelims', 'Prelims', ci.description, ci.unit, ci.qty, ci.sell_rate, ci.sell_total, 0, 0, 0, ci.item_no
  FROM contract_items ci
 WHERE ci.snapshot_id = 79 AND ci.section = 'Prelims' AND ci.item_no <= 6
   AND EXISTS (SELECT 1 FROM afp_lines WHERE afp_id = 48 AND display_order > 100)
   AND NOT EXISTS (SELECT 1 FROM afp_lines l2 WHERE l2.afp_id = 48 AND l2.contract_item_id = ci.id);

UPDATE afp_lines SET display_order = display_order - 94
 WHERE afp_id = 48 AND display_order > 100;

UPDATE afp_lines SET rate = 11643.75, contract_value = 11643.75
 WHERE afp_id = 48 AND contract_item_id = 1803
   AND contract_value = 0 AND percent_complete = 0
   AND (SELECT status FROM applications_for_payment WHERE id = 48) = 'draft';

-- Refresh the draft's contract_sum (cumulative and the amounts due are
-- untouched — every added/repriced line sits at 0% complete).
UPDATE applications_for_payment
   SET contract_sum = (SELECT COALESCE(SUM(contract_value), 0) FROM afp_lines WHERE afp_id = 48)
 WHERE id = 48 AND status = 'draft';
