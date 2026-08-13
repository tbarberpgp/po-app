-- Phone-readable RAMS. The Word (.docx) RAMS is converted to sanitised HTML on
-- upload and stored here so an operative can read it inline on their profile —
-- scrolling to the end is what unlocks signing. NULL = a legacy file-only RAMS
-- (not signable under the Word-only flow until it's re-uploaded as a .docx).
ALTER TABLE rams_documents ADD COLUMN html_content TEXT;
