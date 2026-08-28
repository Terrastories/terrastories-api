import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getDb } from '../../src/db/index.js';

describe('Database Connection', () => {
  let db: any;

  beforeAll(async () => {
    db = await getDb();
  });

  afterAll(async () => {
    // Close database connection if needed
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('should establish database connection', async () => {
    expect(db).toBeDefined();
  });

  it('should execute a simple query', async () => {
    // Test basic SQL execution capability using Drizzle's sql helper
    const { sql } = await import('drizzle-orm');
    const result = await db.all(sql`SELECT 1 as test`);
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
  });

  it(
    'should report PostgreSQL unavailable when the configured server cannot be queried',
    async () => {
      const originalDatabaseUrl = process.env.DATABASE_URL;

      try {
        process.env.DATABASE_URL =
          'postgresql://terrastories:terrastories-test@127.0.0.1:1/terrastories_test';
        vi.resetModules();

        const { testConnection } = await import('../../src/db/index.js');
        const result = await testConnection();

        expect(result).toEqual({
          connected: false,
          spatialSupport: false,
          version: null,
        });
      } finally {
        if (originalDatabaseUrl === undefined) {
          delete process.env.DATABASE_URL;
        } else {
          process.env.DATABASE_URL = originalDatabaseUrl;
        }
        vi.resetModules();
      }
    }
  );
});