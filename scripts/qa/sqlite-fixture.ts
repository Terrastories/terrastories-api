import { mkdir, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getConfig } from '../../src/shared/config/index.js';
import { sql } from 'drizzle-orm';
import { TestDatabaseManager } from '../../tests/helpers/database.js';
import { createTestApp } from '../../tests/helpers/api-client.js';
import {
  storiesSqlite,
  usersSqlite,
  speakersSqlite,
  placesSqlite,
  themesSqlite,
  filesSqlite,
} from '../../src/db/schema/index.js';
import { hash } from 'argon2';
import { createJourneys, type PersonaFixture } from './personas/index.js';
import type { Endpoint, Handler } from './runner.js';

export async function createFixture({ baseUrl }: { baseUrl?: string } = {}) {
  if (baseUrl)
    throw new Error('SQLite fixture supports isolated in-process runs only');
  const manager = new TestDatabaseManager();
  const db = await manager.setup();
  let app: FastifyInstance | undefined;
  let mediaDirectory: string | undefined;
  const mediaPaths: string[] = [];
  const removeOwnedMedia = async () => {
    for (const path of mediaPaths) {
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (mediaDirectory) {
      try {
        await rmdir(mediaDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  };
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
    const [holder] = await db
      .insert(usersSqlite)
      .values({
        email: 'qa-holder@example.test',
        passwordHash,
        firstName: 'QA',
        lastName: 'Holder',
        role: 'admin',
        communityId: fixtures.communities[0].id,
        isActive: true,
      })
      .returning();
    credentials.holder = {
      email: holder.email,
      password,
      communityId: holder.communityId,
    };
    const foreignCommunityId = fixtures.communities[1].id;
    const [foreignUser] = await db
      .insert(usersSqlite)
      .values({
        email: 'qa-foreign@example.test',
        passwordHash,
        firstName: 'Foreign',
        lastName: 'User',
        role: 'viewer',
        communityId: foreignCommunityId,
        isActive: true,
      })
      .returning();
    const [foreignPlace, heldPlace] = await db
      .insert(placesSqlite)
      .values([
        {
          name: 'QA foreign place',
          communityId: foreignCommunityId,
          latitude: -3,
          longitude: -60,
        },
        {
          name: 'QA held place',
          communityId: fixtures.communities[0].id,
          latitude: -3,
          longitude: -60,
          isRestricted: true,
        },
      ])
      .returning();
    const [foreignSpeaker] = await db
      .insert(speakersSqlite)
      .values({ name: 'QA foreign speaker', communityId: foreignCommunityId })
      .returning();
    const [foreignTheme] = await db
      .insert(themesSqlite)
      .values({ name: 'QA foreign theme', communityId: foreignCommunityId })
      .returning();
    // Use the route's configured root and relative paths exactly as real media.
    // Each fixture owns only this unique directory and its four byte payloads.
    const uploadRoot = resolve(getConfig().fileUpload.uploadDir);
    await mkdir(uploadRoot, { recursive: true });
    mediaDirectory = await mkdtemp(join(uploadRoot, 'persona-fixture-'));
    const mediaBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64'
    );
    const mediaRows = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        communityId: foreignCommunityId,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        communityId: fixtures.communities[0].id,
        culturalRestrictions: JSON.stringify({ elderOnly: true }),
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        communityId: fixtures.communities[0].id,
        culturalRestrictions: JSON.stringify({ unknown: true }),
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        communityId: fixtures.communities[0].id,
      },
    ];
    for (const row of mediaRows) {
      const diskPath = join(mediaDirectory, `${row.id}.png`);
      // Register before writing so error cleanup also handles partial writes.
      mediaPaths.push(diskPath);
      await writeFile(diskPath, mediaBytes);
    }
    const [foreignFile, heldFile, unknownFile, readableFile] = await db
      .insert(filesSqlite)
      .values(
        mediaRows.map((row) => ({
          ...row,
          filename: `${row.id}.png`,
          originalName: 'qa.png',
          path: relative(uploadRoot, join(mediaDirectory!, `${row.id}.png`)),
          url: `/api/v1/files/${row.id}`,
          mimeType: 'image/png',
          size: mediaBytes.length,
          uploadedBy: creatorId,
        }))
      )
      .returning();
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
    app = await createTestApp(
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
    const readyApp = app;
    const handler: Handler = async (request) => {
      const response = await readyApp.inject({
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
      foreignCommunityId,
      foreignIds: {
        places: foreignPlace.id,
        speakers: foreignSpeaker.id,
        themes: foreignTheme.id,
        users: foreignUser.id,
        files: foreignFile.id,
      },
      heldPlaceId: heldPlace.id,
      heldFileId: heldFile.id,
      unknownFileId: unknownFile.id,
    });
    const viewerJourney = journeys.find(
      (journey) => journey.persona === 'viewer'
    );
    if (!viewerJourney)
      throw new Error('Viewer journey is required for media proof');
    viewerJourney.steps.splice(1, 0, {
      name: 'read seeded media bytes',
      method: 'GET',
      path: `/api/v1/files/${readableFile.id}`,
      expected: 200,
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
      mediaEvidence: {
        directory: mediaDirectory,
        bytes: mediaBytes,
        readable: { id: readableFile.id, path: mediaPaths[3] },
        unavailable: [foreignFile, heldFile, unknownFile].map(
          (file, index) => ({ id: file.id, path: mediaPaths[index] })
        ),
      },
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
        try {
          await readyApp.close();
        } finally {
          try {
            await manager.teardown();
          } finally {
            await removeOwnedMedia();
          }
        }
      },
    };
  } catch (error) {
    try {
      await app?.close();
    } finally {
      try {
        await manager.teardown();
      } finally {
        await removeOwnedMedia();
      }
    }
    throw error;
  }
}
