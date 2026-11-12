import { sql } from 'drizzle-orm';
import { TestDatabaseManager } from '../../tests/helpers/database.js';
import { createTestApp } from '../../tests/helpers/api-client.js';
import {
  storiesSqlite,
  usersSqlite,
  speakersSqlite,
} from '../../src/db/schema/index.js';
import { hash } from 'argon2';
import { createJourneys, type PersonaFixture } from './personas/index.js';
import type { Endpoint, Handler } from './runner.js';

export async function createFixture({ baseUrl }: { baseUrl?: string } = {}) {
  if (baseUrl)
    throw new Error('SQLite fixture supports isolated in-process runs only');
  const manager = new TestDatabaseManager();
  const db = await manager.setup();
  try {
    const fixtures = await manager.seedTestData();
    const password = 'QaFixturePassword123!';
    const passwordHash = await hash(password, {
      memoryCost: 8192,
      timeCost: 1,
      parallelism: 1,
    });
    const credentials = {} as PersonaFixture['credentials'];
    let creatorId = 0;
    const userIds: Record<string, number> = {};
    for (const role of [
      'viewer',
      'member',
      'editor',
      'admin',
      'super_admin',
    ] as const) {
      const email = `qa-${role}@example.test`;
      const communityId =
        role === 'super_admin'
          ? fixtures.systemCommunity.id
          : fixtures.communities[0].id;
      const [user] = await db
        .insert(usersSqlite)
        .values({
          email,
          passwordHash,
          firstName: 'QA',
          lastName: role,
          role: sql`${role}`,
          communityId,
          isActive: true,
        })
        .returning();
      userIds[role] = user.id;
      if (role === 'admin') creatorId = user.id;
      credentials[role] = {
        email,
        password,
        ...(communityId === null ? {} : { communityId }),
      };
    }
    const [foreignStory, restrictedStory] = await db
      .insert(storiesSqlite)
      .values([
        {
          title: 'Foreign QA story',
          slug: 'qa-foreign',
          communityId: fixtures.communities[1].id,
          createdBy: creatorId,
        },
        {
          title: 'Held QA story',
          slug: 'qa-held',
          communityId: fixtures.communities[0].id,
          createdBy: creatorId,
          isRestricted: true,
        },
      ])
      .returning();
    const [unevidencedStory] = await db
      .insert(storiesSqlite)
      .values({
        title: 'Unevidenced QA story',
        slug: 'qa-unknown',
        communityId: fixtures.communities[0].id,
        createdBy: creatorId,
        privacyLevel: 'unknown',
      })
      .returning();
    const [publicStory] = await db
      .insert(storiesSqlite)
      .values({
        title: 'Public QA story',
        slug: 'qa-public',
        communityId: fixtures.communities[0].id,
        createdBy: creatorId,
      })
      .returning();
    const [speaker] = await db
      .insert(speakersSqlite)
      .values({
        name: 'QA dashboard speaker seed',
        communityId: fixtures.communities[0].id,
      })
      .returning();
    const editable = await db
      .insert(storiesSqlite)
      .values(
        ['editor', 'admin'].map((role) => ({
          title: `QA ${role} editable`,
          slug: `qa-${role}-editable`,
          communityId: fixtures.communities[0].id,
          createdBy: userIds[role],
        }))
      )
      .returning();
    const routes: Endpoint[] = [];
    let expireSession: (() => Promise<void>) | undefined;
    const app = await createTestApp(
      db,
      (route) => {
        for (const method of Array.isArray(route.method)
          ? route.method
          : [route.method]) {
          if (
            !routes.some(
              (item) => item.method === method && item.path === route.url
            )
          )
            routes.push({ method, path: route.url });
        }
      },
      (app) => {
        app.addHook('onResponse', async (request) => {
          if (
            request.url === '/api/v1/auth/login' &&
            request.session &&
            'user' in request.session &&
            request.session.user
          ) {
            const session = request.session;
            expireSession = async () => {
              session.cookie.expires = new Date(0);
              await new Promise<void>((resolve, reject) =>
                session.save((error) => (error ? reject(error) : resolve()))
              );
            };
          }
        });
      }
    );
    await app.ready();
    const handler: Handler = async (request) => {
      const response = await app.inject({
        method: request.method as 'GET',
        url: new URL(request.url).pathname + new URL(request.url).search,
        headers: Object.fromEntries(request.headers),
        payload: ['GET', 'HEAD'].includes(request.method)
          ? undefined
          : Buffer.from(await request.arrayBuffer()),
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value))
          for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, String(value));
      }
      return new Response(
        request.method === 'HEAD' || response.statusCode === 204
          ? null
          : Uint8Array.from(response.rawPayload).buffer,
        { status: response.statusCode, headers }
      );
    };
    const journeys = createJourneys({
      communityId: fixtures.communities[0].id,
      publicStoryId: publicStory.id,
      placeId: fixtures.places[0].id,
      systemUserId: userIds.super_admin,
      speakerId: speaker.id,
      editableStoryIds: { editor: editable[0].id, admin: editable[1].id },
      foreignStoryId: foreignStory.id,
      restrictedStoryId: restrictedStory.id,
      unevidencedStoryId: unevidencedStory.id,
      credentials,
    });
    journeys.push({
      persona: 'expired-session',
      steps: [
        {
          name: 'login before expiry',
          method: 'POST',
          path: '/api/v1/auth/login',
          body: credentials.viewer,
          expected: 200,
        },
        {
          name: 'reject expired server session',
          method: 'GET',
          path: '/api/v1/auth/me',
          expected: 401,
          prepare: async () => {
            if (!expireSession) throw new Error('No session to expire');
            await expireSession();
          },
        },
      ],
    });
    return {
      handler,
      routes,
      journeys,
      exclusions: routes
        .filter(
          (route) =>
            route.method === 'HEAD' ||
            route.method === 'OPTIONS' ||
            route.path.startsWith('/dev/') ||
            route.path === '/api/v1/files/uploads/*'
        )
        .map((route) => ({
          ...route,
          reason:
            route.method === 'HEAD'
              ? 'Framework-generated HEAD alias; frontend journeys use GET.'
              : route.method === 'OPTIONS'
                ? 'CORS preflight is browser transport infrastructure, not a frontend business call.'
                : route.path === '/api/v1/files/uploads/*'
                  ? 'Field-kit path-based media read is explicitly deferred with disconnected operator journey to #147; hosted journeys use file identity reads.'
                  : 'Development-only seed endpoint is not exposed to production frontend personas.',
        })),
      close: async () => {
        await app.close();
        await manager.teardown();
      },
    };
  } catch (error) {
    await manager.teardown();
    throw error;
  }
}
