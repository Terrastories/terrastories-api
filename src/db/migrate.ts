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
    // eslint-disable-next-line no-console
    console.log('🔄 Running database migrations...');

    const config = getConfig();
    const database = await getDb();

    const isPostgres =
      config.database.url.startsWith('postgresql://') ||
      config.database.url.startsWith('postgres://');

    const migrationsFolder = path.join(__dirname, 'migrations');

    if (isPostgres) {
      // eslint-disable-next-line no-console
      console.log('📊 Running PostgreSQL migrations...');

      // Ensure PostGIS extension is enabled before running migrations
      if (config.database.spatialSupport) {
        // eslint-disable-next-line no-console
        console.log('🌍 Setting up PostGIS extension...');
        try {
          const pgDatabase = database as ReturnType<
            typeof import('drizzle-orm/postgres-js').drizzle
          >;
          await pgDatabase.execute('CREATE EXTENSION IF NOT EXISTS postgis;');
          await pgDatabase.execute(
            'CREATE EXTENSION IF NOT EXISTS postgis_topology;'
          );
          // eslint-disable-next-line no-console
          console.log('✅ PostGIS extensions enabled');
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          // eslint-disable-next-line no-console
          console.warn('⚠️ Could not enable PostGIS extensions:', errorMessage);
          // eslint-disable-next-line no-console
          console.warn('   Please ensure PostgreSQL has PostGIS installed');
        }
      }

      await migratePostgres(
        database as ReturnType<
          typeof import('drizzle-orm/postgres-js').drizzle
        >,
        { migrationsFolder }
      );
    } else {
      // eslint-disable-next-line no-console
      console.log('📊 Running SQLite migrations...');
      await migrate(
        database as ReturnType<
          typeof import('drizzle-orm/better-sqlite3').drizzle
        >,
        { migrationsFolder }
      );
    }

    // eslint-disable-next-line no-console
    console.log('✅ Migrations completed successfully!');

    // Test the connection after migration
    const { testConnection } = await import('./index.js');
    const connectionTest = await testConnection();

    // eslint-disable-next-line no-console
    console.log('🔍 Database connection test:');
    // eslint-disable-next-line no-console
    console.log(`  Connected: ${connectionTest.connected ? '✅' : '❌'}`);
    // eslint-disable-next-line no-console
    console.log(
      `  Spatial Support: ${connectionTest.spatialSupport ? '✅' : '❌'}`
    );
    if (connectionTest.version) {
      // eslint-disable-next-line no-console
      console.log(`  Spatial Version: ${connectionTest.version}`);
    }

    process.exit(0);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigrations();
