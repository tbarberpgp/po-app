-- Track payment of material POs that are settled in Xero. A Xero Purchase
-- Order has no "paid" state, so when the ACCPAY Bill the PO becomes is paid,
-- the Invoice webhook fires and we record payment here — matched by the Bill's
-- Reference == our po_number. (Client applications track paid via the existing
-- applications_for_payment.status='paid' against their ACCREC invoice id.)
ALTER TABLE purchase_orders ADD COLUMN paid_at        TEXT;  -- ISO when fully paid in Xero
ALTER TABLE purchase_orders ADD COLUMN paid_reference TEXT;  -- Xero bill number
ALTER TABLE purchase_orders ADD COLUMN xero_bill_id   TEXT;  -- Xero ACCPAY InvoiceID
