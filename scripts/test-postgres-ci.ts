import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { CommunityRepository } from '../src/repositories/community.repository.js';
import { PlaceRepository } from '../src/repositories/place.repository.js';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..');
process.env.NODE_ENV = 'test';
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
}

const parsedDatabaseUrl = new URL(databaseUrl);
const databaseName = parsedDatabaseUrl.pathname.replace(/^\//, '');
if (!/test/i.test(databaseName)) {
  throw new Error(
    `Refusing destructive PostgreSQL integration tests against non-test database: ${databaseName}`
  );
}

if (process.env.ALLOW_POSTGRES_TEST_RESET !== 'true') {
  throw new Error(
    'Set ALLOW_POSTGRES_TEST_RESET=true to acknowledge the PostgreSQL test database will be reset'
  );
}

const sql = postgres(databaseUrl, {
  max: 2,
  prepare: false,
  onnotice: () => undefined,
});

async function executeSqlFixture(relativePath: string): Promise<void> {
  const source = await readFile(path.join(rootDir, relativePath), 'utf8');
  const statements = source
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await sql.unsafe(statement);
  }
}

async function resetDatabase(): Promise<void> {
  await sql.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await sql.unsafe('CREATE SCHEMA public');
}

function runMigration(expectSuccess: boolean): void {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCommand, ['run', 'db:migrate'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
    },
    encoding: 'utf8',
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (expectSuccess) {
    assert.equal(
      result.status,
      0,
      `PostgreSQL migration was expected to succeed:\n${output}`
    );
    assert.match(output, /Spatial Support: ✅/);
    return;
  }

  assert.notEqual(
    result.status,
    0,
    'Migration unexpectedly succeeded for a fixture that violates a production constraint'
  );
  assert.match(output, /Migration failed/);
}

async function verifyFreshSchema(): Promise<void> {
  const [postgis] = await sql<{ version: string }[]>`
    SELECT PostGIS_Version() AS version
  `;
  assert.ok(postgis.version.length > 0, 'PostGIS must be available');

  const columns = await sql<
    {
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
      is_generated: string;
    }[]
  >`
    SELECT
      table_name,
      column_name,
      data_type,
      udt_name,
      is_nullable,
      column_default,
      is_generated
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `;

  const byColumn = new Map(
    columns.map((column) => [
      `${column.table_name}.${column.column_name}`,
      column,
    ])
  );

  for (const requiredColumn of [
    'communities.country',
    'communities.beta',
    'users.reset_password_token',
    'users.reset_password_sent_at',
    'users.remember_created_at',
    'users.sign_in_count',
    'users.last_sign_in_at',
    'users.current_sign_in_ip',
    'places.location',
    'stories.privacy_level',
    'stories.image_url',
    'stories.audio_url',
    'speakers.bio_audio_url',
    'story_places.cultural_context',
    'story_speakers.story_role',
  ]) {
    assert.ok(byColumn.has(requiredColumn), `Missing column ${requiredColumn}`);
  }

  const location = byColumn.get('places.location');
  assert.equal(location?.udt_name, 'geometry');
  assert.equal(location?.is_generated, 'ALWAYS');

  for (const timestampColumn of [
    'communities.created_at',
    'communities.updated_at',
    'users.created_at',
    'users.updated_at',
    'places.created_at',
    'places.updated_at',
    'stories.created_at',
    'stories.updated_at',
  ]) {
    const column = byColumn.get(timestampColumn);
    assert.equal(
      column?.data_type,
      'timestamp without time zone',
      `${timestampColumn} must remain Rails-compatible timestamp data`
    );
    assert.equal(column?.is_nullable, 'NO');
    assert.ok(column?.column_default, `${timestampColumn} needs a default`);
  }

  const indexes = await sql<{ indexname: string; indexdef: string }[]>`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
  `;
  const indexNames = new Set(indexes.map((index) => index.indexname));
  for (const requiredIndex of [
    'communities_slug_unique',
    'users_email_community_unique',
    'places_community_id_idx',
    'places_location_gist_idx',
    'places_location_geography_gist_idx',
    'speakers_elder_status_idx',
    'stories_privacy_level_idx',
    'files_community_idx',
    'story_place_unique',
    'story_speaker_unique',
  ]) {
    assert.ok(indexNames.has(requiredIndex), `Missing index ${requiredIndex}`);
  }
}

