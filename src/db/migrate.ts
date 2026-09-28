/**
 * Database Migration Runner
 *
 * Runs pending migrations for the configured database without crossing dialects.
 * SQLite/D1-compatible and PostgreSQL migration histories are intentionally kept
 * separate because Drizzle migration SQL is dialect-specific.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { getDb, testConnection } from './index.js';
import { getConfig } from '../shared/config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type MigrationDialect = 'sqlite' | 'postgresql';

export function getMigrationPlan(databaseUrl: string): {
  dialect: MigrationDialect;
  migrationsFolder: string;
} {
  const isPostgres =
    databaseUrl.startsWith('postgresql://') ||
    databaseUrl.startsWith('postgres://');

  if (!isPostgres && /^[a-z][a-z0-9+.-]*:\/\//i.test(databaseUrl)) {
    throw new Error(`Unsupported database URL dialect: ${databaseUrl}`);
  }

  if (isPostgres) {
    const migrationsFolder = path.join(__dirname, 'migrations', 'postgres');
    const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');

    if (!existsSync(journalPath)) {
      throw new Error(
        'PostgreSQL migration history is not present. Refusing to run the SQLite/D1 migration set against PostgreSQL.'
      );
    }

    return { dialect: 'postgresql', migrationsFolder };
  }

  return {
    dialect: 'sqlite',
    migrationsFolder: path.join(__dirname, 'migrations'),
  };
}

async function runMigrations() {
  try {
    console.log('🔄 Running database migrations...');

    const config = getConfig();
    const plan = getMigrationPlan(config.database.url);
    const database = await getDb();

    if (plan.dialect === 'postgresql') {
      console.log('📊 Running PostgreSQL migrations...');
      await migratePostgres(
        database as ReturnType<
          typeof import('drizzle-orm/postgres-js').drizzle
        >,
        { migrationsFolder: plan.migrationsFolder }
      );
    } else {
      console.log('📊 Running SQLite/D1-compatible migrations...');
      await migrateSqlite(
        database as ReturnType<
          typeof import('drizzle-orm/better-sqlite3').drizzle
        >,
        { migrationsFolder: plan.migrationsFolder }
      );
    }

    const connectionTest = await testConnection();
    if (!connectionTest.connected) {
      throw new Error('Database connection test failed after migrations');
    }

    console.log('✅ Migrations completed successfully!');
    console.log('🔍 Database connection test: ✅');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runMigrations();
}
