-- Framework overdraw alerts moved to real-time + a weekly digest (see
-- cron.ts runFrameworkOverdrawDigest) that just re-checks the live overdraw
-- state each Monday rather than deduping against a stored marker, so this
-- column never got a reader — confirmed 0 of 505 po_lines rows had a value
-- in it in production before dropping.
ALTER TABLE po_lines DROP COLUMN framework_overdraw_alerted_qty;
