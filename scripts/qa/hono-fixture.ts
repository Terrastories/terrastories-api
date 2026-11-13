/**
 * In-process Hono V2 persona fixture (#199 phase 2).
 *
 * Drives the Hono app (foundation routes plus the #198 Explore read adapter)
 * through `app.fetch` so every registered Hono endpoint is exercised by
 * persona journeys on SQLite. The route table is derived from `app.routes`,
 * so a newly registered route fails coverage until a journey reaches it.
 * Mirrors sqlite-fixture.ts: refuses HTTP mode because its isolated database
 * cannot seed a deployed server.
 */
import { sql } from 'drizzle-orm';
import { hash } from 'bcrypt';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { nodePasswordVerifier } from '../../src/node-password.js';
import { communityMediaSqlite } from '../../src/db/schema/sessions.js';
import {
  filesSqlite,
  placesSqlite,
  speakersSqlite,
  storiesSqlite,
  storyPlacesSqlite,
  storySpeakersSqlite,
  usersSqlite,
} from '../../src/db/schema/index.js';
import { TestDatabaseManager } from '../../tests/helpers/database.js';
import type { Endpoint, Handler, Journey, Step } from './runner.js';

type Role = 'viewer' | 'member' | 'editor' | 'admin' | 'super_admin';

/** The public projection /v2/auth/me and login may ever return. */
const publicUserKeys = 'communityId,email,id,role';

/** Wrong password and unknown user must answer the same body. */
const invalidCredentials = (body: unknown): boolean =>
  (body as { error?: string }).error === 'Invalid credentials' &&
  Object.keys(body as object).length === 1;

const ownUser =
  (email: string, role: Role) =>
  (body: unknown): boolean => {
    const user = (body as { user?: Record<string, unknown> }).user;
    return (
      !!user &&
      Object.keys(user).sort().join(',') === publicUserKeys &&
      user.email === email &&
      user.role === role &&
      typeof user.id === 'number' &&
      !JSON.stringify(body).includes('passwordHash') &&
      !JSON.stringify(body).includes('ts_session')
    );
  };

