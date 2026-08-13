-- Track when an operative was last emailed/texted their profile-link invite, so
-- inviteOperative() can suppress a duplicate within a short cooldown. Fixes
-- operatives receiving several identical invites "at once" when more than one
-- action fires an invite in quick succession (e.g. create → assign-to-site).
ALTER TABLE operatives ADD COLUMN last_invited_at TEXT;
