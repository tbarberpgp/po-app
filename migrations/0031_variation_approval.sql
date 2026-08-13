-- Variations carry NEW budget (material + labour allowances). Before that budget
-- can be expended — a PO linked to the variation, or labour claimed against it —
-- a director-tier approver must sign the variation off. Unapproved variations
-- have approved_at IS NULL. Editing a variation's financial content (sell value,
-- materials, labour) clears the approval so the revised budget is re-approved.
ALTER TABLE variations ADD COLUMN approved_at TEXT;
ALTER TABLE variations ADD COLUMN approved_by TEXT;
