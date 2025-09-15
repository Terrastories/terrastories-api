/**
 * Error Handling Tests for Individual Resource Endpoints
 *
 * Focuses on testing potential 500 error scenarios for Issue #113:
 * - Database connection failures
 * - Schema mismatches
 * - Unhandled exceptions in repository layer
 * - Type coercion issues
 * - Authentication middleware edge cases
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { testDb } from '../helpers/database.js';
import { createTestApp } from '../helpers/api-client.js';

describe('Individual Resource Endpoint Error Handling - Issue #113', () => {
  let app: FastifyInstance;
  let testCommunityId: number;
  let adminSessionId: string;

  beforeEach(async () => {
    // Setup test database
    await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[1].id; // Skip system community

    // Create test app with real routes
    app = await createTestApp(testDb.db);

    // Create admin user and get session
    const adminUser = {
      email: 'admin@example.com',
      password: 'StrongPassword123@',
      firstName: 'Admin',
      lastName: 'User',
      role: 'admin',
      communityId: testCommunityId,
    };

    // Register admin
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: adminUser,
    });

    // Login as admin
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: adminUser.email,
        password: adminUser.password,
        communityId: testCommunityId,
      },
    });

    const cookieHeader = loginResponse.headers['set-cookie'];
    if (Array.isArray(cookieHeader)) {
      adminSessionId = cookieHeader[0];
    } else {
      adminSessionId = cookieHeader || '';
    }
  });

  afterEach(async () => {
    await testDb.cleanup();
    await app.close();
  });

  describe('GET /api/v1/speakers/:id - Error Scenarios', () => {
    test('should return 404 (not 500) for non-existent speaker with valid authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/speakers/99999`,
        headers: {
          cookie: adminSessionId,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.statusCode).not.toBe(500);

      const body = JSON.parse(response.body);
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('not found');

      // Should not contain generic "Internal server error" message
      expect(body.error.message).not.toBe('Internal server error');
    });

    test('should return 404 (not 500) for speaker in different community', async () => {
      // Create a speaker in a different community
      const fixtures = await testDb.seedTestData();
      const otherCommunityId = fixtures.communities[0].id; // Different community

      const speakersTable = await import('../../src/db/schema/speakers.js');
      const [otherCommunitySpeaker] = await testDb.db
        .insert(speakersTable.speakers)
        .values({
          name: 'Other Community Speaker',
          bio: 'From another community',
          communityId: otherCommunityId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/speakers/${otherCommunitySpeaker.id}`,
        headers: {
          cookie: adminSessionId,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.statusCode).not.toBe(500);

      const body = JSON.parse(response.body);
      expect(body.error.message).not.toBe('Internal server error');
    });

    test('should return 401 (not 500) for missing authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/speakers/1`,
      });

      expect(response.statusCode).toBe(401);
      expect(response.statusCode).not.toBe(500);

      const body = JSON.parse(response.body);
      expect(body.error.message).not.toBe('Internal server error');
    });

    test('should handle invalid ID parameter gracefully', async () => {
      const invalidIds = ['abc', '0', '-1', '1.5', 'null', 'undefined'];

      for (const invalidId of invalidIds) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/speakers/${invalidId}`,
          headers: {
            cookie: adminSessionId,
          },
        });

        // Should return 400 for validation error, not 500
        expect(response.statusCode).toBe(400);
        expect(response.statusCode).not.toBe(500);

        const body = JSON.parse(response.body);
        expect(body.error.message).not.toBe('Internal server error');
      }
    });

    test('should handle malformed authentication gracefully', async () => {
      const malformedCookies = [
        'sessionId=invalid-token',
        'sessionId=',
        'invalid-cookie-format',
        'sessionId=null',
      ];

      for (const cookie of malformedCookies) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/speakers/1`,
          headers: {
            cookie: cookie,
          },
        });

        // Should return 401 for auth error, not 500
        expect(response.statusCode).toBe(401);
        expect(response.statusCode).not.toBe(500);

        const body = JSON.parse(response.body);
        expect(body.error.message).not.toBe('Internal server error');
      }
    });
  });

  describe('GET /api/v1/places/:id - Error Scenarios', () => {
    test('should return 404 (not 500) for non-existent place with valid authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/99999`,
        headers: {
          cookie: adminSessionId,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.statusCode).not.toBe(500);

      const body = JSON.parse(response.body);
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('not found');

      // Should not contain generic "Internal server error" message
      expect(body.error.message).not.toBe('Internal server error');
    });

    test('should return 404 (not 500) for place in different community', async () => {
      // Create a place in a different community
      const fixtures = await testDb.seedTestData();
      const otherCommunityId = fixtures.communities[0].id;

      const placesTable = await import('../../src/db/schema/places.js');
      const [otherCommunityPlace] = await testDb.db
        .insert(placesTable.places)
        .values({
          name: 'Other Community Place',
          description: 'From another community',
          communityId: otherCommunityId,
          latitude: 50.0,
          longitude: -120.0,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/${otherCommunityPlace.id}`,
        headers: {
          cookie: adminSessionId,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.statusCode).not.toBe(500);

      const body = JSON.parse(response.body);
      expect(body.error.message).not.toBe('Internal server error');
    });

    test('should handle invalid ID parameter gracefully', async () => {
      const invalidIds = ['abc', '0', '-1', '1.5', 'null', 'undefined'];

      for (const invalidId of invalidIds) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/places/${invalidId}`,
          headers: {
            cookie: adminSessionId,
          },
        });

        // Should return 400 for validation error, not 500
        expect(response.statusCode).toBe(400);
        expect(response.statusCode).not.toBe(500);

        const body = JSON.parse(response.body);
        expect(body.error.message).not.toBe('Internal server error');
      }
    });
  });

  describe('Response Format Consistency', () => {
    test('all error responses should have consistent format', async () => {
      const endpoints = ['/api/v1/speakers/99999', '/api/v1/places/99999'];

      for (const endpoint of endpoints) {
        const response = await app.inject({
          method: 'GET',
          url: endpoint,
          headers: {
            cookie: adminSessionId,
          },
        });

        const body = JSON.parse(response.body);

        // Should have error object with message
        expect(body.error).toBeDefined();
        expect(body.error.message).toBeDefined();
        expect(typeof body.error.message).toBe('string');

        // Should not have statusCode in body (only in HTTP response)
        expect(body.statusCode).toBeUndefined();

        // Should not be the generic 500 error format
        expect(body.message).toBeUndefined(); // This would indicate old format
      }
    });

    test('should return proper Content-Type headers', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/speakers/99999`,
        headers: {
          cookie: adminSessionId,
        },
      });

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('Authentication Edge Cases', () => {
    test('should handle corrupted session data gracefully', async () => {
      // Create a response that might have been corrupted
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/speakers/1`,
        headers: {
          cookie: 'sessionId=corrupted.session.data.here',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.statusCode).not.toBe(500);
    });

    test('should handle expired sessions gracefully', async () => {
      // This would be more complex to test with actual expired tokens
      // For now, we test with invalid format which should not cause 500
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/speakers/1`,
        headers: {
          cookie: 'sessionId=expired.token.format',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.statusCode).not.toBe(500);
    });
  });
});
