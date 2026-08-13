-- Supplier remittance / payment details — the bank account PGP pays the
-- supplier into. Captured on the Approved Suppliers form alongside the
-- contact and VAT details; surfaced on the supplier edit form.
ALTER TABLE suppliers ADD COLUMN bank_account_name   TEXT;
ALTER TABLE suppliers ADD COLUMN bank_sort_code      TEXT;
ALTER TABLE suppliers ADD COLUMN bank_account_number TEXT;
ALTER TABLE suppliers ADD COLUMN bank_name           TEXT;
