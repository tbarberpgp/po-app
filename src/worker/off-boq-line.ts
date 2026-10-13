/**
 * An order line (aliased `pl`, its order `po`) that no BOQ line counts — the
 * project's off-BOQ spend.
 *
 * Every committed order line must land in exactly ONE place (see
 * prelims-position.ts). A materials line counts against the BOQ one of two ways
 * (shared/committed-spend.ts):
 *
 *   1. by WORDING — `is_unpriced = 0` and worded as a live BOQ line (or its
 *      active substitution's replacement);
 *   2. by CODING — `material_id` set.
 *
 * So off-BOQ is everything else: no coding, and not counted by wording. It used
 * to be `is_unpriced = 1 AND material_id IS NULL`, which assumed an unlinked
 * line is always flagged unpriced. The New PO screen does flag it so, but a
 * retrospective PO raised from an invoice (invoices.ts create-po) writes
 * `is_unpriced = 0` with no link, and a line keeps its flag when its coding is
 * cleared. Those lines were counted nowhere: £40,819 on Dallas Rd alone
 * (Barwell flashings, gutters, top-hat sections) was missing from the forecast
 * cost while still listed under the Off-BOQ chip.
 *
 * Prelim and call-off exclusions stay with the caller, as before.
 */
export const OFF_BOQ_LINE = `(pl.material_id IS NULL AND NOT (pl.is_unpriced = 0 AND EXISTS (
  SELECT 1 FROM materials bm
    JOIN material_snapshots bs ON bs.id = bm.snapshot_id AND bs.is_active = 1
    LEFT JOIN material_substitutions bsub ON bsub.material_id = bm.id AND bsub.active = 1
   WHERE bs.project_id = po.project_id
     AND (lower(bm.item) = lower(pl.item)
          OR (bsub.replacement_item IS NOT NULL AND lower(bsub.replacement_item) = lower(pl.item))))))`;
