-- Project completion (lifecycle). A completed project stays fully editable
-- (POs/applications can still be raised); completion is a status flag the
-- workspace can filter on and re-open. NULL completed_at = active/live.
ALTER TABLE projects ADD COLUMN completed_at TEXT;
ALTER TABLE projects ADD COLUMN completed_by TEXT;
