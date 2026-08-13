-- Auto-distribute now drives ALL report emails (managers + clients), replacing
-- the old per-generation manager email. A rule can carry an `include_managers`
-- flag — at send time the distributor adds that project's current PM / site /
-- commercial-manager emails (resolved live, so they never go stale). Seed one
-- "Project managers" rule per active project (daily + weekly, 07:00 UK) so the
-- recipient list lives in one place and no manager loses their report in the
-- switch-over. Idempotent: skips a project that already has a managers rule.
ALTER TABLE distribution_rules ADD COLUMN include_managers INTEGER NOT NULL DEFAULT 0;

INSERT INTO distribution_rules
  (project_id, name, frequency, format, recipients, send_time, only_if, enabled, include_managers, created_at, created_by)
-- Standalone projects only: site-group blocks keep their existing single combined
-- email (sendGroupReport), so seeding per-block rules here would double them up.
SELECT p.id, 'Project managers', 'both', 'pdf_link', '[]', '07:00', 'always', 1, 1, '2026-06-30T00:00:00Z', 'system'
  FROM projects p
 WHERE p.deleted_at IS NULL
   AND p.id <> 'sandbox'
   AND p.site_group_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM distribution_rules dr WHERE dr.project_id = p.id AND dr.include_managers = 1);
