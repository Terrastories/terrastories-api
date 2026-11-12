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

/**
 * SPEC-V2 §6.2/§6.3 story-audience enforcement on the transitional Fastify
 * schema: unrestricted `privacyLevel` 'public' maps to the public audience
 * and 'members_only' to community; a restricted story
 * (`isRestricted = true`) and any other privacyLevel (e.g. 'private') are
 * UNAVAILABLE in V2 runtime to every role — admin, editor, Fastify viewer
 * (= V2 member), super_admin, and the legacy `elder` role too. Denied reads
 * stay 404-masked and excluded from every list total.
 * A physical Fastify `viewer` is treated as canonical V2 `member` (§6.2), so
 * the seeded viewer below exercises member reach, while the canonical
 * viewer semantics stay covered by the sovereignty-policy unit tests.
 * An active private community does NOT block these authenticated reads.
 *
 * The transitional V1 response schemas on these routes serialize `data` as an
 * unconstrained object/array, so payload assertions are made against
 * `meta.total` (list) and status codes (single reads, 404-masked denials).
 */
describe('V2 sovereignty story audiences', () => {
  let app: FastifyInstance;
  let db: TestDatabase;
  let privateCommunityId: number;
  let viewerCookie: string;
  let editorCookie: string;
  let adminCookie: string;
  let elderCookie: string;
  let publicStoryId: number;
  let communityStoryId: number;
  let unknownPrivacyStoryId: number;
  let restrictedStoryId: number;
  let restrictedCommunityStoryId: number;

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
    // Demo Community is seeded with publicStories: false — an active private
    // community, which per §6.2 must not block authenticated own-community
    // audience reads. No seed stories exist in this community, so list totals
    // reflect exactly the three stories inserted below.
    privateCommunityId = fixtures.communities[1].id;

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const timestamp = Date.now();
    const [viewer] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(privateCommunityId, {
          email: `audience-viewer-${timestamp}@example.test`,
          role: 'viewer',
          passwordHash,
        })
      )
      .returning();
    const [editor] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(privateCommunityId, {
          email: `audience-editor-${timestamp}@example.test`,
          role: 'editor',
          passwordHash,
        })
      )
      .returning();
    const [admin] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(privateCommunityId, {
          email: `audience-admin-${timestamp}@example.test`,
          role: 'admin',
          passwordHash,
        })
      )
      .returning();
    const [elder] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(privateCommunityId, {
          email: `audience-elder-${timestamp}@example.test`,
          role: 'elder',
          passwordHash,
        })
      )
      .returning();

    const baseStory = {
      communityId: privateCommunityId,
      createdBy: editor.id,
      description: 'Story audience fixture',
    };
    const [publicStory] = await db
      .insert(storiesSqlite)
      .values({
        ...baseStory,
        title: 'Public audience story',
        slug: `audience-public-${timestamp}`,
        isRestricted: false,
        privacyLevel: 'public',
      })
      .returning();
    const [communityStory] = await db
      .insert(storiesSqlite)
      .values({
        ...baseStory,
        title: 'Community audience story',
        slug: `audience-community-${timestamp}`,
        isRestricted: false,
        privacyLevel: 'members_only',
      })
      .returning();
    const [unknownPrivacyStory] = await db
      .insert(storiesSqlite)
      .values({
        ...baseStory,
        title: 'Unknown privacyLevel story (unavailable)',
        slug: `audience-unknown-privacy-${timestamp}`,
        isRestricted: false,
        privacyLevel: 'private',
      })
      .returning();
    const [restrictedStory] = await db
      .insert(storiesSqlite)
      .values({
        ...baseStory,
        title: 'Restricted story (unavailable)',
        slug: `audience-restricted-${timestamp}`,
        isRestricted: true,
        privacyLevel: 'public',
      })
      .returning();
    // Restricted row whose privacyLevel would otherwise map to the community
    // audience: pins the `isRestricted = false` clause of the community
    // branch in storyAudienceCondition (lists, meta.total, withStories).
    const [restrictedCommunityStory] = await db
      .insert(storiesSqlite)
      .values({
        ...baseStory,
        title: 'Restricted members_only story (unavailable)',
        slug: `audience-restricted-community-${timestamp}`,
        isRestricted: true,
        privacyLevel: 'members_only',
      })
      .returning();
    restrictedCommunityStoryId = restrictedCommunityStory.id;
    publicStoryId = publicStory.id;
    communityStoryId = communityStory.id;
    unknownPrivacyStoryId = unknownPrivacyStory.id;
    restrictedStoryId = restrictedStory.id;

    app = await createTestApp(db);
    viewerCookie = await loginAs(viewer, privateCommunityId);
    editorCookie = await loginAs(editor, privateCommunityId);
    adminCookie = await loginAs(admin, privateCommunityId);
    elderCookie = await loginAs(elder, privateCommunityId);
  });

  afterEach(async () => {
    await app.close();
    await testDb.teardown();
  });

  it('includes public and community audiences in the Fastify viewer (V2 member) community-stories list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${privateCommunityId}/stories`,
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(200);
    const items = response.json().data;
    // SPEC-V2 §6.2: a physical Fastify viewer is a canonical V2 member, so
    // the community-stories list covers public + community audiences, while
    // restricted rows and the unknown privacyLevel story stay unavailable.
    expect(items).toHaveLength(2);
    const ids = items.map((item: { id: number }) => item.id);
    expect(ids).toContain(publicStoryId);
    expect(ids).toContain(communityStoryId);
    expect(ids).not.toContain(unknownPrivacyStoryId);
    expect(ids).not.toContain(restrictedStoryId);
    expect(ids).not.toContain(restrictedCommunityStoryId);
  });

  it('lets a Fastify viewer (V2 member) read a community-audience story', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${communityStoryId}`,
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(200);
  });

  it('denies a Fastify viewer (V2 member) an unknown privacyLevel story read', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${unknownPrivacyStoryId}`,
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('denies a Fastify viewer (V2 member) a restricted members_only story read (unavailable)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${restrictedCommunityStoryId}`,
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('denies a Fastify viewer (V2 member) a restricted story read (unavailable)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${restrictedStoryId}`,
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('lets a Fastify viewer (V2 member) read a community-audience story on the member surface', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/member/stories/${communityStoryId}`,
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(200);
  });

  it('lets a Fastify viewer (V2 member) read a public-audience story inside their own active private community', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${publicStoryId}`,
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(200);
  });

  it('counts public and community audiences for a Fastify viewer (V2 member) list, excluding unavailable stories', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/stories?page=1&limit=50',
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().meta.total).toBe(2);
    expect(response.json().data).toHaveLength(2);
  });

  it('denies an editor an unknown privacyLevel story read (unavailable)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${unknownPrivacyStoryId}`,
      headers: { cookie: editorCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('lets an editor read community-audience stories in their own community', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${communityStoryId}`,
      headers: { cookie: editorCookie },
    });

    expect(response.statusCode).toBe(200);
  });

  it('denies a same-community editor a restricted story read (unavailable)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${restrictedStoryId}`,
      headers: { cookie: editorCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('denies an admin an unknown privacyLevel story read (unavailable)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${unknownPrivacyStoryId}`,
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('denies an admin a restricted story read (unavailable)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${restrictedStoryId}`,
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('denies a legacy elder a restricted story read (unavailable)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${restrictedStoryId}`,
      headers: { cookie: elderCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('denies a legacy elder an unknown privacyLevel story read (unavailable)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${unknownPrivacyStoryId}`,
      headers: { cookie: elderCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('counts only public and community audiences for an editor list, excluding restricted and unknown privacyLevel', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/stories?page=1&limit=50',
      headers: { cookie: editorCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().meta.total).toBe(2);
  });

  it('counts only public and community audiences for an admin list, excluding restricted and unknown privacyLevel', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/stories?page=1&limit=50',
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().meta.total).toBe(2);
  });

  it('excludes restricted and unknown privacyLevel stories from the legacy elder community-stories list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${privateCommunityId}/stories`,
      headers: { cookie: elderCookie },
    });

    expect(response.statusCode).toBe(200);
    const items = response.json().data;
    expect(items).toHaveLength(2);
    const ids = items.map((item: { id: number }) => item.id);
    expect(ids).toContain(publicStoryId);
    expect(ids).toContain(communityStoryId);
    expect(ids).not.toContain(restrictedStoryId);
    expect(ids).not.toContain(unknownPrivacyStoryId);
    expect(ids).not.toContain(restrictedCommunityStoryId);
  });

  it('counts only public and community audiences for a legacy elder list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/stories?page=1&limit=50',
      headers: { cookie: elderCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().meta.total).toBe(2);
  });

  it('denies an unknown physical role every story read on the community story-by-id route (unknown roles read nothing)', async () => {
    // A physical Fastify `viewer` maps to V2 member and Fastify rows never
    // map to the `editors` audience, so admin and member reach coincide on
    // every unrestricted story — only an UNKNOWN role separates them.
    // It must read nothing (SPEC-V2 §6.2 fail-closed): even an
    // unrestricted members_only story and a public story mask as 404.
    const timestamp = Date.now();
    const passwordHash = await hashPassword(TEST_PASSWORD);
    // Unknown role on purpose; Drizzle types the column as its enum union
    // but SQLite enforces nothing, so cast through the column type.
    const [guest] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(privateCommunityId, {
          email: `audience-guest-${timestamp}@example.test`,
          role: 'guest' as unknown as 'viewer',
          passwordHash,
        })
      )
      .returning();
    const guestCookie = await loginAs(guest, privateCommunityId);

    // Unrestricted members_only story in the guest's own community: 404,
    // and the title never leaks in the body.
    const membersOnly = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${privateCommunityId}/stories/${communityStoryId}`,
      headers: { cookie: guestCookie },
    });
    expect(membersOnly.statusCode).toBe(404);
    expect(membersOnly.body).not.toContain('Community audience story');

    // Unknown roles read nothing — not even public stories.
    const publicRead = await app.inject({
      method: 'GET',
      url: `/api/v1/communities/${privateCommunityId}/stories/${publicStoryId}`,
      headers: { cookie: guestCookie },
    });
    expect(publicRead.statusCode).toBe(404);
    expect(publicRead.body).not.toContain('Public audience story');
  });
});
