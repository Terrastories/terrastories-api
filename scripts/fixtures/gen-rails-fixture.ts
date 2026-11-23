import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import { BCRYPT_HASH_PATTERN } from '../../src/shared/auth-policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fixtureRoot = join(repoRoot, 'tests', 'fixtures', 'rails');
const blobsRoot = join(fixtureRoot, 'blobs');

interface FixtureBlobSpec {
  id: number;
  key: string;
  filename: string;
  contentType: string;
  metadata: string;
  createdAt: string;
  serviceName: string;
  bytes: Buffer;
}

function sqlString(value: string | null): string {
  if (value === null) return 'NULL';
  return `'${value.replaceAll("'", "''")}'`;
}

function md5Base64(bytes: Buffer): string {
  return createHash('md5').update(bytes).digest('base64');
}

function validHash(
  prefix: '$2a$' | '$2b$',
  cost: 10 | 12,
  saltBody21: string,
  password: string
): string {
  if (!/^[./A-Za-z0-9]{21}$/.test(saltBody21)) {
    throw new Error(`Invalid salt body: ${saltBody21}`);
  }
  const salt = `${prefix}${cost}$${saltBody21}.`;
  const digest = bcrypt.hashSync(password, salt);
  if (!BCRYPT_HASH_PATTERN.test(digest)) {
    throw new Error(`Generated hash failed BCRYPT_HASH_PATTERN: ${digest}`);
  }
  if (!bcrypt.compareSync(password, digest)) {
    throw new Error('Generated hash failed bcrypt.compareSync self-check');
  }
  return digest;
}

