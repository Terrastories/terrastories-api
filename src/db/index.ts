import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { getConfig } from '../shared/config/index.js';

let db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (db) return db;

  const config = getConfig();
  const dbPath =
    config.environment === 'test' ? ':memory:' : config.database.url;

  const sqlite = new Database(dbPath);
  db = drizzle(sqlite);

  return db;
}

export { db };
