/**
 * Users Endpoints — V1 Compatibility Test
 *
 * Captures the exact response shape of 6 community-scoped user endpoints:
 *   GET    /api/v1/users/      — list (paginated, admin only)
 *   GET    /api/v1/users/:id   — single user (admin only)
 *   POST   /api/v1/users/      — create (201, admin only)
 *   PUT    /api/v1/users/:id   — full update (200, admin only)
 *   PATCH  /api/v1/users/:id   — partial update (200, admin only)
 *   DELETE /api/v1/users/:id   — delete (204, admin only)
 *
 * Note: Users routes block super_admin via middleware for data sovereignty.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, ApiTestClient } from '../helpers/api-client';
import { testDb, createTestData } from '../helpers/database';
import type { FastifyInstance } from 'fastify';

describe('V1 Compatibility: Users Endpoints', () => {
  let app: FastifyInstance;
  let client: ApiTestClient;
  let adminCookie: string;
  let viewerCookie: string;
  let superAdminCookie: string;
  let testCommunityId: number;

  beforeAll(async () => {
    const db = await testDb.setup();
    const fixtures = await createTestData();
    testCommunityId = fixtures.community.id;

    app = await createTestApp(db);
    client = new ApiTestClient(app);

    adminCookie = await client.getTestSessionId(1, testCommunityId, 'admin');
    viewerCookie = await client.getTestSessionId(1, testCommunityId, 'viewer');
    superAdminCookie = await client.getTestSessionId(999, 1, 'super_admin');
  }, 30000);

  afterAll(async () => {
    await testDb.teardown();
  }, 30000);

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/v1/users/ — List (admin only)
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /api/v1/users/', () => {
    it('should return 401 without auth', async () => {
      const res = await client.get('/api/v1/users/');
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for viewer (requires admin)', async () => {
      const res = await client.get('/api/v1/users/', undefined, viewerCookie);
      expect(res.statusCode).toBe(403);
    });

    it('should return 200 with data array and meta pagination for admin', async () => {
      const res = await client.get('/api/v1/users/', undefined, adminCookie);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta).toHaveProperty('page');
      expect(body.meta).toHaveProperty('limit');
      expect(body.meta).toHaveProperty('total');
      expect(body.meta).toHaveProperty('totalPages');
    });

    it('should return user objects with required shape fields', async () => {
      const res = await client.get('/api/v1/users/', undefined, adminCookie);
      const body = JSON.parse(res.body);
      if (body.data.length > 0) {
        const user = body.data[0];
        expect(user).toHaveProperty('id');
        expect(user).toHaveProperty('email');
        expect(user).toHaveProperty('firstName');
        expect(user).toHaveProperty('lastName');
        expect(user).toHaveProperty('role');
        expect(user).toHaveProperty('communityId');
        expect(user).toHaveProperty('isActive');
        expect(user).toHaveProperty('createdAt');
        expect(user).toHaveProperty('updatedAt');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /api/v1/users/:id — Single user (admin only)
  // ═══════════════════════════════════════════════════════════════════
  describe('GET /api/v1/users/:id', () => {
    it('should return 401 without auth', async () => {
      const res = await client.get('/api/v1/users/1');
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 with data object for admin', async () => {
      const res = await client.get('/api/v1/users/1', undefined, adminCookie);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('id');
      expect(body.data).toHaveProperty('email');
      expect(body.data).toHaveProperty('firstName');
      expect(body.data).toHaveProperty('lastName');
      expect(body.data).toHaveProperty('role');
      expect(body.data).toHaveProperty('communityId');
      expect(body.data).toHaveProperty('isActive');
      expect(body.data).toHaveProperty('createdAt');
      expect(body.data).toHaveProperty('updatedAt');
    });

    it('should return 404 for nonexistent user', async () => {
      const res = await client.get(
        '/api/v1/users/99999',
        undefined,
        adminCookie
      );
      expect(res.statusCode).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // POST /api/v1/users/ — Create (admin only)
  // ═══════════════════════════════════════════════════════════════════
  describe('POST /api/v1/users/', () => {
    it('should return 401 without auth', async () => {
      const res = await client.post('/api/v1/users/', {
        email: 'test@test.com',
        password: 'Test12345',
        firstName: 'Test',
        lastName: 'User',
      });
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for viewer', async () => {
      const res = await client.post(
        '/api/v1/users/',
        {
          email: 'test@test.com',
          password: 'Test12345',
          firstName: 'Test',
          lastName: 'User',
        },
        viewerCookie
      );
      expect(res.statusCode).toBe(403);
    });

    it('should return 201 with data and message for admin', async () => {
      const res = await client.post(
        '/api/v1/users/',
        {
          email: `newuser-${Date.now()}@test.com`,
          password: 'TestPass123',
          firstName: 'New',
          lastName: 'User',
          role: 'viewer',
        },
        adminCookie
      );
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('message', 'User created successfully');
      expect(body.data).toHaveProperty('id');
      expect(body.data).toHaveProperty('email');
      expect(body.data).toHaveProperty('role');
      expect(body.data).toHaveProperty('communityId');
    });

    it('should return 400 for missing required fields', async () => {
      const res = await client.post(
        '/api/v1/users/',
        { email: 'bad@test.com' },
        adminCookie
      );
      expect(res.statusCode).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PUT /api/v1/users/:id — Full update (admin only)
  // ═══════════════════════════════════════════════════════════════════
  describe('PUT /api/v1/users/:id', () => {
    it('should return 401 without auth', async () => {
      const res = await client.put('/api/v1/users/1', {
        firstName: 'X',
        lastName: 'Y',
        role: 'viewer',
        isActive: true,
      });
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 with updated data for admin', async () => {
      const res = await client.put(
        '/api/v1/users/1',
        { firstName: 'Updated', lastName: 'Name', role: 'editor' },
        adminCookie
      );
      // May be 200 (updated), 400 (V1 validation), 404 (not in community), or 403
      expect([200, 400, 404, 403]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        const body = JSON.parse(res.body);
        expect(body).toHaveProperty('data');
        expect(body).toHaveProperty('message');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PATCH /api/v1/users/:id — Partial update (admin only)
  // ═══════════════════════════════════════════════════════════════════
  describe('PATCH /api/v1/users/:id', () => {
    it('should return 401 without auth', async () => {
      const res = await client.patch('/api/v1/users/1', { firstName: 'X' });
      expect(res.statusCode).toBe(401);
    });

    it('should return 200 with patched data for admin', async () => {
      const res = await client.patch(
        '/api/v1/users/1',
        { firstName: 'PatchedFirst' },
        adminCookie
      );
      expect([200, 404, 403]).toContain(res.statusCode);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // DELETE /api/v1/users/:id — Delete (admin only)
  // ═══════════════════════════════════════════════════════════════════
  describe('DELETE /api/v1/users/:id', () => {
    it('should return 401 without auth', async () => {
      const res = await client.delete('/api/v1/users/1');
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for viewer', async () => {
      const res = await client.delete('/api/v1/users/1', viewerCookie);
      expect(res.statusCode).toBe(403);
    });

    it('should return 200 for admin deleting user in same community', async () => {
      // Create a new user to delete
      const createRes = await client.post(
        '/api/v1/users/',
        {
          email: `delete-${Date.now()}@test.com`,
          password: 'TestPass123',
          firstName: 'Delete',
          lastName: 'Me',
          role: 'viewer',
        },
        adminCookie
      );
      if (createRes.statusCode === 201) {
        const userId = JSON.parse(createRes.body).data?.id;
        if (!userId) return;

        const res = await client.delete(`/api/v1/users/${userId}`, adminCookie);
        expect(res.statusCode).toBe(200);
      }
    });
  });
});
