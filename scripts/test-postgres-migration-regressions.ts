import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const rootDir = process.cwd();
const migrationsFolder = path.join(rootDir, 'src/db/migrations/postgres');
const previousReleaseFixture = path.join(
  rootDir,
  'tests/fixtures/db/postgres-previous-release.sql'
);
const snapshotPath = path.join(migrationsFolder, 'meta/0001_snapshot.json');

const canonicalUniqueConstraints = [
  'communities_slug_unique',
  'story_place_unique',
  'story_speaker_unique',
  'users_email_community_unique',
] as const;

const stagedCommunityOwnershipConstraints = [
  'places_community_id_communities_id_fk',
  'speakers_community_id_communities_id_fk',
  'stories_community_id_communities_id_fk',
  'users_community_id_communities_id_fk',
] as const;

function assertSafeTestDatabase(databaseUrl: string): void {
  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.replace(/^\//, '')
  );
  const dedicatedTestDatabase = /^(?:test|[a-z0-9][a-z0-9_]*_test)$/i;
  assert.match(
    databaseName,
    dedicatedTestDatabase,
    `refusing destructive PostgreSQL regression gate against non-test database ${databaseName}`
  );
  assert.equal(
    process.env.ALLOW_POSTGRES_TEST_RESET,
    'true',
    'ALLOW_POSTGRES_TEST_RESET=true is required for the destructive PostgreSQL regression gate'
  );
}

