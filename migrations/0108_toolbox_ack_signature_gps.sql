-- A toolbox-talk acknowledgement is an H&S record: it has to prove WHO took the
-- talk, WHERE they were, and carry their signature — the same evidence the paper
-- register used to. Mirrors site_signins (signature + lat/lng/accuracy).
--
-- Location is best-effort, not a gate: a phone that refuses the permission or
-- can't get a fix still records the acknowledgement, with lat/lng left null and
-- the reason in geo_status, rather than blocking an operative on site.
ALTER TABLE operative_notice_acks ADD COLUMN signature TEXT;      -- PNG data-URL; null until acknowledged
ALTER TABLE operative_notice_acks ADD COLUMN lat REAL;
ALTER TABLE operative_notice_acks ADD COLUMN lng REAL;
ALTER TABLE operative_notice_acks ADD COLUMN accuracy REAL;       -- metres (GeolocationCoordinates.accuracy)
ALTER TABLE operative_notice_acks ADD COLUMN geo_status TEXT;     -- 'ok' | 'denied' | 'unavailable'
