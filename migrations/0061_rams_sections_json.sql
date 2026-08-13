-- Structured RAMS content for the gated operative read-through + sign-off.
-- The .docx is parsed (client-side, at upload) into an ordered RamsDoc — sections
-- with typed blocks (paragraphs, lists, key-value, risk-register cards, tables,
-- images, callouts) — and stored here as JSON. The operative reader renders this
-- structure on a phone; html_content stays as the fallback for older documents
-- uploaded before this column existed.
ALTER TABLE rams_documents ADD COLUMN sections_json TEXT;
