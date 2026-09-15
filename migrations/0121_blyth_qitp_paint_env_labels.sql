-- 0121: Blyth (26004) Paint Repairs — say which coat each environmental block
-- belongs to.
--
-- The section measures steel temperature, air temperature, relative humidity
-- and dew point three times: once before each of primer, midcoat and top coat.
-- All three blocks carry identical item text, so the checklist and the PDF both
-- print "Steel Temperature" three times with nothing to tell them apart — a
-- reader has to infer the coat from whichever item follows the block. On the
-- printed record that is a real ambiguity: the readings are the evidence the
-- coat was applied inside spec, and which coat they belong to matters.
--
-- SAFETY: this renames item text only. It does not add, remove or reorder an
-- item, so the array keeps its 20 slots in their existing order. Captured data
-- is keyed by item position — qitp_records.checks and .entries are parallel
-- arrays, qitp_photos.item_index is an offset — so nothing moves and no
-- evidence needs reindexing. Contrast 0114, which did have to shift indices
-- because it removed two items. No section, record, photo or sign-off row is
-- touched.
--
-- Positions renamed (0-based, as stored; the PDF numbers them from 1):
--   3-6   -> pre-primer      7  Primer
--   9-12  -> pre-midcoat    13  Midcoat
--   15-18 -> pre-topcoat    19  Top Coat

UPDATE qitp_sections
  SET items = json_set(items,
    '$[3].text',  'Steel Temperature (pre-primer)',
    '$[4].text',  'Air Temperature (pre-primer)',
    '$[5].text',  'Relative Humidity (pre-primer)',
    '$[6].text',  'Dew Point (pre-primer)',
    '$[9].text',  'Steel Temperature (pre-midcoat)',
    '$[10].text', 'Air Temperature (pre-midcoat)',
    '$[11].text', 'Relative Humidity (pre-midcoat)',
    '$[12].text', 'Dew Point (pre-midcoat)',
    '$[15].text', 'Steel Temperature (pre-topcoat)',
    '$[16].text', 'Air Temperature (pre-topcoat)',
    '$[17].text', 'Relative Humidity (pre-topcoat)',
    '$[18].text', 'Dew Point (pre-topcoat)')
  WHERE project_id = (SELECT id FROM projects WHERE code = '26004')
    AND title = 'Paint Repairs'
    -- Only the 20-item list this migration was written against. Each block is
    -- matched on its own current text, so a template that has already been
    -- renamed, or edited into a different shape, is left alone and re-running
    -- this is a no-op rather than a second rename.
    AND json_valid(items)
    AND json_array_length(items) = 20
    AND json_extract(items, '$[3].text')  = 'Steel Temperature'
    AND json_extract(items, '$[9].text')  = 'Steel Temperature'
    AND json_extract(items, '$[15].text') = 'Steel Temperature'
    AND json_extract(items, '$[7].text')  = 'Primer'
    AND json_extract(items, '$[13].text') = 'Midcoat'
    AND json_extract(items, '$[19].text') = 'Top Coat';
