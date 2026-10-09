-- A delivery note is booked once, against one order. Ticket check-ins already
-- reach the note number through their scan; deliveries logged by hand kept it
-- only as prose in `notes` ("Delivery note 0013507928"), so the same note could
-- be booked twice without anything noticing. Give the number a column so the
-- booking routes can refuse a second booking of it.
ALTER TABLE site_deliveries ADD COLUMN delivery_note_number TEXT;