async function verifyConstraintsAndDefaults(): Promise<void> {
  const constraints = await sql<{ conname: string; definition: string }[]>`
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
  `;
  const constraintsByName = new Map(
    constraints.map((constraint) => [constraint.conname, constraint])
  );

  for (const requiredConstraint of [
    'communities_country_iso_check',
    'users_community_id_fkey',
    'users_role_check',
    'places_community_id_fkey',
    'places_latitude_check',
    'places_longitude_check',
    'stories_community_id_fkey',
    'stories_created_by_fkey',
    'files_community_id_fkey',
    'files_uploaded_by_fkey',
    'story_places_story_id_fkey',
    'story_places_place_id_fkey',
    'story_speakers_story_id_fkey',
    'story_speakers_speaker_id_fkey',
  ]) {
    assert.ok(
      constraintsByName.has(requiredConstraint),
      `Missing constraint ${requiredConstraint}`
    );
  }

  assert.match(
    constraintsByName.get('story_places_story_id_fkey')?.definition ?? '',
    /ON DELETE CASCADE/
  );
  assert.match(
    constraintsByName.get('story_speakers_story_id_fkey')?.definition ?? '',
    /ON DELETE CASCADE/
  );

  const [defaults] = await sql<
    {
      public_stories: boolean;
      locale: string;
      is_active: boolean;
      beta: boolean;
      created_at: Date;
      updated_at: Date;
    }[]
  >`
    INSERT INTO communities (name, slug)
    VALUES ('Fresh Defaults', 'fresh-defaults-' || floor(random() * 1000000)::text)
    RETURNING public_stories, locale, is_active, beta, created_at, updated_at
  `;
  assert.equal(defaults.public_stories, false);
  assert.equal(defaults.locale, 'en');
  assert.equal(defaults.is_active, true);
  assert.equal(defaults.beta, false);
  assert.ok(defaults.created_at instanceof Date);
  assert.ok(defaults.updated_at instanceof Date);
}

