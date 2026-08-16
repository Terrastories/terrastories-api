/**
 * Database Migration Runner
 *
 * Runs all pending migrations for the configured database
 */

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import { getDb } from './index.js';
import { getConfig } from '../shared/config/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  try {
    console.log('🔄 Running database migrations...');

    const config = getConfig();
    const database = await getDb();

    const isPostgres =
      config.database.url.startsWith('postgresql://') ||
      config.database.url.startsWith('postgres://');

    const sqliteMigrationsFolder = path.join(__dirname, 'migrations');
    const postgresMigrationsFolder = path.join(
      __dirname,
      'migrations',
      'postgres'
    );

    if (isPostgres) {
      console.log('📊 Running PostgreSQL migrations...');

      // Production spatial support is fail-closed. Continuing without PostGIS
      // would make a successful startup hide a broken production capability.
      if (config.database.spatialSupport) {
        console.log('🌍 Setting up PostGIS extension...');
        const pgDatabase = database as ReturnType<
          typeof import('drizzle-orm/postgres-js').drizzle
        >;
        await pgDatabase.execute('CREATE EXTENSION IF NOT EXISTS postgis;');
        console.log('✅ PostGIS extension enabled');
      }

      await migratePostgres(
        database as ReturnType<
          typeof import('drizzle-orm/postgres-js').drizzle
        >,
        { migrationsFolder: postgresMigrationsFolder }
      );
    } else {
      console.log('📊 Running SQLite migrations...');
      await migrate(
        database as ReturnType<
          typeof import('drizzle-orm/better-sqlite3').drizzle
        >,
        { migrationsFolder: sqliteMigrationsFolder }
      );
    }

    console.log('✅ Migrations completed successfully!');

    // Test the connection after migration
    const { testConnection } = await import('./index.js');
    const connectionTest = await testConnection();

    console.log('🔍 Database connection test:');

    console.log(`  Connected: ${connectionTest.connected ? '✅' : '❌'}`);

    console.log(
      `  Spatial Support: ${connectionTest.spatialSupport ? '✅' : '❌'}`
    );
    if (connectionTest.version) {
      console.log(`  Spatial Version: ${connectionTest.version}`);
    }

    if (!connectionTest.connected) {
      throw new Error('Database connection check failed after migration');
    }

    if (
      isPostgres &&
      config.database.spatialSupport &&
      !connectionTest.spatialSupport
    ) {
      throw new Error('PostGIS verification failed after migration');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigrations();