const FIXTURE_BLOBS: readonly FixtureBlobSpec[] = [
  {
    id: 100,
    key: 'storymedia01',
    filename: 'story-media.svg',
    contentType: 'image/png',
    metadata: '{"identified":true}',
    createdAt: '2020-10-01 00:00:00',
    serviceName: 'local',
    bytes: Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><title>Story Media</title></svg>\n",
      'utf8'
    ),
  },
  {
    id: 101,
    key: 'placephoto01',
    filename: 'place-photo.svg',
    contentType: 'image/png',
    metadata: '{"identified":true,"width":32,"height":32}',
    createdAt: '2020-10-01 00:01:00',
    serviceName: 'local',
    bytes: Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><circle cx='16' cy='16' r='12'/></svg>\n",
      'utf8'
    ),
  },
  {
    id: 102,
    key: 'placeaudio01',
    filename: 'place-name.ogg',
    contentType: 'audio/ogg',
    metadata: '{"identified":true}',
    createdAt: '2020-10-01 00:02:00',
    serviceName: 'local',
    bytes: Buffer.from('OggS-fixture-place-name-audio-payload\n', 'utf8'),
  },
  {
    id: 103,
    key: 'spkrphoto01',
    filename: 'speaker-photo.svg',
    contentType: 'image/png',
    metadata: '{"identified":true}',
    createdAt: '2020-10-01 00:03:00',
    serviceName: 'local',
    bytes: Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><rect width='10' height='10'/></svg>\n",
      'utf8'
    ),
  },
  {
    id: 104,
    key: 'userphoto01',
    filename: 'user-photo.svg',
    contentType: 'image/png',
    metadata: '{"identified":true}',
    createdAt: '2020-10-01 00:04:00',
    serviceName: 'local',
    bytes: Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><path d='M1 1 L9 9'/></svg>\n",
      'utf8'
    ),
  },
  {
    id: 105,
    key: 'commdisp01',
    filename: 'community-display.svg',
    contentType: 'image/png',
    metadata: '{"identified":true}',
    createdAt: '2020-10-01 00:05:00',
    serviceName: 'local',
    bytes: Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><text x='1' y='9'>Rio</text></svg>\n",
      'utf8'
    ),
  },
  {
    id: 106,
    key: 'commbgimg01',
    filename: 'community-bg.svg',
    contentType: 'image/png',
    metadata: '{"identified":true}',
    createdAt: '2020-10-01 00:06:00',
    serviceName: 'local',
    bytes: Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><rect width='20' height='20'/></svg>\n",
      'utf8'
    ),
  },
  {
    id: 107,
    key: 'sponsorlogo1',
    filename: 'sponsor-1.svg',
    contentType: 'image/png',
    metadata: '{"identified":true}',
    createdAt: '2020-10-01 00:07:00',
    serviceName: 'local',
    bytes: Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><text>S1</text></svg>\n",
      'utf8'
    ),
  },
  {
    id: 108,
    key: 'sponsorlogo2',
    filename: 'sponsor-2.svg',
    contentType: 'image/png',
    metadata: '{"identified":true}',
    createdAt: '2020-10-01 00:08:00',
    serviceName: 'local',
    bytes: Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><text>S2</text></svg>\n",
      'utf8'
    ),
  },
  {
    id: 109,
    key: 'sponsorlogo3',
    filename: 'sponsor-3.svg',
    contentType: 'image/png',
    metadata: '{"identified":true}',
    createdAt: '2020-10-01 00:09:00',
    serviceName: 'local',
    bytes: Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><text>S3</text></svg>\n",
      'utf8'
    ),
  },
  {
    id: 110,
    key: 'staticmap01',
    filename: 'static-map.svg',
    contentType: 'image/png',
    metadata: '{"identified":true}',
    createdAt: '2020-10-01 00:10:00',
    serviceName: 'local',
    bytes: Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><polygon points='0,0 10,0 5,10'/></svg>\n",
      'utf8'
    ),
  },
  {
    id: 111,
    key: 'sharedblob01',
    filename: 'shared-river.svg',
    contentType: 'image/png',
    metadata: '{"identified":true}',
    createdAt: '2020-10-01 00:11:00',
    serviceName: 'local',
    bytes: Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><line x1='0' y1='0' x2='10' y2='10'/></svg>\n",
      'utf8'
    ),
  },
  {
    id: 112,
    key: 'orphanblob01',
    filename: 'orphan-note.txt',
    contentType: 'text/plain',
    metadata: '{"identified":true}',
    createdAt: '2020-10-01 00:12:00',
    serviceName: 'local',
    bytes: Buffer.from('unattached-orphan-fixture-blob\n', 'utf8'),
  },
  {
    id: 113,
    key: 'variantblob1',
    filename: 'place-photo-thumb.svg',
    contentType: 'image/png',
    metadata: '{"identified":true}',
    createdAt: '2020-10-01 00:13:00',
    serviceName: 'local',
    bytes: Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><circle cx='8' cy='8' r='4'/></svg>\n",
      'utf8'
    ),
  },
  {
    id: 114,
    key: 'sierraimg01',
    filename: 'sierra-display.svg',
    contentType: 'image/png',
    metadata: '{"identified":true}',
    createdAt: '2020-10-01 00:14:00',
    serviceName: 'local',
    bytes: Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><text>Sierra</text></svg>\n",
      'utf8'
    ),
  },
  {
    id: 115,
    key: 'previewimg01',
    filename: 'story-video-preview.svg',
    contentType: 'image/png',
    metadata: '{"identified":true}',
    createdAt: '2020-10-01 00:15:00',
    serviceName: 'local',
    bytes: Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><polygon points='2,2 14,8 2,14'/></svg>\n",
      'utf8'
    ),
  },
];

function writeDiskServiceBlobs(): void {
  for (const blob of FIXTURE_BLOBS) {
    const dir = join(blobsRoot, blob.key.slice(0, 2), blob.key.slice(2, 4));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, blob.key), blob.bytes);
  }
}

function blobInsertRow(blob: FixtureBlobSpec): string {
  const checksum = md5Base64(blob.bytes);
  return `  (${blob.id}, ${sqlString(blob.key)}, ${sqlString(blob.filename)}, ${sqlString(blob.contentType)}, ${sqlString(blob.metadata)}, ${blob.bytes.length}, ${sqlString(checksum)}, ${sqlString(blob.createdAt)}, ${sqlString(blob.serviceName)})`;
}

