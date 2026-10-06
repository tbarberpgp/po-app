-- Making a delivery say HOW it came to be attached to its purchase order.
--
-- Deliveries were matched to orders on no evidence at all: where a supplier
-- printed no PO number on the note — routine on drop-shipped goods — the
-- scanner fell back to picking the best-scoring order belonging to that
-- supplier, and the result was shown as a confirmed match. Nothing recorded
-- that the link was a guess, so nothing could be audited afterwards.
--
--   po_link_basis   'ticket'   the PO number was printed on the delivery note
--                   'override' no PO on the paper; a person chose the order
--                   NULL       logged before this was recorded
--   po_link_reason  why that order, typed by the person who chose it
ALTER TABLE site_deliveries ADD COLUMN po_link_basis  TEXT;
ALTER TABLE site_deliveries ADD COLUMN po_link_reason TEXT;

-- The supplier's OWN order reference, off their ticket. Suppliers who
-- drop-ship quote only their own reference, which is also what lands on the
-- invoice (invoices.supplier_order_ref) — so this is the one thread that ties
-- a delivery to the invoice for it.
ALTER TABLE site_deliveries        ADD COLUMN supplier_invoice_ref TEXT;
ALTER TABLE delivery_ticket_scans  ADD COLUMN supplier_invoice_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_site_deliveries_supplier_ref
  ON site_deliveries(supplier_invoice_ref);
