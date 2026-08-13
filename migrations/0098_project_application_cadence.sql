-- How often this project applies for payment (drives commercial expectations
-- and, later, the cash-outlook application cadence): weekly | biweekly | monthly.
ALTER TABLE projects ADD COLUMN application_cadence TEXT;
