/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import { eq } from 'drizzle-orm';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createPostgresClient } from '../src/db/index.js';
import {
  assertValidDate,
  runRepositoryContract,
} from './db-repository-contract.js';
import { portableMigrationFixture as fixture } from '../tests/fixtures/db/portable-migration-fixture.js';

const rootDir = process.cwd();
const { runHonoFoundationContract } = await import(
  './hono-foundation-contract.js'
);
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

/**
 * Validate every migration registered in a folder's Drizzle journal, so a new
 * migration cannot be applied by Drizzle without this guard inspecting it.
 */
async function validateJournalMigrations(
  dialect: Dialect,
  folder: string
): Promise<void> {
  const journal = JSON.parse(
    await readFile(path.join(folder, 'meta', '_journal.json'), 'utf8')
  ) as { dialect?: string; entries?: Array<{ tag?: unknown }> };
  assert.equal(
    journal.dialect,
    dialect,
    `${folder} journal must declare the ${dialect} dialect`
  );
  assert.ok(
    Array.isArray(journal.entries) && journal.entries.length > 0,
    `${folder} journal must register at least one migration`
  );
  for (const entry of journal.entries) {
    assert.equal(
      typeof entry.tag,
      'string',
      `${folder} journal entry is missing its tag`
    );
    const file = `${entry.tag as string}.sql`;
    validateMigrationText(
      dialect,
      await readFile(path.join(folder, file), 'utf8'),
      file
    );
  }
}

