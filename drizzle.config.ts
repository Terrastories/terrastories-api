import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';

dotenv.config();

// Determine database type from URL
const databaseUrl = process.env.DATABASE_URL || './data.db';
const isPostgres = databaseUrl.startsWith('postgresql://') ||
                   databaseUrl.startsWith('postgres://');

export default defineConfig({
  dialect: isPostgres ? 'postgresql' : 'sqlite',
  schema: './dist/db/schema/index.js',
  out: './src/db/migrations',
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
