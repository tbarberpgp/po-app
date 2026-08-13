-- Plant can be charged per day OR per week. rate_unit selects which; the
-- existing day_rate column holds the per-day or per-week rate accordingly.
-- Accrual = rate × (rate_unit = 'week' ? ceil(days/7) : days).
ALTER TABLE plant_logs ADD COLUMN rate_unit TEXT NOT NULL DEFAULT 'day';
