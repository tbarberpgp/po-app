-- CIS Unique Taxpayer Reference for labour subcontractors. Held on the approved
-- supplier for remittances / CIS returns. Distinct from vat_number.
ALTER TABLE suppliers ADD COLUMN utr TEXT;
