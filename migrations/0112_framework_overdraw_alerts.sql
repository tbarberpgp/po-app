-- Framework overdraw alerts: records the qty drawn against a framework line
-- at the moment we last emailed about it being overdrawn, so the daily sweep
-- (runFrameworkOverdrawAlerts) only re-alerts when the overdraw gets worse —
-- not every day the same shortfall sits unresolved. Lives on the framework's
-- own po_lines row (never on a call-off's line). NULL = never alerted.
ALTER TABLE po_lines ADD COLUMN framework_overdraw_alerted_qty REAL;
