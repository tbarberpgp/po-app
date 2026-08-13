-- Assign an operative to a single current site (like a PO belongs to one
-- project). Reassigning moves them to the new site; the previous site's manager
-- is notified so an operative never silently disappears off their roster.
ALTER TABLE operatives ADD COLUMN assigned_project_id TEXT;
ALTER TABLE operatives ADD COLUMN assigned_at TEXT;
ALTER TABLE operatives ADD COLUMN assigned_by TEXT;
CREATE INDEX IF NOT EXISTS idx_operatives_assigned ON operatives(assigned_project_id);
