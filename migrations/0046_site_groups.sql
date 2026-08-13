-- Site groups — bundle multiple contracts (projects) that are areas of the same
-- physical site so they share the OPERATIONAL layer (sign-in / attendance,
-- RAMS & docs, site notices/briefing, deliveries) while each contract keeps its
-- own commercials, POs and applications.
--
-- Implementation: one member is the group's "base" project, which physically
-- hosts the shared operational records. Every member resolves its shared-ops
-- reads/writes to the base, so the three contracts share one QR, one attendance
-- register, one RAMS set and one delivery log. Photos, plant and all commercials
-- stay per-contract.

CREATE TABLE IF NOT EXISTS site_groups (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  base_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL
);

-- Which site group (if any) a contract belongs to.
ALTER TABLE projects ADD COLUMN site_group_id TEXT REFERENCES site_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_projects_site_group ON projects(site_group_id);

-- A delivery is logged once against the shared site (the base project) but can be
-- tagged to the specific contract it belongs to — usually inferred from its PO.
ALTER TABLE site_deliveries ADD COLUMN contract_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
