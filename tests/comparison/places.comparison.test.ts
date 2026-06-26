/**
 * Places Endpoints — V1 Compatibility Test
 *
 * Captures the exact response shape of 8 place endpoints:
 *   GET  /api/v1/places          — list with pagination
 *   GET  /api/v1/places/:id      — single place
 *   GET  /api/v1/places/bounds   — bounding box search
 *   GET  /api/v1/places/near     — near search
 *   GET  /api/v1/places/stats    — community stats
 *   POST /api/v1/places          — create (201)
 *   PUT  /api/v1/places/:id      — update (200)
 *   DELETE /api/v1/places/:id    — delete (204)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, ApiTestClient } from '../helpers/api-client';
import { testDb, createTestData } from '../helpers/database';
import type { FastifyInstance } from 'fastify';

describe('V1 Compatibility: Places Endpoints', () => {
  let app: FastifyInstance;
  let client: ApiTestClient;
  let adminCookie: string;
  let viewerCookie: string;
  let elderCookie: string;
  let testCommunityId: number;

  beforeAll(async () => {
    const db = await testDb.setup();
    const fixtures = await createTestData();
    testCommunityId = fixtures.community.id;

    app = await createTestApp(db);
    client = new ApiTestClient(app);

    adminCookie = await client.getTestSessionId(1, testCommunityId, 'admin');
    viewerCookie = await client.getTestSessionId(1, testCommunityId, 'viewer');
    elderCookie = await client.getTestSessionId(1, testCommunityId, 'elder');
  }, 30000);

  afterAll(async () => {
    await testDb.teardown();
  }, 30000);

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/v1/places — List (paginated)
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /api/v1/places', () => {
    it('should return 401 without auth', async () => {
      const res = await client.get('/api/v1/places');
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 with data array and meta pagination', async () => {
      const res = await client.get('/api/v1/places', undefined, viewerCookie);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta).toHaveProperty('total');
      expect(body.meta).toHaveProperty('page');
      expect(body.meta).toHaveProperty('limit');
      expect(body.meta).toHaveProperty('pages');
      expect(body.meta).toHaveProperty('filters');
    });

    it('should return places with required shape fields', async () => {
      const res = await client.get('/api/v1/places', undefined, viewerCookie);
      const body = JSON.parse(res.body);
      if (body.data.length > 0) {
        const place = body.data[0];
        expect(place).toHaveProperty('id');
        expect(place).toHaveProperty('name');
        expect(place).toHaveProperty('description');
        expect(place).toHaveProperty('latitude');
        expect(place).toHaveProperty('longitude');
        expect(place).toHaveProperty('communityId');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/v1/places/:id — Single place
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /api/v1/places/:id', () => {
    it('should return 401 without auth', async () => {
      const res = await client.get('/api/v1/places/1');
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 with data object', async () => {
      // First get a valid place ID
      const listRes = await client.get(
        '/api/v1/places',
        undefined,
        adminCookie
      );
      const places = JSON.parse(listRes.body).data;
      if (places.length > 0) {
        const res = await client.get(
          `/api/v1/places/${places[0].id}`,
          undefined,
          adminCookie
        );
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toHaveProperty('data');
        expect(body.data).toHaveProperty('id');
        expect(body.data).toHaveProperty('name');
        expect(body.data).toHaveProperty('latitude');
        expect(body.data).toHaveProperty('longitude');
      }
    });

    it('should return 404 for nonexistent place', async () => {
      const res = await client.get(
        '/api/v1/places/99999',
        undefined,
        adminCookie
      );
      expect(res.statusCode).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/v1/places/bounds — Bounding box search
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /api/v1/places/bounds', () => {
    it('should return 401 without auth', async () => {
      const res = await client.get(
        '/api/v1/places/bounds?north=50&south=40&east=-70&west=-130'
      );
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 with data and meta including searchParams.bounds', async () => {
      const res = await client.get(
        '/api/v1/places/bounds?north=50&south=40&east=-70&west=-130',
        undefined,
        viewerCookie
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(body.meta).toHaveProperty('searchParams');
      expect(body.meta.searchParams).toHaveProperty('bounds');
      expect(body.meta.searchParams.bounds).toHaveProperty('north');
      expect(body.meta.searchParams.bounds).toHaveProperty('south');
      expect(body.meta.searchParams.bounds).toHaveProperty('east');
      expect(body.meta.searchParams.bounds).toHaveProperty('west');
    });

    it('should return 400 for invalid bounds', async () => {
      const res = await client.get(
        '/api/v1/places/bounds?north=bad&south=40&east=-70&west=-130',
        undefined,
        viewerCookie
      );
      expect(res.statusCode).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/v1/places/near — Near search
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /api/v1/places/near', () => {
    it('should return 401 without auth', async () => {
      const res = await client.get(
        '/api/v1/places/near?latitude=49&longitude=-123&radius=10'
      );
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 with data and meta including searchParams', async () => {
      const res = await client.get(
        '/api/v1/places/near?latitude=49.2827&longitude=-123.1234&radius=100',
        undefined,
        viewerCookie
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(body.meta).toHaveProperty('searchParams');
      expect(body.meta.searchParams).toHaveProperty('latitude');
      expect(body.meta.searchParams).toHaveProperty('longitude');
      expect(body.meta.searchParams).toHaveProperty('radius');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/v1/places/stats — Community statistics
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /api/v1/places/stats', () => {
    it('should return 401 without auth', async () => {
      const res = await client.get('/api/v1/places/stats');
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 with data stats object', async () => {
      const res = await client.get(
        '/api/v1/places/stats',
        undefined,
        viewerCookie
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(typeof body.data).toBe('object');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // POST /api/v1/places — Create (requires admin/editor)
  // ═══════════════════════════════════════════════════════════════════
  describe('POST /api/v1/places', () => {
    const newPlace = {
      name: 'New Place',
      description: 'A test place',
      latitude: 49.2827,
      longitude: -123.1234,
      region: 'Vancouver',
    };

    it('should return 401 without auth', async () => {
      const res = await client.post('/api/v1/places', newPlace);
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for viewer role', async () => {
      const res = await client.post('/api/v1/places', newPlace, viewerCookie);
      expect(res.statusCode).toBe(403);
    });

    it('should return 201 with data and meta message for admin', async () => {
      const res = await client.post(
        '/api/v1/places',
        { ...newPlace, name: `Admin Place ${Date.now()}` },
        adminCookie
      );
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(body.meta).toHaveProperty('message');
      expect(body.data).toHaveProperty('id');
      expect(body.data).toHaveProperty('name');
      expect(body.data).toHaveProperty('latitude');
      expect(body.data).toHaveProperty('longitude');
      expect(body.data).toHaveProperty('communityId');
    });

    it('should return 201 for editor role', async () => {
      const editorCookie = await client.getTestSessionId(
        1,
        testCommunityId,
        'editor'
      );
      const res = await client.post(
        '/api/v1/places',
        { ...newPlace, name: `Editor Place ${Date.now()}` },
        editorCookie
      );
      expect(res.statusCode).toBe(201);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PUT /api/v1/places/:id — Update (requires admin/editor)
  // ═══════════════════════════════════════════════════════════════════
  describe('PUT /api/v1/places/:id', () => {
    it('should return 401 without auth', async () => {
      const res = await client.put('/api/v1/places/1', { name: 'Updated' });
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for viewer role', async () => {
      const res = await client.put(
        '/api/v1/places/1',
        { name: 'Updated' },
        viewerCookie
      );
      expect(res.statusCode).toBe(403);
    });

    it('should return 200 with updated data and meta message', async () => {
      // Create a place first, then update it
      const createRes = await client.post(
        '/api/v1/places',
        { name: 'To Update', latitude: 49, longitude: -123 },
        adminCookie
      );
      const placeId = JSON.parse(createRes.body).data.id;

      const res = await client.put(
        `/api/v1/places/${placeId}`,
        { name: 'Updated Place' },
        adminCookie
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(body.meta).toHaveProperty('message', 'Place updated successfully');
      expect(body.data.name).toBe('Updated Place');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // DELETE /api/v1/places/:id — Delete (requires admin/elder)
  // ═══════════════════════════════════════════════════════════════════
  describe('DELETE /api/v1/places/:id', () => {
    it('should return 401 without auth', async () => {
      const res = await client.delete('/api/v1/places/1');
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for viewer role', async () => {
      const res = await client.delete('/api/v1/places/1', viewerCookie);
      expect(res.statusCode).toBe(403);
    });

    it('should return 204 for admin', async () => {
      const createRes = await client.post(
        '/api/v1/places',
        { name: 'To Delete', latitude: 48, longitude: -122 },
        adminCookie
      );
      const placeId = JSON.parse(createRes.body).data.id;

      const res = await client.delete(`/api/v1/places/${placeId}`, adminCookie);
      expect(res.statusCode).toBe(204);
    });

    it('should return 204 for elder', async () => {
      const createRes = await client.post(
        '/api/v1/places',
        { name: 'Elder Delete', latitude: 47, longitude: -121 },
        adminCookie
      );
      const placeId = JSON.parse(createRes.body).data.id;

      const res = await client.delete(`/api/v1/places/${placeId}`, elderCookie);
      expect(res.statusCode).toBe(204);
    });
  });
});
