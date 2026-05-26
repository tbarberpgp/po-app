-- Org-wide cost-coding system. Implements the two-code model defined in
-- cost_coding_system.xlsx:
--
--   Product code  ELE.ITM[.VAR]   (lives on products)
--   Cost code     PRJ.ELE.RES     (lives on PO lines / invoices)
--
-- The ELE segment is shared between both — that's how spend rolls up by
-- element across projects. The product code never embeds a project number;
-- product entries are reusable across every project.

-- Master list of package elements (Roofing, Cladding, Insulation, etc.).
-- Codes are 2 digits, 10–99, allocated as per the workbook.
CREATE TABLE elements (
  code  TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  notes TEXT
);

-- Resource types classify spend (Materials / Labour / Plant / Subcontract /
-- Overheads / Other).
CREATE TABLE resource_types (
  code  TEXT PRIMARY KEY,        -- M / L / P / S / O / X
  name  TEXT NOT NULL,
  usage TEXT
);

-- Org-wide product catalogue. The product_code is derived (ELE.ITM[.VAR]) —
-- we store the pieces and stitch them on read so renaming an element doesn't
-- require updating every product row.
CREATE TABLE products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  element_code      TEXT NOT NULL REFERENCES elements(code),
  item_no           INTEGER NOT NULL,                       -- 1..89 normal, 90..99 = variations
  variant           TEXT,                                   -- optional VAR segment
  description       TEXT NOT NULL,
  manufacturer      TEXT,
  supplier          TEXT,
  unit              TEXT,
  unit_cost         REAL,
  default_resource  TEXT REFERENCES resource_types(code) DEFAULT 'M',
  notes             TEXT,
  created_at        TEXT NOT NULL,
  created_by        TEXT,
  UNIQUE(element_code, item_no, variant)
);
CREATE INDEX idx_products_element ON products(element_code);
CREATE INDEX idx_products_manufacturer ON products(manufacturer);

-- Project materials can be linked to a master product. Nullable — projects
-- can still hold unlinked rows while we curate the library.
ALTER TABLE materials ADD COLUMN product_id INTEGER REFERENCES products(id);

-- ── Seed: 22 elements (from the workbook's Elements sheet) ───────────────
INSERT INTO elements (code, name, notes) VALUES
  ('10', 'Preliminaries',                                'Access, scaffold liaison, supervision, site set-up'),
  ('20', 'Roofing - Standing seam',                      'Aluminium / zinc / copper standing seam systems'),
  ('21', 'Roofing - Composite panel',                    'Insulated composite roof panels'),
  ('22', 'Roofing - Built-up',                           'Site-assembled built-up metal roofing'),
  ('23', 'Roofing - Single-ply membrane',                'TPO, PVC, EPDM single-ply'),
  ('24', 'Roofing - Liquid applied',                     'Liquid-applied waterproofing'),
  ('30', 'Wall cladding - Composite panel',              'Insulated composite wall panels'),
  ('31', 'Wall cladding - Rainscreen',                   'Ventilated rainscreen systems'),
  ('32', 'Wall cladding - Through-fix profiled',         'Profiled metal through-fix sheeting'),
  ('33', 'Wall cladding - Secret-fix cassettes',         'Secret-fix cassette and plank systems'),
  ('40', 'Rooflights & smoke vents',                     'In-plane rooflights, AOVs, smoke vents'),
  ('50', 'Rainwater goods',                              'Gutters, downpipes, hoppers, syphonic'),
  ('51', 'Flashings & trims',                            'Pre-formed and site-formed flashings'),
  ('52', 'Soffits & fascias',                            'Linear soffit and fascia systems'),
  ('60', 'Insulation',                                   'PIR, mineral wool, etc.'),
  ('61', 'Vapour control & breather membranes',          'VCLs, breather membranes, tapes'),
  ('62', 'Halter brackets, carrier rails, sub-frames',   'Support systems for cladding'),
  ('63', 'Fixings & fasteners',                          'Screws, bolts, washers, sealants'),
  ('70', 'Edge protection / fall arrest',                'Edge protection, mansafe systems'),
  ('80', 'Plant & access equipment hire',                'MEWPs, scissor lifts, hoists, etc.'),
  ('90', 'Subcontract',                                  'Specialist subcontract labour or packages'),
  ('99', 'Variations / contingency',                     'Variations outside contracted scope');

-- ── Seed: 6 resource types (from the workbook's Resource Types sheet) ───
INSERT INTO resource_types (code, name, usage) VALUES
  ('M', 'Materials',         'Physical materials purchased on POs'),
  ('L', 'Labour',             'Direct site labour costs'),
  ('P', 'Plant',              'Plant and equipment hire'),
  ('S', 'Subcontract',        'Subcontract labour or packages'),
  ('O', 'Overheads / staff',  'Site supervision, prelims overhead'),
  ('X', 'Other',              'Waste, consumables, sundries');
