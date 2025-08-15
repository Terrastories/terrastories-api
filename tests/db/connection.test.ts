import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
});
