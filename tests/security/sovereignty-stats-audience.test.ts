import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  placesSqlite,
  speakersSqlite,
  storiesSqlite,
  storyPlacesSqlite,
  usersSqlite,
} from '../../src/db/schema/index.js';
import { hashPassword } from '../../src/services/password.service.js';
import { createTestApp } from '../helpers/api-client.js';
import {
  TestDataFactory,
  testDb,
  type TestDatabase,
} from '../helpers/database.js';
import { extractSignedSessionCookie } from '../helpers/session-cookie.js';
import { TEST_PASSWORD } from '../constants/field-kit-test-constants.js';

/**
 * SPEC-V2 §6.2/§6.4/§6.5: count/filter metadata is a projection. Viewers and
 * members must not learn how many restricted places or inactive speakers
 * exist, and the removed elder-status scope never appears in any stats.
 */
describe('V2 sovereignty stats audiences', () => {
  let app: FastifyInstance;
  let db: TestDatabase;
  let communityId: number;
  let viewerCookie: string;
  let adminCookie: string;
  let editorCookie: string;
  let elderCookie: string;

  async function loginAs(user: { email: string }, communityId: number) {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: user.email,
        password: TEST_PASSWORD,
        communityId,
      },
    });
    expect(login.statusCode).toBe(200);
    return extractSignedSessionCookie(login.headers['set-cookie']);
  }

  beforeEach(async () => {
    db = await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    communityId = fixtures.communities[1].id;

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const timestamp = Date.now();
    const [viewer] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(communityId, {
          email: `stats-viewer-${timestamp}@example.test`,
          role: 'viewer',
          passwordHash,
        })
      )
      .returning();
    const [admin] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(communityId, {
          email: `stats-admin-${timestamp}@example.test`,
          role: 'admin',
          passwordHash,
        })
      )
      .returning();
    const [editor] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(communityId, {
          email: `stats-editor-${timestamp}@example.test`,
          role: 'editor',
          passwordHash,
        })
      )
      .returning();
    const [elder] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(communityId, {
          email: `stats-elder-${timestamp}@example.test`,
          role: 'elder',
          passwordHash,
        })
      )
      .returning();

    // Places: two unrestricted, one restricted.
    const [publicPlaceWithPublicStory] = await db
      .insert(placesSqlite)
      .values({
        name: 'Public place linked to a public story',
        latitude: 1,
        longitude: 1,
        isRestricted: false,
        communityId,
      })
      .returning();
    const [publicPlaceWithCommunityStory] = await db
      .insert(placesSqlite)
      .values({
        name: 'Public place linked to a community story',
        latitude: 2,
        longitude: 2,
        isRestricted: false,
        communityId,
      })
      .returning();
    const [publicPlaceWithRestrictedStory] = await db
      .insert(placesSqlite)
      .values({
        name: 'Public place linked to a restricted story',
        latitude: 4,
        longitude: 4,
        isRestricted: false,
        communityId,
      })
      .returning();
    await db.insert(placesSqlite).values({
      name: 'Restricted place',
      latitude: 3,
      longitude: 3,
      isRestricted: true,
      communityId,
    });

    const [publicStory] = await db
      .insert(storiesSqlite)
      .values({
        title: 'Public story',
        slug: `stats-public-${timestamp}`,
        communityId,
        createdBy: admin.id,
        isRestricted: false,
        privacyLevel: 'public',
      })
      .returning();
    const [communityStory] = await db
      .insert(storiesSqlite)
      .values({
        title: 'Community story',
        slug: `stats-community-${timestamp}`,
        communityId,
        createdBy: admin.id,
        isRestricted: false,
        privacyLevel: 'members_only',
      })
      .returning();
    const [restrictedStory] = await db
      .insert(storiesSqlite)
      .values({
        title: 'Restricted story',
        slug: `stats-restricted-${timestamp}`,
        communityId,
        createdBy: admin.id,
        isRestricted: true,
        privacyLevel: 'public',
      })
      .returning();
    await db.insert(storyPlacesSqlite).values([
      { storyId: publicStory.id, placeId: publicPlaceWithPublicStory.id },
      { storyId: communityStory.id, placeId: publicPlaceWithCommunityStory.id },
      {
        storyId: restrictedStory.id,
        placeId: publicPlaceWithRestrictedStory.id,
      },
    ]);

    // Speakers: two active, one inactive, one active with elderStatus.
    await db.insert(speakersSqlite).values([
      {
        name: 'Active speaker one',
        communityId,
        isActive: true,
        elderStatus: false,
      },
      {
        name: 'Active speaker two',
        communityId,
        isActive: true,
        elderStatus: false,
      },
      {
        name: 'Inactive speaker',
        communityId,
        isActive: false,
        elderStatus: false,
      },
      {
        name: 'Active elder-status speaker',
        communityId,
        isActive: true,
        elderStatus: true,
      },
    ]);

    app = await createTestApp(db);
    viewerCookie = await loginAs(viewer, communityId);
    adminCookie = await loginAs(admin, communityId);
    editorCookie = await loginAs(editor, communityId);
    elderCookie = await loginAs(elder, communityId);
  });

  afterEach(async () => {
    await app.close();
    await testDb.teardown();
  });

  it('counts only unrestricted places for a Fastify viewer (V2 member) and hides the restricted count', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/places/stats',
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(200);
    const stats = response.json().data;
    expect(stats.total).toBe(3);
    expect(stats.public).toBe(3);
    expect(stats.restricted).toBeUndefined();
  });

  it('counts public and community story places in withStories for a Fastify viewer (V2 member)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/places/stats',
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(200);
    // SPEC-V2 §6.2: the physical Fastify viewer has V2 member reach, so
    // places linked to public AND community stories count; the restricted
    // story is unavailable to every role and its place stays excluded.
    expect(response.json().data.withStories).toBe(2);
  });

  it('counts only unrestricted places for an admin and hides the restricted count', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/places/stats',
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    const stats = response.json().data;
    // SPEC-V2 §6.4: a restricted place is unavailable to every role, admin
    // included, so `total` counts unrestricted places only and the
    // `restricted` key never appears.
    expect(stats.total).toBe(3);
    expect(stats.public).toBe(3);
    expect(stats.restricted).toBeUndefined();
    // The place linked only to the restricted story is not counted either:
    // the restricted story is unavailable to admin too (§6.3).
    expect(stats.withStories).toBe(2);
  });

  it('counts only editor-readable stories in withStories for an editor', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/places/stats',
      headers: { cookie: editorCookie },
    });

    expect(response.statusCode).toBe(200);
    const stats = response.json().data;
    // Editors see unrestricted places (3) and every runtime story audience,
    // but the restricted story is unavailable to every role (§6.3).
    expect(stats.total).toBe(3);
    expect(stats.withStories).toBe(2);
  });

  it('counts only unrestricted places and readable-story places for a legacy elder', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/places/stats',
      headers: { cookie: elderCookie },
    });

    expect(response.statusCode).toBe(200);
    const stats = response.json().data;
    expect(stats.total).toBe(3);
    expect(stats.restricted).toBeUndefined();
    expect(stats.withStories).toBe(2);
  });

  it('counts only active speakers for a Fastify viewer (V2 member) and hides the inactive count', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/speakers/stats',
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(200);
    const stats = response.json().data;
    expect(stats.total).toBe(3);
    expect(stats.active).toBe(3);
    expect(stats.inactive).toBeUndefined();
  });

  it('never exposes the removed elder-status counts to any role', async () => {
    for (const cookie of [viewerCookie, adminCookie]) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers/stats',
        headers: { cookie },
      });

      expect(response.statusCode).toBe(200);
      const stats = response.json().data;
      expect(stats.elders).toBeUndefined();
      expect(stats.nonElders).toBeUndefined();
    }
  });

  it('keeps inactive speaker counts for an admin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/speakers/stats',
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    const stats = response.json().data;
    expect(stats.total).toBe(4);
    expect(stats.inactive).toBe(1);
  });
});
