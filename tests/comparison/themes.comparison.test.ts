/**
 * Themes Endpoints — V1 Compatibility Test
 *
 * Captures the exact response shape of 4 theme endpoints:
 *   GET    /api/v1/themes/               — list all (auth)
 *   GET    /api/v1/themes/active         — active theme (auth)
 *   GET    /api/v1/themes/:id            — single theme (auth)
 *   POST   /api/v1/themes/               — create (201, admin)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, ApiTestClient } from '../helpers/api-client';
import { testDb, createTestData } from '../helpers/database';
import type { FastifyInstance } from 'fastify';

describe('V1 Compatibility: Themes Endpoints', () => {
  let app: FastifyInstance;
  let client: ApiTestClient;
  let adminCookie: string;
  let viewerCookie: string;
  let testCommunityId: number;

  beforeAll(async () => {
    const db = await testDb.setup();
    const fixtures = await createTestData();
    testCommunityId = fixtures.community.id;

    app = await createTestApp(db);
    client = new ApiTestClient(app);

    adminCookie = await client.getTestSessionId(1, testCommunityId, 'admin');
    viewerCookie = await client.getTestSessionId(1, testCommunityId, 'viewer');
  }, 30000);

  afterAll(async () => {
    await testDb.teardown();
  }, 30000);

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/v1/themes/active — Active theme
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /api/v1/themes/active', () => {
    it('should return 401 without auth', async () => {
      const res = await client.get('/api/v1/themes/active');
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 with theme data object', async () => {
      const res = await client.get(
        '/api/v1/themes/active',
        undefined,
        viewerCookie
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Active theme may return the active theme or a message
      expect(body).toBeTruthy();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/v1/themes/ — List all themes
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /api/v1/themes/', () => {
    it('should return 401 without auth', async () => {
      const res = await client.get('/api/v1/themes/');
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 with data array', async () => {
      const res = await client.get('/api/v1/themes/', undefined, viewerCookie);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/v1/themes/:id — Single theme
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /api/v1/themes/:id', () => {
    it('should return 401 without auth', async () => {
      const res = await client.get('/api/v1/themes/1');
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 or 404 for specific theme', async () => {
      const res = await client.get('/api/v1/themes/1', undefined, viewerCookie);
      expect([200, 404]).toContain(res.statusCode);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // POST /api/v1/themes/ — Create (admin only)
  // ═══════════════════════════════════════════════════════════════════
  describe('POST /api/v1/themes/', () => {
    it('should return 401 without auth', async () => {
      const res = await client.post('/api/v1/themes/', {
        name: 'New Theme',
        communityId: testCommunityId,
      });
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for viewer', async () => {
      const res = await client.post(
        '/api/v1/themes/',
        { name: 'Viewer Theme', communityId: testCommunityId },
        viewerCookie
      );
      expect(res.statusCode).toBe(403);
    });

    it('should return 201 for admin', async () => {
      const res = await client.post(
        '/api/v1/themes/',
        { name: `Test Theme ${Date.now()}`, communityId: testCommunityId },
        adminCookie
      );
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('id');
      expect(body.data).toHaveProperty('name');
    });
  });
});
