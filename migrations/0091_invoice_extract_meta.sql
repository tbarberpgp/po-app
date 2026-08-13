-- 0091: invoice extraction metadata — everything read off the document beyond
-- the accounting columns: the supplier's own details (address, VAT number,
-- contact, payment terms, bank/payment details) and the delivery / ship-to
-- address. Powers "+ Add to approved suppliers" prefill and the
-- delivery-address → project fallback match. Additive only.
ALTER TABLE invoices ADD COLUMN extracted_meta_json TEXT;
