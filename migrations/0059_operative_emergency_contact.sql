-- Emergency contact for an operative (name + number, free text). Captured on the
-- bulk-upload import and shown on their profile / detail. Nullable so existing
-- rows are unaffected.
ALTER TABLE operatives ADD COLUMN emergency_contact TEXT;
