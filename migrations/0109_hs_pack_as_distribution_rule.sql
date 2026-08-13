-- Unify H&S pack auto-release into the shared distribution_rules table, so both
-- site reports and H&S packs are scheduled from one place (Reports → Distribution)
-- instead of a separate per-project card. Report rows keep working unchanged.
--   content       — 'report' (default; all existing rows) | 'hs_pack'
--   weekday        — 1..7 (Mon..Sun) for a weekly H&S rule; report rules ignore it
--   last_sent_at   — per-rule guard so a catch-up cron tick can't double-send
ALTER TABLE distribution_rules ADD COLUMN content TEXT NOT NULL DEFAULT 'report';
ALTER TABLE distribution_rules ADD COLUMN weekday INTEGER;
ALTER TABLE distribution_rules ADD COLUMN last_sent_at TEXT;

-- Carry the existing per-project H&S schedules across as unified rules. Recipients
-- were stored as a comma string; wrap them as the JSON array distribution_rules
-- expects. Idempotent — won't duplicate a project's H&S rule on re-run.
INSERT INTO distribution_rules
  (project_id, name, content, frequency, format, recipients, send_time, weekday, only_if, enabled, include_managers, last_sent_at, created_at, created_by)
SELECT s.project_id, 'H&S pack', 'hs_pack', s.frequency, 'pdf',
       CASE WHEN TRIM(COALESCE(s.recipients, '')) = '' THEN '[]'
            ELSE '["' || REPLACE(REPLACE(TRIM(s.recipients), ' ', ''), ',', '","') || '"]' END,
       printf('%02d:00', s.send_hour), s.weekday, 'always', s.active, s.include_managers,
       s.last_sent_at, COALESCE(s.updated_at, datetime('now')), COALESCE(s.updated_by, 'migration-0109')
  FROM hs_pack_schedules s
 WHERE NOT EXISTS (
   SELECT 1 FROM distribution_rules dr WHERE dr.project_id = s.project_id AND dr.content = 'hs_pack'
 );