async function verifyStaticPortabilityContract(): Promise<void> {
  await validateJournalMigrations('sqlite', sqliteMigrations);
  await validateJournalMigrations('postgresql', postgresMigrations);

  const extensionProbe = await createTemporaryMigrationFolder(
    'postgresql',
    '0000_extension_probe',
    'CREATE EXTENSION IF NOT EXISTS postgis;',
    Date.UTC(2026, 0, 1)
  );
  try {
    await assert.rejects(
      validateJournalMigrations('postgresql', extensionProbe),
      /requires a spatial extension/,
      'a journal-registered migration with a spatial extension must be rejected'
    );
  } finally {
    await rm(extensionProbe, { recursive: true, force: true });
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

/**
 * SQLite date columns use Drizzle `integer(..., { mode: 'timestamp' })`, which
 * stores Unix seconds. Seed and compare raw SQLite values in seconds so the
 * fixture matches what the previous release actually wrote.
 */
function sqliteTimestamp(value: string): number {
  const milliseconds = timestamp(value);
  assert.equal(
    milliseconds % 1000,
    0,
    `SQLite fixture timestamp ${value} must be whole seconds`
  );
  return milliseconds / 1000;
}

/**
 * Decode a raw PostgreSQL `timestamp without time zone` value as UTC.
 *
 * drizzlePostgres() installs a transparent parser for OID 1114 on the shared
 * postgres.js client, so raw `client.unsafe()` reads return the server text
 * (for example `2024-01-10 12:00:00`). `new Date()` would parse that text in the
 * host time zone and make the gate pass only on UTC hosts. Mirror Drizzle's
 * own `timestamp` decoding (`value + '+0000'`) so the gate checks what the
 * application reads, on any host time zone.
 */
function postgresTimestamp(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  assert.equal(typeof value, 'string', 'expected a PostgreSQL timestamp value');
  const decoded = new Date(`${value as string}+0000`).getTime();
  assert.ok(
    Number.isFinite(decoded),
    `unparseable PostgreSQL timestamp ${String(value)}`
  );
  return decoded;
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
      sqliteTimestamp(c.createdAt),
      sqliteTimestamp(c.updatedAt)
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
      sqliteTimestamp(u.createdAt),
      sqliteTimestamp(u.updatedAt)
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
      sqliteTimestamp('2024-02-01T10:00:00.000Z'),
      sqliteTimestamp('2025-06-01T10:00:00.000Z')
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
      sqliteTimestamp('2024-03-01T10:00:00.000Z'),
      sqliteTimestamp('2025-06-04T10:00:00.000Z')
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
      sqliteTimestamp('2024-04-01T10:00:00.000Z'),
      sqliteTimestamp('2025-06-05T10:00:00.000Z')
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
      sqliteTimestamp('2024-04-02T10:00:00.000Z'),
      sqliteTimestamp('2025-06-06T10:00:00.000Z')
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
      sqliteTimestamp('2024-04-03T10:00:00.000Z'),
      sqliteTimestamp('2025-06-07T10:00:00.000Z')
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
      sqliteTimestamp('2024-04-04T10:00:00.000Z'),
      sqliteTimestamp('2025-06-08T10:00:00.000Z')
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

  // #186: composite tenant FKs on the rebuilt tables, the backfilled
  // community_id columns, and the composite parent keys.
  for (const table of ['story_places', 'story_speakers']) {
    const columns = columnNames(
      sqlite.prepare(`PRAGMA table_info(${table})`).all() as any[]
    );
    assert.ok(
      columns.has('community_id'),
      `missing ${table}.community_id after the #186 rebuild`
    );
  }
  for (const [table, indexName] of [
    ['places', 'places_community_id_id_unique'],
    ['speakers', 'speakers_community_id_id_unique'],
    ['stories', 'stories_community_id_id_unique'],
    ['files', 'files_community_id_id_unique'],
  ] as const) {
    const indexes = sqlite
      .prepare(`PRAGMA index_list(${table})`)
      .all() as any[];
    const unique = indexes.find((row) => String(row.name) === indexName);
    assert.ok(unique, `missing SQLite composite parent key ${indexName}`);
    assert.equal(Number(unique.unique), 1, `${indexName} must be unique`);
  }

  const compositeTenantFk = (
    table: string,
    parentTable: string,
    fromColumns: string[],
    onDelete: string
  ): void => {
    const rows = sqlite
      .prepare(`PRAGMA foreign_key_list(${table})`)
      .all() as any[];
    const groups = new Map<number, any[]>();
    for (const row of rows) {
      if (row.table !== parentTable) continue;
      const group = groups.get(row.id) ?? [];
      group.push(row);
      groups.set(row.id, group);
    }
    const matched = [...groups.values()].some((group) => {
      const ordered = [...group].sort((left, right) => left.seq - right.seq);
      return (
        ordered.length === fromColumns.length &&
        fromColumns.every((column, index) => ordered[index].from === column) &&
        ordered[0].to === 'community_id' &&
        ordered[1].to === 'id' &&
        ordered.every((row) => row.on_delete === onDelete)
      );
    });
    assert.ok(
      matched,
      `${table} must reference ${parentTable}(community_id, id) via ${fromColumns.join(', ')} ON DELETE ${onDelete}`
    );
  };
  compositeTenantFk(
    'story_places',
    'stories',
    ['community_id', 'story_id'],
    'CASCADE'
  );
  compositeTenantFk(
    'story_places',
    'places',
    ['community_id', 'place_id'],
    'CASCADE'
  );
  compositeTenantFk(
    'story_speakers',
    'stories',
    ['community_id', 'story_id'],
    'CASCADE'
  );
  compositeTenantFk(
    'story_speakers',
    'speakers',
    ['community_id', 'speaker_id'],
    'CASCADE'
  );
  compositeTenantFk(
    'stories',
    'places',
    ['community_id', 'interview_location_id'],
    'NO ACTION'
  );
  compositeTenantFk(
    'stories',
    'speakers',
    ['community_id', 'interviewer_id'],
    'NO ACTION'
  );
  compositeTenantFk(
    'community_media',
    'files',
    ['community_id', 'file_id'],
    'CASCADE'
  );
}

/**
 * Read upgraded rows through Drizzle, as the application does, so the gate
 * checks the dates the application receives and not only the raw integers.
 */
async function verifySqliteApplicationDates(
  database: ReturnType<typeof drizzleSqlite>
): Promise<void> {
  const { communitiesSqlite } = await import('../src/db/schema/communities.js');
  const { usersSqlite } = await import('../src/db/schema/users.js');

  const [community] = await database
    .select({
      createdAt: communitiesSqlite.createdAt,
      updatedAt: communitiesSqlite.updatedAt,
    })
    .from(communitiesSqlite)
    .where(eq(communitiesSqlite.id, fixture.community.id));
  assert.equal(
    community.createdAt.getTime(),
    timestamp(fixture.community.createdAt)
  );
  assert.equal(
    community.updatedAt.getTime(),
    timestamp(fixture.community.updatedAt)
  );

  const [user] = await database
    .select({
      createdAt: usersSqlite.createdAt,
      updatedAt: usersSqlite.updatedAt,
    })
    .from(usersSqlite)
    .where(eq(usersSqlite.id, fixture.user.id));
  assert.equal(user.createdAt.getTime(), timestamp(fixture.user.createdAt));
  assert.equal(user.updatedAt.getTime(), timestamp(fixture.user.updatedAt));
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
  // Compatibility-only V1 field (not canonical per SPEC-V2 §6.1); asserted to keep the coexistence surface stable.
  assert.equal(community.beta, 0);
  assert.equal(
    community.created_at,
    sqliteTimestamp(fixture.community.createdAt)
  );
  assert.equal(
    community.updated_at,
    sqliteTimestamp(fixture.community.updatedAt)
  );

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
  assert.equal(user.created_at, sqliteTimestamp(fixture.user.createdAt));
  assert.equal(user.updated_at, sqliteTimestamp(fixture.user.updatedAt));

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
    `SELECT table_name, column_name, column_default, data_type
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

  // S3: coordinates must be 8-byte doubles on PostgreSQL, matching SQLite
  // REAL precision, on both the fresh schema and the upgraded one.
  const coordinateTypes = new Map(
    columns
      .filter(
        (row: any) =>
          row.table_name === 'places' &&
          (row.column_name === 'latitude' || row.column_name === 'longitude')
      )
      .map((row: any) => [String(row.column_name), String(row.data_type)])
  );
  assert.equal(
    coordinateTypes.get('latitude'),
    'double precision',
    'places.latitude must be double precision'
  );
  assert.equal(
    coordinateTypes.get('longitude'),
    'double precision',
    'places.longitude must be double precision'
  );

  const lastLoginColumn = columns.find(
    (row: any) =>
      row.table_name === 'users' && row.column_name === 'last_login_at'
  );
  assert.ok(lastLoginColumn, 'missing users.last_login_at');
  assert.equal(
    lastLoginColumn.column_default,
    null,
    'users.last_login_at must not retain a legacy default'
  );

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
    `SELECT conname, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint WHERE connamespace = 'public'::regnamespace`
  );
  const constraints = new Map(
    constraintRows.map((row: any) => [
      String(row.conname),
      String(row.definition),
    ])
  );
  for (const constraint of [
    'users_community_id_communities_id_fk',
    'places_community_id_communities_id_fk',
    'speakers_community_id_communities_id_fk',
    'stories_community_id_communities_id_fk',
    'files_community_id_communities_id_fk',
    'files_uploaded_by_users_id_fk',
    'themes_community_id_communities_id_fk',
    'community_media_community_id_communities_id_fk',
  ]) {
    assert.ok(
      constraints.has(constraint),
      `missing PostgreSQL FK ${constraint}`
    );
  }
  // #186: composite (community_id, id) tenant foreign keys must exist on both
  // the fresh schema and the upgraded one, and their definitions must pair
  // community_id with the referenced id column.
  for (const [constraint, expectPair] of [
    ['stories_interview_location_community_fk', 'interview_location_id'],
    ['stories_interviewer_community_fk', 'interviewer_id'],
    ['story_places_story_community_fk', 'story_id'],
    ['story_places_place_community_fk', 'place_id'],
    ['story_speakers_story_community_fk', 'story_id'],
    ['story_speakers_speaker_community_fk', 'speaker_id'],
    ['community_media_file_community_fk', 'file_id'],
  ] as const) {
    const definition = constraints.get(constraint);
    assert.ok(
      definition,
      `missing PostgreSQL composite tenant FK ${constraint}`
    );
    assert.match(
      definition,
      new RegExp(`FOREIGN KEY \\(community_id, ${expectPair}\\)`),
      `${constraint} must be a composite tenant foreign key`
    );
  }
  // #186: parent keys for the composite FKs.
  for (const constraint of [
    'places_community_id_id_unique',
    'speakers_community_id_id_unique',
    'stories_community_id_id_unique',
    'files_community_id_id_unique',
  ]) {
    assert.ok(
      constraints.has(constraint),
      `missing PostgreSQL composite parent key ${constraint}`
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
  // Compatibility-only V1 field (not canonical per SPEC-V2 §6.1); asserted to keep the coexistence surface stable.
  assert.equal(community.beta, false);
  assert.equal(
    postgresTimestamp(community.created_at),
    timestamp(fixture.community.createdAt)
  );
  assert.equal(
    postgresTimestamp(community.updated_at),
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
    postgresTimestamp(user.created_at),
    timestamp(fixture.user.createdAt)
  );
  assert.equal(
    postgresTimestamp(user.updated_at),
    timestamp(fixture.user.updatedAt)
  );

  const [place] = await client.unsafe(
    'SELECT id, community_id, latitude, longitude, media_urls, is_restricted FROM places WHERE id = 1'
  );
  assert.equal(place.id, fixture.places[0].id);
  assert.equal(place.community_id, fixture.community.id);
  // The previous release stored coordinates as 4-byte real. Migration 0002
  // widens them to double precision without changing the stored value, so
  // upgraded rows keep their float32 value (new rows round-trip exactly; the
  // shared contract checks that).
  assert.equal(place.latitude, Math.fround(fixture.places[0].latitude));
  assert.equal(place.longitude, Math.fround(fixture.places[0].longitude));
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

/**
 * Read upgraded rows through Drizzle, as the application does, so the gate
 * checks the dates the application receives and not only the raw column text.
 */
async function verifyPostgresApplicationDates(
  database: ReturnType<typeof drizzlePostgres>
): Promise<void> {
  const { communitiesPg } = await import('../src/db/schema/communities.js');
  const { usersPg } = await import('../src/db/schema/users.js');

  const [community] = await database
    .select({
      createdAt: communitiesPg.createdAt,
      updatedAt: communitiesPg.updatedAt,
    })
    .from(communitiesPg)
    .where(eq(communitiesPg.id, fixture.community.id));
  assertValidDate(community.createdAt, 'communitiesPg.createdAt');
  assertValidDate(community.updatedAt, 'communitiesPg.updatedAt');
  assert.equal(
    community.createdAt.getTime(),
    timestamp(fixture.community.createdAt)
  );
  assert.equal(
    community.updatedAt.getTime(),
    timestamp(fixture.community.updatedAt)
  );

  const [user] = await database
    .select({
      createdAt: usersPg.createdAt,
      updatedAt: usersPg.updatedAt,
    })
    .from(usersPg)
    .where(eq(usersPg.id, fixture.user.id));
  assertValidDate(user.createdAt, 'usersPg.createdAt');
  assertValidDate(user.updatedAt, 'usersPg.updatedAt');
  assert.equal(user.createdAt.getTime(), timestamp(fixture.user.createdAt));
  assert.equal(user.updatedAt.getTime(), timestamp(fixture.user.updatedAt));
}

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * S4: database-default timestamps must stay UTC even when the database (or
 * server) default timezone is not UTC.
 *
 * `timestamp without time zone` columns hold UTC, and defaultNow() writes the
 * session's local wall clock. A client created through createPostgresClient
 * pins every session to UTC, so omitted createdAt/updatedAt defaults land on
 * UTC regardless of the database default; a plain postgres() client inherits
 * the database default and its defaults drift by the database's UTC offset,
 * which the negative control must detect.
 */
async function verifyPostgresTimezoneSafeDefaults(
  databaseUrl: string
): Promise<void> {
  const setupClient = createPostgresClient(databaseUrl, {
    max: 2,
    onnotice: () => undefined,
  });
  let databaseName = '';
  try {
    const [{ name }] = await setupClient`SELECT current_database() AS name`;
    databaseName = String(name);
    await setupClient.unsafe(
      `ALTER DATABASE ${quotePostgresIdentifier(databaseName)} SET timezone TO 'America/Sao_Paulo'`
    );
  } finally {
    await setupClient.end();
  }

  const pinnedClient = createPostgresClient(databaseUrl, {
    max: 2,
    onnotice: () => undefined,
  });
  // Plain client on purpose: no session settings, so the database default applies.
  let unpinnedClient: PostgresClient | null = null;
  try {
    const { communitiesPg } = await import('../src/db/schema/communities.js');

    const pinnedDb = drizzlePostgres(pinnedClient);
    const [pinned] = await pinnedDb
      .insert(communitiesPg)
      .values({
        name: 'Timezone Pinned Community',
        slug: 'timezone-pinned-community',
      })
      .returning({
        createdAt: communitiesPg.createdAt,
        updatedAt: communitiesPg.updatedAt,
      });
    assertValidDate(pinned.createdAt, 'pinned communitiesPg.createdAt');
    assertValidDate(pinned.updatedAt, 'pinned communitiesPg.updatedAt');
    assert.ok(
      Math.abs(pinned.createdAt.getTime() - Date.now()) < 120000,
      'createPostgresClient defaults must be written as UTC (drift < 120000 ms)'
    );

    unpinnedClient = postgres(databaseUrl);
    const unpinnedDb = drizzlePostgres(unpinnedClient);
    const [unpinned] = await unpinnedDb
      .insert(communitiesPg)
      .values({
        name: 'Timezone Unpinned Community',
        slug: 'timezone-unpinned-community',
      })
      .returning({ createdAt: communitiesPg.createdAt });
    assert.ok(
      Math.abs(unpinned.createdAt.getTime() - Date.now()) >= 3600000,
      'negative control must detect the Sao Paulo drift (>= 3600000 ms)'
    );
  } finally {
    if (unpinnedClient) {
      await unpinnedClient.end();
    }
    if (databaseName) {
      await pinnedClient.unsafe(
        `ALTER DATABASE ${quotePostgresIdentifier(databaseName)} RESET timezone`
      );
    }
    await pinnedClient.end();
  }
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
      .run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
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
      .run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000))
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

/* ------------------------------------------------------------------ */
/* #186 drift gate: applied SQLite schema vs the Drizzle snapshot.    */
/* ------------------------------------------------------------------ */

interface SnapshotColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  default?: boolean | number | string;
}

interface SnapshotIndex {
  name: string;
  columns: string[];
  isUnique: boolean;
}

interface SnapshotForeignKey {
  name: string;
  tableFrom: string;
  tableTo: string;
  columnsFrom: string[];
  columnsTo: string[];
  onDelete: string;
  onUpdate: string;
}

interface SnapshotTable {
  name: string;
  columns: Record<string, SnapshotColumn>;
  indexes: Record<string, SnapshotIndex>;
  foreignKeys: Record<string, SnapshotForeignKey>;
  uniqueConstraints?: Record<string, { name: string; columns: string[] }>;
  checkConstraints?: Record<string, { name: string; value: string }>;
}

interface Snapshot {
  tables: Record<string, SnapshotTable>;
}

/** Tables 0005 rebuilds by hand: they must match the Drizzle snapshot exactly. */
const rebuiltTables = [
  'stories',
  'story_places',
  'story_speakers',
  'community_media',
] as const;

/**
 * Normalize a constraint expression for text comparison: collapse whitespace
 * runs, strip identifier quoting ("x", `x`, and [x] all denote the identifier
 * x; single-quoted string literals are untouched), and drop `<table>.`
 * qualification (the Drizzle snapshot qualifies column references with the
 * table name while the applied SQLite SQL does not).
 */
function normalizeConstraintExpression(
  expression: string,
  table: string
): string {
  const tableQualifier = new RegExp(
    `\\b${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\.`,
    'g'
  );
  return expression
    .replace(/["`[\]]/g, '')
    .replace(tableQualifier, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the parenthesized expression of `CONSTRAINT `name` CHECK (...)`
 * from CREATE TABLE SQL, honoring nested parentheses and ignoring
 * parentheses inside single-quoted string literals.
 */
function sqliteCheckExpression(
  createSql: string,
  constraintName: string
): string {
  const header = `CONSTRAINT \`${constraintName}\` CHECK`;
  const headerIndex = createSql.indexOf(header);
  assert.ok(
    headerIndex >= 0,
    `CREATE SQL must declare CHECK constraint ${constraintName}`
  );
  const open = createSql.indexOf('(', headerIndex + header.length);
  assert.ok(open >= 0, `CHECK constraint ${constraintName} has no expression`);
  let depth = 0;
  let quoted = false;
  for (let index = open; index < createSql.length; index += 1) {
    const char = createSql[index];
    if (quoted) {
      quoted = char !== "'";
    } else if (char === "'") {
      quoted = true;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return createSql.slice(open + 1, index);
      }
    }
  }
  return assert.fail(
    `CHECK constraint ${constraintName} has unbalanced parentheses`
  );
}

/**
 * Compare a migrated SQLite database against meta/0005_snapshot.json — the
 * structure `drizzle-kit generate` derived from the Drizzle schema — so the
 * hand-written table rebuilds in 0005 cannot drift from the schema (a dropped
 * column, default, CHECK expression, index, inline UNIQUE, or FK in the SQL
 * would fail this gate).
 *
 * PRAGMA foreign_key_list is name-blind (SQLite keeps CONSTRAINT names only in
 * the sqlite_master SQL text), so foreign keys are compared structurally and
 * constraint names are checked against sqlite_master.
 */
function verifySqliteSnapshotDrift(
  sqlite: Database.Database,
  label: string
): void {
  const snapshot = JSON.parse(
    readFileSync(
      path.join(sqliteMigrations, 'meta', '0005_snapshot.json'),
      'utf8'
    )
  ) as Snapshot;

  for (const table of rebuiltTables) {
    const expected = snapshot.tables[table];
    assert.ok(expected, `snapshot must describe ${table}`);

    const pragmaColumns = sqlite
      .prepare(`PRAGMA table_info(${table})`)
      .all() as any[];
    const expectedColumns = Object.values(expected.columns);
    assert.deepEqual(
      pragmaColumns.map((column) => column.name),
      expectedColumns.map((column) => column.name),
      `${label}: ${table} column names/order must match the snapshot`
    );
    for (const pragmaColumn of pragmaColumns) {
      const snapshotColumn = expectedColumns.find(
        (column) => column.name === pragmaColumn.name
      )!;
      assert.equal(
        String(pragmaColumn.type).toLowerCase(),
        snapshotColumn.type.toLowerCase(),
        `${label}: ${table}.${pragmaColumn.name} type must match the snapshot`
      );
      assert.equal(
        Number(pragmaColumn.notnull),
        snapshotColumn.notNull ? 1 : 0,
        `${label}: ${table}.${pragmaColumn.name} NOT NULL must match the snapshot`
      );
      assert.equal(
        Number(pragmaColumn.pk),
        snapshotColumn.primaryKey ? 1 : 0,
        `${label}: ${table}.${pragmaColumn.name} PRIMARY KEY must match the snapshot`
      );
      const expectedDefault =
        snapshotColumn.default === undefined
          ? null
          : String(snapshotColumn.default);
      assert.equal(
        pragmaColumn.dflt_value === null
          ? null
          : String(pragmaColumn.dflt_value),
        expectedDefault,
        `${label}: ${table}.${pragmaColumn.name} DEFAULT must match the snapshot`
      );
    }

    // Named indexes AND inline UNIQUE constraints. PRAGMA table_info carries
    // no uniqueness information, so a table-level UNIQUE(...) clause — which
    // SQLite surfaces as an origin-'u' auto-index named
    // sqlite_autoindex_<table>_<n>, not as a named CREATE INDEX — would
    // otherwise be invisible to this gate. Comparing both origins (origin
    // 'pk' stays excluded: PRIMARY KEY coverage is checked per column above)
    // makes a dropped or smuggled-in UNIQUE (community_id, id) on a rebuilt
    // table fail here.
    const namedIndexes = new Map<
      string,
      { unique: boolean; columns: string[] }
    >();
    const inlineUniqueIndexes: Array<{ unique: boolean; columns: string[] }> =
      [];
    for (const row of sqlite
      .prepare(`PRAGMA index_list(${table})`)
      .all() as any[]) {
      if (row.origin !== 'c' && row.origin !== 'u') continue;
      const columns = (
        sqlite.prepare(`PRAGMA index_info(${row.name})`).all() as any[]
      )
        .slice()
        .sort((left, right) => left.seqno - right.seqno)
        .map((indexColumn) => indexColumn.name);
      const applied = { unique: Number(row.unique) === 1, columns };
      if (String(row.name).startsWith('sqlite_autoindex_')) {
        inlineUniqueIndexes.push(applied);
      } else {
        namedIndexes.set(String(row.name), applied);
      }
    }
    const expectedIndexes = Object.values(expected.indexes ?? {});
    assert.deepEqual(
      [...namedIndexes.keys()].sort(),
      expectedIndexes.map((index) => index.name).sort(),
      `${label}: ${table} index names must match the snapshot`
    );
    for (const index of expectedIndexes) {
      const applied = namedIndexes.get(index.name);
      assert.ok(applied, `${label}: ${table} must have index ${index.name}`);
      assert.equal(
        applied.unique,
        index.isUnique,
        `${label}: ${table} index ${index.name} uniqueness must match the snapshot`
      );
      assert.deepEqual(
        applied.columns,
        index.columns,
        `${label}: ${table} index ${index.name} columns must match the snapshot`
      );
    }
    // Snapshot UNIQUE constraints apply as unnamed origin-'u' auto-indexes
    // (their CONSTRAINT name lives only in the sqlite_master SQL text), so
    // they are matched structurally; the set comparison also fails when the
    // applied table declares an inline UNIQUE the snapshot does not have.
    const inlineUniqueKey = (entry: { unique: boolean; columns: string[] }) =>
      JSON.stringify([entry.unique, entry.columns]);
    assert.deepEqual(
      inlineUniqueIndexes.map(inlineUniqueKey).sort(),
      Object.values(expected.uniqueConstraints ?? {})
        .map((constraint) =>
          inlineUniqueKey({ unique: true, columns: constraint.columns })
        )
        .sort(),
      `${label}: ${table} inline UNIQUE constraints (unique, columns) must match the snapshot`
    );

    const appliedForeignKeys = (
      sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as any[]
    ).reduce<Map<number, any[]>>((groups, row) => {
      const group = groups.get(row.id) ?? [];
      group.push(row);
      groups.set(row.id, group);
      return groups;
    }, new Map());
    const appliedForeignKeyTuples = [...appliedForeignKeys.values()]
      .map((group) =>
        group
          .slice()
          .sort((left, right) => left.seq - right.seq)
          .map((row) => ({
            table: String(row.table),
            from: String(row.from),
            to: String(row.to),
            onDelete: String(row.on_delete).toLowerCase(),
            onUpdate: String(row.on_update).toLowerCase(),
          }))
      )
      .map((columns) => ({
        table: columns[0].table,
        columnsFrom: columns.map((column) => column.from),
        columnsTo: columns.map((column) => column.to),
        onDelete: columns[0].onDelete,
        onUpdate: columns[0].onUpdate,
      }));
    const expectedForeignKeyTuples = Object.values(
      expected.foreignKeys ?? {}
    ).map((foreignKey) => ({
      table: foreignKey.tableTo,
      columnsFrom: foreignKey.columnsFrom,
      columnsTo: foreignKey.columnsTo,
      onDelete: (foreignKey.onDelete ?? 'no action').toLowerCase(),
      onUpdate: (foreignKey.onUpdate ?? 'no action').toLowerCase(),
    }));
    const tupleKey = (tuple: {
      table: string;
      columnsFrom: string[];
      columnsTo: string[];
      onDelete: string;
      onUpdate: string;
    }) =>
      JSON.stringify([
        tuple.table,
        tuple.columnsFrom,
        tuple.columnsTo,
        tuple.onDelete,
        tuple.onUpdate,
      ]);
    assert.deepEqual(
      appliedForeignKeyTuples.map(tupleKey).sort(),
      expectedForeignKeyTuples.map(tupleKey).sort(),
      `${label}: ${table} foreign keys (table, from, to, on delete, on update) must match the snapshot`
    );

    // Constraint names live in the sqlite_master SQL text, not in PRAGMAs.
    const createSql = String(
      (
        sqlite
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?"
          )
          .get(table) as any
      ).sql
    );
    for (const foreignKey of Object.values(expected.foreignKeys ?? {})) {
      assert.match(
        createSql,
        new RegExp(`CONSTRAINT \`${foreignKey.name}\` FOREIGN KEY`),
        `${label}: ${table} must declare FK constraint name ${foreignKey.name}`
      );
    }
    for (const check of Object.values(expected.checkConstraints ?? {})) {
      assert.match(
        createSql,
        new RegExp(`CONSTRAINT \`${check.name}\` CHECK`),
        `${label}: ${table} must declare CHECK constraint name ${check.name}`
      );
      // The name alone proves nothing about the predicate: compare the
      // snapshot's expression against the applied sqlite_master SQL text
      // (whitespace/quoting normalized) so an altered CHECK fails the gate.
      assert.equal(
        normalizeConstraintExpression(
          sqliteCheckExpression(createSql, check.name),
          table
        ),
        normalizeConstraintExpression(check.value, table),
        `${label}: ${table} CHECK constraint ${check.name} expression must match the snapshot`
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* #186 crash safety: cross-community guard abort and re-run.         */
/* ------------------------------------------------------------------ */

/** Row counts a 0000-only database seeded by this gate always holds. */
const seededRowCounts: Array<[table: string, count: number]> = [
  ['stories', 1],
  ['story_places', 1],
  ['story_speakers', 1],
  ['community_media', 0],
];

/**
 * A migration folder whose journal stops before 0005: the state an upgraded
 * database is in when a runner picks up migration 0005.
 */
async function createSqlitePre186Folder(): Promise<string> {
  const folder = await mkdtemp(
    path.join(os.tmpdir(), 'terrastories-sqlite-pre186-')
  );
  await mkdir(path.join(folder, 'meta'));
  const journal = JSON.parse(
    await readFile(path.join(sqliteMigrations, 'meta', '_journal.json'), 'utf8')
  ) as { entries: Array<{ tag: string }> };
  const entries = journal.entries.filter(
    (entry) => entry.tag !== '0005_composite_tenant_fks'
  );
  await writeFile(
    path.join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries }, null, 2)
  );
  for (const entry of entries) {
    await copyFile(
      path.join(sqliteMigrations, `${entry.tag}.sql`),
      path.join(folder, `${entry.tag}.sql`)
    );
  }
  return folder;
}

async function createSeededPre186Sqlite(): Promise<{
  sqlite: Database.Database;
  otherPlaceId: number;
}> {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const database = drizzleSqlite(sqlite);
  const pre186Folder = await createSqlitePre186Folder();
  try {
    await migrateSqlite(database, { migrationsFolder: pre186Folder });
  } finally {
    await rm(pre186Folder, { recursive: true, force: true });
  }
  seedPreviousReleaseSqlite(sqlite);

  // A cross-community edge the legacy single-column FKs allow: a second
  // community, a place in it, and a story_places row binding story 1
  // (community 1) to that place. Migration 0005 must refuse this data.
  const now = sqliteTimestamp('2026-01-01T00:00:00.000Z');
  sqlite
    .prepare(
      `INSERT INTO communities
       (id, name, slug, public_stories, created_at, updated_at)
       VALUES (2, 'Other Community', 'other-community', 1, ?, ?)`
    )
    .run(now, now);
  const otherPlaceId = 9001;
  sqlite
    .prepare(
      `INSERT INTO places
       (id, name, community_id, latitude, longitude, created_at, updated_at)
       VALUES (?, 'Other Community Place', 2, 1.5, 2.5, ?, ?)`
    )
    .run(otherPlaceId, now, now);
  sqlite
    .prepare(
      `INSERT INTO story_places (id, story_id, place_id, created_at, updated_at)
       VALUES (2, 1, ?, ?, ?)`
    )
    .run(otherPlaceId, now, now);
  return { sqlite, otherPlaceId };
}

function assertJoinSurfaceIntact(
  sqlite: Database.Database,
  label: string
): void {
  for (const [table, baseline] of seededRowCounts) {
    // The seeded cross-community edge adds one story_places row.
    const expected = table === 'story_places' ? baseline + 1 : baseline;
    const count = (
      sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get() as any
    ).count;
    assert.equal(
      count,
      expected,
      `${label}: ${table} must still exist with its rows after the failed migration`
    );
  }
  const residue = (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('stories_old', 'story_places_new', 'story_speakers_new', 'community_media_new')"
      )
      .all() as any[]
  ).map((row) => String(row.name));
  assert.deepEqual(
    residue,
    [],
    `${label}: a failed migration must not leave rebuild residue tables`
  );
}

/**
 * Migration 0005's statements, mirroring a runner that executes the file one
 * statement at a time with no wrapping transaction (the production D1 path
 * through `wrangler d1 migrations apply`, whose atomicity this repository
 * cannot guarantee from source).
 */
async function compositeTenantFkStatements(): Promise<string[]> {
  const source = await readFile(
    path.join(sqliteMigrations, '0005_composite_tenant_fks.sql'),
    'utf8'
  );
  return splitStatements(source);
}

async function verifySqliteCrossCommunityGuard(): Promise<void> {
  const statements = await compositeTenantFkStatements();

  // 1. Statement-by-statement (non-atomic runner): the guard aborts before
  //    any destructive step, the tables survive, and a re-run after repair
  //    succeeds — proving the guard table's re-entrancy.
  {
    const { sqlite, otherPlaceId } = await createSeededPre186Sqlite();
    let aborted = false;
    try {
      for (const statement of statements) sqlite.exec(statement);
    } catch (error) {
      if (!/cross_community_rows/.test(String(error))) throw error;
      aborted = true;
    }
    assert.equal(
      aborted,
      true,
      'stepwise: the cross-community edge must abort migration 0005'
    );
    assertJoinSurfaceIntact(sqlite, 'stepwise');
    const guardAfterAbort = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_186_cross_community_guard'"
      )
      .get();
    assert.ok(
      guardAfterAbort,
      'stepwise: the aborted guard leaves its table behind (no transaction to roll it back)'
    );
    sqlite
      .prepare('DELETE FROM story_places WHERE place_id = ?')
      .run(otherPlaceId);
    for (const statement of statements) sqlite.exec(statement);
    assert.equal(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='_186_cross_community_guard'"
        )
        .get(),
      undefined,
      'stepwise: the re-run must drop the guard table'
    );
    verifySqliteSchema(sqlite);
    verifySqliteSnapshotDrift(sqlite, 'stepwise re-run');
    sqlite.close();
  }

  // 2. Drizzle migrator (atomic runner): same abort, fully rolled back. The
  //    better-sqlite3 migrator throws synchronously, hence try/catch instead
  //    of assert.rejects.
  {
    const { sqlite, otherPlaceId } = await createSeededPre186Sqlite();
    const database = drizzleSqlite(sqlite);
    let aborted = false;
    try {
      await migrateSqlite(database, { migrationsFolder: sqliteMigrations });
    } catch (error) {
      if (!/cross_community_rows/.test(String(error))) throw error;
      aborted = true;
    }
    assert.equal(
      aborted,
      true,
      'drizzle: the cross-community edge must abort migration 0005'
    );
    assertJoinSurfaceIntact(sqlite, 'drizzle');
    assert.equal(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='_186_cross_community_guard'"
        )
        .get(),
      undefined,
      'drizzle: the transactional rollback must remove the guard table'
    );
    sqlite
      .prepare('DELETE FROM story_places WHERE place_id = ?')
      .run(otherPlaceId);
    await migrateSqlite(database, { migrationsFolder: sqliteMigrations });
    verifySqliteSchema(sqlite);
    verifySqliteSnapshotDrift(sqlite, 'drizzle re-run');
    sqlite.close();
  }
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

  console.log('  1/5 fresh migration + shared repository contract');
  const freshSqlite = new Database(':memory:');
  freshSqlite.pragma('foreign_keys = ON');
  const freshDb = drizzleSqlite(freshSqlite);
  await migrateSqlite(freshDb, { migrationsFolder: sqliteMigrations });
  verifySqliteSchema(freshSqlite);
  verifySqliteSnapshotDrift(freshSqlite, 'fresh');
  await runRepositoryContract(freshDb);
  await runHonoFoundationContract(freshDb);
  verifySqliteTransactionAndForeignKey(freshSqlite);
  await migrateSqlite(freshDb, { migrationsFolder: sqliteMigrations });
  freshSqlite.close();

  console.log('  2/5 previous-release upgrade + data preservation');
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
  verifySqliteSnapshotDrift(upgradeSqlite, 'previous-release upgrade');
  verifySqlitePreservation(upgradeSqlite);
  await verifySqliteApplicationDates(upgradeDb);
  upgradeSqlite.close();

  console.log('  3/5 deliberate dialect incompatibility rejection');
  validateMigrationText(
    'sqlite',
    await readFile(
      path.join(sqliteMigrations, '0000_glamorous_guardsmen.sql'),
      'utf8'
    ),
    'SQLite baseline'
  );

  console.log('  4/5 failed migration recording guard');
  await verifySqliteFailedMigrationNotRecorded();

  console.log('  5/5 cross-community guard abort and re-run');
  await verifySqliteCrossCommunityGuard();
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
  const client = createPostgresClient(databaseUrl, {
    max: 2,
    onnotice: () => undefined,
  });
  try {
    console.log('  1/4 fresh migration + shared repository contract');
    await resetPostgres(client);
    const freshDb = drizzlePostgres(client);
    await migratePostgres(freshDb, { migrationsFolder: postgresMigrations });
    await verifyPostgresSchema(client);
    // Before the contract runs, make a non-UTC database default so the S4
    // probe proves the session pin rather than a lucky UTC server default.
    await verifyPostgresTimezoneSafeDefaults(databaseUrl);
    await runRepositoryContract(freshDb);
    await runHonoFoundationContract(freshDb);
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
    await verifyPostgresApplicationDates(upgradeDb);

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
