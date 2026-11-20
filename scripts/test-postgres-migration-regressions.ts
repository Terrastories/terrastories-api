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
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const rootDir = process.cwd();
const migrationsFolder = path.join(rootDir, 'src/db/migrations/postgres');
const previousReleaseFixture = path.join(
  rootDir,
  'tests/fixtures/db/postgres-previous-release.sql'
);
const snapshotPath = path.join(migrationsFolder, 'meta/0012_snapshot.json');

const canonicalUniqueConstraints = [
  'communities_slug_unique',
  'users_email_community_unique',
  // #186: composite parent keys for the tenant foreign keys.
  'places_community_id_id_unique',
  'speakers_community_id_id_unique',
  'stories_community_id_id_unique',
  'files_community_id_id_unique',
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
  await client.unsafe('DROP SCHEMA IF EXISTS issue135_collision CASCADE');
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
          'users_email_community_unique',
          'places_community_id_id_unique',
          'speakers_community_id_id_unique',
          'stories_community_id_id_unique',
          'files_community_id_id_unique'
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

async function verifyConstraintNameCollisionUpgrade(
  client: ReturnType<typeof postgres>
): Promise<void> {
  await resetDatabase(client);
  await installPreviousRelease(client);

  await client.unsafe('CREATE SCHEMA issue135_collision');
  await client.unsafe(`
    CREATE TABLE issue135_collision.communities (
      id integer PRIMARY KEY
    )
  `);
  for (const [tableName, constraintName] of [
    ['users', 'users_community_id_communities_id_fk'],
    ['places', 'places_community_id_communities_id_fk'],
    ['speakers', 'speakers_community_id_communities_id_fk'],
    ['stories', 'stories_community_id_communities_id_fk'],
  ] as const) {
    await client.unsafe(`
      CREATE TABLE issue135_collision.${tableName} (
        community_id integer NOT NULL,
        CONSTRAINT ${constraintName}
          FOREIGN KEY (community_id)
          REFERENCES issue135_collision.communities(id)
      )
    `);
  }

  try {
    await migrate(drizzle(client), { migrationsFolder });
    await assertConstraintValidation(
      client,
      stagedCommunityOwnershipConstraints,
      true,
      'same-named constraints in another schema must not suppress public ownership FKs'
    );
    await assertSnapshotConstraintNames(client);

    await assert.rejects(
      client.unsafe(`
        INSERT INTO users
          (email, password_hash, first_name, last_name, role, community_id, is_active, created_at, updated_at)
        VALUES
          ('collision-orphan@example.com', 'hash', 'Collision', 'User', 'viewer', 999971, true, now(), now())
      `),
      undefined,
      'public user ownership FK must reject new orphan writes despite same-named constraints elsewhere'
    );
  } finally {
    await client.unsafe('DROP SCHEMA IF EXISTS issue135_collision CASCADE');
  }
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

async function createPostgresMigrationsFolderThrough(
  lastTag: string
): Promise<string> {
  const folder = await mkdtemp(
    path.join(os.tmpdir(), 'terrastories-pg-through-')
  );
  await mkdir(path.join(folder, 'meta'));
  const journal = JSON.parse(
    await readFile(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')
  ) as { entries: Array<{ tag: string }> };
  const end = journal.entries.findIndex((entry) => entry.tag === lastTag);
  assert.ok(end >= 0, `PostgreSQL migration ${lastTag} must exist`);
  const entries = journal.entries.slice(0, end + 1);
  for (const entry of entries) {
    await copyFile(
      path.join(migrationsFolder, `${entry.tag}.sql`),
      path.join(folder, `${entry.tag}.sql`)
    );
  }
  await writeFile(
    path.join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries }, null, 2)
  );
  return folder;
}

async function verifySlice2BackfillAndOrphanUpgrade(
  client: ReturnType<typeof postgres>
): Promise<void> {
  await resetDatabase(client);
  const through0008 = await createPostgresMigrationsFolderThrough(
    '0008_users_identity_and_audit_entries'
  );
  try {
    await migrate(drizzle(client), { migrationsFolder: through0008 });
  } finally {
    await rm(through0008, { recursive: true, force: true });
  }

  const fileA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const fileB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const orphanFile = '99999999-9999-4999-8999-999999999999';

  await client`
    INSERT INTO communities (id, name, slug, created_at, updated_at)
    VALUES (1, 'Slice2 PG Comm', 'slice2-pg-comm', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `;
  await client`
    INSERT INTO users (id, email, email_normalized, password_hash, first_name, last_name, role, community_id, created_at, updated_at)
    VALUES (1, 's2pg@example.org', 's2pg@example.org', 'hash', 'S2', 'PG', 'editor', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `;
  await client`
    INSERT INTO files (id, filename, original_name, path, url, mime_type, size, community_id, uploaded_by, created_at, updated_at)
    VALUES
      (${fileB}, 'b.png', 'b.png', 'uploads/1/b.png', ${`/v2/media/${fileB}`}, 'image/png', 222, 1, 1, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'),
      (${fileA}, 'a.png', 'a.png', 'uploads/1/a.png', ${`/v2/media/${fileA}`}, 'image/png', 111, 1, 1, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z')
  `;
  await client`
    INSERT INTO community_media (file_id, community_id, kind)
    VALUES
      (${fileB}, 1, 'branding'),
      (${fileA}, 1, 'branding')
  `;
  for (let i = 1; i <= 3; i += 1) {
    await client`
      INSERT INTO attachments (attachable_id, attachable_type, url, filename, content_type, file_size, created_at)
      VALUES (10, 'Story', ${`https://example.org/${i}.jpg`}, ${`${i}.jpg`}, 'image/jpeg', 100, '2026-01-01T00:00:01.000Z')
    `;
  }
  await client`DELETE FROM attachments WHERE id = 3`;

  // Simulate legacy orphaned files row under NOT VALID FKs so 0009's orphan-skipping
  // UPDATE guard is exercised directly.
  await client.unsafe(
    'ALTER TABLE files DROP CONSTRAINT files_community_id_communities_id_fk'
  );
  await client.unsafe(
    'ALTER TABLE files DROP CONSTRAINT files_uploaded_by_users_id_fk'
  );
  await client`
    INSERT INTO files (id, filename, original_name, path, url, mime_type, size, community_id, uploaded_by, created_at, updated_at)
    VALUES (${orphanFile}, 'orphan.png', 'orphan.png', 'uploads/orphan/x.png', ${`/v2/media/${orphanFile}`}, 'image/png', 333, 999995, 999996, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z')
  `;
  await client.unsafe(
    'ALTER TABLE files ADD CONSTRAINT files_community_id_communities_id_fk FOREIGN KEY (community_id) REFERENCES communities(id) NOT VALID'
  );
  await client.unsafe(
    'ALTER TABLE files ADD CONSTRAINT files_uploaded_by_users_id_fk FOREIGN KEY (uploaded_by) REFERENCES users(id) NOT VALID'
  );

  await migrate(drizzle(client), { migrationsFolder });
  await assertSnapshotConstraintNames(client);

  const fileRows = await client`
    SELECT id, path, storage_key, size, byte_size, checksum, community_id, uploaded_by
    FROM files
    ORDER BY path
  `;
  const byId = new Map(fileRows.map((row) => [String(row.id), row]));
  assert.equal(byId.get(fileA)?.storage_key, 'uploads/1/a.png');
  assert.equal(Number(byId.get(fileA)?.byte_size), 111);
  assert.equal(byId.get(fileA)?.checksum, null);
  assert.equal(byId.get(fileB)?.storage_key, 'uploads/1/b.png');
  assert.equal(Number(byId.get(fileB)?.byte_size), 222);
  assert.equal(byId.get(fileB)?.checksum, null);
  assert.equal(byId.get(orphanFile)?.community_id, 999995);
  assert.equal(byId.get(orphanFile)?.uploaded_by, 999996);
  assert.equal(byId.get(orphanFile)?.storage_key, null);
  assert.equal(byId.get(orphanFile)?.byte_size, null);

  const [{ cmCount }] = await client`
    SELECT count(*)::int AS "cmCount" FROM community_media
  `;
  assert.equal(cmCount, 2, 'community_media rows must remain intact');

  const attachmentRows = await client`
    SELECT id, community_id, file_id, owner_type, owner_id, role, ordinal, url, created_at
    FROM attachments
    ORDER BY id
  `;
  assert.deepEqual(
    attachmentRows.map((row) => Number(row.id)),
    [1, 2, 4, 5],
    'community_media backfill must preserve V1 attachments and advance past sequence high-water mark'
  );
  assert.deepEqual(
    {
      community_id: attachmentRows[2].community_id,
      file_id: String(attachmentRows[2].file_id),
      owner_type: attachmentRows[2].owner_type,
      owner_id: attachmentRows[2].owner_id,
      role: attachmentRows[2].role,
      ordinal: attachmentRows[2].ordinal,
      url: attachmentRows[2].url,
    },
    {
      community_id: 1,
      file_id: fileA,
      owner_type: 'community',
      owner_id: 1,
      role: 'community_display_image',
      ordinal: 0,
      url: null,
    }
  );
  assert.deepEqual(
    {
      community_id: attachmentRows[3].community_id,
      file_id: String(attachmentRows[3].file_id),
      owner_type: attachmentRows[3].owner_type,
      owner_id: attachmentRows[3].owner_id,
      role: attachmentRows[3].role,
      ordinal: attachmentRows[3].ordinal,
      url: attachmentRows[3].url,
    },
    {
      community_id: 1,
      file_id: fileB,
      owner_type: 'community',
      owner_id: 1,
      role: 'community_display_image',
      ordinal: 1,
      url: null,
    }
  );
}

async function verifySlice10SessionBackfill(
  client: ReturnType<typeof postgres>
): Promise<void> {
  await resetDatabase(client);
  const through0009 = await createPostgresMigrationsFolderThrough(
    '0009_canonical_media_and_map_configs'
  );
  try {
    await migrate(drizzle(client), { migrationsFolder: through0009 });
  } finally {
    await rm(through0009, { recursive: true, force: true });
  }

  const now = 1_700_000_000_000;
  await client`
    INSERT INTO communities (id, name, slug, created_at, updated_at)
    VALUES (1, 'Slice10 PG Comm', 'slice10-pg-comm', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `;
  await client`
    INSERT INTO users (id, email, email_normalized, password_hash, first_name, last_name, role, community_id, created_at, updated_at)
    VALUES (1, 's10pg@example.org', 's10pg@example.org', 'hash', 'S10', 'PG', 'viewer', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `;
  const expiresBig = now + 30 * 24 * 3600_000;
  await client`
    INSERT INTO sessions (id, token_hash, user_id, expires_at)
    VALUES ('sess-big', 'th-big', 1, ${expiresBig}), ('sess-small', 'th-small', 1, 1000)
  `;

  await migrate(drizzle(client), { migrationsFolder });

  // DEVICE_SESSION_ABSOLUTE_MS (5184000000 ms) is the value sessionLifetimesFor
  // applies for every kind; the migration files carry the literal.
  const absoluteLifetime = 5_184_000_000;
  const idleWindow = 43_200_000; // STANDARD_SESSION_IDLE_MS — 12h
  const rows = await client`
    SELECT id, kind, created_at, last_seen_at, idle_expires_at, absolute_expires_at
    FROM sessions
    ORDER BY id
  `;
  assert.equal(rows.length, 2, 'legacy session rows must survive 0010');
  const big = rows.find((row) => String(row.id) === 'sess-big');
  const small = rows.find((row) => String(row.id) === 'sess-small');
  assert.ok(big && small, 'both legacy sessions must be backfilled');
  // A renewing legacy session must not be cut off at its legacy expiry.
  assert.equal(String(big.kind), 'standard');
  assert.equal(Number(big.created_at), expiresBig - idleWindow);
  assert.equal(Number(big.last_seen_at), Number(big.created_at));
  assert.equal(Number(big.idle_expires_at), expiresBig);
  assert.equal(
    Number(big.absolute_expires_at),
    Math.max(Number(big.created_at) + absoluteLifetime, expiresBig)
  );
  assert.ok(
    Number(big.absolute_expires_at) > Number(big.idle_expires_at),
    'renewal window must outlive the legacy expiry'
  );
  assert.equal(String(small.kind), 'standard');
  assert.equal(Number(small.created_at), 0);
  assert.equal(Number(small.last_seen_at), 0);
  assert.equal(Number(small.idle_expires_at), 1000);
  assert.equal(Number(small.absolute_expires_at), absoluteLifetime);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, 'DATABASE_URL is required');
  assertSafeTestDatabase(databaseUrl);

  const client = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
  try {
    console.log('🐘 PostgreSQL migration regression gate');
    console.log(
      '  1/6 previous-schema ownership orphan expand-contract upgrade'
    );
    await verifyLegacyCommunityOwnershipOrphanUpgrade(client);
    console.log('  2/6 cross-schema constraint-name collision upgrade');
    await verifyConstraintNameCollisionUpgrade(client);
    console.log('  3/6 orphan-theme expand-contract upgrade');
    await verifyOrphanThemeUpgrade(client);
    console.log('  4/6 applied constraints match Drizzle snapshot semantics');
    await verifyFreshSnapshotConstraintNames(client);
    console.log(
      '  5/6 Slice 2 files/community_media backfill and orphan files guard'
    );
    await verifySlice2BackfillAndOrphanUpgrade(client);
    console.log('  6/6 Slice 10 legacy session backfill');
    await verifySlice10SessionBackfill(client);
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
