-- Let a variation record its labour scope but treat that labour as ABSORBED in
-- the existing contract labour allowance — i.e. £0 additional cost to the
-- project. The labour lines stay (for the record / scope), but every roll-up
-- (labour_budget, margin, Forecast Final Cost) counts the labour as zero. Used
-- for variations that sell extra to the client but are done within the gang's
-- existing time.
ALTER TABLE variations ADD COLUMN labour_absorbed INTEGER NOT NULL DEFAULT 0;
