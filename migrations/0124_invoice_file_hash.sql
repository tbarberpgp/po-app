-- Duplicate detection by DOCUMENT, not only by what the extractor read off it.
--
-- The same invoice reaches the Accounts mailbox more than once as a matter of
-- course — the supplier's original and a colleague's forward of it both sit
-- there — and the mailbox pull's window overlaps on purpose. Identity by
-- supplier + invoice number only holds when the extractor reads the same name
-- twice ("Fixfast Ltd" / "FIXFAST LIMITED" are two suppliers to a SQL compare);
-- bytes always match.
ALTER TABLE invoices ADD COLUMN file_sha256 TEXT;
CREATE INDEX IF NOT EXISTS idx_invoices_file_sha256 ON invoices(file_sha256);
