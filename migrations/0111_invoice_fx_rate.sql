-- Foreign-currency invoices: keep the sterling equivalent alongside the
-- document's own figures.
--
-- Xero applies its own FX rate when the bill is created, so that rate is the
-- authoritative one — we read it back after the push rather than inventing a
-- rate here. base_* are the GBP amounts (amount x rate) used by the sterling
-- roll-ups (AP totals, cash outlook, project committed spend); the existing
-- net/vat/gross columns keep the invoice's own currency, untouched.
--
-- GBP invoices leave these NULL: rate 1 is implicit, and the roll-ups fall
-- back to the raw amount when no base figure is stored.
ALTER TABLE invoices ADD COLUMN xero_currency_rate REAL;
ALTER TABLE invoices ADD COLUMN base_net_amount REAL;
ALTER TABLE invoices ADD COLUMN base_gross_amount REAL;
ALTER TABLE invoices ADD COLUMN base_currency TEXT;
ALTER TABLE invoices ADD COLUMN fx_rate_at TEXT;
