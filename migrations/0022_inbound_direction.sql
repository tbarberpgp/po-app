-- Inbound applications can now be either incoming labour (labourapps@) or
-- outgoing client applications (clientapps@). Track which so the tray resolve
-- creates the right kind of AfP.
ALTER TABLE inbound_applications
  ADD COLUMN direction TEXT NOT NULL DEFAULT 'incoming_labour'
    CHECK (direction IN ('incoming_labour', 'outgoing'));
