-- 0120: a receipt logged from an invoice says which invoice it came from.
--
-- "Mark as collected" on an invoice writes one receipt row per outstanding PO
-- line — collection from a trade counter IS receipt, and the 3-way match can't
-- complete honestly without it. Those rows carry no scan and no ticket photo,
-- because a counter hands over an invoice, not a delivery note. The order's
-- delivery register therefore drew them with a dashed "no ticket" box and
-- titled them "Manual check-in", which in this app means the weakest evidence
-- there is: goods logged from memory with no paper behind them.
--
-- The paper exists. It is the invoice, and the row already named it — in prose,
-- in `notes`, where nothing can follow it. This column makes that link real, so
-- the register can show the invoice as the receipt's paperwork instead of
-- reporting that there is none.
--
-- Additive: every other kind of check-in leaves it NULL and is unaffected.
ALTER TABLE site_deliveries ADD COLUMN source_invoice_id INTEGER;

-- The rows that route has already written, recovered from the prose they left.
-- The note is generated verbatim as
--   'Collected from supplier — marked from invoice <number>'
-- with '#<id>' standing in when the invoice had no number of its own, so both
-- forms are matched back. Anything that doesn't resolve to exactly one invoice
-- — a deleted invoice, an edited number, or a number two invoices share — is
-- left NULL and keeps today's behaviour, which is honest about not knowing.
UPDATE site_deliveries
   SET source_invoice_id = (
         SELECT i.id FROM invoices i
          WHERE i.invoice_number = replace(site_deliveries.notes, 'Collected from supplier — marked from invoice ', '')
       )
 WHERE source_invoice_id IS NULL
   AND notes LIKE 'Collected from supplier — marked from invoice %'
   AND notes NOT LIKE 'Collected from supplier — marked from invoice #%'
   AND (
         SELECT COUNT(*) FROM invoices i
          WHERE i.invoice_number = replace(site_deliveries.notes, 'Collected from supplier — marked from invoice ', '')
       ) = 1;

UPDATE site_deliveries
   SET source_invoice_id = (
         SELECT i.id FROM invoices i
          WHERE i.id = CAST(replace(site_deliveries.notes, 'Collected from supplier — marked from invoice #', '') AS INTEGER)
       )
 WHERE source_invoice_id IS NULL
   AND notes LIKE 'Collected from supplier — marked from invoice #%';
