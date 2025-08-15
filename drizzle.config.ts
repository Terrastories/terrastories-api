import { defineConfig } from 'drizzle-kit';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema/communities.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL || './data.db',
  },
  verbose: true,
  strict: true,
});
