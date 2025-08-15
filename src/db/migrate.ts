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

    const migrationsFolder = path.join(__dirname, 'migrations');

    if (isPostgres) {
      console.log('📊 Running PostgreSQL migrations...');

      // Ensure PostGIS extension is enabled before running migrations
      if (config.database.spatialSupport) {
        console.log('🌍 Setting up PostGIS extension...');
        try {
          const pgDatabase = database as ReturnType<
            typeof import('drizzle-orm/postgres-js').drizzle
          >;
          await pgDatabase.execute('CREATE EXTENSION IF NOT EXISTS postgis;');
          await pgDatabase.execute(
            'CREATE EXTENSION IF NOT EXISTS postgis_topology;'
          );
          console.log('✅ PostGIS extensions enabled');
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          console.warn('⚠️ Could not enable PostGIS extensions:', errorMessage);
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
      console.log('📊 Running SQLite migrations...');
      await migrate(
        database as ReturnType<
          typeof import('drizzle-orm/better-sqlite3').drizzle
        >,
        { migrationsFolder }
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

    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigrations();
