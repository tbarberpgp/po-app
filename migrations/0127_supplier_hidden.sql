-- Curation for a register that is really a mirror of Xero.
--
-- "Sync with Xero" pulls every contact flagged IsSupplier==true and creates a
-- row for anything it can't match, so the register fills up with names the
-- company genuinely pays but never raises a PO against — a director's expense
-- claim, the bookkeeper, a software subscription. They land in "Materials
-- suppliers" beside Fixfast and Alumasc, and clutter every supplier picker.
--
-- Deleting them doesn't hold. Three separate paths recreate a supplier the
-- moment its name has no row: the Xero sync, coding an invoice to that name
-- (routes/invoices.ts), and raising a PO against it (routes/pos.ts). All three
-- ask "is there a row called this?" — so the row is what suppresses them.
--
-- Hence hide rather than delete. Keeping the row is what stops the three paths
-- recreating it, and keeps an already-pushed invoice's supplier_id pointing at
-- something. The name simply stops being offered as somewhere to buy from.
--
-- Deliberately NOT a `status` value: status is about whether we're allowed to
-- buy from someone right now ('suspended' means in dispute, and still warns on
-- a PO). Hidden means "not somewhere we buy from at all" — an orthogonal fact,
-- and one that has to survive a status edit.
ALTER TABLE suppliers ADD COLUMN hidden         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN hidden_reason  TEXT;
ALTER TABLE suppliers ADD COLUMN hidden_at      TEXT;
ALTER TABLE suppliers ADD COLUMN hidden_by      TEXT;

-- Partial index: the register and every picker filter on `hidden = 0`, and the
-- hidden set stays small, so this keeps the common read off a full scan.
CREATE INDEX idx_suppliers_hidden ON suppliers(hidden) WHERE hidden = 1;
