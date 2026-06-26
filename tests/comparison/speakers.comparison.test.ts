/**
 * Speakers Endpoints — V1 Compatibility Test
 *
 * Captures the exact response shape of 8 speaker endpoints:
 *   GET    /api/v1/speakers        — list with pagination
 *   GET    /api/v1/speakers/:id    — single speaker
 *   GET    /api/v1/speakers/search — text search
 *   GET    /api/v1/speakers/stats  — community stats
 *   POST   /api/v1/speakers        — create (201)
 *   PUT    /api/v1/speakers/:id    — full update (200)
 *   PATCH  /api/v1/speakers/:id    — partial update (200)
 *   DELETE /api/v1/speakers/:id    — delete (204)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, ApiTestClient } from '../helpers/api-client';
import { testDb, createTestData } from '../helpers/database';
import type { FastifyInstance } from 'fastify';

describe('V1 Compatibility: Speakers Endpoints', () => {
  let app: FastifyInstance;
  let client: ApiTestClient;
  let adminCookie: string;
  let viewerCookie: string;
  let editorCookie: string;
  let testCommunityId: number;

  beforeAll(async () => {
    const db = await testDb.setup();
    const fixtures = await createTestData();
    testCommunityId = fixtures.community.id;

    app = await createTestApp(db);
    client = new ApiTestClient(app);

    adminCookie = await client.getTestSessionId(1, testCommunityId, 'admin');
    viewerCookie = await client.getTestSessionId(1, testCommunityId, 'viewer');
    editorCookie = await client.getTestSessionId(1, testCommunityId, 'editor');
  }, 30000);

  afterAll(async () => {
    await testDb.teardown();
  }, 30000);

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/v1/speakers — List (paginated)
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /api/v1/speakers', () => {
    it('should return 401 without auth', async () => {
      const res = await client.get('/api/v1/speakers');
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 with data array and meta pagination', async () => {
      const res = await client.get('/api/v1/speakers', undefined, viewerCookie);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta).toHaveProperty('total');
      expect(body.meta).toHaveProperty('page');
      expect(body.meta).toHaveProperty('limit');
      expect(body.meta).toHaveProperty('pages');
    });

    it('should return speakers with expected shape fields', async () => {
      const res = await client.get('/api/v1/speakers', undefined, viewerCookie);
      const body = JSON.parse(res.body);
      if (body.data.length > 0) {
        const speaker = body.data[0];
        expect(speaker).toHaveProperty('id');
        expect(speaker).toHaveProperty('name');
        expect(speaker).toHaveProperty('bio');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/v1/speakers/:id — Single speaker
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /api/v1/speakers/:id', () => {
    it('should return 401 without auth', async () => {
      const res = await client.get('/api/v1/speakers/1');
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 with data object', async () => {
      const listRes = await client.get(
        '/api/v1/speakers',
        undefined,
        adminCookie
      );
      const speakers = JSON.parse(listRes.body).data;
      if (speakers.length > 0) {
        const res = await client.get(
          `/api/v1/speakers/${speakers[0].id}`,
          undefined,
          adminCookie
        );
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toHaveProperty('data');
        expect(body.data).toHaveProperty('id');
        expect(body.data).toHaveProperty('name');
      }
    });

    it('should return 404 for nonexistent speaker', async () => {
      const res = await client.get(
        '/api/v1/speakers/99999',
        undefined,
        adminCookie
      );
      expect(res.statusCode).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/v1/speakers/search — Text search
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /api/v1/speakers/search', () => {
    it('should return 401 without auth', async () => {
      const res = await client.get('/api/v1/speakers/search?q=test');
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 with data and meta', async () => {
      const res = await client.get(
        '/api/v1/speakers/search?q=Maria',
        undefined,
        viewerCookie
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(body.meta).toHaveProperty('total');
      expect(body.meta).toHaveProperty('page');
    });

    it('should return 400 for query shorter than 2 chars', async () => {
      const res = await client.get(
        '/api/v1/speakers/search?q=a',
        undefined,
        viewerCookie
      );
      expect(res.statusCode).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/v1/speakers/stats — Community statistics
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /api/v1/speakers/stats', () => {
    it('should return 401 without auth', async () => {
      const res = await client.get('/api/v1/speakers/stats');
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 with data stats object', async () => {
      const res = await client.get(
        '/api/v1/speakers/stats',
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
  // POST /api/v1/speakers — Create (requires admin/editor)
  // ═══════════════════════════════════════════════════════════════════
  describe('POST /api/v1/speakers', () => {
    const newSpeaker = { name: 'New Speaker', photoUrl: '' };

    it('should return 401 without auth', async () => {
      const res = await client.post('/api/v1/speakers', newSpeaker);
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for viewer role', async () => {
      const res = await client.post(
        '/api/v1/speakers',
        newSpeaker,
        viewerCookie
      );
      expect(res.statusCode).toBe(403);
    });

    it('should return 201 with data and meta for admin', async () => {
      const res = await client.post(
        '/api/v1/speakers',
        { ...newSpeaker, name: `Admin Speaker ${Date.now()}` },
        adminCookie
      );
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(body.meta).toHaveProperty(
        'message',
        'Speaker created successfully'
      );
      expect(body.data).toHaveProperty('id');
      expect(body.data).toHaveProperty('name');
    });

    it('should return 201 for editor role', async () => {
      const res = await client.post(
        '/api/v1/speakers',
        { ...newSpeaker, name: `Editor Speaker ${Date.now()}` },
        editorCookie
      );
      expect(res.statusCode).toBe(201);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PUT /api/v1/speakers/:id — Full update (requires admin/editor)
  // ═══════════════════════════════════════════════════════════════════
  describe('PUT /api/v1/speakers/:id', () => {
    it('should return 401 without auth', async () => {
      const res = await client.put('/api/v1/speakers/1', { name: 'Updated' });
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for viewer role', async () => {
      const res = await client.put(
        '/api/v1/speakers/1',
        { name: 'Updated' },
        viewerCookie
      );
      expect(res.statusCode).toBe(403);
    });

    it('should return 200 with updated data and meta message', async () => {
      const createRes = await client.post(
        '/api/v1/speakers',
        { name: 'To Update', photoUrl: '' },
        adminCookie
      );
      const speakerId = JSON.parse(createRes.body).data.id;

      const res = await client.put(
        `/api/v1/speakers/${speakerId}`,
        { name: 'Updated Speaker' },
        adminCookie
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(body.meta).toHaveProperty(
        'message',
        'Speaker updated successfully'
      );
      expect(body.data.name).toBe('Updated Speaker');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PATCH /api/v1/speakers/:id — Partial update (requires admin/editor)
  // ═══════════════════════════════════════════════════════════════════
  describe('PATCH /api/v1/speakers/:id', () => {
    it('should return 401 without auth', async () => {
      const res = await client.patch('/api/v1/speakers/1', { name: 'Patched' });
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 with partially updated data', async () => {
      const createRes = await client.post(
        '/api/v1/speakers',
        { name: 'To Patch', photoUrl: '' },
        adminCookie
      );
      const speakerId = JSON.parse(createRes.body).data.id;

      const res = await client.patch(
        `/api/v1/speakers/${speakerId}`,
        { bio: 'Patched bio' },
        adminCookie
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // DELETE /api/v1/speakers/:id — Delete (requires admin)
  // ═══════════════════════════════════════════════════════════════════
  describe('DELETE /api/v1/speakers/:id', () => {
    it('should return 401 without auth', async () => {
      const res = await client.delete('/api/v1/speakers/1');
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for viewer role', async () => {
      const res = await client.delete('/api/v1/speakers/1', viewerCookie);
      expect(res.statusCode).toBe(403);
    });

    it('should return 204 for admin', async () => {
      const createRes = await client.post(
        '/api/v1/speakers',
        { name: `To Delete ${Date.now()}`, photoUrl: '' },
        adminCookie
      );
      const speakerId = JSON.parse(createRes.body).data.id;

      const res = await client.delete(
        `/api/v1/speakers/${speakerId}`,
        adminCookie
      );
      expect(res.statusCode).toBe(204);
    });
  });
});
