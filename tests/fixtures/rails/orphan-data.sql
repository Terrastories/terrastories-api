-- Synthetic orphan patterns for the Stage-2 transform tests (hand-written,
-- no real data). Rails has no foreign keys on these tables, so such rows occur.
BEGIN;

-- Join rows whose story and/or other endpoint has no source row.
INSERT INTO places_stories(id, story_id, place_id) VALUES
  (90, 9999, 50),
  (91, 30, 9998),
  (92, 9996, 9998),
  (93, 9995, 53);
INSERT INTO speaker_stories(id, speaker_id, story_id) VALUES
  (90, 40, 9999),
  (91, 9998, 30),
  (92, 9997, 9996),
  (93, 42, 9995);

-- Orphan media (story missing / NULL) and attachments with no attributable owner.
INSERT INTO media(id, story_id, created_at, updated_at) VALUES
  (72, 9999, '2020-06-03 00:00:00', '2024-06-03 00:00:00'),
  (73, NULL, '2020-06-04 00:00:00', '2024-06-04 00:00:00');
INSERT INTO active_storage_attachments(id, name, record_type, record_id, blob_id, created_at) VALUES
  (120, 'media', 'Media', 72, 112, '2020-10-03 00:00:00'),
  (121, 'file', 'Widget', 1, 112, '2020-10-03 00:00:00');

COMMIT;
