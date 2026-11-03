-- 0140: whether Xero has paid each supplier bill we pushed.
--
-- Since POs stopped being pushed to Xero (Aug 2026), money out reaches Xero as
-- the ACCPAY bill an approved invoice becomes. The paid-status matcher only ever
-- looked for a bill whose Reference was a PO number — but a pushed bill carries
-- the SUPPLIER's invoice number as its Reference, so not one real order was ever
-- marked paid. We already hold every pushed bill's id (xero_bill_id), so the
-- bill's own status can be read straight back and kept here, and the order it
-- was matched to inherits it.
--
-- amount_paid is Xero's AmountPaid, in the bill's own currency and gross of VAT,
-- so a part-paid bill shows as part paid rather than as untouched.
-- xero_bill_status is the bill's Xero status as last read (DRAFT, AUTHORISED,
-- PAID, VOIDED…) — a voided bill must stop counting as owed.
ALTER TABLE invoices ADD COLUMN paid_at          TEXT;
ALTER TABLE invoices ADD COLUMN amount_paid      REAL;
ALTER TABLE invoices ADD COLUMN xero_bill_status TEXT;

-- The hourly sync reads every pushed bill not yet paid.
CREATE INDEX IF NOT EXISTS idx_invoices_unpaid_bills
    ON invoices(xero_bill_id) WHERE xero_bill_id IS NOT NULL AND paid_at IS NULL;