function generateFixtures(): void {
  writeDiskServiceBlobs();

  // Deterministic valid hashes from obviously-fake fixture passwords documented
  // in tests/fixtures/rails/README.md.
  const hashViewer = validHash(
    '$2a$',
    10,
    'fixtureSaltUser000020',
    'fixture-pass-viewer-2026'
  );
  const hashMember = validHash(
    '$2a$',
    12,
    'fixtureSaltUser000021',
    'fixture-pass-member-2026'
  );
  const hashEditor = validHash(
    '$2b$',
    10,
    'fixtureSaltUser000022',
    'fixture-pass-editor-2026'
  );
  const hashAdmin = validHash(
    '$2a$',
    12,
    'fixtureSaltUser000023',
    'fixture-pass-admin-2026'
  );
  const hashSuper = validHash(
    '$2a$',
    12,
    'fixtureSaltUser000024',
    'fixture-pass-super-2026'
  );
  const hashMemberSierra = validHash(
    '$2a$',
    10,
    'fixtureSaltUser000025',
    'fixture-pass-sierra-2026'
  );
  const hashNullEmail = validHash(
    '$2a$',
    10,
    'fixtureSaltUser000027',
    'fixture-pass-nullemail-2026'
  );
  const hashDupCase = validHash(
    '$2a$',
    10,
    'fixtureSaltUser000028',
    'fixture-pass-dupcase-2026'
  );
  const hashCrossKind = validHash(
    '$2a$',
    10,
    'fixtureSaltUser000029',
    'fixture-pass-crosskind-2026'
  );

  // Malformed hashes (must NOT satisfy BCRYPT_HASH_PATTERN).
  const hashTruncated = hashViewer.slice(0, 35);
  const hashBadPrefix = `$2x$10$fixtureSaltUser000202.${hashViewer.slice(29)}`;
  const hashCost15 = bcrypt.hashSync(
    'fixture-pass-cost15-2026',
    '$2a$15$fixtureSaltUser000203.'
  );

  for (const malformed of ['', hashTruncated, hashBadPrefix, hashCost15]) {
    if (BCRYPT_HASH_PATTERN.test(malformed)) {
      throw new Error(
        `Malformed fixture hash unexpectedly passed BCRYPT_HASH_PATTERN: ${malformed}`
      );
    }
  }

  const dataSql = [
    '-- Generated by scripts/fixtures/gen-rails-fixture.ts. Do not hand-edit.',
    'BEGIN;',
    '',
    "INSERT INTO schema_migrations(version) VALUES ('20240410210545');",
    'INSERT INTO ar_internal_metadata(key, value, created_at, updated_at)',
    "VALUES ('environment', 'production', '2024-04-10 21:05:45', '2024-04-10 21:05:45');",
    '',
    'INSERT INTO communities(id, name, locale, country, created_at, updated_at, beta, public, slug, description) VALUES',
    "  (10, 'Comunidade Rio Verde — Amazônia', 'pt-BR', 'Brazil', '2020-01-01 00:00:00', '2024-01-01 00:00:00', false, true, 'rio_verde', '<p>Histórias da Amazônia e do Rio Verde.</p>'),",
    "  (11, 'Comunidad Sierra Alta — Ñandú', 'es', 'Perú', '2020-01-02 00:00:00', '2024-01-02 00:00:00', true, false, 'sierra_alta', '<p>Relatos de la Sierra Alta.</p>'),",
    "  (12, 'Община Северная Река', NULL, 'Mongolia', '2020-01-03 00:00:00', '2024-01-03 00:00:00', false, false, NULL, NULL);",
    '',
    'INSERT INTO places(id, name, type_of_place, created_at, updated_at, lat, long, region, description, community_id) VALUES',
    "  (50, 'Aldeia Rio Verde', 'village', '2020-02-01 00:00:00', '2024-02-01 00:00:00', -1.455800, -48.490200, 'Pará', 'Mapped place description', 10),",
    "  (51, 'Local Sagrado', 'sacred site', '2020-02-02 00:00:00', '2024-02-02 00:00:00', NULL, NULL, NULL, 'Coordinates intentionally unknown', 10),",
    "  (52, 'Marco Norte', 'boundary north-west', '2020-02-03 00:00:00', '2024-02-03 00:00:00', 89.999999, -179.999999, 'Extremo Norte', 'Boundary 6-dp coordinates', 10),",
    "  (53, 'Cumbre Sur', 'boundary south-east', '2020-02-04 00:00:00', '2024-02-04 00:00:00', -89.999999, 179.999999, 'Sierra Alta', 'Private community boundary place', 11);",
    '',
    'INSERT INTO speakers(id, name, created_at, updated_at, birthdate, birthplace_id, speaker_community, community_id) VALUES',
    "  (40, 'Maria da Silva', '2020-03-01 00:00:00', '2024-03-01 00:00:00', '1950-06-15 00:00:00', 50, 'Comunidade Vizinha', 10),",
    "  (41, 'João Pereira', '2020-03-02 00:00:00', '2024-03-02 00:00:00', '1948-12-31 23:59:59', NULL, NULL, 10),",
    "  (42, 'Elena Quispe', '2020-03-03 00:00:00', '2024-03-03 00:00:00', '1960-01-01 00:00:01', 53, 'Comunidad Sierra Alta', 11);",
    '',
    'INSERT INTO users(',
    '  id, email, encrypted_password, reset_password_token, reset_password_sent_at,',
    '  remember_created_at, sign_in_count, current_sign_in_at, last_sign_in_at,',
    '  current_sign_in_ip, last_sign_in_ip, created_at, updated_at, role,',
    '  community_id, super_admin, username, name',
    ') VALUES',
    `  (20, 'viewer@example.org', ${sqlString(hashViewer)}, NULL, NULL, NULL, 1, '2024-01-05 12:00:00', NULL, '127.0.0.1', NULL, '2020-04-01 00:00:00', '2024-04-01 00:00:00', 3, 10, false, 'viewer_rio', 'Viewer Rio'),`,
    `  (21, 'shared@example.org', ${sqlString(hashMember)}, NULL, NULL, NULL, 2, '2024-01-06 12:00:00', '2024-01-05 12:00:00', '127.0.0.2', '127.0.0.1', '2020-04-02 00:00:00', '2024-04-02 00:00:00', 0, 10, false, 'member_rio', NULL),`,
    `  (22, 'editor@example.org', ${sqlString(hashEditor)}, 'fixture-reset-token-placeholder', '2024-01-07 12:00:00', NULL, 3, NULL, NULL, NULL, NULL, '2020-04-03 00:00:00', '2024-04-03 00:00:00', 1, 10, false, 'editor_rio', 'Editor Rio'),`,
    `  (23, 'admin@example.org', ${sqlString(hashAdmin)}, NULL, NULL, '2024-01-08 12:00:00', 4, NULL, NULL, NULL, NULL, '2020-04-04 00:00:00', '2024-04-04 00:00:00', 2, 10, false, 'admin_rio', 'Admin Rio'),`,
    `  (24, 'super@example.org', ${sqlString(hashSuper)}, NULL, NULL, NULL, 5, NULL, NULL, NULL, NULL, '2020-04-05 00:00:00', '2024-04-05 00:00:00', 100, NULL, true, 'superadmin', 'System Admin'),`,
    `  (25, 'shared@example.org', ${sqlString(hashMemberSierra)}, NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL, '2020-04-06 00:00:00', '2024-04-06 00:00:00', 0, 11, false, 'member_sierra', 'Miembro Sierra');`,
    '',
    'INSERT INTO stories(',
    '  id, title, "desc", created_at, updated_at, permission_level, date_interviewed,',
    '  language, interview_location_id, interviewer_id, community_id, topic',
    ') VALUES',
    "  (30, 'Public Story', '<p>Public story description</p>', '2020-05-01 00:00:00', '2024-05-01 00:00:00', 0, '2019-01-01 00:00:00', 'Portuguese', 50, 40, 10, 'history'),",
    "  (31, 'Community Story', '<p>Community-only story</p>', '2020-05-02 00:00:00', '2024-05-02 00:00:00', 1, NULL, 'Portuguese', NULL, NULL, 10, ''),",
    "  (32, 'Editors Story', '<p>Editors-only story</p>', '2020-05-03 00:00:00', '2024-05-03 00:00:00', 2, NULL, NULL, NULL, NULL, 10, NULL),",
    "  (34, 'Sierra Public Story', '<p>Public story inside private community</p>', '2020-05-04 00:00:00', '2024-05-04 00:00:00', 0, '2021-07-10 00:00:00', 'Spanish', 53, 42, 11, 'agua');",
    '',
    'INSERT INTO places_stories(id, story_id, place_id) VALUES',
    '  (1, 30, 50),',
    '  (2, 31, 51),',
    '  (3, 32, 50),',
    '  (5, 34, 53);',
    '',
    'INSERT INTO speaker_stories(id, speaker_id, story_id) VALUES',
    '  (1, 40, 30),',
    '  (2, 41, 31),',
    '  (3, 40, 32),',
    '  (4, 42, 34);',
    '',
    'INSERT INTO media(id, story_id, created_at, updated_at) VALUES',
    "  (70, 30, '2020-06-01 00:00:00', '2024-06-01 00:00:00'),",
    "  (71, 34, '2020-06-02 00:00:00', '2024-06-02 00:00:00');",
    '',
    'INSERT INTO media_links(id, url, story_id, created_at, updated_at)',
    "VALUES (80, 'https://example.org/external-media', 30, '2020-06-02 00:00:00', '2024-06-02 00:00:00');",
    '',
    'INSERT INTO themes(',
    '  id, active, created_at, updated_at, mapbox_style_url, mapbox_access_token,',
    '  center_lat, center_long, sw_boundary_lat, sw_boundary_long,',
    '  ne_boundary_lat, ne_boundary_long, zoom, pitch, bearing, mapbox_3d,',
    '  map_projection, community_id, protomaps_api_key, protomaps_basemap_style',
    ') VALUES (',
    "  60, true, '2020-07-01 00:00:00', '2024-07-01 00:00:00', 'mapbox://styles/example', 'legacy-map-token',",
    '  -1.455800, -48.490200, -2.000000, -49.000000,',
    '  -1.000000, -48.000000, 8.500000, 15.000000, 30.000000, true,',
    '  7, 10, \'legacy-protomaps-key\', \'{"theme":"light"}\'',
    ');',
    '',
    'INSERT INTO curriculums(id, title, description, user_id, created_at, updated_at)',
    "VALUES (90, 'Historical Curriculum', 'Must be archived even if not a V2 runtime feature', 22, '2020-08-01 00:00:00', '2024-08-01 00:00:00');",
    'INSERT INTO curriculum_stories(id, curriculum_id, story_id, created_at, updated_at, display_order)',
    "VALUES (91, 90, 30, '2020-08-02 00:00:00', '2024-08-02 00:00:00', 2);",
    '',
    'INSERT INTO flipper_features(id, key, description, created_at, updated_at) VALUES',
    "  (95, 'public_communities', 'Canonical publication visibility gate', '2020-09-01 00:00:00', '2024-09-01 00:00:00'),",
    "  (96, 'split_settings', 'Canonical community settings gate', '2020-09-01 00:00:00', '2024-09-01 00:00:00'),",
    "  (97, 'custom_pilot_flag', 'Custom feature flag requiring explicit disposition', '2020-09-01 00:00:00', '2024-09-01 00:00:00');",
    'INSERT INTO flipper_gates(id, feature_key, key, value, created_at, updated_at) VALUES',
    "  (95, 'public_communities', 'boolean', 'true', '2020-09-01 00:00:00', '2024-09-01 00:00:00'),",
    "  (96, 'split_settings', 'boolean', 'true', '2020-09-01 00:00:00', '2024-09-01 00:00:00'),",
    "  (97, 'custom_pilot_flag', 'boolean', 'true', '2020-09-01 00:00:00', '2024-09-01 00:00:00');",
    '',
    'INSERT INTO active_storage_blobs(',
    '  id, key, filename, content_type, metadata, byte_size, checksum, created_at, service_name',
    ') VALUES',
    `${[...FIXTURE_BLOBS.slice(0, 10), FIXTURE_BLOBS[14]!].map(blobInsertRow).join(',\n')};`,
    '',
    'INSERT INTO active_storage_attachments(id, name, record_type, record_id, blob_id, created_at) VALUES',
    "  (101, 'media', 'Media', 70, 100, '2020-10-02 00:00:00'),",
    "  (102, 'photo', 'Place', 50, 101, '2020-10-02 00:00:00'),",
    "  (103, 'name_audio', 'Place', 50, 102, '2020-10-02 00:00:00'),",
    "  (104, 'photo', 'Speaker', 40, 103, '2020-10-02 00:00:00'),",
    "  (105, 'photo', 'User', 22, 104, '2020-10-02 00:00:00'),",
    "  (106, 'display_image', 'Community', 10, 105, '2020-10-02 00:00:00'),",
    "  (107, 'background_img', 'Community', 10, 106, '2020-10-02 00:00:00'),",
    "  (108, 'sponsor_logos', 'Community', 10, 107, '2020-10-02 00:00:00'),",
    "  (109, 'sponsor_logos', 'Community', 10, 108, '2020-10-02 00:00:00'),",
    "  (110, 'sponsor_logos', 'Community', 10, 109, '2020-10-02 00:00:00'),",
    "  (115, 'display_image', 'Community', 11, 114, '2020-10-02 00:00:00');",
    '',
    'COMMIT;',
    '',
  ].join('\n');

  const edgeDataSql = [
    '-- Generated by scripts/fixtures/gen-rails-fixture.ts. Do not hand-edit.',
    'BEGIN;',
    '',
    '-- Edge users: blank username, null email, same-community case collision,',
    '-- cross-kind collision, contradictory role/super_admin pairs, empty and',
    '-- malformed bcrypt hashes.',
    'INSERT INTO users(',
    '  id, email, encrypted_password, reset_password_token, reset_password_sent_at,',
    '  remember_created_at, sign_in_count, current_sign_in_at, last_sign_in_at,',
    '  current_sign_in_ip, last_sign_in_ip, created_at, updated_at, role,',
    '  community_id, super_admin, username, name',
    ') VALUES',
    `  (26, 'blankuser@example.org', '', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, '2020-04-07 00:00:00', '2024-04-07 00:00:00', 0, 10, false, '', 'Blank Username User'),`,
    `  (27, NULL, ${sqlString(hashNullEmail)}, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, '2020-04-08 00:00:00', '2024-04-08 00:00:00', 3, 10, false, 'nullemail_user', 'Null Email User'),`,
    `  (28, 'VIEWER@EXAMPLE.ORG', ${sqlString(hashDupCase)}, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, '2020-04-09 00:00:00', '2024-04-09 00:00:00', 3, 10, false, 'viewer_dup_case', 'Case Collision User'),`,
    `  (29, 'crosskind@example.org', ${sqlString(hashCrossKind)}, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, '2020-04-10 00:00:00', '2024-04-10 00:00:00', 0, 10, false, 'editor@example.org', 'Cross-Kind User'),`,
    `  (201, 'contra_admin@example.org', ${sqlString(hashTruncated)}, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, '2020-04-11 00:00:00', '2024-04-11 00:00:00', 2, 10, true, 'contra_admin', 'Contradictory Super Flag'),`,
    `  (202, 'contra_super@example.org', ${sqlString(hashBadPrefix)}, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, '2020-04-12 00:00:00', '2024-04-12 00:00:00', 100, NULL, false, 'contra_super', 'Contradictory Non-Super Flag'),`,
    `  (203, 'cost15@example.org', ${sqlString(hashCost15)}, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, '2020-04-13 00:00:00', '2024-04-13 00:00:00', 0, 11, false, 'cost15_user', 'Cost 15 User');`,
    '',
    '-- Edge story: NULL permission_level and cross-community interviewer_id.',
    'INSERT INTO stories(',
    '  id, title, "desc", created_at, updated_at, permission_level, date_interviewed,',
    '  language, interview_location_id, interviewer_id, community_id, topic',
    ') VALUES',
    "  (33, 'Unclassified Story', '<p>Null permission and cross-community interviewer</p>', '2020-05-05 00:00:00', '2024-05-05 00:00:00', NULL, NULL, 'Portuguese', 50, 42, 10, 'territory');",
    '',
    '-- Duplicate places_stories edge (multiplicity preserved).',
    'INSERT INTO places_stories(id, story_id, place_id) VALUES',
    '  (4, 30, 50);',
    '',
    '-- media_links row with NULL url.',
    'INSERT INTO media_links(id, url, story_id, created_at, updated_at) VALUES',
    "  (81, NULL, 30, '2020-06-03 00:00:00', '2024-06-03 00:00:00');",
    '',
    '-- Edge ActiveStorage blobs: Theme static_map, cross-community shared blob,',
    '-- unattached orphan blob, variant record + variant image blob, and',
    '-- preview_image blob derived from an ActiveStorage::Blob.',
    'INSERT INTO active_storage_blobs(',
    '  id, key, filename, content_type, metadata, byte_size, checksum, created_at, service_name',
    ') VALUES',
    `${[...FIXTURE_BLOBS.slice(10, 14), FIXTURE_BLOBS[15]!].map(blobInsertRow).join(',\n')};`,
    '',
    'INSERT INTO active_storage_variant_records(id, blob_id, variation_digest) VALUES',
    "  (120, 101, 'variant-digest-place-thumb');",
    '',
    'INSERT INTO active_storage_attachments(id, name, record_type, record_id, blob_id, created_at) VALUES',
    "  (111, 'static_map', 'Theme', 60, 110, '2020-10-02 00:00:00'),",
    "  (112, 'photo', 'Place', 52, 111, '2020-10-02 00:00:00'),",
    "  (113, 'media', 'Media', 71, 111, '2020-10-02 00:00:00'),",
    "  (114, 'image', 'ActiveStorage::VariantRecord', 120, 113, '2020-10-02 00:00:00'),",
    "  (116, 'preview_image', 'ActiveStorage::Blob', 100, 115, '2020-10-02 00:00:00');",
    '',
    '-- Custom deployment table (must be captured dynamically).',
    'CREATE TABLE community_notes (',
    '  id bigint PRIMARY KEY,',
    '  community_id integer NOT NULL,',
    '  note text NOT NULL,',
    '  created_at timestamp without time zone NOT NULL',
    ');',
    'INSERT INTO community_notes(id, community_id, note, created_at) VALUES',
    "  (1, 10, 'Custom table community note payload', '2024-02-15 10:00:00');",
    '',
    '-- Wide extension table exceeding one jsonb_build_object chunk.',
    'CREATE TABLE community_extension_wide (',
    '  id bigint PRIMARY KEY,',
    '  c01 text, c02 text, c03 text, c04 text, c05 text,',
    '  c06 text, c07 text, c08 text, c09 text, c10 text,',
    '  c11 text, c12 text, c13 text, c14 text, c15 text,',
    '  c16 text, c17 text, c18 text, c19 text, c20 text,',
    '  c21 text, c22 text, c23 text, c24 text, c25 text,',
    '  c26 text, c27 text, c28 text, c29 text, c30 text,',
    '  c31 text, c32 text, c33 text, c34 text, c35 text,',
    '  c36 text, c37 text, c38 text, c39 text, c40 text,',
    '  c41 text, c42 text, c43 text, c44 text, c45 text,',
    '  c46 text, c47 text, c48 text, c49 text, c50 text,',
    '  c51 text, c52 text, c53 text, c54 text, c55 text',
    ');',
    '',
    'INSERT INTO community_extension_wide VALUES (',
    '  1,',
    "  '01','02','03','04','05','06','07','08','09','10',",
    "  '11','12','13','14','15','16','17','18','19','20',",
    "  '21','22','23','24','25','26','27','28','29','30',",
    "  '31','32','33','34','35','36','37','38','39','40',",
    "  '41','42','43','44','45','46','47','48','49','50',",
    "  '51','52','53','54','55'",
    ');',
    '',
    'COMMIT;',
    '',
  ].join('\n');

  writeFileSync(join(fixtureRoot, 'data.sql'), dataSql, 'utf8');
  writeFileSync(join(fixtureRoot, 'edge-data.sql'), edgeDataSql, 'utf8');
  process.stdout.write(
    `Generated ${FIXTURE_BLOBS.length} DiskService blobs, data.sql, and edge-data.sql under tests/fixtures/rails\n`
  );
}

generateFixtures();
