-- Link a site sign-in to the operative who made it.
--
-- Until now site_signins stored only the person's NAME, company, trade and
-- phone as loose text — even though the sign-in page resolves the operative
-- from a picker and has their record in hand. Everything downstream therefore
-- joined attendance to the register on `lower(name) = lower(name)`: the trade
-- breakdown in site reports (documented in its own code as "best-effort …
-- blank where names don't match"), RAMS-signed status, and induction state.
-- Someone recorded once as "Dave Smith" and once as "David Smith" was silently
-- two people, and no screen said so.
--
-- NULL stays a valid, meaningful state: a visitor (client rep, surveyor) signs
-- in legitimately without being on the operative register. Reports already
-- count those separately as `visitors`.

ALTER TABLE site_signins ADD COLUMN operative_id TEXT REFERENCES operatives(id);
CREATE INDEX IF NOT EXISTS idx_site_signins_operative ON site_signins(operative_id);

-- ── Backfill ───────────────────────────────────────────────────────────────
-- Two throwaway views carry the comparison keys so the tiers below stay
-- readable. The phone key mirrors normalisePhone() in shared/operatives-import
-- exactly — strip separators, drop a leading 44, then drop a leading 0 — so a
-- number stored as "+44 7700 900111" matches one stored as "07700 900111".
-- Diverging from that rule here would make the backfill disagree with the
-- matching the app itself does.
CREATE VIEW _bf_op AS
SELECT id, archived_at, lower(trim(name)) AS n,
       CASE WHEN substr(x.d, 1, 1) = '0' THEN substr(x.d, 2) ELSE x.d END AS p
  FROM (SELECT id, archived_at, name,
               CASE WHEN substr(raw.r, 1, 2) = '44' THEN substr(raw.r, 3) ELSE raw.r END AS d
          FROM (SELECT id, archived_at, name,
                       replace(replace(replace(replace(replace(replace(COALESCE(phone, ''),
                         ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '') AS r
                  FROM operatives) raw) x;

CREATE VIEW _bf_ss AS
SELECT id, lower(trim(name)) AS n,
       CASE WHEN substr(x.d, 1, 1) = '0' THEN substr(x.d, 2) ELSE x.d END AS p
  FROM (SELECT id, name,
               CASE WHEN substr(raw.r, 1, 2) = '44' THEN substr(raw.r, 3) ELSE raw.r END AS d
          FROM (SELECT id, name,
                       replace(replace(replace(replace(replace(replace(COALESCE(phone, ''),
                         ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '') AS r
                  FROM site_signins) raw) x;

-- Tier 1 — phone AND name agree on one live operative. 96% of the current book.
-- Archived records are excluded throughout: the duplicate phones and duplicate
-- names in the register are old records superseded by a current one, and
-- ignoring them is what makes the tiers below unambiguous.
UPDATE site_signins SET operative_id = (
  SELECT o.id FROM _bf_op o JOIN _bf_ss s ON s.id = site_signins.id
   WHERE o.archived_at IS NULL AND o.p <> '' AND o.p = s.p AND o.n = s.n)
WHERE operative_id IS NULL AND (
  SELECT COUNT(*) FROM _bf_op o JOIN _bf_ss s ON s.id = site_signins.id
   WHERE o.archived_at IS NULL AND o.p <> '' AND o.p = s.p AND o.n = s.n) = 1;

-- Tier 2 — the phone belongs to exactly one live operative (name was typed
-- differently, or has since been corrected on the register).
UPDATE site_signins SET operative_id = (
  SELECT o.id FROM _bf_op o JOIN _bf_ss s ON s.id = site_signins.id
   WHERE o.archived_at IS NULL AND o.p <> '' AND o.p = s.p)
WHERE operative_id IS NULL AND (
  SELECT COUNT(*) FROM _bf_op o JOIN _bf_ss s ON s.id = site_signins.id
   WHERE o.archived_at IS NULL AND o.p <> '' AND o.p = s.p) = 1;

-- Tier 3 — no usable phone on the sign-in, but the name belongs to exactly one
-- live operative. Anything still ambiguous after this is deliberately left
-- NULL: two people who share a name and gave no phone cannot be told apart
-- here, and guessing would attach one person's attendance to the other.
UPDATE site_signins SET operative_id = (
  SELECT o.id FROM _bf_op o JOIN _bf_ss s ON s.id = site_signins.id
   WHERE o.archived_at IS NULL AND o.n = s.n)
WHERE operative_id IS NULL AND (
  SELECT COUNT(*) FROM _bf_op o JOIN _bf_ss s ON s.id = site_signins.id
   WHERE o.archived_at IS NULL AND o.n = s.n) = 1;

DROP VIEW _bf_ss;
DROP VIEW _bf_op;
