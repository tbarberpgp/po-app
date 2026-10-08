-- Extra sites an operative also signs in at. assigned_project_id stays their ONE
-- home site (roster, reports, the reassignment alert); a row here lets them pick
-- themselves on another site's sign-in list too. Added for a Latbuild roofer
-- working Dallas Rd Townhouse (26008) and Blocks B/C/D (26001 group) in the same
-- week — reassigning him back and forth was the only option, and on the wrong
-- day his name simply wasn't on the list.
CREATE TABLE IF NOT EXISTS operative_extra_sites (
  operative_id TEXT NOT NULL REFERENCES operatives(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL,
  added_at     TEXT NOT NULL,
  added_by     TEXT NOT NULL,
  PRIMARY KEY (operative_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_operative_extra_sites_project ON operative_extra_sites(project_id);
