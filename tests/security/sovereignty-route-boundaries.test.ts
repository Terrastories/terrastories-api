import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
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
  let adminCookie: string;
  let superAdminCookie: string;
  let communityBStoryId: number;
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
    const [admin] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(communityAId, {
          email: `admin-a-${Date.now()}@example.test`,
          role: 'admin',
          passwordHash,
        })
      )
      .returning();
    const [superAdmin] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(communityAId, {
          email: `super-admin-${Date.now()}@example.test`,
          role: 'super_admin',
          passwordHash,
        })
      )
      .returning();

    communityBStorySlug = `community-b-story-${Date.now()}`;
    const [communityBStory] = await db
      .insert(storiesSqlite)
      .values({
        title: 'Community B private story',
        description: 'Must never be observable by Community A',
        slug: communityBStorySlug,
        communityId: communityBId,
        createdBy: communityBAuthor.id,
        isRestricted: false,
        privacyLevel: 'private',
      })
      .returning();
    communityBStoryId = communityBStory.id;

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

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: admin.email,
        password: TEST_PASSWORD,
        communityId: communityAId,
      },
    });
    expect(adminLogin.statusCode).toBe(200);
    adminCookie = extractSignedSessionCookie(adminLogin.headers['set-cookie']);

    const superAdminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: superAdmin.email,
        password: TEST_PASSWORD,
        communityId: communityAId,
      },
    });
    expect(superAdminLogin.statusCode).toBe(200);
    superAdminCookie = extractSignedSessionCookie(
      superAdminLogin.headers['set-cookie']
    );
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

  it('rejects conflicting tenant aliases before a handler can select the foreign community', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/places?communityId=${communityAId}&community_id=${communityBId}`,
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().data).toBeUndefined();
  });

  it('rejects malformed tenant aliases instead of silently discarding them', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/places?communityId=${communityAId}&community_id=invalid`,
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

  it('does not reveal or mutate a foreign story through an ID-only update route', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/stories/${communityBStoryId}?communityId=${communityAId}`,
      headers: { cookie: adminCookie },
      payload: { title: 'Cross-community overwrite attempt' },
    });
    const nonexistentResponse = await app.inject({
      method: 'PATCH',
      url: '/api/v1/stories/999999',
      headers: { cookie: adminCookie },
      payload: { title: 'Cross-community overwrite attempt' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.statusCode).toBe(nonexistentResponse.statusCode);
    expect(response.json()).toEqual(nonexistentResponse.json());

    const [persistedStory] = await db
      .select()
      .from(storiesSqlite)
      .where(eq(storiesSqlite.id, communityBStoryId));
    expect(persistedStory.title).toBe('Community B private story');
  });

  it('does not reveal or delete a foreign story through an ID-only delete route', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/stories/${communityBStoryId}?communityId=${communityAId}`,
      headers: { cookie: adminCookie },
    });
    const nonexistentResponse = await app.inject({
      method: 'DELETE',
      url: '/api/v1/stories/999999',
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.statusCode).toBe(nonexistentResponse.statusCode);
    expect(response.json()).toEqual(nonexistentResponse.json());

    const [persistedStory] = await db
      .select()
      .from(storiesSqlite)
      .where(eq(storiesSqlite.id, communityBStoryId));
    expect(persistedStory).toBeDefined();
  });

  it('rejects a cross-community tenant override supplied in a write body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/themes',
      headers: { cookie: adminCookie },
      payload: {
        name: 'Cross-community theme',
        communityId: communityBId,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().data).toBeUndefined();
  });

  it.each([
    ['place list', '/api/v1/places'],
    [
      'place near search',
      '/api/v1/places/near?latitude=0&longitude=0&radius=1',
    ],
    [
      'place bounds search',
      '/api/v1/places/bounds?north=1&south=-1&east=1&west=-1',
    ],
    ['place stats', '/api/v1/places/stats'],
    ['speaker list', '/api/v1/speakers'],
    ['speaker search', '/api/v1/speakers/search?q=test'],
    ['speaker stats', '/api/v1/speakers/stats'],
    ['theme list', '/api/v1/themes'],
    ['active themes', '/api/v1/themes/active'],
    ['file list', '/api/v1/files'],
    ['story detail', '/api/v1/stories/999999'],
  ])(
    'blocks super-admin from the %s community-content surface',
    async (_name, url) => {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: superAdminCookie },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().data).toBeUndefined();
    }
  );
});
