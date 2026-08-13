-- 0088: Dallas Rd Blocks C (26002) & D (26003) — price the Fall Arrest ancil
-- lines, which parsed at £0 (same gap fixed for Block B in 0087). Values from
-- the filed combined application workbook's Fall Arrest tab:
--   26002 Block C Fall Arrest  £11,545.15   (snapshot 61, ci 1311)
--   26003 Block D Fall Arrest  £11,643.75   (snapshot 69, ci 1529)
-- Guarded on the current £0 so a re-run (or a later manual reprice) is safe.

UPDATE contract_items SET sell_rate = 11545.15, sell_total = 11545.15
 WHERE id = 1311 AND snapshot_id = 61 AND sell_total = 0;

UPDATE contract_items SET sell_rate = 11643.75, sell_total = 11643.75
 WHERE id = 1529 AND snapshot_id = 69 AND sell_total = 0;
