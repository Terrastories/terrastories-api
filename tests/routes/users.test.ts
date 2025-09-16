/**
 * Community-Scoped User Management Route Tests
 *
 * Tests for regular user management endpoints that operate within
 * community boundaries for data sovereignty compliance.
 *
 * Covers all CRUD operations with proper authentication, authorization,
 * and community data isolation validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { testDb } from '../helpers/database.js';
import { createTestApp } from '../helpers/api-client.js';

describe('Community-Scoped User Management Routes', () => {
  let app: FastifyInstance;
  let testCommunityId: number;
  let testData: any;

  beforeEach(async () => {
    // Setup test database
    const db = await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[0].id;

    // Create test app
    app = await createTestApp(db);

    // Store test data for easier access
    testData = {
      community1: fixtures.communities[0],
      community2: fixtures.communities[1],
      users: {
        admin1: fixtures.users.find(
          (u: any) =>
            u.role === 'admin' && u.communityId === fixtures.communities[0].id
        ),
        admin2: fixtures.users.find(
          (u: any) =>
            u.role === 'admin' && u.communityId === fixtures.communities[1].id
        ),
        editor1: fixtures.users.find(
          (u: any) =>
            u.role === 'editor' && u.communityId === fixtures.communities[0].id
        ),
        superAdmin: fixtures.users.find((u: any) => u.role === 'super_admin'),
      },
    };
  });

  afterEach(async () => {
    await app.close();
    await testDb.cleanup();
  });

  // Helper function to create authenticated session
  async function createAuthSession(user: any) {
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: user.email,
        password: 'TestPassword123!', // Default test password
        communityId: user.communityId,
      },
    });

    expect(loginResponse.statusCode).toBe(200);

    const setCookieHeader = loginResponse.headers['set-cookie'];
    const signedCookie = Array.isArray(setCookieHeader)
      ? setCookieHeader[1]
      : setCookieHeader;
    return signedCookie?.split(';')[0] || '';
  }

  describe('GET /api/v1/users', () => {
    it('should list users in authenticated user community with pagination', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users?page=1&limit=10',
        headers: { Cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
      expect(body.meta).toHaveProperty('page', 1);
      expect(body.meta).toHaveProperty('limit', 10);
      expect(body.meta).toHaveProperty('total');
      expect(body.meta).toHaveProperty('totalPages');

      // All returned users should be from same community
      expect(body.data).toBeInstanceOf(Array);
      for (const user of body.data) {
        expect(user.communityId).toBe(testData.users.admin1.communityId);
        expect(user).toHaveProperty('id');
        expect(user).toHaveProperty('email');
        expect(user).toHaveProperty('firstName');
        expect(user).toHaveProperty('lastName');
        expect(user).toHaveProperty('role');
        expect(user).toHaveProperty('isActive');
        expect(user).toHaveProperty('createdAt');
        expect(user).toHaveProperty('updatedAt');
        expect(user).not.toHaveProperty('passwordHash');
      }
    });

    it('should support search filtering by name and email', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users?search=test&limit=5',
        headers: { Cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeInstanceOf(Array);

      // All results should match search term
      for (const user of body.data) {
        const fullName = `${user.firstName} ${user.lastName}`.toLowerCase();
        const email = user.email.toLowerCase();
        expect(fullName.includes('test') || email.includes('test')).toBe(true);
      }
    });

    it('should support role filtering', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users?role=editor',
        headers: { Cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // All results should have editor role
      for (const user of body.data) {
        expect(user.role).toBe('editor');
      }
    });

    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Authentication required');
    });

    it('should require admin role', async () => {
      const sessionCookie = await createAuthSession(testData.users.editor1);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users',
        headers: { Cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Insufficient permissions');
    });

    it('should only show users from same community (data sovereignty)', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users',
        headers: { Cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Verify no users from other communities are returned
      for (const user of body.data) {
        expect(user.communityId).toBe(testData.users.admin1.communityId);
        expect(user.communityId).not.toBe(testData.community2.id);
      }
    });
  });

  describe('GET /api/v1/users/:id', () => {
    it('should get user details when user is in same community', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      const targetUserId = testData.users.editor1.id; // Same community

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${targetUserId}`,
        headers: { Cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body).toHaveProperty('data');
      expect(body.data.id).toBe(targetUserId);
      expect(body.data.communityId).toBe(testData.users.admin1.communityId);
      expect(body.data).toHaveProperty('email');
      expect(body.data).toHaveProperty('firstName');
      expect(body.data).toHaveProperty('lastName');
      expect(body.data).toHaveProperty('role');
      expect(body.data).not.toHaveProperty('passwordHash');
    });

    it('should return 404 when user is in different community', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      const otherCommunityUserId = testData.users.admin2.id; // Different community

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${otherCommunityUserId}`,
        headers: { Cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('User not found');
    });

    it('should return 404 when user does not exist', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/users/99999',
        headers: { Cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${testData.users.editor1.id}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should require admin role', async () => {
      const sessionCookie = await createAuthSession(testData.users.editor1);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${testData.users.editor1.id}`,
        headers: { Cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('POST /api/v1/users', () => {
    const validUserData = {
      email: 'newuser@example.com',
      password: 'SecurePassword123!',
      firstName: 'New',
      lastName: 'User',
      role: 'editor' as const,
      isActive: true,
    };

    it('should create user in authenticated user community', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(validUserData),
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);

      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('message', 'User created successfully');
      expect(body.data.email).toBe(validUserData.email);
      expect(body.data.firstName).toBe(validUserData.firstName);
      expect(body.data.lastName).toBe(validUserData.lastName);
      expect(body.data.role).toBe(validUserData.role);
      expect(body.data.communityId).toBe(testData.users.admin1.communityId);
      expect(body.data.isActive).toBe(true);
      expect(body.data).toHaveProperty('id');
      expect(body.data).toHaveProperty('createdAt');
      expect(body.data).toHaveProperty('updatedAt');
      expect(body.data).not.toHaveProperty('password');
      expect(body.data).not.toHaveProperty('passwordHash');
    });

    it('should reject duplicate email within same community', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      const duplicateEmailData = {
        ...validUserData,
        email: testData.users.editor1.email, // Existing email in same community
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(duplicateEmailData),
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('email already exists');
    });

    it('should allow same email in different communities', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      const sameEmailDifferentCommunity = {
        ...validUserData,
        email: testData.users.admin2.email, // Exists in different community
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(sameEmailDifferentCommunity),
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.email).toBe(sameEmailDifferentCommunity.email);
      expect(body.data.communityId).toBe(testData.users.admin1.communityId);
    });

    it('should validate required fields', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      const invalidData = {
        email: 'invalid-email', // Invalid email format
        // Missing password, firstName, lastName
        role: 'editor',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(invalidData),
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('error');
    });

    it('should validate password strength', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      const weakPasswordData = {
        ...validUserData,
        password: '123', // Too weak
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(weakPasswordData),
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('password');
    });

    it('should validate role values', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      const invalidRoleData = {
        ...validUserData,
        role: 'invalid_role',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(invalidRoleData),
      });

      expect(response.statusCode).toBe(400);
    });

    it('should not allow creating super_admin users', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      const superAdminData = {
        ...validUserData,
        role: 'super_admin',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(superAdminData),
      });

      // Should either reject the role or filter it out
      expect([400, 403].includes(response.statusCode)).toBe(true);
    });

    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify(validUserData),
      });

      expect(response.statusCode).toBe(401);
    });

    it('should require admin role', async () => {
      const sessionCookie = await createAuthSession(testData.users.editor1);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(validUserData),
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('PUT /api/v1/users/:id', () => {
    const updateData = {
      firstName: 'Updated',
      lastName: 'Name',
      role: 'viewer' as const,
      isActive: false,
    };

    it('should update user when user is in same community', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      const targetUserId = testData.users.editor1.id; // Same community

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${targetUserId}`,
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(updateData),
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('message', 'User updated successfully');
      expect(body.data.id).toBe(targetUserId);
      expect(body.data.firstName).toBe(updateData.firstName);
      expect(body.data.lastName).toBe(updateData.lastName);
      expect(body.data.role).toBe(updateData.role);
      expect(body.data.isActive).toBe(updateData.isActive);
      expect(body.data.communityId).toBe(testData.users.admin1.communityId);
    });

    it('should return 404 when user is in different community', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      const otherCommunityUserId = testData.users.admin2.id; // Different community

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${otherCommunityUserId}`,
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(updateData),
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('User not found');
    });

    it('should validate update data', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      const targetUserId = testData.users.editor1.id;
      const invalidData = {
        role: 'invalid_role',
        isActive: 'not_boolean',
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${targetUserId}`,
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(invalidData),
      });

      expect(response.statusCode).toBe(400);
    });

    it('should not allow updating to super_admin role', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      const targetUserId = testData.users.editor1.id;
      const superAdminUpdate = {
        role: 'super_admin',
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${targetUserId}`,
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(superAdminUpdate),
      });

      expect([400, 403].includes(response.statusCode)).toBe(true);
    });

    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${testData.users.editor1.id}`,
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify(updateData),
      });

      expect(response.statusCode).toBe(401);
    });

    it('should require admin role', async () => {
      const sessionCookie = await createAuthSession(testData.users.editor1);

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/users/${testData.users.editor1.id}`,
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(updateData),
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('PATCH /api/v1/users/:id', () => {
    const partialUpdateData = {
      isActive: false,
    };

    it('should partially update user when user is in same community', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      const targetUserId = testData.users.editor1.id;
      const originalFirstName = testData.users.editor1.firstName;

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${targetUserId}`,
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(partialUpdateData),
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.data.id).toBe(targetUserId);
      expect(body.data.isActive).toBe(false); // Updated field
      expect(body.data.firstName).toBe(originalFirstName); // Unchanged field
    });

    it('should return 404 when user is in different community', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      const otherCommunityUserId = testData.users.admin2.id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${otherCommunityUserId}`,
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(partialUpdateData),
      });

      expect(response.statusCode).toBe(404);
    });

    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${testData.users.editor1.id}`,
        headers: { 'Content-Type': 'application/json' },
        payload: JSON.stringify(partialUpdateData),
      });

      expect(response.statusCode).toBe(401);
    });

    it('should require admin role', async () => {
      const sessionCookie = await createAuthSession(testData.users.editor1);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${testData.users.editor1.id}`,
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(partialUpdateData),
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('DELETE /api/v1/users/:id', () => {
    it('should delete user when user is in same community', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      // Create a test user to delete
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify({
          email: 'todelete@example.com',
          password: 'SecurePassword123!',
          firstName: 'To',
          lastName: 'Delete',
          role: 'viewer',
        }),
      });
      const createdUser = JSON.parse(createResponse.body).data;

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${createdUser.id}`,
        headers: { Cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('message');
      expect(body.data).toHaveProperty('id', createdUser.id);

      // Verify user is deleted/deactivated
      const getResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/users/${createdUser.id}`,
        headers: { Cookie: sessionCookie },
      });
      expect(getResponse.statusCode).toBe(404);
    });

    it('should return 404 when user is in different community', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);
      const otherCommunityUserId = testData.users.admin2.id;

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${otherCommunityUserId}`,
        headers: { Cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 when user does not exist', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/users/99999',
        headers: { Cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${testData.users.editor1.id}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should require admin role', async () => {
      const sessionCookie = await createAuthSession(testData.users.editor1);

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${testData.users.editor1.id}`,
        headers: { Cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should prevent admin from deleting themselves', async () => {
      const sessionCookie = await createAuthSession(testData.users.admin1);

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/users/${testData.users.admin1.id}`,
        headers: { Cookie: sessionCookie },
      });

      expect([400, 403].includes(response.statusCode)).toBe(true);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('cannot delete');
    });
  });

  describe('Data Sovereignty Compliance', () => {
    it('should block super admin access to regular user endpoints', async () => {
      const sessionCookie = await createAuthSession(testData.users.superAdmin);

      const endpoints = [
        'GET /api/v1/users',
        'GET /api/v1/users/1',
        'POST /api/v1/users',
        'PUT /api/v1/users/1',
        'PATCH /api/v1/users/1',
        'DELETE /api/v1/users/1',
      ];

      for (const endpoint of endpoints) {
        const [method, path] = endpoint.split(' ');
        const response = await app.inject({
          method,
          url: path,
          headers: {
            Cookie: sessionCookie,
            'Content-Type': 'application/json',
          },
          payload:
            method === 'POST'
              ? JSON.stringify({
                  email: 'test@example.com',
                  password: 'SecurePassword123!',
                  firstName: 'Test',
                  lastName: 'User',
                  role: 'editor',
                })
              : undefined,
        });

        expect(response.statusCode).toBe(403);
        const body = JSON.parse(response.body);
        expect(body.error).toContain('data sovereignty');
      }
    });

    it('should ensure all operations respect community boundaries', async () => {
      const admin1SessionCookie = await createAuthSession(
        testData.users.admin1
      );
      const admin2SessionCookie = await createAuthSession(
        testData.users.admin2
      );

      // Admin 1 should only see users in community 1
      const users1Response = await app.inject({
        method: 'GET',
        url: '/api/v1/users',
        headers: { Cookie: admin1SessionCookie },
      });
      const users1 = JSON.parse(users1Response.body).data;
      for (const user of users1) {
        expect(user.communityId).toBe(testData.community1.id);
      }

      // Admin 2 should only see users in community 2
      const users2Response = await app.inject({
        method: 'GET',
        url: '/api/v1/users',
        headers: { Cookie: admin2SessionCookie },
      });
      const users2 = JSON.parse(users2Response.body).data;
      for (const user of users2) {
        expect(user.communityId).toBe(testData.community2.id);
      }

      // No overlap between communities
      const userIds1 = users1.map((u: any) => u.id);
      const userIds2 = users2.map((u: any) => u.id);
      const intersection = userIds1.filter((id: number) =>
        userIds2.includes(id)
      );
      expect(intersection).toHaveLength(0);
    });
  });
});