function splitStatements(source: string): string[] {
  return source
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function resetDatabase(
  client: ReturnType<typeof postgres>
): Promise<void> {
  await client.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await client.unsafe('CREATE SCHEMA public');
}

async function installPreviousRelease(
  client: ReturnType<typeof postgres>
): Promise<void> {
  const source = await readFile(previousReleaseFixture, 'utf8');
  for (const statement of splitStatements(source)) {
    await client.unsafe(statement);
  }
}

type SnapshotForeignKey = { name?: string };
type SnapshotTable = { foreignKeys?: Record<string, SnapshotForeignKey> };
type Snapshot = { tables?: Record<string, SnapshotTable> };

async function snapshotForeignKeyNames(): Promise<string[]> {
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as Snapshot;
  return Object.values(snapshot.tables ?? {})
    .flatMap((table) => Object.values(table.foreignKeys ?? {}))
    .map((foreignKey) => foreignKey.name)
    .filter((name): name is string => Boolean(name))
    .sort();
}

async function assertSnapshotConstraintNames(
  client: ReturnType<typeof postgres>
): Promise<void> {
  const expected = await snapshotForeignKeyNames();
  const rows = await client.unsafe(`
    SELECT conname
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND contype = 'f'
    ORDER BY conname
  `);
  const actual = rows.map((row) => String(row.conname)).sort();
  assert.deepEqual(
    actual,
    expected,
    'applied PostgreSQL FK names must exactly match the latest Drizzle snapshot'
  );
}

async function assertConstraintValidation(
  client: ReturnType<typeof postgres>,
  constraintNames: readonly string[],
  expectedValidated: boolean,
  message: string
): Promise<void> {
  const rows = await client.unsafe(
    `
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace
        AND conname = ANY ($1::text[])
      ORDER BY conname
    `,
    [constraintNames]
  );

  assert.deepEqual(
    rows.map((row) => ({
      name: String(row.conname),
      validated: Boolean(row.convalidated),
    })),
    [...constraintNames]
      .sort()
      .map((name) => ({ name, validated: expectedValidated })),
    message
  );
}

async function assertCanonicalUniqueConstraints(
  client: ReturnType<typeof postgres>
): Promise<void> {
  const expectedNames = [...canonicalUniqueConstraints].sort();
  const rows = await client.unsafe(`
    SELECT constraint_entry.conname, constraint_entry.contype, backing_index.relname AS index_name
    FROM pg_constraint AS constraint_entry
    LEFT JOIN pg_class AS backing_index ON backing_index.oid = constraint_entry.conindid
    WHERE constraint_entry.connamespace = 'public'::regnamespace
      AND constraint_entry.conname = ANY (
        ARRAY[
          'communities_slug_unique',
          'story_place_unique',
          'story_speaker_unique',
          'users_email_community_unique'
        ]::text[]
      )
    ORDER BY constraint_entry.conname
  `);

  assert.deepEqual(
    rows.map((row) => ({
      name: String(row.conname),
      type: String(row.contype),
      indexName: row.index_name ? String(row.index_name) : null,
    })),
    expectedNames.map((name) => ({
      name,
      type: 'u',
      indexName: name,
    })),
    'PostgreSQL shared uniqueness rules must be named UNIQUE constraints with matching backing indexes, not bare unique indexes'
  );
}

async function assertFileTimestampDefaultsAbsent(
  client: ReturnType<typeof postgres>
): Promise<void> {
  const rows = await client.unsafe(`
    SELECT column_name, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'files'
      AND column_name IN ('created_at', 'updated_at')
    ORDER BY column_name
  `);
  assert.deepEqual(
    rows.map((row) => ({
      columnName: String(row.column_name),
      columnDefault: row.column_default ?? null,
    })),
    [
      { columnName: 'created_at', columnDefault: null },
      { columnName: 'updated_at', columnDefault: null },
    ],
    'PostgreSQL file timestamps must not have database defaults when SQLite/schema history does not'
  );
}

async function verifyLegacyCommunityOwnershipOrphanUpgrade(
  client: ReturnType<typeof postgres>
): Promise<void> {
  await resetDatabase(client);
  await installPreviousRelease(client);

  await client.unsafe(`
    INSERT INTO users
      (id, email, password_hash, first_name, last_name, role, community_id, is_active, created_at, updated_at)
    VALUES
      (991, 'legacy-orphan@example.com', 'hash', 'Legacy', 'User', 'viewer', 999991, true, now(), now())
  `);
  await client.unsafe(`
    INSERT INTO places
      (id, name, community_id, latitude, longitude, created_at, updated_at)
    VALUES
      (992, 'Legacy orphan place', 999992, 1, 1, now(), now())
  `);
  await client.unsafe(`
    INSERT INTO speakers
      (id, name, community_id, created_at, updated_at)
    VALUES
      (993, 'Legacy orphan speaker', 999993, now(), now())
  `);
  await client.unsafe(`
    INSERT INTO stories
      (id, title, slug, community_id, created_by, created_at, updated_at)
    VALUES
      (994, 'Legacy orphan story', 'legacy-orphan-story', 999994, 991, now(), now())
  `);

  await migrate(drizzle(client), { migrationsFolder });

  await assertConstraintValidation(
    client,
    stagedCommunityOwnershipConstraints,
    false,
    'legacy community orphans must keep newly introduced ownership FKs staged and unvalidated'
  );
  await assertSnapshotConstraintNames(client);

  const preservedRows = await client.unsafe(`
    SELECT 'users' AS table_name, id, community_id FROM users WHERE id = 991
    UNION ALL
    SELECT 'places' AS table_name, id, community_id FROM places WHERE id = 992
    UNION ALL
    SELECT 'speakers' AS table_name, id, community_id FROM speakers WHERE id = 993
    UNION ALL
    SELECT 'stories' AS table_name, id, community_id FROM stories WHERE id = 994
    ORDER BY table_name
  `);
  assert.deepEqual(
    preservedRows.map((row) => ({
      tableName: String(row.table_name),
      id: Number(row.id),
      communityId: Number(row.community_id),
    })),
    [
      { tableName: 'places', id: 992, communityId: 999992 },
      { tableName: 'speakers', id: 993, communityId: 999993 },
      { tableName: 'stories', id: 994, communityId: 999994 },
      { tableName: 'users', id: 991, communityId: 999991 },
    ],
    'legacy orphan ownership rows must be preserved exactly during upgrade'
  );

  await assert.rejects(
    client.unsafe(`
      INSERT INTO users
        (email, password_hash, first_name, last_name, role, community_id, is_active, created_at, updated_at)
      VALUES
        ('new-orphan@example.com', 'hash', 'New', 'User', 'viewer', 999981, true, now(), now())
    `),
    undefined,
    'staged user ownership FK must reject new orphan writes'
  );
  await assert.rejects(
    client.unsafe(`
      INSERT INTO places
        (name, community_id, latitude, longitude, created_at, updated_at)
      VALUES
        ('New orphan place', 999982, 1, 1, now(), now())
    `),
    undefined,
    'staged place ownership FK must reject new orphan writes'
  );
  await assert.rejects(
    client.unsafe(`
      INSERT INTO speakers
        (name, community_id, created_at, updated_at)
      VALUES
        ('New orphan speaker', 999983, now(), now())
    `),
    undefined,
    'staged speaker ownership FK must reject new orphan writes'
  );
  await assert.rejects(
    client.unsafe(`
      INSERT INTO stories
        (title, slug, community_id, created_by, created_at, updated_at)
      VALUES
        ('New orphan story', 'new-orphan-story', 999984, 991, now(), now())
    `),
    undefined,
    'staged story ownership FK must reject new orphan writes'
  );
}

async function verifyOrphanThemeUpgrade(
  client: ReturnType<typeof postgres>
): Promise<void> {
  await resetDatabase(client);
  await installPreviousRelease(client);
  await client.unsafe(`
    INSERT INTO themes
      (id, name, community_id, created_at, updated_at)
    VALUES
      (999, 'Legacy orphan theme', 999999, now(), now())
  `);

  await migrate(drizzle(client), { migrationsFolder });

  await assertFileTimestampDefaultsAbsent(client);
  await assertCanonicalUniqueConstraints(client);
  await assertConstraintValidation(
    client,
    stagedCommunityOwnershipConstraints,
    true,
    'ownership FKs must validate on clean previous-release upgrades'
  );

  const [legacyTheme] = await client.unsafe(
    'SELECT id, community_id FROM themes WHERE id = 999'
  );
  assert.equal(String(legacyTheme?.community_id), '999999');

  const [constraint] = await client.unsafe(`
    SELECT convalidated
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conname = 'themes_community_id_communities_id_fk'
  `);
  assert.ok(constraint, 'theme ownership FK must exist after legacy upgrade');
  assert.equal(
    constraint.convalidated,
    false,
    'legacy orphan rows must keep the staged FK unvalidated until remediated'
  );
  await assertSnapshotConstraintNames(client);

  await assert.rejects(
    client.unsafe(`
      INSERT INTO themes
        (name, community_id, created_at, updated_at)
      VALUES
        ('New orphan theme', 999998, now(), now())
    `),
    undefined,
    'staged FK must reject new orphan theme writes'
  );
}

async function verifyFreshSnapshotConstraintNames(
  client: ReturnType<typeof postgres>
): Promise<void> {
  await resetDatabase(client);
  await migrate(drizzle(client), { migrationsFolder });
  await assertSnapshotConstraintNames(client);
  await assertFileTimestampDefaultsAbsent(client);
  await assertCanonicalUniqueConstraints(client);
  await assertConstraintValidation(
    client,
    stagedCommunityOwnershipConstraints,
    true,
    'fresh databases must fully validate community ownership FKs'
  );

  const [themeConstraint] = await client.unsafe(`
    SELECT convalidated
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conname = 'themes_community_id_communities_id_fk'
  `);
  assert.equal(
    themeConstraint?.convalidated,
    true,
    'fresh databases must fully validate the theme ownership FK'
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, 'DATABASE_URL is required');
  assertSafeTestDatabase(databaseUrl);

  const client = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
  try {
    console.log('🐘 PostgreSQL migration regression gate');
    console.log(
      '  1/3 previous-schema ownership orphan expand-contract upgrade'
    );
    await verifyLegacyCommunityOwnershipOrphanUpgrade(client);
    console.log('  2/3 orphan-theme expand-contract upgrade');
    await verifyOrphanThemeUpgrade(client);
    console.log('  3/3 applied constraints match Drizzle snapshot semantics');
    await verifyFreshSnapshotConstraintNames(client);
    console.log('✅ PostgreSQL migration regression gate passed');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('❌ PostgreSQL migration regression gate failed');
  console.error(error);
  process.exitCode = 1;
});
