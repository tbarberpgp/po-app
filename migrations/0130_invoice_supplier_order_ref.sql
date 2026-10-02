-- 0130: the supplier's OWN order reference, held on the invoice.
--
-- `extracted_po_ref` is one half of the conversation — OUR PO number as the
-- supplier printed it. The other half is the supplier's own sales-order number
-- (Alumasc call theirs an SOR), and the app has never had anywhere to put it.
--
-- That gap is why the Dallas Road Alumasc audit of 24 Sep 2026 was so slow to
-- settle. Where no delivery note survived, the SOR is the only key that ties an
-- invoice back to the order it was raised against: four separate invoices all
-- quote SOR 456694 and all belong to PO-26001-0014, and the 457972/457973 pair
-- splits Block B's adhesive from Block C's — which is how an invoice matched to
-- the wrong block was found at all. Until now that evidence lived in a PDF on
-- someone's desktop, so the next person to ask had to redo the whole audit.
--
-- Deliberately free text, and deliberately NOT a Xero-bound field: a supplier
-- reference neither shapes nor reaches the bill, so unlike the amounts it stays
-- editable after a push. It is almost always learnt afterwards.
ALTER TABLE invoices ADD COLUMN supplier_order_ref TEXT;

-- Finding every invoice on one sales order is the question this column exists
-- to answer, so it is worth an index rather than a scan of the whole book.
CREATE INDEX IF NOT EXISTS idx_invoices_supplier_order_ref
    ON invoices(supplier_order_ref) WHERE supplier_order_ref IS NOT NULL;
