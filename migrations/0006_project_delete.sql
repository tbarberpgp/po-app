-- Soft delete on projects. Mirrors purchase_orders — keeps the row for audit
-- but hides it from every query, and rolls its committed value off the books.
--
-- The project's `code` is rewritten on delete (e.g. BNC001 → BNC001#deleted)
-- so the original is free to be reused for a new project.

ALTER TABLE projects ADD COLUMN deleted_at      TEXT;
ALTER TABLE projects ADD COLUMN deleted_by      TEXT;
ALTER TABLE projects ADD COLUMN deletion_reason TEXT;
