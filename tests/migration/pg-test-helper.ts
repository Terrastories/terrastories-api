import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

export type RailsSchemaPin = '2024' | '2025';

export const fixtureDir = dirname(
  fileURLToPath(new URL('../fixtures/rails/schema.sql', import.meta.url))
);

function assertSafeDbIdentifier(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Unsafe PostgreSQL test database identifier: ${name}`);
  }
}

export async function withIsolatedRailsDatabase(
  baseUrl: string,
  fn: (dbUrl: string, pool: Pool) => Promise<void>
): Promise<void> {
  const dbName = `rails_mig_test_${randomBytes(6).toString('hex')}`;
  assertSafeDbIdentifier(dbName);

  const adminPool = new Pool({ connectionString: baseUrl, max: 1 });
  let targetPool: Pool | null = null;

  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
    const targetUrl = new URL(baseUrl);
    targetUrl.pathname = `/${dbName}`;
    const dbUrl = targetUrl.toString();

    targetPool = new Pool({ connectionString: dbUrl, max: 2 });
    await fn(dbUrl, targetPool);
  } finally {
    if (targetPool) {
      await targetPool.end();
    }
    try {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName]
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
      await adminPool.end();
    }
  }
}

export async function loadFixtureSql(
  pool: Pool,
  pin: RailsSchemaPin
): Promise<void> {
  await pool.query(await readFile(join(fixtureDir, 'schema.sql'), 'utf8'));
  if (pin === '2025') {
    await pool.query(
      await readFile(join(fixtureDir, 'schema-2025_11_20.delta.sql'), 'utf8')
    );
  }
  await pool.query(await readFile(join(fixtureDir, 'data.sql'), 'utf8'));
  await pool.query(await readFile(join(fixtureDir, 'edge-data.sql'), 'utf8'));
}
