-- Carry the contract-item category onto each AfP line so the application
-- detail view can group into the same three sections as the cost sheet:
-- Preliminaries / Measured works / Ancil Items. Ad-hoc variation lines leave
-- this null and render under a "Variations" group.
ALTER TABLE afp_lines ADD COLUMN category TEXT;
