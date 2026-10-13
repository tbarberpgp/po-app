/**
 * An order line (aliased `pl`, its order `po`) that nothing counts yet: not
 * coded to a budget line, not worded as one, and not off-BOQ spend either.
 *
 * A materials line counts against the BOQ by WORDING (`is_unpriced = 0` and
 * worded as a live BOQ line or its active substitution's replacement) or by
 * CODING (`material_id` set); off-BOQ spend is `is_unpriced = 1` with no
 * coding (shared/committed-spend.ts, projects.ts). A retrospective PO raised
 * from an invoice (invoices.ts create-po) writes its lines unlinked but with
 * `is_unpriced = 0`, so any line its auto-coder can't match falls between all
 * three — on 2026-10-13, 119 lines / £39,558 on 26001 alone (Barwell
 * flashings, gutters, top-hat sections).
 *
 * Deliberately NOT folded into off-BOQ spend: those lines are mostly BOQ
 * materials under the supplier's wording, and booking them as unexpected spend
 * would overstate it. They're raised as "needs attention" instead, until someone
 * codes each one to its budget line — at which point it counts there. Until
 * then the forecast does not include them.
 *
 * Call-off and prelim exclusions stay with the caller.
 */
export const UNCODED_LINE = `(pl.material_id IS NULL AND pl.is_unpriced = 0 AND NOT EXISTS (
  SELECT 1 FROM materials bm
    JOIN material_snapshots bs ON bs.id = bm.snapshot_id AND bs.is_active = 1
    LEFT JOIN material_substitutions bsub ON bsub.material_id = bm.id AND bsub.active = 1
   WHERE bs.project_id = po.project_id
     AND (lower(bm.item) = lower(pl.item)
          OR (bsub.replacement_item IS NOT NULL AND lower(bsub.replacement_item) = lower(pl.item)))))`;
