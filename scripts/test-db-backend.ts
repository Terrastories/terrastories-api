/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { portableMigrationFixture as fixture } from '../tests/fixtures/db/portable-migration-fixture.js';

const rootDir = process.cwd();
const sqliteMigrations = path.join(rootDir, 'src/db/migrations');
const postgresMigrations = path.join(sqliteMigrations, 'postgres');
const backend = process.argv[2];

process.env.NODE_ENV = 'test';

type Dialect = 'sqlite' | 'postgresql';
type PostgresClient = ReturnType<typeof postgres>;

function splitStatements(source: string): string[] {
  return source
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function validateMigrationText(
  dialect: Dialect,
  source: string,
  label: string
): void {
  const forbidden =
    dialect === 'sqlite'
      ? /\bserial\b|\bjsonb\b|::|DO\s+\$|gen_random_uuid\(|CREATE\s+EXTENSION|\bST_[A-Za-z_]+/i
      : /`|AUTOINCREMENT|\bPRAGMA\b|CREATE\s+EXTENSION|\bST_[A-Za-z_]+/i;

  assert.doesNotMatch(
    source,
    forbidden,
    `${label} contains SQL that belongs to the other backend or requires a spatial extension`
  );
}

async function verifyStaticPortabilityContract(): Promise<void> {
  for (const file of [
    '0000_glamorous_guardsmen.sql',
    '0001_authentication_fields.sql',
    '0002_community_rails_fields.sql',
    '0003_file_indexes.sql',
  ]) {
    validateMigrationText(
      'sqlite',
      await readFile(path.join(sqliteMigrations, file), 'utf8'),
      file
    );
  }

  for (const file of [
    '0000_current_compat_baseline.sql',
    '0001_theme_ownership_fk.sql',
  ]) {
    validateMigrationText(
      'postgresql',
      await readFile(path.join(postgresMigrations, file), 'utf8'),
      file
    );
  }

  for (const file of [
    'src/db/index.ts',
    'src/db/schema/places.ts',
    'src/repositories/place.repository.ts',
  ]) {
    const source = await readFile(path.join(rootDir, file), 'utf8');
    assert.doesNotMatch(
      source,
      /PostGIS_Version|mod_spatialite|ST_DWithin|ST_Distance|ST_SetSRID|ST_MakePoint/,
      `${file} must keep V2 spatial semantics application-level`
    );
  }

  assert.throws(() =>
    validateMigrationText('sqlite', 'CREATE TABLE x (id serial);', 'probe')
  );
  assert.throws(() =>
    validateMigrationText(
      'postgresql',
      'CREATE TABLE `x` (`id` integer PRIMARY KEY AUTOINCREMENT);',
      'probe'
    )
  );
}

async function createTemporaryMigrationFolder(
  dialect: Dialect,
  tag: string,
  source: string,
  when: number
): Promise<string> {
  const folder = await mkdtemp(
    path.join(os.tmpdir(), 'terrastories-migration-')
  );
  await mkdir(path.join(folder, 'meta'));
  await writeFile(
    path.join(folder, 'meta', '_journal.json'),
    JSON.stringify(
      {
        version: '7',
        dialect,
        entries: [
          {
            idx: 0,
            version: dialect === 'sqlite' ? '6' : '7',
            when,
            tag,
            breakpoints: true,
          },
        ],
      },
      null,
      2
    )
  );
  await writeFile(path.join(folder, `${tag}.sql`), source);
  return folder;
}

async function createSqlitePreviousReleaseFolder(): Promise<string> {
  const folder = await mkdtemp(
    path.join(os.tmpdir(), 'terrastories-sqlite-v1-')
  );
  await mkdir(path.join(folder, 'meta'));
  await copyFile(
    path.join(sqliteMigrations, '0000_glamorous_guardsmen.sql'),
    path.join(folder, '0000_glamorous_guardsmen.sql')
  );
  await writeFile(
    path.join(folder, 'meta', '_journal.json'),
    JSON.stringify(
      {
        version: '7',
        dialect: 'sqlite',
        entries: [
          {
            idx: 0,
            version: '6',
            when: 1758134617085,
            tag: '0000_glamorous_guardsmen',
            breakpoints: true,
          },
        ],
      },
      null,
      2
    )
  );
  return folder;
}

function timestamp(value: string): number {
  return new Date(value).getTime();
}

function seedPreviousReleaseSqlite(sqlite: Database.Database): void {
  const c = fixture.community;
  sqlite
    .prepare(
      `INSERT INTO communities
       (id, name, description, slug, public_stories, locale, cultural_settings, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      c.id,
      c.name,
      c.description,
      c.slug,
      Number(c.publicStories),
      c.locale,
      c.culturalSettings,
      Number(c.isActive),
      timestamp(c.createdAt),
      timestamp(c.updatedAt)
    );

  const u = fixture.user;
  sqlite
    .prepare(
      `INSERT INTO users
       (id, email, password_hash, first_name, last_name, role, community_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      u.id,
      u.email,
      u.passwordHash,
      u.firstName,
      u.lastName,
      u.role,
      u.communityId,
      Number(u.isActive),
      timestamp(u.createdAt),
      timestamp(u.updatedAt)
    );

  const insertPlace = sqlite.prepare(
    `INSERT INTO places
     (id, name, description, community_id, latitude, longitude, region, media_urls, photo_url,
      cultural_significance, is_restricted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const place of fixture.places) {
    insertPlace.run(
      place.id,
      place.name,
      place.description,
      c.id,
      place.latitude,
      place.longitude,
      place.region,
      JSON.stringify(place.mediaUrls),
      place.photoUrl,
      place.culturalSignificance,
      Number(place.isRestricted),
      timestamp('2024-02-01T10:00:00.000Z'),
      timestamp('2025-06-01T10:00:00.000Z')
    );
  }

  const speaker = fixture.speaker;
  sqlite
    .prepare(
      `INSERT INTO speakers
       (id, name, bio, community_id, photo_url, bio_audio_url, birth_year, elder_status,
        cultural_role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      speaker.id,
      speaker.name,
      speaker.bio,
      speaker.communityId,
      speaker.photoUrl,
      speaker.bioAudioUrl,
      speaker.birthYear,
      Number(speaker.elderStatus),
      speaker.culturalRole,
      Number(speaker.isActive),
      timestamp('2024-03-01T10:00:00.000Z'),
      timestamp('2025-06-04T10:00:00.000Z')
    );

  const story = fixture.story;
  sqlite
    .prepare(
      `INSERT INTO stories
       (id, title, description, slug, community_id, created_by, is_restricted, privacy_level,
        media_urls, image_url, audio_url, language, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      story.id,
      story.title,
      story.description,
      story.slug,
      story.communityId,
      story.createdBy,
      Number(story.isRestricted),
      story.privacyLevel,
      JSON.stringify(story.mediaUrls),
      story.imageUrl,
      story.audioUrl,
      story.language,
      JSON.stringify(story.tags),
      timestamp('2024-04-01T10:00:00.000Z'),
      timestamp('2025-06-05T10:00:00.000Z')
    );

  const file = fixture.file;
  sqlite
    .prepare(
      `INSERT INTO files
       (id, filename, original_name, path, url, mime_type, size, community_id, uploaded_by,
        metadata, cultural_restrictions, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      file.id,
      file.filename,
      file.originalName,
      file.path,
      file.url,
      file.mimeType,
      file.size,
      file.communityId,
      file.uploadedBy,
      JSON.stringify(file.metadata),
      JSON.stringify(file.culturalRestrictions),
      Number(file.isActive),
      timestamp('2024-04-02T10:00:00.000Z'),
      timestamp('2025-06-06T10:00:00.000Z')
    );

  sqlite
    .prepare(
      `INSERT INTO story_places
       (id, story_id, place_id, cultural_context, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fixture.storyPlace.id,
      fixture.storyPlace.storyId,
      fixture.storyPlace.placeId,
      'restricted-context',
      0,
      timestamp('2024-04-03T10:00:00.000Z'),
      timestamp('2025-06-07T10:00:00.000Z')
    );

  sqlite
    .prepare(
      `INSERT INTO story_speakers
       (id, story_id, speaker_id, story_role, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fixture.storySpeaker.id,
      fixture.storySpeaker.storyId,
      fixture.storySpeaker.speakerId,
      'narrator',
      0,
      timestamp('2024-04-04T10:00:00.000Z'),
      timestamp('2025-06-08T10:00:00.000Z')
    );
}

async function executePostgresFixture(client: PostgresClient): Promise<void> {
  const source = await readFile(
    path.join(rootDir, 'tests/fixtures/db/postgres-previous-release.sql'),
    'utf8'
  );
  for (const statement of splitStatements(source)) {
    await client.unsafe(statement);
  }
}

async function seedPreviousReleasePostgres(
  client: PostgresClient
): Promise<void> {
  const c = fixture.community;
  await client`
    INSERT INTO communities
      (id, name, description, slug, public_stories, locale, cultural_settings, is_active, created_at, updated_at)
    VALUES
      (${c.id}, ${c.name}, ${c.description}, ${c.slug}, ${c.publicStories}, ${c.locale},
       ${c.culturalSettings}, ${c.isActive}, ${c.createdAt}, ${c.updatedAt})
  `;

  const u = fixture.user;
  await client`
    INSERT INTO users
      (id, email, password_hash, first_name, last_name, role, community_id, is_active, created_at, updated_at)
    VALUES
      (${u.id}, ${u.email}, ${u.passwordHash}, ${u.firstName}, ${u.lastName}, ${u.role},
       ${u.communityId}, ${u.isActive}, ${u.createdAt}, ${u.updatedAt})
  `;

  for (const place of fixture.places) {
    await client`
      INSERT INTO places
        (id, name, description, community_id, latitude, longitude, region, media_urls, photo_url,
         cultural_significance, is_restricted, created_at, updated_at)
      VALUES
        (${place.id}, ${place.name}, ${place.description}, ${c.id}, ${place.latitude}, ${place.longitude},
         ${place.region}, ${JSON.stringify(place.mediaUrls)}, ${place.photoUrl}, ${place.culturalSignificance},
         ${place.isRestricted}, ${'2024-02-01T10:00:00.000Z'},
         ${'2025-06-01T10:00:00.000Z'})
    `;
  }

  const speaker = fixture.speaker;
  await client`
    INSERT INTO speakers
      (id, name, bio, community_id, photo_url, bio_audio_url, birth_year, elder_status,
       cultural_role, is_active, created_at, updated_at)
    VALUES
      (${speaker.id}, ${speaker.name}, ${speaker.bio}, ${speaker.communityId}, ${speaker.photoUrl},
       ${speaker.bioAudioUrl}, ${speaker.birthYear}, ${speaker.elderStatus}, ${speaker.culturalRole},
       ${speaker.isActive}, ${'2024-03-01T10:00:00.000Z'},
       ${'2025-06-04T10:00:00.000Z'})
  `;

  const story = fixture.story;
  await client`
    INSERT INTO stories
      (id, title, description, slug, community_id, created_by, is_restricted, privacy_level,
       media_urls, image_url, audio_url, language, tags, created_at, updated_at)
    VALUES
      (${story.id}, ${story.title}, ${story.description}, ${story.slug}, ${story.communityId},
       ${story.createdBy}, ${story.isRestricted}, ${story.privacyLevel}, ${JSON.stringify(story.mediaUrls)},
       ${story.imageUrl}, ${story.audioUrl}, ${story.language}, ${JSON.stringify(story.tags)},
       ${'2024-04-01T10:00:00.000Z'}, ${'2025-06-05T10:00:00.000Z'})
  `;

  const file = fixture.file;
  await client`
    INSERT INTO files
      (id, filename, original_name, path, url, mime_type, size, community_id, uploaded_by,
       metadata, cultural_restrictions, is_active, created_at, updated_at)
    VALUES
      (${file.id}, ${file.filename}, ${file.originalName}, ${file.path}, ${file.url}, ${file.mimeType},
       ${file.size}, ${file.communityId}, ${file.uploadedBy}, ${JSON.stringify(file.metadata)},
       ${JSON.stringify(file.culturalRestrictions)}, ${file.isActive},
       ${'2024-04-02T10:00:00.000Z'}, ${'2025-06-06T10:00:00.000Z'})
  `;

  await client`
    INSERT INTO story_places
      (id, story_id, place_id, cultural_context, sort_order, created_at, updated_at)
    VALUES
      (${fixture.storyPlace.id}, ${fixture.storyPlace.storyId}, ${fixture.storyPlace.placeId},
       'restricted-context', 0, ${'2024-04-03T10:00:00.000Z'},
       ${'2025-06-07T10:00:00.000Z'})
  `;
  await client`
    INSERT INTO story_speakers
      (id, story_id, speaker_id, story_role, sort_order, created_at, updated_at)
    VALUES
      (${fixture.storySpeaker.id}, ${fixture.storySpeaker.storyId}, ${fixture.storySpeaker.speakerId},
       'narrator', 0, ${'2024-04-04T10:00:00.000Z'},
       ${'2025-06-08T10:00:00.000Z'})
  `;
}

function columnNames(rows: any[]): Set<string> {
  return new Set(rows.map((row) => String(row.name ?? row.column_name)));
}

function verifySqliteSchema(sqlite: Database.Database): void {
  const communities = sqlite
    .prepare('PRAGMA table_info(communities)')
    .all() as any[];
  const users = sqlite.prepare('PRAGMA table_info(users)').all() as any[];
  const places = sqlite.prepare('PRAGMA table_info(places)').all() as any[];
  const communityColumns = columnNames(communities);
  const userColumns = columnNames(users);
  const placeColumns = columnNames(places);

  for (const column of ['country', 'beta'])
    assert.ok(communityColumns.has(column));
  for (const column of [
    'reset_password_token',
    'reset_password_sent_at',
    'remember_created_at',
    'sign_in_count',
    'last_sign_in_at',
    'current_sign_in_ip',
  ]) {
    assert.ok(userColumns.has(column), `missing users.${column}`);
  }
  assert.equal(placeColumns.has('location'), false);

  const fileIndexes = new Set(
    (sqlite.prepare('PRAGMA index_list(files)').all() as any[]).map((row) =>
      String(row.name)
    )
  );
  for (const indexName of [
    'files_community_idx',
    'files_user_idx',
    'files_mime_type_idx',
    'files_active_idx',
    'files_created_at_idx',
  ]) {
    assert.ok(fileIndexes.has(indexName), `missing SQLite index ${indexName}`);
  }

  const placeFks = sqlite
    .prepare('PRAGMA foreign_key_list(places)')
    .all() as any[];
  const userFks = sqlite
    .prepare('PRAGMA foreign_key_list(users)')
    .all() as any[];
  const themeFks = sqlite
    .prepare('PRAGMA foreign_key_list(themes)')
    .all() as any[];
  assert.ok(placeFks.some((row) => row.table === 'communities'));
  assert.ok(userFks.some((row) => row.table === 'communities'));
  assert.ok(themeFks.some((row) => row.table === 'communities'));
}

function verifySqlitePreservation(sqlite: Database.Database): void {
  const community = sqlite
    .prepare(
      'SELECT id, name, country, beta, created_at, updated_at FROM communities WHERE id = 1'
    )
    .get() as any;
  assert.equal(community.id, fixture.community.id);
  assert.equal(community.name, fixture.community.name);
  assert.equal(community.country, null);
  assert.equal(community.beta, 0);
  assert.equal(community.created_at, timestamp(fixture.community.createdAt));
  assert.equal(community.updated_at, timestamp(fixture.community.updatedAt));

  const user = sqlite
    .prepare(
      'SELECT id, email, community_id, reset_password_token, sign_in_count, created_at, updated_at FROM users WHERE id = 1'
    )
    .get() as any;
  assert.equal(user.id, fixture.user.id);
  assert.equal(user.email, fixture.user.email);
  assert.equal(user.community_id, fixture.user.communityId);
  assert.equal(user.reset_password_token, null);
  assert.equal(user.sign_in_count, 0);
  assert.equal(user.created_at, timestamp(fixture.user.createdAt));
  assert.equal(user.updated_at, timestamp(fixture.user.updatedAt));

  const place = sqlite
    .prepare(
      'SELECT id, community_id, latitude, longitude, media_urls, is_restricted FROM places WHERE id = 1'
    )
    .get() as any;
  assert.equal(place.id, fixture.places[0].id);
  assert.equal(place.community_id, fixture.community.id);
  assert.equal(place.latitude, fixture.places[0].latitude);
  assert.equal(place.longitude, fixture.places[0].longitude);
  assert.deepEqual(JSON.parse(place.media_urls), fixture.places[0].mediaUrls);
  assert.equal(place.is_restricted, 1);

  const story = sqlite
    .prepare(
      'SELECT id, community_id, created_by, is_restricted FROM stories WHERE id = 1'
    )
    .get() as any;
  assert.equal(story.id, fixture.story.id);
  assert.equal(story.community_id, fixture.story.communityId);
  assert.equal(story.created_by, fixture.story.createdBy);
  assert.equal(story.is_restricted, 1);

  const speaker = sqlite
    .prepare('SELECT id, community_id FROM speakers WHERE id = 1')
    .get() as any;
  assert.equal(speaker.id, fixture.speaker.id);
  assert.equal(speaker.community_id, fixture.speaker.communityId);

  const file = sqlite
    .prepare(
      'SELECT id, community_id, uploaded_by, metadata, is_active FROM files WHERE id = ?'
    )
    .get(fixture.file.id) as any;
  assert.equal(file.id, fixture.file.id);
  assert.equal(file.community_id, fixture.file.communityId);
  assert.equal(file.uploaded_by, fixture.file.uploadedBy);
  assert.deepEqual(JSON.parse(file.metadata), fixture.file.metadata);
  assert.equal(file.is_active, 1);

  const storyPlace = sqlite
    .prepare(
      'SELECT id, story_id, place_id, sort_order FROM story_places WHERE id = 1'
    )
    .get() as any;
  assert.deepEqual(storyPlace, {
    id: fixture.storyPlace.id,
    story_id: fixture.storyPlace.storyId,
    place_id: fixture.storyPlace.placeId,
    sort_order: 0,
  });

  const storySpeaker = sqlite
    .prepare(
      'SELECT id, story_id, speaker_id, story_role, sort_order FROM story_speakers WHERE id = 1'
    )
    .get() as any;
  assert.deepEqual(storySpeaker, {
    id: fixture.storySpeaker.id,
    story_id: fixture.storySpeaker.storyId,
    speaker_id: fixture.storySpeaker.speakerId,
    story_role: 'narrator',
    sort_order: 0,
  });
}

async function verifyPostgresSchema(client: PostgresClient): Promise<void> {
  const columns = await client.unsafe(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'`
  );
  const names = new Set(
    columns.map((row: any) => `${row.table_name}.${row.column_name}`)
  );
  for (const required of [
    'communities.country',
    'communities.beta',
    'users.reset_password_token',
    'users.reset_password_sent_at',
    'users.remember_created_at',
    'users.sign_in_count',
    'users.last_sign_in_at',
    'users.current_sign_in_ip',
  ]) {
    assert.ok(names.has(required), `missing ${required}`);
  }
  assert.equal(names.has('places.location'), false);

  const indexRows = await client.unsafe(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
  );
  const indexes = new Set(indexRows.map((row: any) => String(row.indexname)));
  for (const indexName of [
    'files_community_idx',
    'files_user_idx',
    'files_mime_type_idx',
    'files_active_idx',
    'files_created_at_idx',
  ]) {
    assert.ok(indexes.has(indexName), `missing PostgreSQL index ${indexName}`);
  }

  const constraintRows = await client.unsafe(
    `SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace`
  );
  const constraints = new Set(
    constraintRows.map((row: any) => String(row.conname))
  );
  for (const constraint of [
    'users_community_id_fkey',
    'places_community_id_fkey',
    'speakers_community_id_fkey',
    'stories_community_id_fkey',
    'files_community_id_fkey',
    'files_uploaded_by_fkey',
    'story_places_story_id_fkey',
    'story_places_place_id_fkey',
    'story_speakers_story_id_fkey',
    'story_speakers_speaker_id_fkey',
    'themes_community_id_fkey',
  ]) {
    assert.ok(
      constraints.has(constraint),
      `missing PostgreSQL FK ${constraint}`
    );
  }
}

async function verifyPostgresPreservation(
  client: PostgresClient
): Promise<void> {
  const [community] = await client.unsafe(
    'SELECT id, name, country, beta, created_at, updated_at FROM communities WHERE id = 1'
  );
  assert.equal(community.id, fixture.community.id);
  assert.equal(community.name, fixture.community.name);
  assert.equal(community.country, null);
  assert.equal(community.beta, false);
  assert.equal(
    new Date(community.created_at).getTime(),
    timestamp(fixture.community.createdAt)
  );
  assert.equal(
    new Date(community.updated_at).getTime(),
    timestamp(fixture.community.updatedAt)
  );

  const [user] = await client.unsafe(
    'SELECT id, email, community_id, reset_password_token, sign_in_count, created_at, updated_at FROM users WHERE id = 1'
  );
  assert.equal(user.id, fixture.user.id);
  assert.equal(user.email, fixture.user.email);
  assert.equal(user.community_id, fixture.user.communityId);
  assert.equal(user.reset_password_token, null);
  assert.equal(user.sign_in_count, 0);
  assert.equal(
    new Date(user.created_at).getTime(),
    timestamp(fixture.user.createdAt)
  );
  assert.equal(
    new Date(user.updated_at).getTime(),
    timestamp(fixture.user.updatedAt)
  );

  const [place] = await client.unsafe(
    'SELECT id, community_id, latitude, longitude, media_urls, is_restricted FROM places WHERE id = 1'
  );
  assert.equal(place.id, fixture.places[0].id);
  assert.equal(place.community_id, fixture.community.id);
  assert.equal(place.latitude, fixture.places[0].latitude);
  assert.equal(place.longitude, fixture.places[0].longitude);
  assert.deepEqual(place.media_urls, fixture.places[0].mediaUrls);
  assert.equal(place.is_restricted, true);

  const [story] = await client.unsafe(
    'SELECT id, community_id, created_by, is_restricted FROM stories WHERE id = 1'
  );
  assert.equal(story.id, fixture.story.id);
  assert.equal(story.community_id, fixture.story.communityId);
  assert.equal(story.created_by, fixture.story.createdBy);
  assert.equal(story.is_restricted, true);

  const [speaker] = await client.unsafe(
    'SELECT id, community_id FROM speakers WHERE id = 1'
  );
  assert.equal(speaker.id, fixture.speaker.id);
  assert.equal(speaker.community_id, fixture.speaker.communityId);

  const [file] = await client.unsafe(
    `SELECT id, community_id, uploaded_by, metadata, is_active FROM files WHERE id = '${fixture.file.id}'`
  );
  assert.equal(file.id, fixture.file.id);
  assert.equal(file.community_id, fixture.file.communityId);
  assert.equal(file.uploaded_by, fixture.file.uploadedBy);
  assert.deepEqual(file.metadata, fixture.file.metadata);
  assert.equal(file.is_active, true);

  const [storyPlace] = await client.unsafe(
    'SELECT id, story_id, place_id, sort_order FROM story_places WHERE id = 1'
  );
  assert.deepEqual(
    {
      id: storyPlace.id,
      story_id: storyPlace.story_id,
      place_id: storyPlace.place_id,
      sort_order: storyPlace.sort_order,
    },
    {
      id: fixture.storyPlace.id,
      story_id: fixture.storyPlace.storyId,
      place_id: fixture.storyPlace.placeId,
      sort_order: 0,
    }
  );

  const [storySpeaker] = await client.unsafe(
    'SELECT id, story_id, speaker_id, story_role, sort_order FROM story_speakers WHERE id = 1'
  );
  assert.deepEqual(
    {
      id: storySpeaker.id,
      story_id: storySpeaker.story_id,
      speaker_id: storySpeaker.speaker_id,
      story_role: storySpeaker.story_role,
      sort_order: storySpeaker.sort_order,
    },
    {
      id: fixture.storySpeaker.id,
      story_id: fixture.storySpeaker.storyId,
      speaker_id: fixture.storySpeaker.speakerId,
      story_role: 'narrator',
      sort_order: 0,
    }
  );
}

async function runRepositoryContract(database: unknown): Promise<void> {
  const { CommunityRepository } = await import(
    '../src/repositories/community.repository.js'
  );
  const { PlaceRepository } = await import(
    '../src/repositories/place.repository.js'
  );

  const communities = new CommunityRepository(database as any);
  const places = new PlaceRepository(database as any);

  const community = await communities.create({
    name: 'Repository Contract Community',
    country: 'BR',
    beta: true,
  });
  assert.equal(community.country, 'BR');
  assert.equal(community.beta, true);
  assert.ok(community.createdAt instanceof Date);

  await assert.rejects(
    communities.create({
      name: 'Duplicate Slug Community',
      slug: community.slug,
    }),
    /slug already exists/i
  );

  const first = await places.create({
    name: 'A Nearby Public',
    communityId: community.id,
    latitude: -1.4558,
    longitude: -48.4902,
    mediaUrls: ['https://example.test/nearby.jpg'],
    isRestricted: false,
  });
  const second = await places.create({
    name: 'B Nearby Restricted',
    communityId: community.id,
    latitude: -1.456,
    longitude: -48.4901,
    isRestricted: true,
  });
  await places.create({
    name: 'C Far Public',
    communityId: community.id,
    latitude: -3.119,
    longitude: -60.0217,
    isRestricted: false,
  });

  assert.deepEqual(first.mediaUrls, ['https://example.test/nearby.jpg']);
  assert.ok(first.createdAt instanceof Date);

  const publicNear = await places.searchNear({
    communityId: community.id,
    latitude: -1.4558,
    longitude: -48.4902,
    radiusKm: 1,
    page: 1,
    limit: 20,
  });
  assert.deepEqual(
    publicNear.data.map((place) => place.id),
    [first.id]
  );

  const allNear = await places.searchNear({
    communityId: community.id,
    latitude: -1.4558,
    longitude: -48.4902,
    radiusKm: 1,
    page: 1,
    limit: 20,
    includeRestricted: true,
  });
  assert.deepEqual(
    new Set(allNear.data.map((place) => place.id)),
    new Set([first.id, second.id])
  );

  const bounded = await places.searchInBounds({
    communityId: community.id,
    north: -1.45,
    south: -1.46,
    east: -48.48,
    west: -48.5,
    page: 1,
    limit: 20,
    includeRestricted: true,
  });
  assert.deepEqual(
    new Set(bounded.data.map((place) => place.id)),
    new Set([first.id, second.id])
  );

  const ordered = await places.getByCommunity(community.id, {
    page: 1,
    limit: 20,
    includeRestricted: true,
    sortBy: 'name',
    sortOrder: 'asc',
  });
  assert.deepEqual(
    ordered.data.map((place) => place.name),
    ['A Nearby Public', 'B Nearby Restricted', 'C Far Public']
  );

  const firstPage = await places.getByCommunity(community.id, {
    page: 1,
    limit: 2,
    includeRestricted: true,
    sortBy: 'name',
    sortOrder: 'asc',
  });
  const secondPage = await places.getByCommunity(community.id, {
    page: 2,
    limit: 2,
    includeRestricted: true,
    sortBy: 'name',
    sortOrder: 'asc',
  });
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.pages, 2);
  assert.deepEqual(
    firstPage.data.map((place) => place.name),
    ['A Nearby Public', 'B Nearby Restricted']
  );
  assert.deepEqual(
    secondPage.data.map((place) => place.name),
    ['C Far Public']
  );

  const countryResults = await communities.search({
    country: 'BR',
    beta: true,
  });
  assert.ok(countryResults.some((row) => row.id === community.id));

  const datelineCommunity = await communities.create({
    name: 'Dateline Radius Community',
  });
  const datelineEast = await places.create({
    name: 'Dateline East',
    communityId: datelineCommunity.id,
    latitude: 0,
    longitude: 179.9,
  });
  const datelineWest = await places.create({
    name: 'Dateline West',
    communityId: datelineCommunity.id,
    latitude: 0,
    longitude: -179.9,
  });
  await places.create({
    name: 'Dateline Far',
    communityId: datelineCommunity.id,
    latitude: 0,
    longitude: 170,
  });
  const datelineResults = await places.searchNear({
    communityId: datelineCommunity.id,
    latitude: 0,
    longitude: 179.95,
    radiusKm: 30,
    page: 1,
    limit: 10,
    includeRestricted: true,
  });
  assert.deepEqual(
    new Set(datelineResults.data.map((place) => place.id)),
    new Set([datelineEast.id, datelineWest.id])
  );

  const polarCommunity = await communities.create({
    name: 'Polar Radius Community',
  });
  const polarNear = await places.create({
    name: 'Polar Near',
    communityId: polarCommunity.id,
    latitude: 89.9,
    longitude: 120,
  });
  await places.create({
    name: 'Polar Far',
    communityId: polarCommunity.id,
    latitude: 88,
    longitude: 0,
  });
  const polarResults = await places.searchNear({
    communityId: polarCommunity.id,
    latitude: 89.9,
    longitude: 0,
    radiusKm: 30,
    page: 1,
    limit: 10,
    includeRestricted: true,
  });
  assert.deepEqual(
    polarResults.data.map((place) => place.id),
    [polarNear.id]
  );
}

function verifySqliteTransactionAndForeignKey(sqlite: Database.Database): void {
  const before = (
    sqlite.prepare('SELECT count(*) AS count FROM communities').get() as any
  ).count;
  const transaction = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO communities (name, slug, created_at, updated_at)
         VALUES ('Rollback Probe', 'rollback-probe', ?, ?)`
      )
      .run(Date.now(), Date.now());
    throw new Error('rollback probe');
  });
  assert.throws(transaction, /rollback probe/);
  const after = (
    sqlite.prepare('SELECT count(*) AS count FROM communities').get() as any
  ).count;
  assert.equal(after, before);

  assert.throws(() =>
    sqlite
      .prepare(
        `INSERT INTO users
         (email, password_hash, first_name, last_name, community_id, created_at, updated_at)
         VALUES ('orphan@example.test', 'hash', 'Orphan', 'User', 999999, ?, ?)`
      )
      .run(Date.now(), Date.now())
  );

  sqlite.exec('CREATE TEMP TABLE null_unique_probe (value TEXT UNIQUE)');
  const nullableProbe = sqlite.prepare(
    'INSERT INTO null_unique_probe (value) VALUES (?)'
  );
  nullableProbe.run(null);
  nullableProbe.run(null);
  nullableProbe.run('duplicate');
  assert.throws(() => nullableProbe.run('duplicate'));
  sqlite.exec('DROP TABLE null_unique_probe');
}

async function verifyPostgresTransactionAndForeignKey(
  client: PostgresClient
): Promise<void> {
  const [{ count: before }] = await client.unsafe(
    'SELECT count(*)::int AS count FROM communities'
  );
  await assert.rejects(
    client.begin(async (transaction) => {
      await transaction`
        INSERT INTO communities (name, slug)
        VALUES ('Rollback Probe', 'rollback-probe')
      `;
      throw new Error('rollback probe');
    }),
    /rollback probe/
  );
  const [{ count: after }] = await client.unsafe(
    'SELECT count(*)::int AS count FROM communities'
  );
  assert.equal(after, before);

  await assert.rejects(
    client`
      INSERT INTO users
        (email, password_hash, first_name, last_name, community_id)
      VALUES
        ('orphan@example.test', 'hash', 'Orphan', 'User', 999999)
    `
  );

  await client.unsafe('DROP TABLE IF EXISTS null_unique_probe');
  await client.unsafe('CREATE TABLE null_unique_probe (value text UNIQUE)');
  await client.unsafe(
    'INSERT INTO null_unique_probe (value) VALUES (NULL), (NULL)'
  );
  await client.unsafe(
    "INSERT INTO null_unique_probe (value) VALUES ('duplicate')"
  );
  await assert.rejects(
    client.unsafe("INSERT INTO null_unique_probe (value) VALUES ('duplicate')")
  );
  await client.unsafe('DROP TABLE IF EXISTS null_unique_probe');
}

async function verifySqliteFailedMigrationNotRecorded(): Promise<void> {
  const sqlite = new Database(':memory:');
  const database = drizzleSqlite(sqlite);
  const folder = await createTemporaryMigrationFolder(
    'sqlite',
    '0000_failure_probe',
    'ALTER TABLE missing_table ADD COLUMN broken integer;',
    1999999999000
  );
  let failed = false;
  try {
    await migrateSqlite(database, { migrationsFolder: folder });
  } catch {
    failed = true;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  assert.equal(failed, true, 'SQLite failure probe unexpectedly succeeded');
  const table = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'"
    )
    .get();
  if (table) {
    const count = (
      sqlite
        .prepare('SELECT count(*) AS count FROM __drizzle_migrations')
        .get() as any
    ).count;
    assert.equal(count, 0, 'failed SQLite migration was recorded as applied');
  }
  sqlite.close();
}

async function resetPostgres(client: PostgresClient): Promise<void> {
  await client.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await client.unsafe('CREATE SCHEMA public');
}

async function verifyPostgresFailedMigrationNotRecorded(
  client: PostgresClient
): Promise<void> {
  await resetPostgres(client);
  const database = drizzlePostgres(client);
  const folder = await createTemporaryMigrationFolder(
    'postgresql',
    '0000_failure_probe',
    'ALTER TABLE missing_table ADD COLUMN broken integer;',
    1999999999000
  );
  let failed = false;
  try {
    await migratePostgres(database, { migrationsFolder: folder });
  } catch {
    failed = true;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  assert.equal(failed, true, 'PostgreSQL failure probe unexpectedly succeeded');
  const [table] = await client.unsafe(
    "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS table_name"
  );
  if (table.table_name) {
    const [{ count }] = await client.unsafe(
      'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations'
    );
    assert.equal(
      count,
      0,
      'failed PostgreSQL migration was recorded as applied'
    );
  }
}

async function runSqliteGate(): Promise<void> {
  process.env.DATABASE_URL = './dual-backend-ci.db';
  console.log('🪶 SQLite/D1-compatible integration gate');
  await verifyStaticPortabilityContract();

  console.log('  1/4 fresh migration + shared repository contract');
  const freshSqlite = new Database(':memory:');
  freshSqlite.pragma('foreign_keys = ON');
  const freshDb = drizzleSqlite(freshSqlite);
  await migrateSqlite(freshDb, { migrationsFolder: sqliteMigrations });
  verifySqliteSchema(freshSqlite);
  await runRepositoryContract(freshDb);
  verifySqliteTransactionAndForeignKey(freshSqlite);
  await migrateSqlite(freshDb, { migrationsFolder: sqliteMigrations });
  freshSqlite.close();

  console.log('  2/4 previous-release upgrade + data preservation');
  const upgradeSqlite = new Database(':memory:');
  upgradeSqlite.pragma('foreign_keys = ON');
  const upgradeDb = drizzleSqlite(upgradeSqlite);
  const previousReleaseFolder = await createSqlitePreviousReleaseFolder();
  try {
    await migrateSqlite(upgradeDb, { migrationsFolder: previousReleaseFolder });
  } finally {
    await rm(previousReleaseFolder, { recursive: true, force: true });
  }
  seedPreviousReleaseSqlite(upgradeSqlite);
  await migrateSqlite(upgradeDb, { migrationsFolder: sqliteMigrations });
  verifySqliteSchema(upgradeSqlite);
  verifySqlitePreservation(upgradeSqlite);
  upgradeSqlite.close();

  console.log('  3/4 deliberate dialect incompatibility rejection');
  validateMigrationText(
    'sqlite',
    await readFile(
      path.join(sqliteMigrations, '0000_glamorous_guardsmen.sql'),
      'utf8'
    ),
    'SQLite baseline'
  );

  console.log('  4/4 failed migration recording guard');
  await verifySqliteFailedMigrationNotRecorded();
  console.log('✅ SQLite/D1-compatible integration gate passed');
}

async function runPostgresGate(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, 'DATABASE_URL is required for PostgreSQL integration');
  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.replace(/^\//, '')
  );
  const dedicatedTestDatabase = /^(?:test|[a-z0-9][a-z0-9_]*_test)$/i;
  assert.equal(dedicatedTestDatabase.test('latest'), false);
  assert.match(
    databaseName,
    dedicatedTestDatabase,
    `refusing destructive PostgreSQL gate against non-test database ${databaseName}`
  );
  assert.equal(
    process.env.ALLOW_POSTGRES_TEST_RESET,
    'true',
    'ALLOW_POSTGRES_TEST_RESET=true is required for the destructive PostgreSQL gate'
  );

  console.log('🐘 PostgreSQL integration gate');
  await verifyStaticPortabilityContract();
  const client = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
  try {
    console.log('  1/4 fresh migration + shared repository contract');
    await resetPostgres(client);
    const freshDb = drizzlePostgres(client);
    await migratePostgres(freshDb, { migrationsFolder: postgresMigrations });
    await verifyPostgresSchema(client);
    await runRepositoryContract(freshDb);
    await verifyPostgresTransactionAndForeignKey(client);
    await migratePostgres(freshDb, { migrationsFolder: postgresMigrations });

    console.log('  2/4 previous-release upgrade + data preservation');
    await resetPostgres(client);
    await executePostgresFixture(client);
    await seedPreviousReleasePostgres(client);
    const upgradeDb = drizzlePostgres(client);
    await migratePostgres(upgradeDb, { migrationsFolder: postgresMigrations });
    await verifyPostgresSchema(client);
    await verifyPostgresPreservation(client);

    console.log('  3/4 deliberate dialect incompatibility rejection');
    validateMigrationText(
      'postgresql',
      await readFile(
        path.join(postgresMigrations, '0000_current_compat_baseline.sql'),
        'utf8'
      ),
      'PostgreSQL baseline'
    );

    console.log('  4/4 failed migration recording guard');
    await verifyPostgresFailedMigrationNotRecorded(client);
    console.log('✅ PostgreSQL integration gate passed');
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  if (backend === 'sqlite') {
    await runSqliteGate();
    return;
  }
  if (backend === 'postgres') {
    await runPostgresGate();
    return;
  }
  throw new Error('Usage: tsx scripts/test-db-backend.ts <sqlite|postgres>');
}

main().catch((error) => {
  console.error('❌ dual-backend integration gate failed');
  console.error(error);
  process.exitCode = 1;
});
