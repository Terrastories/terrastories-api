/**
 * Story Routes Error Handling Tests
 *
 * Covers the stories error-handling contract on the SQLite test app:
 * - Injected repository failures on POST/PATCH/DELETE must answer a generic
 *   500 { error: 'Internal server error' } and never leak SQL text.
 * - Domain errors keep their original mapping (403/404), not 500.
 * - Ids above MAX_DATABASE_ID (2^31 - 1) are rejected as 400 by request
 *   validation before any database call, identically on both backends.
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
import { FastifyInstance } from 'fastify';
import { testDb } from '../helpers/database.js';
import { createTestApp } from '../helpers/api-client.js';
import { extractSignedSessionCookie } from '../helpers/session-cookie.js';
import { StoryRepository } from '../../src/repositories/story.repository.js';

/** Failure text a real database driver would produce; must never reach the client. */
const DB_FAILURE_MESSAGE =
  'Failed query: select "id" from "places" where id = $1';

describe('Stories API error handling - Issue #135', () => {
  let app: FastifyInstance;
  let testCommunityId: number;
  let adminSessionId: string;
  let viewerSessionId: string;

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

    // An admin (story owner) and a viewer (may not edit) in the same community.
    const adminUser = {
      email: 'admin@example.com',
      password: 'StrongPassword123@',
      firstName: 'Admin',
      lastName: 'User',
      role: 'admin',
      communityId: testCommunityId,
    };
    const viewerUser = {
      email: 'viewer@example.com',
      password: 'StrongPassword123@',
      firstName: 'Viewer',
      lastName: 'User',
      role: 'viewer',
      communityId: testCommunityId,
    };
    for (const user of [adminUser, viewerUser]) {
      const registerResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: user,
      });
      if (registerResponse.statusCode !== 201) {
        throw new Error(
          `Registration failed for ${user.email}: ${registerResponse.statusCode} ${registerResponse.body}`
        );
      }
    }

    adminSessionId = await loginSession(adminUser.email, adminUser.password);
    viewerSessionId = await loginSession(viewerUser.email, viewerUser.password);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) {
      await app.close();
    }
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  /**
   * Create one story directly through the repository on the app's database.
   *
   * The POST /api/v1/stories 201 response schema declares `data` without
   * properties, so fast-json-stringify strips the created story (including
   * its id) from the client-visible body. The route under test here is
   * PATCH/DELETE error handling, so the fixture is seeded directly instead.
   */
  const createStory = async (): Promise<number> => {
    const { UserRepository } = await import(
      '../../src/repositories/user.repository.js'
    );
    const users = new UserRepository(testDb.db as any);
    const author = await users.create({
      email: 'story-author@example.test',
      passwordHash: 'stories-error-handling-test-hash',
      firstName: 'Story',
      lastName: 'Author',
      communityId: testCommunityId,
    });
    const created = await new StoryRepository(testDb.db as any).create({
      title: 'Error Handling Target Story',
      communityId: testCommunityId,
      createdBy: author.id,
    });
    return created.id;
  };

  /** A database failure must become a generic 500 that leaks no SQL text. */
  const expectGeneric500 = (response: { statusCode: number; body: string }) => {
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Internal server error',
    });
    expect(response.body).not.toContain('Failed query');
    expect(response.body).not.toContain('select');
  };

  describe('Injected repository failures', () => {
    test('POST /api/v1/stories with a failing place validation returns a generic 500', async () => {
      const { placesSqlite } = await import('../../src/db/schema/places.js');
      const [place] = await testDb.db
        .insert(placesSqlite)
        .values({
          name: 'Stories Error Place',
          communityId: testCommunityId,
          latitude: -1.4,
          longitude: -48.4,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      const spy = vi
        .spyOn(StoryRepository.prototype, 'validatePlacesInCommunity')
        .mockRejectedValue(new Error(DB_FAILURE_MESSAGE));

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/stories',
        headers: { cookie: adminSessionId },
        payload: {
          title: 'Story With Failing Place Validation',
          communityId: testCommunityId,
          placeIds: [place.id],
        },
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expectGeneric500(response);
    });

    test('PATCH /api/v1/stories/:id with a failing update returns a generic 500', async () => {
      const storyId = await createStory();

      const spy = vi
        .spyOn(StoryRepository.prototype, 'update')
        .mockRejectedValue(new Error(DB_FAILURE_MESSAGE));

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stories/${storyId}`,
        headers: { cookie: adminSessionId },
        payload: { title: 'Title That Never Lands' },
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expectGeneric500(response);
    });

    test('DELETE /api/v1/stories/:id with a failing delete returns a generic 500', async () => {
      const storyId = await createStory();

      const spy = vi
        .spyOn(StoryRepository.prototype, 'delete')
        .mockRejectedValue(new Error(DB_FAILURE_MESSAGE));

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/stories/${storyId}`,
        headers: { cookie: adminSessionId },
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expectGeneric500(response);
    });
  });

  describe('Domain errors keep their status mapping', () => {
    test('a story the viewer may not edit is still 403, not 500', async () => {
      const storyId = await createStory();

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stories/${storyId}`,
        headers: { cookie: viewerSessionId },
        payload: { title: 'Viewer Edit Attempt' },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(typeof body.error).toBe('string');
      expect(body.error).not.toBe('Internal server error');
    });
  });

  describe('Out-of-range ids are rejected by request validation', () => {
    test('POST with placeIds above MAX_DATABASE_ID returns 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/stories',
        headers: { cookie: adminSessionId },
        payload: {
          title: 'Story With Oversized Place Id',
          communityId: testCommunityId,
          placeIds: [3000000000],
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test('POST with interviewLocationId above MAX_DATABASE_ID returns 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/stories',
        headers: { cookie: adminSessionId },
        payload: {
          title: 'Story With Oversized Interview Location Id',
          communityId: testCommunityId,
          interviewLocationId: 3000000000,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test('PATCH /api/v1/stories/3000000000 returns 400', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/stories/3000000000',
        headers: { cookie: adminSessionId },
        payload: { title: 'Oversized Id Patch' },
      });

      expect(response.statusCode).toBe(400);
    });

    test('DELETE /api/v1/stories/3000000000 returns 400', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/stories/3000000000',
        headers: { cookie: adminSessionId },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
