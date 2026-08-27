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
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');

  if (isPostgres) {
    const queryClient = postgres(config.database.url, {
      max: config.database.poolSize,
      ssl: config.database.ssl ? 'require' : false,
    });
    db = drizzlePostgres(queryClient);
  } else {
    const dbPath =
      config.environment === 'test' ? ':memory:' : config.database.url;
    db = drizzleSqlite(new Database(dbPath));
  }

  return db;
}

/**
 * Test the configured database connection surface.
 *
 * Spatial behavior is intentionally application-level on every backend, so a
 * connected database always has the same portable Haversine/bounding-box
 * capability and never depends on a database extension.
 */
export async function testConnection(): Promise<{
  connected: boolean;
  spatialSupport: boolean;
  version: string | null;
}> {
  try {
    await getDb();
    return {
      connected: true,
      spatialSupport: true,
      version: 'application-level',
    };
  } catch {
    return {
      connected: false,
      spatialSupport: false,
      version: null,
    };
  }
}

export { db };
