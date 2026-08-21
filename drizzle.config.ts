import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';

dotenv.config();

// Determine database type from URL
const databaseUrl = process.env.DATABASE_URL || './data.db';
const isPostgres =
  databaseUrl.startsWith('postgresql://') ||
  databaseUrl.startsWith('postgres://');

export default defineConfig({
  dialect: isPostgres ? 'postgresql' : 'sqlite',
  schema: './src/db/schema/*.ts',
  // Keep dialect-specific migration histories separate. SQLite/D1 is the
  // existing baseline; PostgreSQL migrations live under their own folder so
  // Drizzle can never overwrite or execute SQLite SQL for PostgreSQL.
  out: isPostgres ? './src/db/migrations/postgres' : './src/db/migrations',
  dbCredentials: isPostgres
    ? {
        url: databaseUrl,
      }
    : {
        url: databaseUrl,
      },
  verbose: true,
  strict: true,
});
