BEGIN;

INSERT INTO schema_migrations(version) VALUES ('20240410210545');
INSERT INTO ar_internal_metadata(key, value, created_at, updated_at)
VALUES ('environment', 'production', '2024-04-10 21:05:45', '2024-04-10 21:05:45');

INSERT INTO communities(id, name, locale, country, created_at, updated_at, beta, public, slug, description) VALUES
  (10, 'Public Community', 'en', 'Suriname', '2020-01-01 00:00:00', '2024-01-01 00:00:00', false, true, 'public_community', 'Public description'),
  (11, 'Private Community', 'pt-BR', 'Brazil', '2020-01-02 00:00:00', '2024-01-02 00:00:00', true, false, NULL, 'Private description');

INSERT INTO places(id, name, type_of_place, created_at, updated_at, lat, long, region, description, community_id) VALUES
  (50, 'Mapped Place', 'village', '2020-02-01 00:00:00', '2024-02-01 00:00:00', -1.455800, -48.490200, 'Para', 'Mapped place description', 10),
  (51, 'Unmapped Place', 'sacred site', '2020-02-02 00:00:00', '2024-02-02 00:00:00', NULL, NULL, NULL, 'Coordinates intentionally unknown', 10);

INSERT INTO speakers(id, name, created_at, updated_at, birthdate, birthplace_id, speaker_community, community_id) VALUES
  (40, 'Speaker One', '2020-03-01 00:00:00', '2024-03-01 00:00:00', '1950-06-15 00:00:00', 50, 'Neighbouring Community', 10),
  (41, 'Speaker Two', '2020-03-02 00:00:00', '2024-03-02 00:00:00', NULL, NULL, NULL, 10);

INSERT INTO users(
  id, email, encrypted_password, reset_password_token, reset_password_sent_at,
  remember_created_at, sign_in_count, current_sign_in_at, last_sign_in_at,
  current_sign_in_ip, last_sign_in_ip, created_at, updated_at, role,
  community_id, super_admin, username, name
) VALUES
  (20, 'viewer@example.org', '$2a$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12345', NULL, NULL, NULL, 1, '2024-01-05 12:00:00', NULL, '127.0.0.1', NULL, '2020-04-01', '2024-04-01', 3, 10, false, 'viewer', 'Viewer Name'),
  (21, 'member@example.org', '$2a$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12345', NULL, NULL, NULL, 2, '2024-01-06 12:00:00', '2024-01-05 12:00:00', '127.0.0.2', '127.0.0.1', '2020-04-02', '2024-04-02', 0, 10, false, 'member', NULL),
  (22, 'editor@example.org', '$2a$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12345', 'reset-token', '2024-01-07 12:00:00', NULL, 3, NULL, NULL, NULL, NULL, '2020-04-03', '2024-04-03', 1, 10, false, 'editor', 'Editor Name'),
  (23, 'admin@example.org', '$2a$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12345', NULL, NULL, '2024-01-08 12:00:00', 4, NULL, NULL, NULL, NULL, '2020-04-04', '2024-04-04', 2, 10, false, 'admin', 'Admin Name'),
  (24, 'super@example.org', '$2a$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12345', NULL, NULL, NULL, 5, NULL, NULL, NULL, NULL, '2020-04-05', '2024-04-05', 100, NULL, true, 'superadmin', 'System Admin');

INSERT INTO stories(
  id, title, "desc", created_at, updated_at, permission_level, date_interviewed,
  language, interview_location_id, interviewer_id, community_id, topic
) VALUES
  (30, 'Public Story', 'Public story description', '2020-05-01', '2024-05-01', 0, '2019-01-01', 'English', 50, 40, 10, 'history'),
  (31, 'Community Story', 'Community-only story', '2020-05-02', '2024-05-02', 1, NULL, 'Portuguese', NULL, NULL, 10, 'territory'),
  (32, 'Editors Story', 'Editors-only story', '2020-05-03', '2024-05-03', 2, NULL, NULL, NULL, NULL, 10, NULL);

INSERT INTO places_stories(id, story_id, place_id) VALUES
  (1, 30, 50),
  (2, 31, 51),
  (3, 32, 50);

INSERT INTO speaker_stories(id, speaker_id, story_id) VALUES
  (1, 40, 30),
  (2, 41, 31),
  (3, 40, 32);

INSERT INTO media(id, story_id, created_at, updated_at)
VALUES (70, 30, '2020-06-01', '2024-06-01');

INSERT INTO media_links(id, url, story_id, created_at, updated_at)
VALUES (80, 'https://example.org/external-media', 30, '2020-06-02', '2024-06-02');

INSERT INTO themes(
  id, active, created_at, updated_at, mapbox_style_url, mapbox_access_token,
  center_lat, center_long, sw_boundary_lat, sw_boundary_long,
  ne_boundary_lat, ne_boundary_long, zoom, pitch, bearing, mapbox_3d,
  map_projection, community_id, protomaps_api_key, protomaps_basemap_style
) VALUES (
  60, true, '2020-07-01', '2024-07-01', 'mapbox://styles/example', 'legacy-map-token',
  -1.455800, -48.490200, -2.000000, -49.000000,
  -1.000000, -48.000000, 8.500000, 15.000000, 30.000000, true,
  1, 10, 'legacy-protomaps-key', '{"theme":"light"}'
);

INSERT INTO curriculums(id, title, description, user_id, created_at, updated_at)
VALUES (90, 'Historical Curriculum', 'Must be archived even if not a V2 runtime feature', 22, '2020-08-01', '2024-08-01');
INSERT INTO curriculum_stories(id, curriculum_id, story_id, created_at, updated_at, display_order)
VALUES (91, 90, 30, '2020-08-02', '2024-08-02', 2);

INSERT INTO flipper_features(id, key, description, created_at, updated_at)
VALUES (95, 'example_feature', 'Feature state must be accounted for', '2020-09-01', '2024-09-01');
INSERT INTO flipper_gates(id, feature_key, key, value, created_at, updated_at)
VALUES (96, 'example_feature', 'boolean', 'true', '2020-09-01', '2024-09-01');

INSERT INTO active_storage_blobs(
  id, key, filename, content_type, metadata, byte_size, checksum, created_at, service_name
) VALUES (
  100, 'fixtureblob', 'fixture.svg', 'image/svg+xml', '{"identified":true}', 47,
  'VMUF7/0JWAABfjohpyP8FQ==', '2020-10-01', 'local'
);

INSERT INTO active_storage_attachments(id, name, record_type, record_id, blob_id, created_at) VALUES
  (101, 'media', 'Media', 70, 100, '2020-10-02'),
  (102, 'photo', 'Place', 50, 100, '2020-10-02'),
  (103, 'name_audio', 'Place', 50, 100, '2020-10-02'),
  (104, 'photo', 'Speaker', 40, 100, '2020-10-02'),
  (105, 'photo', 'User', 22, 100, '2020-10-02'),
  (106, 'display_image', 'Community', 10, 100, '2020-10-02'),
  (107, 'background_img', 'Community', 10, 100, '2020-10-02'),
  (108, 'sponsor_logos', 'Community', 10, 100, '2020-10-02');

INSERT INTO active_storage_variant_records(id, blob_id, variation_digest)
VALUES (109, 100, 'variant-digest-fixture');

COMMIT;
