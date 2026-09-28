import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();

interface SnapshotIndex {
  name?: string;
}

interface SnapshotTable {
  indexes?: Record<string, SnapshotIndex>;
}

interface Snapshot {
  tables?: Record<string, SnapshotTable>;
}

async function assertAuthIndexesInSnapshot(
  label: string,
  snapshotPath: string,
  tableKey: string
): Promise<void> {
  const snapshot = JSON.parse(
    await readFile(path.join(rootDir, snapshotPath), 'utf8')
  ) as Snapshot;
  const table = snapshot.tables?.[tableKey];
  assert.ok(table, `${label} snapshot must contain ${tableKey}`);

  const indexNames = Object.values(table.indexes ?? {})
    .map((index) => index.name)
    .filter((name): name is string => Boolean(name))
    .sort();

  for (const expected of [
    'idx_users_community_email',
    'idx_users_reset_password_token',
  ]) {
    assert.ok(
      indexNames.includes(expected),
      `${label} snapshot must declare applied authentication index ${expected}`
    );
  }
}

async function main(): Promise<void> {
  console.log('🧭 Migration metadata regression gate');
  await assertAuthIndexesInSnapshot(
    'SQLite',
    'src/db/migrations/meta/0003_snapshot.json',
    'users'
  );
  await assertAuthIndexesInSnapshot(
    'PostgreSQL',
    'src/db/migrations/postgres/meta/0001_snapshot.json',
    'public.users'
  );
  console.log('✅ Migration metadata regression gate passed');
}

main().catch((error) => {
  console.error('❌ Migration metadata regression gate failed');
  console.error(error);
  process.exitCode = 1;
});
