-- Let operatives upload their own qualification cards from their profile.
-- A self-upload lands as PENDING (verified_at NULL) and doesn't count as a valid
-- card until a manager verifies it. Manager uploads are verified on creation.
ALTER TABLE operative_quals ADD COLUMN source TEXT NOT NULL DEFAULT 'manager'; -- manager | self
ALTER TABLE operative_quals ADD COLUMN verified_at TEXT;
ALTER TABLE operative_quals ADD COLUMN verified_by TEXT;

-- Existing cards were all manager-entered → treat them as already verified.
UPDATE operative_quals SET verified_at = created_at WHERE verified_at IS NULL;
