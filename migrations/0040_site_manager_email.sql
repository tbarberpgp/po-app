-- Per-project site manager email. Used as the recipient for site alerts (e.g.
-- an operative signing in without having signed the RAMS). Falls back to the
-- project creator when unset.
ALTER TABLE projects ADD COLUMN site_manager_email TEXT;
