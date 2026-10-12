-- 0135: a hand-raised "needs attention" flag on an application for payment.
--
-- Some problems with an application can only be found by a person reading the
-- source document against the app: on 2026-10-12 Paul Garbutt's Blyth #23 read
-- £6,046 in the app against an invoice (INV 013) for £3,850. No automatic check
-- sees that, so there was nowhere to say so where the next person would look.
--
-- The note is shown on the application itself, so whoever certifies it sees
-- it, and every flagged application is listed under the dashboard's Needs
-- attention. It never touches the application's figures and can be set or
-- cleared at any status. Additive; existing rows read NULL (not flagged).
ALTER TABLE applications_for_payment ADD COLUMN attention_note TEXT;
ALTER TABLE applications_for_payment ADD COLUMN attention_note_by TEXT;
ALTER TABLE applications_for_payment ADD COLUMN attention_note_at TEXT;
