-- A line coded to the budget line it is already worded as counts by wording,
-- and the wording count requires is_unpriced = 0 — while the coded count skips
-- same-wording lines. Left at 1, such a line was counted nowhere: committed,
-- Off-BOQ spend and the forecast all missed it. One live case on 2026-10-13:
-- PO-26001-0033, 75 rolls of MG4BLK Euroroof Charcoal, £5,507.25. The coding
-- routes now clear the flag themselves (pos.ts CODE_LINE_SET); this repairs
-- the line coded before that.
UPDATE po_lines
   SET is_unpriced = 0
 WHERE is_unpriced = 1
   AND material_id IS NOT NULL
   AND lower(item) = (SELECT lower(m.item) FROM materials m WHERE m.id = po_lines.material_id);
