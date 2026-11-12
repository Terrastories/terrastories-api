import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { communitiesSqlite, usersSqlite } from '../../src/db/schema/index.js';
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
 * SPEC-V2 §4/§6.1 community discoverability: a community's `visibility`
 * (Fastify `publicStories`) controls public discoverability and its `status`
 * (Fastify `isActive`) closes every public path when disabled. On the
 * unauthenticated community surfaces —
 *
 *   GET /api/communities            (public list)
 *   GET /api/v1/communities         (v1 list, `?isActive=` must not widen)
 *   GET /api/v1/communities/:id     (v1 by-id)
 *
 * — a community is visible to anonymous and other-community callers only
 * when it is public AND active; everything else is excluded from lists and
 * totals and answers 404 by-id (no existence signal). An authenticated
 * same-community session user may additionally see their own active but
 * private community; `super_admin` gets no extra visibility on these routes
 * (it sees what anonymous sees). `culturalSettings` is removed V1 cultural
 * metadata and never reaches anonymous or other-community callers here.
 */
describe('V2 sovereignty community discoverability', () => {
  let app: FastifyInstance;
  let db: TestDatabase;
  let publicCommunityId: number;
  let privateCommunityId: number;
  let disabledCommunityId: number;
  let openViewerCookie: string;
  let privateViewerCookie: string;
  let superAdminCookie: string;

  const CULTURAL_SETTINGS = JSON.stringify({
    secret: 'cultural-settings-marker',
  });

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

    const timestamp = Date.now();
    // Exactly three communities so list totals are unambiguous:
    // public+active, private+active, public+disabled.
    const [publicCommunity] = await db
      .insert(communitiesSqlite)
      .values(
        TestDataFactory.createCommunity({
          name: 'OPEN-COMMUNITY',
          slug: `open-community-${timestamp}`,
          publicStories: true,
          isActive: true,
          culturalSettings: CULTURAL_SETTINGS,
        })
      )
      .returning();
    const [privateCommunity] = await db
      .insert(communitiesSqlite)
      .values(
        TestDataFactory.createCommunity({
          name: 'PRIVATE-COMMUNITY',
          slug: `private-community-${timestamp}`,
          publicStories: false,
          isActive: true,
          culturalSettings: CULTURAL_SETTINGS,
        })
      )
      .returning();
    const [disabledCommunity] = await db
      .insert(communitiesSqlite)
      .values(
        TestDataFactory.createCommunity({
          name: 'DISABLED-COMMUNITY',
          slug: `disabled-community-${timestamp}`,
          publicStories: true,
          isActive: false,
          culturalSettings: CULTURAL_SETTINGS,
        })
      )
      .returning();

    publicCommunityId = publicCommunity.id;
    privateCommunityId = privateCommunity.id;
    disabledCommunityId = disabledCommunity.id;

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const [openViewer] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(publicCommunityId, {
          email: `discover-open-viewer-${timestamp}@example.test`,
          role: 'viewer',
          passwordHash,
        })
      )
      .returning();
    const [privateViewer] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(privateCommunityId, {
          email: `discover-private-viewer-${timestamp}@example.test`,
          role: 'viewer',
          passwordHash,
        })
      )
      .returning();
    // Attached to the private community on purpose: a super_admin session
    // must not gain same-community widening from its communityId.
    const [superAdmin] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(privateCommunityId, {
          email: `discover-super-admin-${timestamp}@example.test`,
          role: 'super_admin',
          passwordHash,
        })
      )
      .returning();

    app = await createTestApp(db);
    openViewerCookie = await loginAs(openViewer, publicCommunityId);
    privateViewerCookie = await loginAs(privateViewer, privateCommunityId);
    superAdminCookie = await loginAs(superAdmin, privateCommunityId);
  });

  afterEach(async () => {
    await app.close();
    await testDb.teardown();
  });

  function expectOnlyPublicCommunity(body: {
    data?: Array<{ id: number; name: string }>;
    meta?: { total?: number };
  }) {
    expect(body.data).toHaveLength(1);
    expect(body.data?.[0]?.name).toBe('OPEN-COMMUNITY');
    expect(body.meta?.total).toBe(1);
  }

  describe('anonymous public list: GET /api/communities', () => {
    it('lists only the public+active community with a matching total', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/communities',
      });

      expect(response.statusCode).toBe(200);
      expectOnlyPublicCommunity(response.json());
      expect(response.body).not.toContain('PRIVATE-COMMUNITY');
      expect(response.body).not.toContain('DISABLED-COMMUNITY');
    });

    it('never exposes culturalSettings', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/communities',
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('culturalSettings');
      for (const item of response.json().data) {
        expect(item).not.toHaveProperty('culturalSettings');
      }
    });
  });

  describe('anonymous v1 list: GET /api/v1/communities', () => {
    it('lists only the public+active community with a matching total', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/communities',
      });

      expect(response.statusCode).toBe(200);
      expectOnlyPublicCommunity(response.json());
      expect(response.body).not.toContain('PRIVATE-COMMUNITY');
      expect(response.body).not.toContain('DISABLED-COMMUNITY');
    });

    it('does not let ?isActive=false widen discovery', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/communities?isActive=false',
      });

      expect(response.statusCode).toBe(200);
      expectOnlyPublicCommunity(response.json());
      expect(response.body).not.toContain('PRIVATE-COMMUNITY');
      expect(response.body).not.toContain('DISABLED-COMMUNITY');
    });

    it('never exposes culturalSettings', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/communities',
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('culturalSettings');
      for (const item of response.json().data) {
        expect(item).not.toHaveProperty('culturalSettings');
      }
    });
  });

  describe('anonymous v1 by-id: GET /api/v1/communities/:id', () => {
    it('returns 200 for the public+active community without cultural metadata', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${publicCommunityId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.name).toBe('OPEN-COMMUNITY');
      expect(response.json().data).not.toHaveProperty('culturalSettings');
      expect(response.json().data).not.toHaveProperty('culturalProtocols');
    });

    it('returns 404 for a private community (no existence signal)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${privateCommunityId}`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('PRIVATE-COMMUNITY');
    });

    it('returns 404 for a disabled community (no existence signal)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${disabledCommunityId}`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('DISABLED-COMMUNITY');
    });
  });

  describe('authenticated viewer of another community', () => {
    it('sees the same lists as anonymous', async () => {
      const v1List = await app.inject({
        method: 'GET',
        url: '/api/v1/communities',
        headers: { cookie: openViewerCookie },
      });
      expect(v1List.statusCode).toBe(200);
      expectOnlyPublicCommunity(v1List.json());
      expect(v1List.body).not.toContain('PRIVATE-COMMUNITY');
      expect(v1List.body).not.toContain('DISABLED-COMMUNITY');

      const publicList = await app.inject({
        method: 'GET',
        url: '/api/communities',
        headers: { cookie: openViewerCookie },
      });
      expect(publicList.statusCode).toBe(200);
      expectOnlyPublicCommunity(publicList.json());
      expect(publicList.body).not.toContain('PRIVATE-COMMUNITY');
      expect(publicList.body).not.toContain('DISABLED-COMMUNITY');
    });

    it('gets 404 for the private and disabled communities by id', async () => {
      const privateResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${privateCommunityId}`,
        headers: { cookie: openViewerCookie },
      });
      expect(privateResponse.statusCode).toBe(404);

      const disabledResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${disabledCommunityId}`,
        headers: { cookie: openViewerCookie },
      });
      expect(disabledResponse.statusCode).toBe(404);
    });
  });

  describe('authenticated same-community viewer', () => {
    it('sees their own active-but-private community by id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${privateCommunityId}`,
        headers: { cookie: privateViewerCookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.name).toBe('PRIVATE-COMMUNITY');
    });

    it('still gets 404 for a disabled community', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${disabledCommunityId}`,
        headers: { cookie: privateViewerCookie },
      });

      expect(response.statusCode).toBe(404);
    });

    it('finds their own private community in the v1 list and its total', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/communities',
        headers: { cookie: privateViewerCookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().meta.total).toBe(2);
      const names = response
        .json()
        .data.map((community: { name: string }) => community.name);
      expect(names).toContain('OPEN-COMMUNITY');
      expect(names).toContain('PRIVATE-COMMUNITY');
      expect(names).not.toContain('DISABLED-COMMUNITY');
    });

    it('finds their own private community in the public list and its total', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/communities',
        headers: { cookie: privateViewerCookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().meta.total).toBe(2);
      const names = response
        .json()
        .data.map((community: { name: string }) => community.name);
      expect(names).toContain('PRIVATE-COMMUNITY');
      expect(names).not.toContain('DISABLED-COMMUNITY');
    });
  });

  describe('super_admin on public/v1 community routes', () => {
    it('sees what anonymous sees by id (no same-community widening)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/communities/${privateCommunityId}`,
        headers: { cookie: superAdminCookie },
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('PRIVATE-COMMUNITY');
    });

    it('sees what anonymous sees in the v1 list', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/communities',
        headers: { cookie: superAdminCookie },
      });

      expect(response.statusCode).toBe(200);
      expectOnlyPublicCommunity(response.json());
      expect(response.body).not.toContain('PRIVATE-COMMUNITY');
      expect(response.body).not.toContain('DISABLED-COMMUNITY');
    });
  });
});