export async function createFixture({ baseUrl }: { baseUrl?: string } = {}) {
  if (baseUrl)
    throw new Error('SQLite fixture supports isolated in-process runs only');
  const manager = new TestDatabaseManager();
  const db = await manager.setup();
  try {
    const fixtures = await manager.seedTestData();
    // Public active community for Explore; Demo community stays private.
    const communityId = fixtures.communities[0].id;
    const communitySlug = fixtures.communities[0].slug;
    const privateCommunityId = fixtures.communities[1].id;
    const privateCommunitySlug = fixtures.communities[1].slug;
    const password = 'QaHonoPassword123!';
    // bcrypt emits $2b$; the verifier accepts the Rails/Devise $2a$ encoding.
    const passwordHash = (await hash(password, 4)).replace('$2b$', '$2a$');
    const credentials: Record<Role, { email: string; password: string }> = {
      viewer: { email: 'qa-hono-viewer@example.test', password },
      member: { email: 'qa-hono-member@example.test', password },
      editor: { email: 'qa-hono-editor@example.test', password },
      admin: { email: 'qa-hono-admin@example.test', password },
      super_admin: { email: 'qa-hono-super@example.test', password },
    };
    // The schema enum predates the V2 member role; the raw binding stores it.
    let creatorId = 0;
    for (const role of Object.keys(credentials) as Role[]) {
      const [user] = await db
        .insert(usersSqlite)
        .values({
          email: credentials[role].email,
          passwordHash,
          firstName: 'QA',
          lastName: 'Hono',
          role: sql`${role}`,
          communityId:
            role === 'super_admin' ? fixtures.systemCommunity.id : communityId,
          isActive: true,
        })
        .returning();
      if (role === 'admin') creatorId = user.id;
    }
    // Branding media through the injected storage adapter: readable for the
    // public community, withheld by cultural restrictions, foreign+restricted.
    const storage = new Map<string, Uint8Array>();
    const mediaBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const brandingFile = async (
      ownerCommunityId: number,
      culturalRestrictions: string | null
    ) => {
      const id = crypto.randomUUID();
      const path = `communities/${ownerCommunityId}/${id}.png`;
      await db.insert(filesSqlite).values({
        id,
        filename: `${id}.png`,
        originalName: 'qa-branding.png',
        path,
        url: `/v2/media/${id}`,
        mimeType: 'image/png',
        size: mediaBytes.length,
        uploadedBy: creatorId,
        communityId: ownerCommunityId,
        culturalRestrictions,
      });
      await db.insert(communityMediaSqlite).values({
        fileId: id,
        communityId: ownerCommunityId,
        kind: 'branding',
      });
      storage.set(path, mediaBytes);
      return id;
    };
    const readableFileId = await brandingFile(communityId, null);
    const restrictedFileId = await brandingFile(communityId, '{}');
    const foreignRestrictedFileId = await brandingFile(
      privateCommunityId,
      '{}'
    );
    // Explore story gate (#162 option A): restricted and unevidenced stories
    // stay hidden from every role, and foreign ids answer the same 404.
    const [publicPlace, restrictedPlace] = await db
      .insert(placesSqlite)
      .values([
        {
          name: 'QA public place',
          communityId,
          latitude: -3,
          longitude: -60,
        },
        {
          name: 'QA restricted place',
          communityId,
          latitude: -3,
          longitude: -60,
          isRestricted: true,
        },
      ])
      .returning();
    const [foreignPlace] = await db
      .insert(placesSqlite)
      .values({
        name: 'QA foreign place',
        communityId: privateCommunityId,
        latitude: -3,
        longitude: -60,
      })
      .returning();
    const [speaker] = await db
      .insert(speakersSqlite)
      .values({ name: 'QA hono speaker', communityId, isActive: true })
      .returning();
    const [publicStory, restrictedStory, unevidencedStory, foreignStory] =
      await db
        .insert(storiesSqlite)
        .values([
          {
            title: 'QA public story',
            slug: 'qa-hono-public',
            communityId,
            createdBy: creatorId,
            privacyLevel: 'public',
          },
          {
            title: 'QA restricted story',
            slug: 'qa-hono-restricted',
            communityId,
            createdBy: creatorId,
            privacyLevel: 'public',
            isRestricted: true,
          },
          {
            title: 'QA unevidenced story',
            slug: 'qa-hono-unevidenced',
            communityId,
            createdBy: creatorId,
            privacyLevel: 'unknown',
          },
          {
            title: 'QA foreign story',
            slug: 'qa-hono-foreign',
            communityId: privateCommunityId,
            createdBy: creatorId,
            privacyLevel: 'public',
          },
        ])
        .returning();
    // Rails-shaped lists join places and speakers; the public story carries
    // one edge of each so it stays visible while the withheld rows do not.
    await db
      .insert(storyPlacesSqlite)
      .values({ storyId: publicStory.id, placeId: publicPlace.id });
    await db
      .insert(storySpeakersSqlite)
      .values({ storyId: publicStory.id, speakerId: speaker.id });
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      verifier: nodePasswordVerifier,
      secureCookies: false,
      storage: { read: async (key) => storage.get(key) ?? null },
    });
    // Derive the endpoint table from the app itself: middleware registrations
    // (method ALL, wildcard paths) are not callable endpoints, and bodyLimit
    // re-registers the login route, so keep the first concrete entry.
    const routes: Endpoint[] = [];
    const registered = new Set<string>();
    for (const route of app.routes) {
      if (route.method === 'ALL' || route.path.includes('*')) continue;
      const key = `${route.method} ${route.path}`;
      if (registered.has(key)) continue;
      registered.add(key);
      routes.push({ method: route.method, path: route.path });
    }
    if (routes.length === 0)
      throw new Error('Hono app registered no persona endpoints');
    const handler: Handler = (request) => app.fetch(request);
    const storyIds = (body: unknown): number[] =>
      (body as { data?: { stories?: { id?: number }[] } }).data?.stories?.map(
        (story) => story.id
      ) ?? [];
    const explore: Step[] = [
      {
        name: 'explore communities list',
        method: 'GET',
        path: '/explore/communities',
        expected: 200,
        check: (body) => {
          const slugs =
            (body as { data?: { slug?: string }[] }).data?.map(
              (community) => community.slug
            ) ?? [];
          return (
            slugs.includes(communitySlug) &&
            !slugs.includes(privateCommunitySlug)
          );
        },
      },
      {
        name: 'explore community detail',
        method: 'GET',
        path: `/explore/communities/${communitySlug}`,
        expected: 200,
        check: (body) =>
          (body as { data?: { slug?: string } }).data?.slug === communitySlug,
      },
      {
        name: 'hide private community',
        method: 'GET',
        path: `/explore/communities/${privateCommunitySlug}`,
        expected: 404,
      },
      {
        name: 'hide unknown community',
        method: 'GET',
        path: '/explore/communities/no-such-community',
        expected: 404,
      },
      {
        name: 'explore stories list',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories`,
        expected: 200,
        check: (body) => {
          const ids = storyIds(body);
          return (
            ids.includes(publicStory.id) &&
            !ids.includes(restrictedStory.id) &&
            !ids.includes(unevidencedStory.id) &&
            !ids.includes(foreignStory.id)
          );
        },
      },
      {
        name: 'explore story detail',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${publicStory.id}`,
        expected: 200,
        check: (body) =>
          (body as { data?: { id?: number } }).data?.id === publicStory.id,
      },
      {
        name: 'hide restricted story',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${restrictedStory.id}`,
        expected: 404,
      },
      {
        name: 'hide unevidenced story',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${unevidencedStory.id}`,
        expected: 404,
      },
      {
        name: 'reject malformed story id',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/not-an-id`,
        expected: 404,
      },
      {
        name: 'reject cross-community story id',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${foreignStory.id}`,
        expected: 404,
      },
      {
        name: 'explore place detail',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${publicPlace.id}`,
        expected: 200,
        check: (body) =>
          (body as { data?: { id?: number } }).data?.id === publicPlace.id,
      },
      {
        name: 'hide restricted place',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${restrictedPlace.id}`,
        expected: 404,
      },
      {
        name: 'reject cross-community place id',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${foreignPlace.id}`,
        expected: 404,
      },
      {
        name: 'reject malformed place id',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/not-a-place`,
        expected: 404,
      },
      {
        name: 'explore branding media',
        method: 'GET',
        path: `/explore/media/${readableFileId}`,
        expected: 200,
      },
      {
        name: 'hide restricted branding media',
        method: 'GET',
        path: `/explore/media/${restrictedFileId}`,
        expected: 404,
      },
      {
        name: 'hide foreign branding media',
        method: 'GET',
        path: `/explore/media/${foreignRestrictedFileId}`,
        expected: 404,
      },
      {
        name: 'reject malformed media id',
        method: 'GET',
        path: '/explore/media/not-a-uuid',
        expected: 404,
      },
    ];
    const journeys: Journey[] = [
      {
        persona: 'anonymous',
        steps: [
          {
            name: 'health',
            method: 'GET',
            path: '/health',
            expected: 200,
            check: (body) => (body as { status?: string }).status === 'ok',
          },
          {
            name: 'ready',
            method: 'GET',
            path: '/ready',
            expected: 200,
            check: (body) => (body as { status?: string }).status === 'ready',
          },
          ...explore,
          {
            name: 'require authentication',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 401,
          },
          {
            name: 'reject wrong password',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            body: {
              email: credentials.admin.email,
              password: 'QaWrongPassword123!',
            },
            check: invalidCredentials,
          },
          {
            name: 'reject unknown user identically',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            body: {
              email: 'qa-hono-nobody@example.test',
              password: 'QaWrongPassword123!',
            },
            check: invalidCredentials,
          },
        ],
      },
      ...(['viewer', 'member', 'editor', 'admin'] as const).map((role) => ({
        persona: role,
        steps: [
          {
            name: 'login',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: credentials[role],
            check: ownUser(credentials[role].email, role),
          },
          {
            name: 'read own profile without secrets',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: ownUser(credentials[role].email, role),
          },
          {
            name: 'read own community media',
            method: 'GET',
            path: `/v2/media/${readableFileId}`,
            expected: 200,
          },
          {
            name: 'reject other community media',
            method: 'GET',
            path: `/v2/media/${foreignRestrictedFileId}`,
            expected: 404,
          },
          {
            name: 'reject restricted media',
            method: 'GET',
            path: `/v2/media/${restrictedFileId}`,
            expected: 404,
          },
          {
            name: 'reject malformed media id',
            method: 'GET',
            path: '/v2/media/not-a-uuid',
            expected: 404,
          },
          {
            name: 'logout',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
            saveCookieAs: 'pre-logout',
          },
          {
            name: 'reject replayed cookie after logout',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 401,
            useSavedCookie: 'pre-logout',
          },
          {
            name: 'login again',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: credentials[role],
          },
          {
            name: 'revoke every session',
            method: 'POST',
            path: '/v2/auth/revoke',
            expected: 204,
            saveCookieAs: 'pre-revoke',
          },
          {
            name: 'reject revoked session',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 401,
            useSavedCookie: 'pre-revoke',
          },
        ],
      })),
      {
        persona: 'super_admin',
        steps: [
          {
            name: 'login',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: credentials.super_admin,
            check: ownUser(credentials.super_admin.email, 'super_admin'),
          },
          {
            name: 'read own profile without secrets',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: ownUser(credentials.super_admin.email, 'super_admin'),
          },
          {
            name: 'deny restricted media of another community',
            method: 'GET',
            path: `/v2/media/${foreignRestrictedFileId}`,
            expected: 404,
          },
          {
            name: 'logout',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
          },
        ],
      },
      {
        persona: 'field-kit',
        steps: [],
        skipped:
          'Phase 2: disconnected browser and recovery-code proof belongs to #147.',
      },
    ];
    return {
      handler,
      routes,
      journeys,
      exclusions: [],
      sessionCookieName: 'ts_session',
      close: async () => {
        await manager.teardown();
      },
    };
  } catch (error) {
    await manager.teardown();
    throw error;
  }
}
