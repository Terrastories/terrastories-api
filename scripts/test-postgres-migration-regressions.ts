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
    console.log('  1/2 orphan-theme expand-contract upgrade');
    await verifyOrphanThemeUpgrade(client);
    console.log('  2/2 applied FK names match Drizzle snapshot');
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
