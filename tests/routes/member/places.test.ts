/**
 * Member Places API Tests (GET endpoints only)
 *
 * Tests the implemented GET endpoints for member place management.
 * Note: POST/PUT/DELETE endpoints are not yet implemented and should be added in future PRs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { placesSqlite } from '../../../src/db/schema/index.js';
import { testDb } from '../../helpers/database.js';
import { createTestApp } from '../../helpers/api-client.js';
import { extractSignedSessionCookie } from '../../helpers/session-cookie.js';
import { seedRegisteredUser } from '../../helpers/community-authority.js';

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

    // Seed user directly (registration requires community-admin authority)
    await seedRegisteredUser(testDb.db, editorUser);

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
    editorSessionId = extractSignedSessionCookie(setCookieHeader);
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

  describe('GET /api/v1/member/places/:id - restricted places (SPEC-V2 §6.4)', () => {
    it('should return 404 for a restricted place for an editor', async () => {
      const [restrictedPlace] = await testDb.db
        .insert(placesSqlite)
        .values({
          name: 'Restricted Member Place',
          latitude: 49.2827,
          longitude: -123.1207,
          isRestricted: true,
          communityId: testCommunityId,
        })
        .returning();

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/member/places/${restrictedPlace.id}`,
        headers: { cookie: editorSessionId },
      });

      // A restricted place is unavailable to every role: the member
      // surface must mask it as nonexistent, never 403.
      expect(response.statusCode).toBe(404);
    });

    it('should exclude restricted places from the member list', async () => {
      await testDb.db
        .insert(placesSqlite)
        .values({
          name: 'Hidden Restricted Member Place',
          latitude: 49.2827,
          longitude: -123.1207,
          isRestricted: true,
          communityId: testCommunityId,
        })
        .returning();
      const [openPlace] = await testDb.db
        .insert(placesSqlite)
        .values({
          name: 'Open Member Place',
          latitude: 49.2828,
          longitude: -123.1208,
          isRestricted: false,
          communityId: testCommunityId,
        })
        .returning();

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places?page=1&limit=50',
        headers: { cookie: editorSessionId },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // The transitional member-list response schema strips item fields, so
      // exclusion is asserted through the count projection: only the one
      // unrestricted place exists in this community.
      expect(body.meta.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(openPlace.id).toBeDefined();
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
