-- Auto sign-out: sign-ins left open are closed at 19:00 UK time on their
-- sign-in day by the hourly cron. Flagged so registers/exports can show the
-- stamp was automatic, and cleared again when a manager edits the time.
ALTER TABLE site_signins ADD COLUMN signed_out_auto INTEGER NOT NULL DEFAULT 0;