async function verifyUpgradeDataInvariants(): Promise<void> {
  const [community] = await sql<
    {
      id: number;
      country: string;
      beta: boolean;
      locale: string;
      is_active: boolean;
    }[]
  >`
    SELECT id, country, beta, locale, is_active
    FROM communities
    WHERE id = 1
  `;
  assert.deepEqual(community, {
    id: 1,
    country: 'BR',
    beta: true,
    locale: 'en',
    is_active: true,
  });

  const [user] = await sql<
    {
      community_id: number;
      reset_password_token: string;
      sign_in_count: number;
      current_sign_in_ip: string;
    }[]
  >`
    SELECT community_id, reset_password_token, sign_in_count, current_sign_in_ip
    FROM users
    WHERE id = 1
  `;
  assert.equal(user.community_id, 1);
  assert.equal(user.reset_password_token, '[REDACTED_TOKEN]');
  assert.equal(user.sign_in_count, 7);
  assert.equal(user.current_sign_in_ip, '192.0.2.10');

  const [place] = await sql<
    {
      community_id: number;
      is_restricted: boolean;
      srid: number;
      geometry_type: string;
    }[]
  >`
    SELECT
      community_id,
      is_restricted,
      ST_SRID(location) AS srid,
      GeometryType(location) AS geometry_type
    FROM places
    WHERE id = 1
  `;
  assert.equal(place.community_id, 1);
  assert.equal(place.is_restricted, true);
  assert.equal(place.srid, 4326);
  assert.equal(place.geometry_type, 'POINT');

  const [speaker] = await sql<
    { community_id: number; elder_status: boolean }[]
  >`SELECT community_id, elder_status FROM speakers WHERE id = 1`;
  assert.deepEqual(speaker, { community_id: 1, elder_status: true });

  const [story] = await sql<
    { community_id: number; created_by: number; is_restricted: boolean }[]
  >`SELECT community_id, created_by, is_restricted FROM stories WHERE id = 1`;
  assert.deepEqual(story, {
    community_id: 1,
    created_by: 1,
    is_restricted: true,
  });

  const [file] = await sql<
    {
      community_id: number;
      uploaded_by: number;
      metadata: { duration: number };
      cultural_restrictions: { elderOnly: boolean; accessLevel: string };
    }[]
  >`
    SELECT community_id, uploaded_by, metadata, cultural_restrictions
    FROM files
    WHERE id = '11111111-1111-4111-8111-111111111111'
  `;
  assert.equal(file.community_id, 1);
  assert.equal(file.uploaded_by, 1);
  assert.equal(file.metadata.duration, 42);
  assert.equal(file.cultural_restrictions.elderOnly, true);
  assert.equal(file.cultural_restrictions.accessLevel, 'community');

  const [storyPlace] = await sql<
    { story_id: number; place_id: number; sort_order: number }[]
  >`SELECT story_id, place_id, sort_order FROM story_places WHERE id = 1`;
  assert.deepEqual(storyPlace, { story_id: 1, place_id: 1, sort_order: 0 });

  const [storySpeaker] = await sql<
    { story_id: number; speaker_id: number; sort_order: number }[]
  >`SELECT story_id, speaker_id, sort_order FROM story_speakers WHERE id = 1`;
  assert.deepEqual(storySpeaker, {
    story_id: 1,
    speaker_id: 1,
    sort_order: 0,
  });
}

async function verifyConstraintEnforcement(): Promise<void> {
  await assert.rejects(
    sql.unsafe(`
      INSERT INTO users (
        email, password_hash, first_name, last_name, community_id,
        created_at, updated_at
      ) VALUES (
        'orphan@example.test', '[REDACTED_SECRET]', 'Orphan', 'User', 999999,
        now(), now()
      )
    `),
    (error: unknown) => (error as { code?: string }).code === '23503'
  );

  await assert.rejects(
    sql.unsafe(`
      INSERT INTO places (
        name, community_id, latitude, longitude, created_at, updated_at
      ) VALUES ('Invalid Coordinate', 1, 91, 0, now(), now())
    `),
    (error: unknown) => (error as { code?: string }).code === '23514'
  );

  await assert.rejects(
    sql.unsafe(`
      INSERT INTO story_places (story_id, place_id, created_at, updated_at)
      VALUES (1, 1, now(), now())
    `),
    (error: unknown) => (error as { code?: string }).code === '23505'
  );

  await assert.rejects(
    sql.unsafe(`UPDATE communities SET country = 'br' WHERE id = 1`),
    (error: unknown) => (error as { code?: string }).code === '23514'
  );
}

async function verifySpatialBehaviorAndIndex(): Promise<void> {
  const nearby = await sql<{ id: number }[]>`
    SELECT id
    FROM places
    WHERE ST_DWithin(
      location::geography,
      ST_SetSRID(ST_MakePoint(-48.4902, -1.4558), 4326)::geography,
      1000
    )
    ORDER BY id
  `;
  assert.deepEqual(
    nearby.map((row) => row.id),
    [1, 2]
  );

  await sql.unsafe('SET enable_seqscan = off');
  const planRows = await sql.unsafe(`
    EXPLAIN
    SELECT id
    FROM places
    WHERE ST_DWithin(
      location::geography,
      ST_SetSRID(ST_MakePoint(-48.4902, -1.4558), 4326)::geography,
      1000
    )
  `);
  await sql.unsafe('RESET enable_seqscan');

  const plan = planRows
    .map((row: Record<string, unknown>) => String(row['QUERY PLAN']))
    .join('\n');
  assert.match(
    plan,
    /places_location_geography_gist_idx/,
    `Expected PostGIS geography GiST index in query plan:\n${plan}`
  );
}

