import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();

interface SnapshotColumn {
  name?: string;
  notNull?: boolean;
}

interface SnapshotIndex {
  name?: string;
}

interface SnapshotTable {
  columns?: Record<string, SnapshotColumn>;
  indexes?: Record<string, SnapshotIndex>;
}

interface Snapshot {
  tables?: Record<string, SnapshotTable>;
}

async function assertSnapshotMetadata(
  label: string,
  snapshotPath: string,
  usersTableKey: string,
  communitiesTableKey: string
): Promise<void> {
  const snapshot = JSON.parse(
    await readFile(path.join(rootDir, snapshotPath), 'utf8')
  ) as Snapshot;
  const table = snapshot.tables?.[usersTableKey];
  assert.ok(table, `${label} snapshot must contain ${usersTableKey}`);

  const indexNames = Object.values(table.indexes ?? {})
    .map((index) => index.name)
    .filter((name): name is string => Boolean(name))
    .sort();

  for (const expected of [
    'idx_users_community_email',
    'idx_users_reset_password_token',
    'users_username_normalized_unique',
    'users_community_email_normalized_unique',
    'users_null_community_email_normalized_unique',
  ]) {
    assert.ok(
      indexNames.includes(expected),
      `${label} snapshot must declare applied authentication index ${expected}`
    );
  }

  const communitiesTable = snapshot.tables?.[communitiesTableKey];
  assert.ok(
    communitiesTable,
    `${label} snapshot must contain ${communitiesTableKey}`
  );
  const deprovisionedAtCol = communitiesTable.columns?.deprovisioned_at;
  assert.ok(
    deprovisionedAtCol,
    `${label} snapshot must declare communities.deprovisioned_at`
  );
  assert.equal(
    deprovisionedAtCol.notNull,
    false,
    `${label} snapshot communities.deprovisioned_at must be nullable`
  );
}

async function main(): Promise<void> {
  console.log('🧭 Migration metadata regression gate');
  await assertSnapshotMetadata(
    'SQLite',
    'src/db/migrations/meta/0016_snapshot.json',
    'users',
    'communities'
  );
  await assertSnapshotMetadata(
    'PostgreSQL',
    'src/db/migrations/postgres/meta/0015_snapshot.json',
    'public.users',
    'public.communities'
  );
  console.log('✅ Migration metadata regression gate passed');
}

main().catch((error) => {
  console.error('❌ Migration metadata regression gate failed');
  console.error(error);
  process.exitCode = 1;
});
