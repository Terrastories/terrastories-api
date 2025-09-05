import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import Database from 'better-sqlite3';
import postgres from 'postgres';
import { getConfig } from '../shared/config/index.js';

// Database type for repositories
export type Database =
  | ReturnType<typeof drizzleSqlite>
  | ReturnType<typeof drizzlePostgres>;

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (db) return db;

  const config = getConfig();

  // Determine database type from URL
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');

  if (isPostgres) {
    // PostgreSQL with PostGIS support
    const connectionString = config.database.url;
    const queryClient = postgres(connectionString, {
      max: config.database.poolSize,
      ssl: config.database.ssl ? 'require' : false,
      prepare: false, // Required for PostGIS spatial functions
      // Note: PostGIS type configuration would go here in production
      // For now, keeping it simple to avoid TypeScript issues
    });

    db = drizzlePostgres(queryClient);

    // Verify PostGIS extension
    if (config.database.spatialSupport && config.environment !== 'test') {
      try {
        await queryClient`SELECT PostGIS_Version()`;
        // PostGIS extension verified
      } catch {
        // PostGIS extension not found - spatial features will be limited
      }
    }
  } else {
    // SQLite with SpatiaLite support for development/testing
    const dbPath =
      config.environment === 'test' ? ':memory:' : config.database.url;
    const sqlite = new Database(dbPath);

    // Enable spatial support for SQLite if available
    if (config.database.spatialSupport) {
      try {
        sqlite.loadExtension('mod_spatialite');
        sqlite.exec('SELECT InitSpatialMetaData()');
        // SpatiaLite extension loaded
      } catch {
        // SpatiaLite extension not found - spatial features will be limited
      }
    }

    db = drizzleSqlite(sqlite);
  }

  return db;
}

/**
 * Test database connection and spatial capabilities
 */
export async function testConnection(): Promise<{
  connected: boolean;
  spatialSupport: boolean;
  version: string | null;
}> {
  try {
    const database = await getDb();
    const config = getConfig();

    let spatialSupport = false;
    let version: string | null = null;

    if (
      config.database.url.startsWith('postgresql://') ||
      config.database.url.startsWith('postgres://')
    ) {
      // Test PostgreSQL + PostGIS
      try {
        const result = await (
          database as ReturnType<typeof drizzlePostgres>
        ).execute('SELECT PostGIS_Version() as version');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        version = (result as any).rows[0]?.version || null;
        spatialSupport = !!version;
      } catch {
        spatialSupport = false;
      }
    } else {
      // Test SQLite + SpatiaLite
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (database as any)
          .prepare('SELECT spatialite_version() as version')
          .get();
        version = result?.version || null;
        spatialSupport = !!version;
      } catch {
        spatialSupport = false;
      }
    }

    return {
      connected: true,
      spatialSupport,
      version,
    };
  } catch {
    // Database connection test failed
    return {
      connected: false,
      spatialSupport: false,
      version: null,
    };
  }
}

export { db };