async function verifyRepositoriesOnPostgres(): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  const database = drizzle(client);

  try {
    const communityRepository = new CommunityRepository(database as any);
    const community = await communityRepository.create({
      name: 'Repository Integration Community',
      locale: 'en',
    });

    const placeRepository = new PlaceRepository(database as any);
    const publicPlace = await placeRepository.create({
      name: 'Repository Near Public',
      communityId: community.id,
      latitude: -1.4558,
      longitude: -48.4902,
      isRestricted: false,
    });
    const restrictedPlace = await placeRepository.create({
      name: 'Repository Near Restricted',
      communityId: community.id,
      latitude: -1.456,
      longitude: -48.4901,
      isRestricted: true,
    });
    await placeRepository.create({
      name: 'Repository Far Public',
      communityId: community.id,
      latitude: -3.119,
      longitude: -60.0217,
      isRestricted: false,
    });

    const publicSearch = await placeRepository.searchNear({
      communityId: community.id,
      latitude: -1.4558,
      longitude: -48.4902,
      radiusKm: 1,
      page: 1,
      limit: 20,
    });
    assert.deepEqual(
      publicSearch.data.map((place) => place.id),
      [publicPlace.id]
    );

    const unrestrictedSearch = await placeRepository.searchNear({
      communityId: community.id,
      latitude: -1.4558,
      longitude: -48.4902,
      radiusKm: 1,
      page: 1,
      limit: 20,
      includeRestricted: true,
    });
    assert.deepEqual(
      new Set(unrestrictedSearch.data.map((place) => place.id)),
      new Set([publicPlace.id, restrictedPlace.id])
    );
  } finally {
    await client.end();
  }
}

async function verifyFailedMigrationIsNotRecorded(): Promise<void> {
  const [migrationTable] = await sql<{ table_name: string | null }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations')::text AS table_name
  `;
  if (!migrationTable.table_name) return;

  const [migrationCount] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
  `;
  assert.equal(
    migrationCount.count,
    0,
    'Failed migration must not be recorded as applied'
  );
}

async function main(): Promise<void> {
  console.log('🐘 PostgreSQL/PostGIS integration gate');

  console.log('  1/4 fresh database migration');
  await resetDatabase();
  runMigration(true);
  await verifyFreshSchema();
  await verifyConstraintsAndDefaults();
  runMigration(true);

  console.log('  2/4 fail-closed migration probe');
  await resetDatabase();
  await executeSqlFixture(
    'tests/fixtures/postgres/previous-release-schema.sql'
  );
  await executeSqlFixture('tests/fixtures/postgres/production-like-data.sql');
  await sql.unsafe('UPDATE places SET latitude = 999 WHERE id = 1');
  runMigration(false);
  await verifyFailedMigrationIsNotRecorded();

  console.log('  3/4 previous-release + production-like upgrade');
  await resetDatabase();
  await executeSqlFixture(
    'tests/fixtures/postgres/previous-release-schema.sql'
  );
  await executeSqlFixture('tests/fixtures/postgres/production-like-data.sql');
  runMigration(true);
  await verifyFreshSchema();
  await verifyConstraintsAndDefaults();
  await verifyUpgradeDataInvariants();
  await verifyConstraintEnforcement();
  await verifySpatialBehaviorAndIndex();

  console.log('  4/4 repository behavior on PostgreSQL/PostGIS');
  await verifyRepositoriesOnPostgres();

  console.log('✅ PostgreSQL/PostGIS integration gate passed');
}

main()
  .catch((error) => {
    console.error('❌ PostgreSQL/PostGIS integration gate failed');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
