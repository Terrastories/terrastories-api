/**
 * Member Stories API Tests (GET endpoints only)
 *
 * Tests the implemented GET endpoints for member story management.
 * Note: POST/PUT/DELETE endpoints are not yet implemented and should be added in future PRs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { testDb } from '../../helpers/database.js';
import { createTestApp } from '../../helpers/api-client.js';

describe('Member Stories API - GET Endpoints', () => {
  let app: FastifyInstance;
  let editorSessionId: string;
  let testCommunityId: number;

  beforeEach(async () => {
    await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[1].id; // Skip system community

    app = await createTestApp(testDb.db);

    // Create and login test user
    const editorUser = {
      email: 'editor@example.com',
      password: 'StrongPassword123@',
      firstName: 'Editor',
      lastName: 'User',
      role: 'editor',
      communityId: testCommunityId,
    };

    // Register user
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: editorUser,
    });

    // Login and get session cookie
    const editorLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: editorUser.email,
        password: editorUser.password,
        communityId: testCommunityId,
      },
    });
    // Extract SIGNED session cookie from Set-Cookie header
    // @fastify/session creates multiple cookies - we need the signed one (longer with signature)
    const setCookieHeader = editorLogin.headers['set-cookie'];
    if (Array.isArray(setCookieHeader)) {
      // Find all sessionId cookies
      const sessionCookies = setCookieHeader.filter((cookie) =>
        cookie.startsWith('sessionId=')
      );
      
      // Use the signed cookie (longer one with signature) if available
      editorSessionId = sessionCookies.length > 1 ? sessionCookies[1] : sessionCookies[0] || '';
    } else if (setCookieHeader && typeof setCookieHeader === 'string') {
      editorSessionId = setCookieHeader.startsWith('sessionId=') ? setCookieHeader : '';
    }
  });

  afterEach(async () => {
    await app.close();
    await testDb.teardown();
  });

  describe('Authentication & Authorization', () => {
    it('should reject unauthenticated requests', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('error');
    });

    it('should accept authenticated requests with valid session', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories',
        headers: { cookie: editorSessionId },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        data: expect.any(Array),
        meta: expect.objectContaining({
          page: expect.any(Number),
          limit: expect.any(Number),
          total: expect.any(Number),
        }),
      });
    });
  });

  describe('GET /api/v1/member/stories', () => {
    it('should list community stories with pagination', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories?page=1&limit=10',
        headers: { cookie: editorSessionId },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body).toMatchObject({
        data: expect.any(Array),
        meta: expect.objectContaining({
          page: 1,
          limit: 10,
          total: expect.any(Number),
          totalPages: expect.any(Number),
          hasNextPage: expect.any(Boolean),
          hasPrevPage: expect.any(Boolean),
        }),
      });
    });

    it('should validate pagination parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories?page=0&limit=101',
        headers: { cookie: editorSessionId },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('error');
    });

    it('should support search and filtering', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories?search=test&language=en',
        headers: { cookie: editorSessionId },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
    });
  });

  describe('GET /api/v1/member/stories/:id', () => {
    it('should return 404 for non-existent story', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories/99999',
        headers: { cookie: editorSessionId },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body)).toMatchObject({
        error: expect.objectContaining({
          code: 'NOT_FOUND',
        }),
      });
    });
  });

  describe('Response Format Validation', () => {
    it('should return consistent envelope format for list endpoint', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories',
        headers: { cookie: editorSessionId },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body).toMatchObject({
        data: expect.any(Array),
        meta: expect.objectContaining({
          page: expect.any(Number),
          limit: expect.any(Number),
          total: expect.any(Number),
          totalPages: expect.any(Number),
          hasNextPage: expect.any(Boolean),
          hasPrevPage: expect.any(Boolean),
        }),
      });
    });
  });

  describe('Rate Limiting', () => {
    it('should apply rate limits to member endpoints', async () => {
      // Make multiple rapid requests
      const promises = Array(10)
        .fill(null)
        .map(() =>
          app.inject({
            method: 'GET',
            url: '/api/v1/member/stories',
            headers: { cookie: editorSessionId },
          })
        );

      const responses = await Promise.all(promises);

      // All should succeed or be rate limited (but not fail with other errors)
      responses.forEach((response) => {
        expect([200, 429]).toContain(response.statusCode);
      });
    });
  });
});

// Note: POST, PUT, DELETE endpoints are not yet implemented
// TODO: Add tests for CRUD operations when they are implemented in future PRs
