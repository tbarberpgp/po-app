-- The same two-stage release, applied to subcontractor labour certificates.
--
-- Certificates were the other way a payable reached Xero on one signature.
-- Certify agrees the value, "approve for payment" was the financial go-ahead,
-- and the push created the draft ACCPAY bill — with both of the latter two
-- available to the same person. Migration 0118 closed that on supplier
-- invoices; the approve-for-payment step was written to mirror the invoice
-- gate, so leaving it alone would have left the mirror broken and the money
-- flowing through whichever route still took one signature.
--
-- Approve-for-payment now HOLDS the certificate. A named release approver
-- signs it off and that is what pushes the bill. The allowlist is the same
-- table 0118 created — the final sign-off on money leaving the company is one
-- role held by one set of people, whichever workpiece it comes through.

ALTER TABLE applications_for_payment ADD COLUMN pay_released_at   TEXT;
ALTER TABLE applications_for_payment ADD COLUMN pay_released_by   TEXT;
ALTER TABLE applications_for_payment ADD COLUMN pay_release_note  TEXT;

-- Certificates already in Xero are past this gate. Recording a release on them
-- keeps "in Xero implies released" true, so the new check reads historic
-- certificates correctly instead of reporting live bills as unreleased.
-- Attributed to the migration — nobody performed these sign-offs.
UPDATE applications_for_payment
   SET pay_released_at = COALESCE(pay_approved_at, certified_at, created_at),
       pay_released_by = 'migration 0119 (bill pre-dates the release gate)'
 WHERE pay_released_at IS NULL
   AND (xero_po_id IS NOT NULL OR xero_sync_status = 'synced');
