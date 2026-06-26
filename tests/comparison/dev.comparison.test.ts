/**
 * Dev Endpoints — V1 Compatibility Test
 *
 * Captures the exact response shape of dev/seed endpoint:
 *   GET /dev/seed — Seeds the database with test data
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, ApiTestClient } from '../helpers/api-client';
import { testDb } from '../helpers/database';
import type { FastifyInstance } from 'fastify';

describe('V1 Compatibility: Dev Endpoints', () => {
  let app: FastifyInstance;
  let client: ApiTestClient;

  beforeAll(async () => {
    const db = await testDb.setup();
    app = await createTestApp(db);
    client = new ApiTestClient(app);
  }, 30000);

  afterAll(async () => {
    await testDb.teardown();
  }, 30000);

  // ═══════════════════════════════════════════════════════════════════
  // GET /dev/seed
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /dev/seed', () => {
    it('should return actual V1 test-env seed response', async () => {
      const res = await client.get('/dev/seed');
      // In this compatibility test environment V1's dev seed endpoint fails.
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('error');
    });

    it('should not return success counts when seeding fails', async () => {
      const res = await client.get('/dev/seed');
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body).not.toHaveProperty('total');
      expect(body).not.toHaveProperty('counts');
    });

    it('should consistently return the V1 test-env failure', async () => {
      // Call seed twice; in this environment V1 fails both times.
      const res1 = await client.get('/dev/seed');
      expect(res1.statusCode).toBe(500);

      const res2 = await client.get('/dev/seed');
      expect(res2.statusCode).toBe(500);

      const body2 = JSON.parse(res2.body);
      expect(body2).toHaveProperty('error');
    });
  });
});
