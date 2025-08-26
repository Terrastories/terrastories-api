/**
 * Super Admin API Tests
 *
 * Tests all super admin endpoints for community and user management
 * with proper role-based access control and data sovereignty enforcement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { testDb } from '../helpers/database.js';
import { createTestApp } from '../helpers/api-client.js';

describe('Super Admin API', () => {
  let app: FastifyInstance;
  let superAdminSessionId: string;
  let adminSessionId: string;
  let editorSessionId: string;
  let testCommunityId: number;
  let superAdminUserId: number;

  beforeEach(async () => {
    await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[1].id; // Skip system community

    app = await createTestApp(testDb.db);

    // Create super admin user
    const superAdminUser = {
      email: 'superadmin@example.com',
      password: 'SuperStrongPassword123@',
      firstName: 'Super',
      lastName: 'Admin',
      role: 'super_admin',
      communityId: testCommunityId,
    };

    const superAdminRegResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: superAdminUser,
    });
    superAdminUserId = superAdminRegResponse.json().user.id;

    // Login super admin
    const superAdminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: superAdminUser.email,
        password: superAdminUser.password,
        communityId: testCommunityId,
      },
    });
    const sessionCookie = superAdminLogin.cookies.find(
      (cookie) => cookie.name === 'sessionId'
    );
    superAdminSessionId = sessionCookie?.value || '';

    // Create regular admin user for negative tests
    const adminUser = {
      email: 'admin@example.com',
      password: 'AdminPassword123@',
      firstName: 'Admin',
      lastName: 'User',
      role: 'admin',
      communityId: testCommunityId,
    };

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: adminUser,
    });

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: adminUser.email,
        password: adminUser.password,
        communityId: testCommunityId,
      },
    });
    const adminSessionCookie = adminLogin.cookies.find(
      (cookie) => cookie.name === 'sessionId'
    );
    adminSessionId = adminSessionCookie?.value || '';

    // Create editor user for more negative tests
    const editorUser = {
      email: 'editor@example.com',
      password: 'EditorPassword123@',
      firstName: 'Editor',
      lastName: 'User',
      role: 'editor',
      communityId: testCommunityId,
    };

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: editorUser,
    });

    const editorLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: editorUser.email,
        password: editorUser.password,
        communityId: testCommunityId,
      },
    });
    const editorSessionCookie = editorLogin.cookies.find(
      (cookie) => cookie.name === 'sessionId'
    );
    editorSessionId = editorSessionCookie?.value || '';
  });

  afterEach(async () => {
    await app.close();
    await testDb.cleanup();
  });

  describe('Community Management Endpoints', () => {
    describe('GET /api/v1/super_admin/communities', () => {
      it('should list all communities for super admin', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/super_admin/communities',
          cookies: { sessionId: superAdminSessionId },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          data: expect.arrayContaining([
            expect.objectContaining({
              id: expect.any(Number),
              name: expect.any(String),
              userCount: expect.any(Number),
              createdAt: expect.any(String),
            }),
          ]),
          meta: {
            page: 1,
            limit: 20,
            total: expect.any(Number),
            totalPages: expect.any(Number),
          },
        });
      });

      it('should support pagination', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/super_admin/communities?page=1&limit=5',
          cookies: { sessionId: superAdminSessionId },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().meta.limit).toBe(5);
        expect(response.json().meta.page).toBe(1);
      });

      it('should support search filtering', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/super_admin/communities?search=test',
          cookies: { sessionId: superAdminSessionId },
        });

        expect(response.statusCode).toBe(200);
        // Results should be filtered by search term
      });

      it('should deny access to non-super-admin users', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/super_admin/communities',
          cookies: { sessionId: adminSessionId },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          error: 'Insufficient permissions',
          statusCode: 403,
        });
      });

      it('should deny access to unauthenticated users', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/super_admin/communities',
        });

        expect(response.statusCode).toBe(401);
      });
    });

    describe('GET /api/v1/super_admin/communities/:id', () => {
      it('should get specific community details for super admin', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/super_admin/communities/${testCommunityId}`,
          cookies: { sessionId: superAdminSessionId },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          data: {
            id: testCommunityId,
            name: expect.any(String),
            description: expect.any(String),
            locale: expect.any(String),
            userCount: expect.any(Number),
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          },
        });
      });

      it('should return 404 for non-existent community', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/super_admin/communities/99999',
          cookies: { sessionId: superAdminSessionId },
        });

        expect(response.statusCode).toBe(404);
      });

      it('should deny access to non-super-admin users', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/super_admin/communities/${testCommunityId}`,
          cookies: { sessionId: editorSessionId },
        });

        expect(response.statusCode).toBe(403);
      });
    });

    describe('POST /api/v1/super_admin/communities', () => {
      it('should create new community for super admin', async () => {
        const newCommunity = {
          name: 'Test Community Created',
          description: 'A test community created by super admin',
          locale: 'en-US',
        };

        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/super_admin/communities',
          cookies: { sessionId: superAdminSessionId },
          payload: newCommunity,
        });

        expect(response.statusCode).toBe(201);
        expect(response.json()).toMatchObject({
          data: {
            id: expect.any(Number),
            name: newCommunity.name,
            description: newCommunity.description,
            locale: newCommunity.locale,
            createdAt: expect.any(String),
          },
        });
      });

      it('should validate required fields', async () => {
        const invalidCommunity = {
          description: 'Missing name',
        };

        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/super_admin/communities',
          cookies: { sessionId: superAdminSessionId },
          payload: invalidCommunity,
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error: expect.stringContaining('validation'),
        });
      });

      it('should deny access to non-super-admin users', async () => {
        const newCommunity = {
          name: 'Test Community',
          description: 'Test',
          locale: 'en-US',
        };

        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/super_admin/communities',
          cookies: { sessionId: adminSessionId },
          payload: newCommunity,
        });

        expect(response.statusCode).toBe(403);
      });
    });

    describe('PUT /api/v1/super_admin/communities/:id', () => {
      it('should update community for super admin', async () => {
        const updates = {
          name: 'Updated Community Name',
          description: 'Updated description',
        };

        const response = await app.inject({
          method: 'PUT',
          url: `/api/v1/super_admin/communities/${testCommunityId}`,
          cookies: { sessionId: superAdminSessionId },
          payload: updates,
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          data: {
            id: testCommunityId,
            name: updates.name,
            description: updates.description,
            updatedAt: expect.any(String),
          },
        });
      });

      it('should return 404 for non-existent community', async () => {
        const response = await app.inject({
          method: 'PUT',
          url: '/api/v1/super_admin/communities/99999',
          cookies: { sessionId: superAdminSessionId },
          payload: { name: 'Updated' },
        });

        expect(response.statusCode).toBe(404);
      });

      it('should deny access to non-super-admin users', async () => {
        const response = await app.inject({
          method: 'PUT',
          url: `/api/v1/super_admin/communities/${testCommunityId}`,
          cookies: { sessionId: editorSessionId },
          payload: { name: 'Updated' },
        });

        expect(response.statusCode).toBe(403);
      });
    });

    describe('DELETE /api/v1/super_admin/communities/:id', () => {
      it('should archive community for super admin (soft delete)', async () => {
        // Create community to delete
        const newCommunity = {
          name: 'Community To Delete',
          description: 'Will be deleted',
          locale: 'en-US',
        };

        const createResponse = await app.inject({
          method: 'POST',
          url: '/api/v1/super_admin/communities',
          cookies: { sessionId: superAdminSessionId },
          payload: newCommunity,
        });

        const communityId = createResponse.json().data.id;

        const response = await app.inject({
          method: 'DELETE',
          url: `/api/v1/super_admin/communities/${communityId}`,
          cookies: { sessionId: superAdminSessionId },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          data: {
            message: 'Community archived successfully',
            id: communityId,
          },
        });
      });

      it('should return 404 for non-existent community', async () => {
        const response = await app.inject({
          method: 'DELETE',
          url: '/api/v1/super_admin/communities/99999',
          cookies: { sessionId: superAdminSessionId },
        });

        expect(response.statusCode).toBe(404);
      });

      it('should deny access to non-super-admin users', async () => {
        const response = await app.inject({
          method: 'DELETE',
          url: `/api/v1/super_admin/communities/${testCommunityId}`,
          cookies: { sessionId: adminSessionId },
        });

        expect(response.statusCode).toBe(403);
      });
    });
  });

  describe('User Management Endpoints', () => {
    describe('GET /api/v1/super_admin/users', () => {
      it('should list all users across communities for super admin', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/super_admin/users',
          cookies: { sessionId: superAdminSessionId },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          data: expect.arrayContaining([
            expect.objectContaining({
              id: expect.any(Number),
              email: expect.any(String),
              firstName: expect.any(String),
              lastName: expect.any(String),
              role: expect.any(String),
              communityId: expect.any(Number),
              communityName: expect.any(String),
              createdAt: expect.any(String),
            }),
          ]),
          meta: {
            page: 1,
            limit: 20,
            total: expect.any(Number),
            totalPages: expect.any(Number),
          },
        });
      });

      it('should support filtering by community', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/super_admin/users?community=${testCommunityId}`,
          cookies: { sessionId: superAdminSessionId },
        });

        expect(response.statusCode).toBe(200);
        // All returned users should belong to the specified community
        response.json().data.forEach((user: any) => {
          expect(user.communityId).toBe(testCommunityId);
        });
      });

      it('should support filtering by role', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/super_admin/users?role=admin',
          cookies: { sessionId: superAdminSessionId },
        });

        expect(response.statusCode).toBe(200);
        // All returned users should have admin role
        response.json().data.forEach((user: any) => {
          expect(user.role).toBe('admin');
        });
      });

      it('should deny access to non-super-admin users', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/super_admin/users',
          cookies: { sessionId: adminSessionId },
        });

        expect(response.statusCode).toBe(403);
      });
    });

    describe('GET /api/v1/super_admin/users/:id', () => {
      it('should get specific user details for super admin', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/super_admin/users/${superAdminUserId}`,
          cookies: { sessionId: superAdminSessionId },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          data: {
            id: superAdminUserId,
            email: expect.any(String),
            firstName: expect.any(String),
            lastName: expect.any(String),
            role: 'super_admin',
            communityId: expect.any(Number),
            communityName: expect.any(String),
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          },
        });
      });

      it('should return 404 for non-existent user', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/super_admin/users/99999',
          cookies: { sessionId: superAdminSessionId },
        });

        expect(response.statusCode).toBe(404);
      });

      it('should deny access to non-super-admin users', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/super_admin/users/${superAdminUserId}`,
          cookies: { sessionId: editorSessionId },
        });

        expect(response.statusCode).toBe(403);
      });
    });

    describe('POST /api/v1/super_admin/users', () => {
      it('should create user in any community for super admin', async () => {
        const newUser = {
          email: 'newuser@example.com',
          password: 'NewUserPassword123@',
          firstName: 'New',
          lastName: 'User',
          role: 'editor',
          communityId: testCommunityId,
        };

        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/super_admin/users',
          cookies: { sessionId: superAdminSessionId },
          payload: newUser,
        });

        expect(response.statusCode).toBe(201);
        expect(response.json()).toMatchObject({
          data: {
            id: expect.any(Number),
            email: newUser.email,
            firstName: newUser.firstName,
            lastName: newUser.lastName,
            role: newUser.role,
            communityId: newUser.communityId,
            createdAt: expect.any(String),
          },
        });
      });

      it('should validate required fields', async () => {
        const invalidUser = {
          firstName: 'Invalid',
          // Missing required fields
        };

        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/super_admin/users',
          cookies: { sessionId: superAdminSessionId },
          payload: invalidUser,
        });

        expect(response.statusCode).toBe(400);
      });

      it('should prevent duplicate emails', async () => {
        const duplicateUser = {
          email: 'admin@example.com', // Already exists
          password: 'Password123@',
          firstName: 'Duplicate',
          lastName: 'User',
          role: 'editor',
          communityId: testCommunityId,
        };

        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/super_admin/users',
          cookies: { sessionId: superAdminSessionId },
          payload: duplicateUser,
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          error: expect.stringContaining('email already exists'),
        });
      });

      it('should deny access to non-super-admin users', async () => {
        const newUser = {
          email: 'test@example.com',
          password: 'Password123@',
          firstName: 'Test',
          lastName: 'User',
          role: 'editor',
          communityId: testCommunityId,
        };

        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/super_admin/users',
          cookies: { sessionId: adminSessionId },
          payload: newUser,
        });

        expect(response.statusCode).toBe(403);
      });
    });

    describe('PUT /api/v1/super_admin/users/:id', () => {
      it('should update user details including role changes for super admin', async () => {
        const updates = {
          firstName: 'Updated',
          lastName: 'Name',
          role: 'admin',
        };

        const response = await app.inject({
          method: 'PUT',
          url: `/api/v1/super_admin/users/${superAdminUserId}`,
          cookies: { sessionId: superAdminSessionId },
          payload: updates,
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          data: {
            id: superAdminUserId,
            firstName: updates.firstName,
            lastName: updates.lastName,
            role: updates.role,
            updatedAt: expect.any(String),
          },
        });
      });

      it('should return 404 for non-existent user', async () => {
        const response = await app.inject({
          method: 'PUT',
          url: '/api/v1/super_admin/users/99999',
          cookies: { sessionId: superAdminSessionId },
          payload: { firstName: 'Updated' },
        });

        expect(response.statusCode).toBe(404);
      });

      it('should deny access to non-super-admin users', async () => {
        const response = await app.inject({
          method: 'PUT',
          url: `/api/v1/super_admin/users/${superAdminUserId}`,
          cookies: { sessionId: editorSessionId },
          payload: { firstName: 'Updated' },
        });

        expect(response.statusCode).toBe(403);
      });
    });

    describe('DELETE /api/v1/super_admin/users/:id', () => {
      it('should deactivate user account for super admin', async () => {
        // Create user to delete
        const userToDelete = {
          email: 'todelete@example.com',
          password: 'Password123@',
          firstName: 'To',
          lastName: 'Delete',
          role: 'viewer',
          communityId: testCommunityId,
        };

        const createResponse = await app.inject({
          method: 'POST',
          url: '/api/v1/super_admin/users',
          cookies: { sessionId: superAdminSessionId },
          payload: userToDelete,
        });

        const userId = createResponse.json().data.id;

        const response = await app.inject({
          method: 'DELETE',
          url: `/api/v1/super_admin/users/${userId}`,
          cookies: { sessionId: superAdminSessionId },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          data: {
            message: 'User deactivated successfully',
            id: userId,
          },
        });
      });

      it('should return 404 for non-existent user', async () => {
        const response = await app.inject({
          method: 'DELETE',
          url: '/api/v1/super_admin/users/99999',
          cookies: { sessionId: superAdminSessionId },
        });

        expect(response.statusCode).toBe(404);
      });

      it('should deny access to non-super-admin users', async () => {
        const response = await app.inject({
          method: 'DELETE',
          url: `/api/v1/super_admin/users/${superAdminUserId}`,
          cookies: { sessionId: adminSessionId },
        });

        expect(response.statusCode).toBe(403);
      });
    });
  });

  describe('Data Sovereignty Protection', () => {
    it('should block super admin from accessing community stories', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories',
        cookies: { sessionId: superAdminSessionId },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: expect.stringContaining(
          'Super admins cannot access community cultural data'
        ),
        statusCode: 403,
      });
    });

    it('should block super admin from accessing community places', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places',
        cookies: { sessionId: superAdminSessionId },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: expect.stringContaining(
          'Super admins cannot access community cultural data'
        ),
        statusCode: 403,
      });
    });

    it('should block super admin from accessing community speakers', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/speakers',
        cookies: { sessionId: superAdminSessionId },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: expect.stringContaining(
          'Super admins cannot access community cultural data'
        ),
        statusCode: 403,
      });
    });
  });

  describe('Audit Logging', () => {
    it('should log super admin actions for community operations', async () => {
      const newCommunity = {
        name: 'Logged Community',
        description: 'Test audit logging',
        locale: 'en-US',
      };

      await app.inject({
        method: 'POST',
        url: '/api/v1/super_admin/communities',
        cookies: { sessionId: superAdminSessionId },
        payload: newCommunity,
      });

      // TODO: Verify audit log entry was created
      // This would check the audit log table/service
    });

    it('should log super admin actions for user operations', async () => {
      const newUser = {
        email: 'loggeduser@example.com',
        password: 'Password123@',
        firstName: 'Logged',
        lastName: 'User',
        role: 'viewer',
        communityId: testCommunityId,
      };

      await app.inject({
        method: 'POST',
        url: '/api/v1/super_admin/users',
        cookies: { sessionId: superAdminSessionId },
        payload: newUser,
      });

      // TODO: Verify audit log entry was created
      // This would check the audit log table/service
    });
  });
});
