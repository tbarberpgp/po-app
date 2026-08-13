-- Keep the source file for labour applications that arrive by email and get
-- parked in the inbound tray (no project code resolved). We store the file in R2
-- on receipt and record the key here; when the parked application is resolved
-- into a real AfP, the AfP inherits these so the document attaches to the Xero
-- bill — same as the direct-upload path.
ALTER TABLE inbound_applications ADD COLUMN source_file_key TEXT;
ALTER TABLE inbound_applications ADD COLUMN source_file_name TEXT;
ALTER TABLE inbound_applications ADD COLUMN source_file_type TEXT;
