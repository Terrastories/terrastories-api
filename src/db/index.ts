import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

let db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (db) return db;

  // Use test database in test environment
  const dbPath =
    process.env.NODE_ENV === 'test'
      ? ':memory:'
      : process.env.DATABASE_URL || 'data.db';

  const sqlite = new Database(dbPath);
  db = drizzle(sqlite);

  return db;
}

export { db };
