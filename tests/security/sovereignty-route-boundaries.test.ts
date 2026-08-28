import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { storiesSqlite, usersSqlite } from '../../src/db/schema/index.js';
import { hashPassword } from '../../src/services/password.service.js';
import { createTestApp } from '../helpers/api-client.js';
import {
  TestDataFactory,
  testDb,
  type TestDatabase,
} from '../helpers/database.js';
import { extractSignedSessionCookie } from '../helpers/session-cookie.js';
import { TEST_PASSWORD } from '../constants/field-kit-test-constants.js';

describe('V2 sovereignty route boundaries', () => {
  let app: FastifyInstance;
  let db: TestDatabase;
  let communityAId: number;
  let communityBId: number;
  let viewerCookie: string;
  let communityBStorySlug: string;

  beforeEach(async () => {
    db = await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    communityAId = fixtures.communities[0].id;
    communityBId = fixtures.communities[1].id;

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const [viewer] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(communityAId, {
          email: `viewer-a-${Date.now()}@example.test`,
          role: 'viewer',
          passwordHash,
        })
      )
      .returning();
    const [communityBAuthor] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(communityBId, {
          email: `author-b-${Date.now()}@example.test`,
          role: 'editor',
          passwordHash,
        })
      )
      .returning();

    communityBStorySlug = `community-b-story-${Date.now()}`;
    await db.insert(storiesSqlite).values({
      title: 'Community B private story',
      description: 'Must never be observable by Community A',
      slug: communityBStorySlug,
      communityId: communityBId,
      createdBy: communityBAuthor.id,
      isRestricted: false,
      privacyLevel: 'private',
    });

    app = await createTestApp(db);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: viewer.email,
        password: TEST_PASSWORD,
        communityId: communityAId,
      },
    });
    expect(login.statusCode).toBe(200);
    viewerCookie = extractSignedSessionCookie(login.headers['set-cookie']);
  });

  afterEach(async () => {
    await app.close();
    await testDb.teardown();
  });

  it('rejects a cross-community place-list tenant override before querying data', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/places?community_id=${communityBId}`,
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().data).toBeUndefined();
  });

  it('rejects a cross-community story-by-slug tenant override', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/slug/${communityBStorySlug}/community/${communityBId}`,
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().data).toBeUndefined();
  });
});
