INSERT INTO communities (
  id, name, description, slug, public_stories, country, beta, created_at, updated_at
) VALUES (
  1,
  'Legacy Community',
  'Production-like migration fixture',
  'legacy-community',
  false,
  'BR',
  true,
  '2024-01-10 12:00:00',
  '2025-06-15 09:30:00'
);
--> statement-breakpoint
INSERT INTO users (
  id, email, password_hash, first_name, last_name, role, community_id,
  is_active, last_login_at, reset_password_token, reset_password_sent_at,
  remember_created_at, sign_in_count, last_sign_in_at, current_sign_in_ip,
  created_at, updated_at
) VALUES (
  1,
  'admin@example.test',
  '[REDACTED_HASH]',
  'Migration',
  'Admin',
  'admin',
  1,
  true,
  '2025-06-14 09:00:00',
  '[REDACTED_TOKEN]',
  '2025-06-13 08:00:00',
  '2025-06-12 07:00:00',
  7,
  '2025-06-14 09:00:00',
  '192.0.2.10',
  '2024-01-10 12:05:00',
  '2025-06-15 09:35:00'
);
--> statement-breakpoint
INSERT INTO places (
  id, name, description, community_id, latitude, longitude, region,
  is_restricted, created_at, updated_at
) VALUES
  (
    1, 'Sacred Site', 'Restricted cultural place', 1,
    -1.4558, -48.4902, 'Belem', true,
    '2024-02-01 10:00:00', '2025-06-01 10:00:00'
  ),
  (
    2, 'Community Center', 'Public community place', 1,
    -1.4562, -48.4895, 'Belem', false,
    '2024-02-02 10:00:00', '2025-06-02 10:00:00'
  ),
  (
    3, 'Far Site', 'Outside local search radius', 1,
    -3.1190, -60.0217, 'Manaus', false,
    '2024-02-03 10:00:00', '2025-06-03 10:00:00'
  );
--> statement-breakpoint
INSERT INTO speakers (
  id, name, bio, community_id, photo_url, birth_year, elder_status,
  created_at, updated_at
) VALUES (
  1,
  'Elder Speaker',
  'Knowledge holder',
  1,
  'https://example.test/elder.jpg',
  1950,
  true,
  '2024-03-01 10:00:00',
  '2025-06-04 10:00:00'
);
--> statement-breakpoint
INSERT INTO stories (
  id, title, description, slug, community_id, created_by, is_restricted,
  created_at, updated_at
) VALUES (
  1,
  'Restricted Story',
  'Story preserving a restricted migration invariant',
  'restricted-story',
  1,
  1,
  true,
  '2024-04-01 10:00:00',
  '2025-06-05 10:00:00'
);
--> statement-breakpoint
INSERT INTO files (
  id, filename, original_name, path, url, mime_type, size,
  community_id, uploaded_by, metadata, cultural_restrictions, is_active,
  created_at, updated_at
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'elder-audio.mp3',
  'elder interview.mp3',
  'communities/1/stories/1/elder-audio.mp3',
  'https://example.test/files/elder-audio.mp3',
  'audio/mpeg',
  4096,
  1,
  1,
  '{"duration": 42}',
  '{"elderOnly": true, "accessLevel": "community"}',
  true,
  '2024-04-02 10:00:00',
  '2025-06-06 10:00:00'
);
--> statement-breakpoint
INSERT INTO story_places (
  id, story_id, place_id, created_at, updated_at
) VALUES (
  1, 1, 1, '2024-04-03 10:00:00', '2025-06-07 10:00:00'
);
--> statement-breakpoint
INSERT INTO story_speakers (
  id, story_id, speaker_id, created_at, updated_at
) VALUES (
  1, 1, 1, '2024-04-04 10:00:00', '2025-06-08 10:00:00'
);
--> statement-breakpoint
INSERT INTO themes (
  id, name, description, center_lat, center_long, active, community_id,
  created_at, updated_at
) VALUES (
  1,
  'Legacy Theme',
  'Theme retained through upgrade',
  -1.455800,
  -48.490200,
  true,
  1,
  '2024-05-01 10:00:00',
  '2025-06-09 10:00:00'
);
--> statement-breakpoint
INSERT INTO attachments (
  id, attachable_id, attachable_type, url, filename, content_type, file_size,
  created_at
) VALUES (
  1,
  1,
  'Story',
  'https://example.test/attachments/story-photo.jpg',
  'story-photo.jpg',
  'image/jpeg',
  2048,
  '2024-05-02 10:00:00'
);
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('communities', 'id'), 1, true);
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('users', 'id'), 1, true);
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('places', 'id'), 3, true);
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('speakers', 'id'), 1, true);
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('stories', 'id'), 1, true);
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('story_places', 'id'), 1, true);
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('story_speakers', 'id'), 1, true);
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('themes', 'id'), 1, true);
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('attachments', 'id'), 1, true);
