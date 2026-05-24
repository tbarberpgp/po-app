-- Optional seed — only for local dev. Run with `pnpm db:seed:local`.
-- Adds placeholder approver emails so the routing logic has somewhere to send mail.

INSERT INTO approvers (project_id, tier, email, name) VALUES
  (NULL, 'line_manager',        'line.manager@example.com',        'Default Line Manager'),
  (NULL, 'commercial_manager',  'commercial.manager@example.com',  'Default Commercial Manager'),
  (NULL, 'director',            'director@example.com',            'Default Director');
