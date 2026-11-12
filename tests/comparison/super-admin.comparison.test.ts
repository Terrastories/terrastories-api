/**
 * Super Admin Endpoints — V1 Compatibility Test
 *
 * Captures the exact response shape of 10 super admin endpoints:
 *
 * Communities:
 *   GET    /api/v1/super_admin/communities      — list
 *   POST   /api/v1/super_admin/communities      — create (201)
 *   GET    /api/v1/super_admin/communities/:id  — single
 *   PUT    /api/v1/super_admin/communities/:id  — update (200)
 *   DELETE /api/v1/super_admin/communities/:id  — delete (204)
 *
 * Users:
 *   GET    /api/v1/super_admin/users            — list
 *   POST   /api/v1/super_admin/users            — create (201)
 *   GET    /api/v1/super_admin/users/:id        — single
 *   PUT    /api/v1/super_admin/users/:id        — update (200)
 *   DELETE /api/v1/super_admin/users/:id        — delete (204)
 *
 * All endpoints require super_admin role authentication.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, ApiTestClient } from '../helpers/api-client';
import { testDb, createTestData } from '../helpers/database';
import type { FastifyInstance } from 'fastify';

describe('V1 Compatibility: Super Admin Endpoints', () => {
  let app: FastifyInstance;
  let client: ApiTestClient;
  let superAdminCookie: string;
  let adminCookie: string;
  let viewerCookie: string;
  let testCommunityId: number;
  let systemCommunityId: number;

  beforeAll(async () => {
    const db = await testDb.setup();
    const fixtures = await createTestData();
    testCommunityId = fixtures.community.id;
    systemCommunityId = 1;

    app = await createTestApp(db);
    client = new ApiTestClient(app);

    superAdminCookie = await client.getTestSessionId(
      999,
      systemCommunityId,
      'super_admin'
    );
    adminCookie = await client.getTestSessionId(1, testCommunityId, 'admin');
    viewerCookie = await client.getTestSessionId(1, testCommunityId, 'viewer');
  }, 30000);

  afterAll(async () => {
    await testDb.teardown();
  }, 30000);

  // ═══════════════════════════════════════════════════════════════════
  // SUPER ADMIN COMMUNITIES
  // ═══════════════════════════════════════════════════════════════════

  describe('Super Admin Communities', () => {
    // GET /api/v1/super_admin/communities
    describe('GET /api/v1/super_admin/communities', () => {
      it('should return 401 without auth', async () => {
        const res = await client.get('/api/v1/super_admin/communities');
        expect(res.statusCode).toBe(401);
      });

      it('should return 403 for non-super-admin', async () => {
        const res = await client.get(
          '/api/v1/super_admin/communities',
          undefined,
          adminCookie
        );
        expect(res.statusCode).toBe(403);
      });

      it('should return 200 with data array and meta for super admin', async () => {
        const res = await client.get(
          '/api/v1/super_admin/communities',
          undefined,
          superAdminCookie
        );
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
    });

    // POST /api/v1/super_admin/communities
    describe('POST /api/v1/super_admin/communities', () => {
      it('should return 401 without auth', async () => {
        const res = await client.post('/api/v1/super_admin/communities', {
          name: 'Test',
        });
        expect(res.statusCode).toBe(401);
      });

      it('should return 403 for admin (not super admin)', async () => {
        const res = await client.post(
          '/api/v1/super_admin/communities',
          {
            name: 'Test',
            description: 'Test',
            publicStories: true,
            locale: 'en',
          },
          adminCookie
        );
        expect(res.statusCode).toBe(403);
      });

      it('should return 201 for super admin', async () => {
        const res = await client.post(
          '/api/v1/super_admin/communities',
          {
            name: `SA Community ${Date.now()}`,
            description: 'Created by super admin',
            publicStories: true,
            locale: 'en',
          },
          superAdminCookie
        );
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body).toHaveProperty('data');
        expect(body.data).toHaveProperty('id');
        expect(body.data).toHaveProperty('name');
        expect(body.data).toHaveProperty('slug');
      });
    });

    // GET /api/v1/super_admin/communities/:id
    describe('GET /api/v1/super_admin/communities/:id', () => {
      it('should return 401 without auth', async () => {
        const res = await client.get('/api/v1/super_admin/communities/1');
        expect(res.statusCode).toBe(401);
      });

      it('should return 200 for super admin', async () => {
        const res = await client.get(
          `/api/v1/super_admin/communities/${testCommunityId}`,
          undefined,
          superAdminCookie
        );
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toHaveProperty('data');
        expect(body.data).toHaveProperty('id');
        expect(body.data).toHaveProperty('name');
      });

      it('should return 404 for nonexistent community', async () => {
        const res = await client.get(
          '/api/v1/super_admin/communities/99999',
          undefined,
          superAdminCookie
        );
        expect(res.statusCode).toBe(404);
      });
    });

    // PUT /api/v1/super_admin/communities/:id
    describe('PUT /api/v1/super_admin/communities/:id', () => {
      it('should return 401 without auth', async () => {
        const res = await client.put('/api/v1/super_admin/communities/1', {
          name: 'Updated',
        });
        expect(res.statusCode).toBe(401);
      });

      it('should return 200 for super admin', async () => {
        // Create a community to update
        const createRes = await client.post(
          '/api/v1/super_admin/communities',
          {
            name: 'To Update SA',
            description: 'Desc',
            publicStories: true,
            locale: 'en',
          },
          superAdminCookie
        );
        if (createRes.statusCode === 201) {
          const communityId = JSON.parse(createRes.body).data?.id;
          if (!communityId) return;

          const res = await client.put(
            `/api/v1/super_admin/communities/${communityId}`,
            { name: 'Updated SA Community', description: 'Updated desc' },
            superAdminCookie
          );
          expect(res.statusCode).toBe(200);
          const body = JSON.parse(res.body);
          expect(body).toHaveProperty('data');
          expect(body.data.name).toBe('Updated SA Community');
        }
      });
    });

    // DELETE /api/v1/super_admin/communities/:id
    describe('DELETE /api/v1/super_admin/communities/:id', () => {
      it('should return 401 without auth', async () => {
        const res = await client.delete('/api/v1/super_admin/communities/1');
        expect(res.statusCode).toBe(401);
      });

      it('should return 403 for viewer', async () => {
        const res = await client.delete(
          '/api/v1/super_admin/communities/1',
          viewerCookie
        );
        expect(res.statusCode).toBe(403);
      });

      it('should return 200 for super admin', async () => {
        const createRes = await client.post(
          '/api/v1/super_admin/communities',
          {
            name: `To Delete SA ${Date.now()}`,
            description: 'Desc',
            publicStories: true,
            locale: 'en',
          },
          superAdminCookie
        );
        if (createRes.statusCode === 201) {
          const communityId = JSON.parse(createRes.body).data?.id;
          if (!communityId) return;

          const res = await client.delete(
            `/api/v1/super_admin/communities/${communityId}`,
            superAdminCookie
          );
          expect(res.statusCode).toBe(200);
        }
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SUPER ADMIN USERS
  // ═══════════════════════════════════════════════════════════════════

  describe('Super Admin Users', () => {
    // GET /api/v1/super_admin/users
    describe('GET /api/v1/super_admin/users', () => {
      it('should return 401 without auth', async () => {
        const res = await client.get('/api/v1/super_admin/users');
        expect(res.statusCode).toBe(401);
      });

      it('should return 403 for non-super-admin', async () => {
        const res = await client.get(
          '/api/v1/super_admin/users',
          undefined,
          adminCookie
        );
        expect(res.statusCode).toBe(403);
      });

      it('should return 200 with data array and meta for super admin', async () => {
        const res = await client.get(
          '/api/v1/super_admin/users',
          undefined,
          superAdminCookie
        );
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
    });

    // GET /api/v1/super_admin/users/:id
    describe('GET /api/v1/super_admin/users/:id', () => {
      it('should return 401 without auth', async () => {
        const res = await client.get('/api/v1/super_admin/users/1');
        expect(res.statusCode).toBe(401);
      });

      it('should hide community account details from super admin', async () => {
        const res = await client.get(
          '/api/v1/super_admin/users/1',
          undefined,
          superAdminCookie
        );
        expect(res.statusCode).toBe(404);
        const body = JSON.parse(res.body);
        expect(body).not.toHaveProperty('data');
      });

      it('should return 404 for nonexistent user', async () => {
        const res = await client.get(
          '/api/v1/super_admin/users/99999',
          undefined,
          superAdminCookie
        );
        expect(res.statusCode).toBe(404);
      });
    });

    // POST /api/v1/super_admin/users
    describe('POST /api/v1/super_admin/users', () => {
      it('should return 401 without auth', async () => {
        const res = await client.post('/api/v1/super_admin/users', {
          email: 'test@test.com',
          password: 'Test12345!',
          firstName: 'Test',
          lastName: 'User',
          role: 'admin',
          communityId: testCommunityId,
        });
        expect(res.statusCode).toBe(401);
      });

      it('should return 403 for a community account in a claimed community (SPEC-V2 §7)', async () => {
        const res = await client.post(
          '/api/v1/super_admin/users',
          {
            email: `sa-admin-${Date.now()}@test.com`,
            password: 'TestPass123!',
            firstName: 'SA',
            lastName: 'Admin',
            role: 'admin',
            communityId: testCommunityId,
          },
          superAdminCookie
        );
        expect(res.statusCode).toBe(403);
      });

      it('should return 201 for a system account', async () => {
        const res = await client.post(
          '/api/v1/super_admin/users',
          {
            email: `sa-user-${Date.now()}@test.com`,
            password: 'TestPass123!',
            firstName: 'SA',
            lastName: 'User',
            role: 'super_admin',
            communityId: testCommunityId,
          },
          superAdminCookie
        );
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body.data).toMatchObject({
          id: expect.any(Number),
          role: 'super_admin',
        });
      });

      it('should create a system account for super admin', async () => {
        const res = await client.post(
          '/api/v1/super_admin/users',
          {
            email: `sa-system-${Date.now()}@test.com`,
            password: 'TestPass123!',
            firstName: 'SA',
            lastName: 'User',
            role: 'super_admin',
            communityId: systemCommunityId,
          },
          superAdminCookie
        );
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body).toHaveProperty('data');
        expect(body.data).toHaveProperty('id');
        expect(body.data).toHaveProperty('email');
        expect(body.data.role).toBe('super_admin');
        const detail = await client.get(
          `/api/v1/super_admin/users/${body.data.id}`,
          undefined,
          superAdminCookie
        );
        expect(detail.statusCode).toBe(200);
        expect(JSON.parse(detail.body).data.id).toBe(body.data.id);
        const update = await client.put(
          `/api/v1/super_admin/users/${body.data.id}`,
          { firstName: 'SystemUpdated' },
          superAdminCookie
        );
        expect(update.statusCode).toBe(200);
        expect(JSON.parse(update.body).data.firstName).toBe('SystemUpdated');
      });
    });

    // PUT /api/v1/super_admin/users/:id
    describe('PUT /api/v1/super_admin/users/:id', () => {
      it('should return 401 without auth', async () => {
        const res = await client.put('/api/v1/super_admin/users/1', {
          firstName: 'X',
        });
        expect(res.statusCode).toBe(401);
      });

      it('should allow profile updates without granting membership authority', async () => {
        const res = await client.put(
          '/api/v1/super_admin/users/1',
          {
            firstName: 'SAUpdated',
            lastName: 'User',
            role: 'admin',
            communityId: testCommunityId,
          },
          superAdminCookie
        );
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).data).toMatchObject({
          firstName: 'SAUpdated',
          role: 'admin',
          communityId: testCommunityId,
        });
        const roleChange = await client.put(
          '/api/v1/super_admin/users/1',
          { role: 'viewer' },
          superAdminCookie
        );
        expect(roleChange.statusCode).toBe(403);
      });
    });

    // DELETE /api/v1/super_admin/users/:id
    describe('DELETE /api/v1/super_admin/users/:id', () => {
      it('should return 401 without auth', async () => {
        const res = await client.delete('/api/v1/super_admin/users/1');
        expect(res.statusCode).toBe(401);
      });

      it('should return 403 for viewer', async () => {
        const res = await client.delete(
          '/api/v1/super_admin/users/1',
          viewerCookie
        );
        expect(res.statusCode).toBe(403);
      });

      it('should return 200 for super admin deactivating', async () => {
        const createRes = await client.post(
          '/api/v1/super_admin/users',
          {
            email: `sa-delete-${Date.now()}@test.com`,
            password: 'TestPass123!',
            firstName: 'Delete',
            lastName: 'Me',
            role: 'super_admin',
            communityId: systemCommunityId,
          },
          superAdminCookie
        );
        expect(createRes.statusCode).toBe(201);
        const userId = JSON.parse(createRes.body).data?.id;
        expect(userId).toBeGreaterThan(0);

        const res = await client.delete(
          `/api/v1/super_admin/users/${userId}`,
          superAdminCookie
        );
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toHaveProperty('data');
      });
    });
  });
});
