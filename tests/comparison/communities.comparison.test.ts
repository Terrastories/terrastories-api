/**
 * Communities Endpoints — V1 Compatibility Test
 *
 * Captures the exact response shape of public API and V1 communities endpoints
 * to establish V1 parity baseline for V2 migration.
 *
 * PUBLIC (no auth, prefix /api):
 *   GET /api/communities
 *   GET /api/communities/:community_id/stories
 *   GET /api/communities/:community_id/stories/:id
 *   GET /api/communities/:community_id/places
 *   GET /api/communities/:community_id/places/:id
 *
 * AUTH (prefix /api/v1):
 *   GET  /api/v1/communities
 *   GET  /api/v1/communities/:id
 *   GET  /api/v1/communities/:id/stories
 *   GET  /api/v1/communities/:id/stories/:storyId
 *   POST /api/v1/communities
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, ApiTestClient } from '../helpers/api-client';
import { testDb, createTestData } from '../helpers/database';
import type { FastifyInstance } from 'fastify';

describe('V1 Compatibility: Communities Endpoints', () => {
  let app: FastifyInstance;
  let client: ApiTestClient;
  let adminCookie: string;
  let viewerCookie: string;
  let superAdminCookie: string;
  let testCommunityId: number;
  let systemCommunityId: number;

  beforeAll(async () => {
    const db = await testDb.setup();
    const fixtures = await createTestData();
    testCommunityId = fixtures.community.id;
    systemCommunityId = 1;

    app = await createTestApp(db);
    client = new ApiTestClient(app);

    adminCookie = await client.getTestSessionId(1, testCommunityId, 'admin');
    viewerCookie = await client.getTestSessionId(1, testCommunityId, 'viewer');
    superAdminCookie = await client.getTestSessionId(
      999,
      systemCommunityId,
      'super_admin'
    );
  }, 30000);

  afterAll(async () => {
    await testDb.teardown();
  }, 30000);

  // ═══════════════════════════════════════════════════════════════════
  // PUBLIC API (no auth required, prefix /api)
  // ═══════════════════════════════════════════════════════════════════

  describe('GET /api/communities', () => {
    it('should return 200 with data array and meta pagination', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/communities' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta).toHaveProperty('page');
      expect(body.meta).toHaveProperty('limit');
      expect(body.meta).toHaveProperty('total');
      // V1 public communities meta only includes page, limit, and total.
      expect(body.meta).not.toHaveProperty('totalPages');
    });

    it('should return communities with required fields', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/communities' });
      const body = JSON.parse(res.body);
      if (body.data.length > 0) {
        const community = body.data[0];
        expect(community).toHaveProperty('id');
        expect(community).toHaveProperty('name');
        expect(community).toHaveProperty('description');
        expect(community).toHaveProperty('publicStories');
      }
    });
  });

  describe('GET /api/communities/:community_id/stories', () => {
    it('should return 200 with data array', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/stories`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('should return 404 for nonexistent community', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/communities/99999/stories',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/communities/:community_id/stories/:id', () => {
    it('should return 200 with story data object', async () => {
      const storiesRes = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/stories`,
      });
      const stories = JSON.parse(storiesRes.body).data;
      if (stories.length > 0) {
        const storyId = stories[0].id;
        const res = await app.inject({
          method: 'GET',
          url: `/api/communities/${testCommunityId}/stories/${storyId}`,
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toHaveProperty('data');
        expect(body.data).toHaveProperty('id');
        expect(body.data).toHaveProperty('title');
      }
    });

    it('should return 404 for nonexistent story', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/stories/99999`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/communities/:community_id/places', () => {
    it('should return 200 with data array', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/places`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(Array.isArray(body.data)).toBe(true);
      if (body.data.length > 0) {
        expect(body.data[0]).toHaveProperty('id');
        expect(body.data[0]).toHaveProperty('name');
      }
    });
  });

  describe('GET /api/communities/:community_id/places/:id', () => {
    it('should return 200 with place data object', async () => {
      const placesRes = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/places`,
      });
      const places = JSON.parse(placesRes.body).data;
      if (places.length > 0) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/communities/${testCommunityId}/places/${places[0].id}`,
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toHaveProperty('data');
        expect(body.data).toHaveProperty('id');
        expect(body.data).toHaveProperty('name');
      }
    });

    it('should return 404 for nonexistent place', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/places/99999`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // V1 API (prefix /api/v1)
  // ═══════════════════════════════════════════════════════════════════

  describe('GET /api/v1/communities', () => {
    it('should return 200 without auth', async () => {
      const res = await client.get('/api/v1/communities');
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('should include community id and name in response', async () => {
      const res = await client.get('/api/v1/communities');
      const body = JSON.parse(res.body);
      if (body.data.length > 0) {
        expect(body.data[0]).toHaveProperty('id');
        expect(body.data[0]).toHaveProperty('name');
      }
    });
  });

  describe('GET /api/v1/communities/:id', () => {
    it('should return 200 with community data', async () => {
      const res = await client.get(`/api/v1/communities/${testCommunityId}`);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('id');
      expect(body.data).toHaveProperty('name');
      expect(body.data).toHaveProperty('description');
    });

    it('should return 404 for nonexistent community', async () => {
      const res = await client.get('/api/v1/communities/99999');
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/communities/:id/stories', () => {
    it('should return 200 for authenticated community member', async () => {
      const res = await client.get(
        `/api/v1/communities/${testCommunityId}/stories`,
        undefined,
        adminCookie
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('should return 401 without auth', async () => {
      const res = await client.get(
        `/api/v1/communities/${testCommunityId}/stories`
      );
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for super admin (data sovereignty)', async () => {
      const res = await client.get(
        `/api/v1/communities/${testCommunityId}/stories`,
        undefined,
        superAdminCookie
      );
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /api/v1/communities/:id/stories/:storyId', () => {
    it('should return 200 with enriched story data', async () => {
      const storiesRes = await client.get(
        `/api/v1/communities/${testCommunityId}/stories`,
        undefined,
        adminCookie
      );
      const stories = JSON.parse(storiesRes.body).data;
      if (stories.length > 0) {
        const res = await client.get(
          `/api/v1/communities/${testCommunityId}/stories/${stories[0].id}`,
          undefined,
          adminCookie
        );
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toHaveProperty('data');
        expect(body.data).toHaveProperty('id');
        expect(body.data).toHaveProperty('title');
        // Enriched fields
        expect(body.data).toHaveProperty('traditional_knowledge');
        expect(body.data).toHaveProperty('cultural_significance');
        expect(body.data).toHaveProperty('privacy_level');
      }
    });

    it('should return 404 for nonexistent story', async () => {
      const res = await client.get(
        `/api/v1/communities/${testCommunityId}/stories/99999`,
        undefined,
        adminCookie
      );
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/v1/communities', () => {
    it('should return 201 for admin creating community', async () => {
      const res = await client.post(
        '/api/v1/communities',
        {
          name: `New Community ${Date.now()}`,
          description: 'Created via test',
          publicStories: true,
          locale: 'en',
        },
        adminCookie
      );
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('id');
      expect(body.data).toHaveProperty('name');
      expect(body.data).toHaveProperty('slug');
    });

    it('should return 401 without auth', async () => {
      const res = await client.post('/api/v1/communities', {
        name: 'Unauthorized Community',
      });
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for viewer role', async () => {
      const res = await client.post(
        '/api/v1/communities',
        { name: 'Viewer Attempt' },
        viewerCookie
      );
      expect(res.statusCode).toBe(403);
    });
  });
});
