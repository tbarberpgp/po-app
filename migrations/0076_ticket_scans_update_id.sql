-- WhatsApp delivery tickets are sourced from project_updates (media_url), so we
-- key each scan by the originating project_updates.id (dedupe + one-tap check-in
-- can trace it back). 0075 shipped with only photo_id; add the column it needs.
ALTER TABLE delivery_ticket_scans ADD COLUMN update_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_dts_update ON delivery_ticket_scans(update_id);
