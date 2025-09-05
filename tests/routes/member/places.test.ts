/**
 * Member Places API Tests (GET endpoints only)
 *
 * Tests the implemented GET endpoints for member place management.
 * Note: POST/PUT/DELETE endpoints are not yet implemented and should be added in future PRs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { testDb } from '../../helpers/database.js';
import { createTestApp } from '../../helpers/api-client.js';

describe('Member Places API - GET Endpoints', () => {
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
        url: '/api/v1/member/places',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should accept authenticated requests with valid session', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places',
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

  describe('GET /api/v1/member/places', () => {
    it('should list community places with pagination', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places?page=1&limit=10',
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
        url: '/api/v1/member/places?page=0&limit=101',
        headers: { cookie: editorSessionId },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('error');
    });

    it('should support geographic filtering', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places?region=test&search=location',
        headers: { cookie: editorSessionId },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('meta');
    });
  });

  describe('Response Format Validation', () => {
    it('should return consistent envelope format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places',
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
});

// Note: POST, PUT, DELETE endpoints are not yet implemented
// TODO: Add tests for CRUD operations when they are implemented in future PRs
