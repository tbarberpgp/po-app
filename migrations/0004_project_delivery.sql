-- Site / delivery details for each project.
-- Printed in the DELIVERY DETAILS block on every PO PDF for that project.

ALTER TABLE projects ADD COLUMN delivery_address      TEXT;
ALTER TABLE projects ADD COLUMN site_contact_name     TEXT;
ALTER TABLE projects ADD COLUMN site_contact_phone    TEXT;
ALTER TABLE projects ADD COLUMN delivery_instructions TEXT;
