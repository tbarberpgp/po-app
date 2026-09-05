-- Two-stage invoice release to Xero.
--
-- Before: approving an invoice for payment WAS the release — the approve route
-- created the draft bill in Xero on the spot, and anyone with commercial.edit
-- could also push manually. Approving and paying were one act.
--
-- After: approval stops at HELD. Matching an invoice to its PO and approving it
-- for payment stays with the people who do that work (hgardner, adouty); a
-- named final approver then releases the held invoice and that is what creates
-- the bill in Xero.
--
-- The allowlist below is why this is a table and not a role check: no role
-- draws the line in the right place. The releasers are SOME superadmins and not
-- all of them, and one of them (adouty) also approves at stage one — so any
-- permission matrix would either miss a releaser or hand the second signature
-- to people meant to have only the first. Identity can say who signs off.
--
-- Named for releases generally, not invoices: 0119 puts subcontractor labour
-- certificates behind the same list. The last approval before money leaves the
-- company is one job, whichever workpiece the payable came through.

ALTER TABLE invoices ADD COLUMN released_at  TEXT;
ALTER TABLE invoices ADD COLUMN released_by  TEXT;
ALTER TABLE invoices ADD COLUMN release_note TEXT;

CREATE TABLE release_approvers (
  email    TEXT PRIMARY KEY,
  name     TEXT,
  added_at TEXT NOT NULL,
  added_by TEXT
);

INSERT INTO release_approvers (email, name, added_at, added_by) VALUES
  ('tbarber@powergridprojects.net', 'Thomas Barber', datetime('now'), 'migration 0118'),
  ('adouty@powergridprojects.net',  'Angela Douty',  datetime('now'), 'migration 0118');

-- Every invoice already in Xero is past this gate. Recording a release on those
-- rows keeps "in Xero implies released" true for the whole book, so the new
-- checks read historic invoices correctly instead of reporting 153 live bills
-- as unreleased. Attributed to the migration, not to a person — nobody
-- performed these sign-offs.
UPDATE invoices
   SET released_at = COALESCE(approved_at, received_at, created_at),
       released_by = 'migration 0118 (bill pre-dates the release gate)'
 WHERE released_at IS NULL
   AND (status = 'pushed' OR xero_bill_id IS NOT NULL);
