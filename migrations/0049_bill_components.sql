-- Component materials that build up each bill item, taken from the Pricing tab
-- (the indented sub-rows beneath a measured line). Each carries the cost-sheet
-- quantity (girth/usage × measured qty), which is what drives material/stock
-- demand once a programme activity is linked to its bill line(s).

CREATE TABLE contract_item_components (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_item_id  INTEGER NOT NULL REFERENCES contract_items(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,   -- material/component (Pricing col B)
  girth             REAL,            -- usage factor per unit of the bill item (col C)
  qty               REAL,            -- quantity for the item (col D = girth × measured qty)
  unit              TEXT,            -- col E
  material_rate     REAL,            -- col F
  display_order     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_cic_item ON contract_item_components(contract_item_id);
