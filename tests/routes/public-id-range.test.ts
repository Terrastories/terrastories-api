/**
 * Path id range validation tests
 *
 * Path ids above MAX_DATABASE_ID (2147483647, the PostgreSQL integer cap)
 * are answered before any database call, so SQLite and PostgreSQL answer
 * out-of-range ids identically:
 * - public routes return 404 (an id that cannot exist is "not found", the
 *   same answer they already give a non-numeric id):
 *   GET /api/communities/:community_id/stories,
 *   GET /api/communities/:community_id/stories/:id,
 *   GET /api/communities/:community_id/places/:id
 * - GET /api/v1/places/:id (authenticated) returns 400 (request validation)
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from 'vitest';
import { CommunityRepository } from '../../src/repositories/community.repository.js';
import { FastifyInstance } from 'fastify';
import { testDb } from '../helpers/database.js';
import { createTestApp } from '../helpers/api-client.js';
import { extractSignedSessionCookie } from '../helpers/session-cookie.js';

/** Above 2^31 - 1 (MAX_DATABASE_ID) but a well-formed decimal integer. */
const OVERSIZED_ID = 3000000000;

describe('Out-of-range path ids never reach the database - Issue #135', () => {
  let app: FastifyInstance;
  let testCommunityId: number;
  let sessionId: string;

  const loginSession = async (
    email: string,
    password: string
  ): Promise<string> => {
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password, communityId: testCommunityId },
    });
    if (loginResponse.statusCode !== 200) {
      throw new Error(
        `Login failed for ${email}: ${loginResponse.statusCode} ${loginResponse.body}`
      );
    }
    return extractSignedSessionCookie(loginResponse.headers['set-cookie']);
  };

  beforeEach(async () => {
    await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[1].id; // Skip system community

    app = await createTestApp(testDb.db);

    const adminUser = {
      email: 'admin@example.com',
      password: 'StrongPassword123@',
      firstName: 'Admin',
      lastName: 'User',
      role: 'admin',
      communityId: testCommunityId,
    };
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: adminUser,
    });
    if (registerResponse.statusCode !== 201) {
      throw new Error(
        `Registration failed for ${adminUser.email}: ${registerResponse.statusCode} ${registerResponse.body}`
      );
    }

    sessionId = await loginSession(adminUser.email, adminUser.password);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  describe('Public routes (no authentication)', () => {
    test('GET /api/communities/3000000000/stories returns 404', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${OVERSIZED_ID}/stories`,
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error).toBe('Community not found');
    });

    test('GET /api/communities/:valid/stories/3000000000 returns 404', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/stories/${OVERSIZED_ID}`,
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error).toBe(
        'Story not found or not public'
      );
    });

    test('GET /api/communities/:valid/places/3000000000 returns 404', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/places/${OVERSIZED_ID}`,
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body).error).toBe('Place not found');
    });

    // The id bound must run before the community lookup: with a failing
    // database, an oversized story/place id still answers 404 and issues no
    // query at all (it used to reach validateCommunity first and return 500).
    test.each([
      ['stories', 'Story not found or not public'],
      ['places', 'Place not found'],
    ])(
      'GET /api/communities/:valid/%s/3000000000 makes zero database calls',
      async (resource, message) => {
        const failure = new Error('database unavailable');
        const findCommunity = vi
          .spyOn(CommunityRepository.prototype, 'findById')
          .mockRejectedValue(failure);
        const select = vi.spyOn(testDb.db, 'select').mockImplementation(() => {
          throw failure;
        });
        try {
          const response = await app.inject({
            method: 'GET',
            url: `/api/communities/${testCommunityId}/${resource}/${OVERSIZED_ID}`,
          });

          expect(response.statusCode).toBe(404);
          expect(JSON.parse(response.body).error).toBe(message);
          expect(findCommunity).not.toHaveBeenCalled();
          expect(select).not.toHaveBeenCalled();
        } finally {
          findCommunity.mockRestore();
          select.mockRestore();
        }
      }
    );
  });

  describe('Authenticated routes', () => {
    test('GET /api/v1/places/3000000000 returns 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/${OVERSIZED_ID}`,
        headers: { cookie: sessionId },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
