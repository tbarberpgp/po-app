-- 0129: Blyth (26004) Paint Repairs — close the section on an acceptance line.
-- Source: Paul Garbutt, 2026-10-01.
--
-- The section currently ends on "Top Coat", which records only that the top
-- coat went on. Nothing records that someone then looked at the finished job
-- and accepted it. This appends that statement as the final item:
--
--     "Cosmetic coating complete and accepted."
--
-- It carries photo:"optional" like every other paint item (0115), so site can
-- evidence the finished face. No separate signature is attached to the item:
-- Paint Repairs is a HOLD point whose responsible party is NE Site Coatings,
-- and their qitp_signoffs row releases the section — that signature already
-- sits directly beneath this line on screen and in the PDF, so adding the item
-- brings the acceptance under the paint inspector's existing sign-off. The
-- schema has no per-item signature and this does not invent one.
--
-- hold:false matches all 20 existing paint items; the HOLD lives on the
-- section, not on any single line.
--
-- "optional" (not "required") for the same reason 0115 gave: cabins are
-- mid-inspection and one has already passed. A required photo would
-- retroactively block a section that was legitimately passed without it.
--
-- SAFETY: a pure append. json_insert at '$[#]' adds slot 20 and rewrites no
-- existing element, so the list keeps its order and its text. Captured data is
-- keyed by item position — qitp_records.checks and .entries are parallel
-- arrays, qitp_photos.item_index is an offset — so every record and photo
-- already captured against items 0-19 still points at the same item. Contrast
-- 0114, which had to reindex because it removed items mid-list. Records
-- written before this runs simply have shorter arrays, which reads as "not yet
-- ticked" on the new item, exactly as it should. No record, photo or sign-off
-- row is touched, and no section, cabin row or QR token is created or deleted.
UPDATE qitp_sections
   SET items = json_insert(items, '$[#]',
         json('{"text": "Cosmetic coating complete and accepted.", "hold": false, "photo": "optional", "entry": "none"}'))
 WHERE project_id = (SELECT id FROM projects WHERE code = '26004')
   AND title = 'Paint Repairs'
   -- Pin the exact template this was written against: the 20-item list as
   -- 0115 left it and 0121 renamed it. If it has since been re-cut, this
   -- updates nothing rather than appending to a newer revision. The length
   -- guard also makes a second run a no-op, so the line cannot be added twice.
   AND json_valid(items)
   AND json_array_length(items) = 20
   AND json_extract(items, '$[0].text')  = 'Before Repairs'
   AND json_extract(items, '$[7].text')  = 'Primer'
   AND json_extract(items, '$[13].text') = 'Midcoat'
   AND json_extract(items, '$[19].text') = 'Top Coat';
