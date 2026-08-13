-- Delivery reconciliation: store expected (PO-ordered) vs received totals so the
-- Received list can show an expected-vs-received bar and flag shortfalls.
ALTER TABLE site_deliveries ADD COLUMN expected_qty REAL;
ALTER TABLE site_deliveries ADD COLUMN received_qty REAL;
