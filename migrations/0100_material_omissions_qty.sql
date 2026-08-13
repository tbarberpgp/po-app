-- Partial omissions: omit only part of a BOQ material's quantity.
-- omit_qty NULL keeps the original behaviour (whole line omitted & hidden);
-- a value reduces the budgeted quantity by that many units instead.
ALTER TABLE material_omissions ADD COLUMN omit_qty REAL;
