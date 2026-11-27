import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import Database from 'better-sqlite3';
import postgres from 'postgres';
import { getConfig } from '../shared/config/index.js';

// Database type for repositories
/** PostgreSQL TLS option for postgres.js from the validated config. */
export function resolvePostgresSsl(database: {
  ssl: boolean;
  sslMode?: 'disable' | 'require' | 'verify-full' | undefined;
}): false | 'require' | 'verify-full' {
  const mode = database.sslMode ?? (database.ssl ? 'require' : 'disable');
  return mode === 'disable' ? false : mode;
}

export type Database =
  | ReturnType<typeof drizzleSqlite>
  | ReturnType<typeof drizzlePostgres>;

/**
 * Session settings every application PostgreSQL connection must use.
 *
 * Timestamp columns are `timestamp without time zone` holding UTC, and
 * Drizzle decodes them as UTC. `defaultNow()` writes the session's local wall
 * clock, so the session time zone is pinned to UTC; otherwise a server whose
 * default time zone is not UTC (common on native installs) stores defaults
 * offset by its UTC offset.
 */
export const postgresSessionSettings = { TimeZone: 'UTC' } as const;

/** Create a postgres.js client with the required session settings. */
export function createPostgresClient(
  url: string,
  options: postgres.Options<Record<string, postgres.PostgresType>> = {}
): postgres.Sql {
  return postgres(url, {
    ...options,
    connection: { ...options.connection, ...postgresSessionSettings },
  });
}

let db: Database | null = null;
let connectionProbe: (() => Promise<void>) | null = null;
let closeConnection: (() => Promise<void>) | null = null;

export async function getDb(): Promise<Database> {
  if (db) return db;

  const config = getConfig();
  // Determine database type from URL
  const isPostgres =
    config.database.url.startsWith('postgresql://') ||
    config.database.url.startsWith('postgres://');

  if (isPostgres) {
    const queryClient = createPostgresClient(config.database.url, {
      max: config.database.poolSize,
      ssl: resolvePostgresSsl(config.database),
    });
    db = drizzlePostgres(queryClient);
    closeConnection = () => queryClient.end();
    connectionProbe = async () => {
      await queryClient`SELECT 1`;
    };
  } else {
    const dbPath =
      config.environment === 'test' ? ':memory:' : config.database.url;
    const sqliteClient = new Database(dbPath);
    db = drizzleSqlite(sqliteClient);
    closeConnection = async () => {
      sqliteClient.close();
    };
    connectionProbe = async () => {
      sqliteClient.prepare('SELECT 1').get();
    };
  }

  return db;
}

export async function closeDb(): Promise<void> {
  if (closeConnection) await closeConnection();
  db = null;
  connectionProbe = null;
  closeConnection = null;
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
    if (!connectionProbe) {
      throw new Error('Database connection probe is unavailable');
    }
    await connectionProbe();

    return {
      connected: true,
      spatialSupport: true,
      version: 'application-level',
    };
  } catch {
    // Keep the shared client alive. postgres.js reconnects its pool after
    // transient failures, and route repositories retain this Drizzle instance.
    return {
      connected: false,
      spatialSupport: false,
      version: null,
    };
  }
}

export { db };
