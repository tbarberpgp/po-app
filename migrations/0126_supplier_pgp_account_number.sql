-- The account number the SUPPLIER holds PGP under — the customer reference
-- Alumasc, SIG et al. ask for on the phone ("what's your account with us?").
--
-- Deliberately not called `account_number`: `suppliers.bank_account_number`
-- already exists and is the opposite direction — the account we pay THEM into.
-- One is quoted out loud to a trade counter, the other is payment data; naming
-- them apart keeps a future reader from wiring the wrong one into a remittance
-- or, worse, onto something supplier-facing.
ALTER TABLE suppliers ADD COLUMN pgp_account_number TEXT;
