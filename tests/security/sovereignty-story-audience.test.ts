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
 * schema: `privacyLevel`/`isRestricted` map to canonical audiences
 * (public | community | editors) and each role may read only its audience:
 * viewer -> public, member -> public+community, editor/admin -> all.
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
  let publicStoryId: number;
  let communityStoryId: number;
  let editorsStoryId: number;
  let restrictedStoryId: number;

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
    const [editorsStory] = await db
      .insert(storiesSqlite)
      .values({
        ...baseStory,
        title: 'Editors audience story',
        slug: `audience-editors-${timestamp}`,
        isRestricted: false,
        privacyLevel: 'private',
      })
      .returning();
    const [restrictedStory] = await db
      .insert(storiesSqlite)
      .values({
        ...baseStory,
        title: 'Restricted (admin-only) story',
        slug: `audience-restricted-${timestamp}`,
        isRestricted: true,
        privacyLevel: 'public',
      })
      .returning();
    publicStoryId = publicStory.id;
    communityStoryId = communityStory.id;
    editorsStoryId = editorsStory.id;
    restrictedStoryId = restrictedStory.id;

    app = await createTestApp(db);
    viewerCookie = await loginAs(viewer, privateCommunityId);
    editorCookie = await loginAs(editor, privateCommunityId);
    adminCookie = await loginAs(admin, privateCommunityId);
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
    // the editors-audience and restricted (admin-only) stories stay excluded.
    expect(items).toHaveLength(2);
    const ids = items.map((item: { id: number }) => item.id);
    expect(ids).toContain(publicStoryId);
    expect(ids).toContain(communityStoryId);
    expect(ids).not.toContain(editorsStoryId);
    expect(ids).not.toContain(restrictedStoryId);
  });

  it('lets a Fastify viewer (V2 member) read a community-audience story', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${communityStoryId}`,
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(200);
  });

  it('denies a Fastify viewer (V2 member) an editors-audience story read', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${editorsStoryId}`,
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('denies a Fastify viewer (V2 member) a restricted (admin-only) story read', async () => {
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

  it('counts public and community audiences for a Fastify viewer (V2 member) list, excluding editors-audience', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/stories?page=1&limit=50',
      headers: { cookie: viewerCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().meta.total).toBe(2);
    expect(response.json().data).toHaveLength(2);
  });

  it('lets an editor read editors-audience stories in their own community', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${editorsStoryId}`,
      headers: { cookie: editorCookie },
    });

    expect(response.statusCode).toBe(200);
  });

  it('lets an editor read community-audience stories in their own community', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${communityStoryId}`,
      headers: { cookie: editorCookie },
    });

    expect(response.statusCode).toBe(200);
  });

  it('denies a same-community editor a restricted story read (V1 parity: admins only)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${restrictedStoryId}`,
      headers: { cookie: editorCookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('lets an admin read editors-audience stories in their own community', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${editorsStoryId}`,
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
  });

  it('lets an admin read restricted (admin-only) stories in their own community', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/stories/${restrictedStoryId}`,
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
  });

  it('counts public, community and editors audiences for an editor list, excluding restricted', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/stories?page=1&limit=50',
      headers: { cookie: editorCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().meta.total).toBe(3);
  });

  it('counts every story, restricted included, for an admin list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/stories?page=1&limit=50',
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().meta.total).toBe(4);
  });
});
