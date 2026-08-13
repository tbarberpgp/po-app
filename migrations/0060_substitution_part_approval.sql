-- Part-substitution + approval.
--
-- Two additions to material_substitutions:
--
--  1. sub_units — how much of the material's BOQ quantity is being substituted.
--     NULL (or >= the material's total_units) means a FULL swap, the original
--     behaviour. A value below total_units is a PART substitution: that quantity
--     moves to the replacement and the remainder stays on the original product.
--
--  2. An approval lifecycle. Every PART substitution must be approved before it
--     takes effect, because it repurposes part of a material line's £ value
--     allowance (possibly toward a different spec). Lifecycle:
--       pending_approval  active=0  — proposed, NOT yet driving PO/stock/spend
--       approved          active=1  — effective (the existing "active" sub join)
--       rejected          active=0  — declined
--       superseded        active=0  — replaced by a newer proposal
--     FULL swaps keep the old behaviour: created straight to approved + active=1.
--     Existing rows default to 'approved', so nothing already live changes.
ALTER TABLE material_substitutions ADD COLUMN sub_units        REAL;
ALTER TABLE material_substitutions ADD COLUMN status           TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE material_substitutions ADD COLUMN approval_tier    TEXT;
ALTER TABLE material_substitutions ADD COLUMN approved_at      TEXT;
ALTER TABLE material_substitutions ADD COLUMN approved_by      TEXT;
ALTER TABLE material_substitutions ADD COLUMN rejected_at      TEXT;
ALTER TABLE material_substitutions ADD COLUMN rejected_by      TEXT;
ALTER TABLE material_substitutions ADD COLUMN rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_msub_status ON material_substitutions(status);
