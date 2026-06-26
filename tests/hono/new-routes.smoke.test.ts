/**
 * Smoke test for the new Hono places/speakers/public-api route factories.
 *
 * These route files are NOT yet mounted in src/routes/hono/index.ts, so this
 * test mounts them directly on a Hono app against the in-memory test DB to
 * prove they (a) instantiate, (b) wire up auth middleware, (c) call the
 * underlying services, and (d) return the expected response shapes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import {
  createHonoTestApp,
  honoRequest,
  honoLogin,
} from '../helpers/hono-client';
import { testDb, createTestData } from '../helpers/database';
import {
  setSessionStore,
  MemorySessionStore,
} from '../../src/shared/session/session-store';
import { createPlacesRoutes } from '../../src/routes/hono/places.js';
import { createSpeakersRoutes } from '../../src/routes/hono/speakers.js';
import { createPublicApiRoutes } from '../../src/routes/hono/public-api.js';
import type { HonoTestApp } from '../helpers/hono-client';
import type { TestDatabase } from '../helpers/database';

/**
 * Build a Hono app that has the V2 auth routes (for login) PLUS the three new
 * route sets mounted at /v2/places, /v2/speakers, /v2/public.
 *
 * NOTE: public-api routes are mounted under /v2/public/* rather than /v2/*
 * because the codebase already has an authenticated /v2/communities route
 * (src/routes/hono/communities.ts) that would shadow the public-api's bare
 * GET /communities list endpoint. The public-api route factory itself defines
 * routes relative to /communities/* — only the mount prefix differs here.
 */
async function buildAppWithNewRoutes(
  db: TestDatabase
): Promise<HonoTestApp> {
  const base = await createHonoTestApp(db);
  const app = new Hono();
  // Mount the full built app (which has /v2/auth, /v2/themes, /v2/health) ...
  app.route('/', base);
  // ... then mount the new route sets. places & speakers mount cleanly at
  // /v2/places and /v2/speakers (no existing route there).
  app.route('/v2/places', createPlacesRoutes(db));
  app.route('/v2/speakers', createSpeakersRoutes(db));
  // public-api is isolated under /v2/public to avoid the pre-existing
  // authenticated /v2/communities route in index.ts.
  app.route('/v2/public', createPublicApiRoutes(db));
  return app;
}

describe('Hono V2: Places endpoints (new route factory)', () => {
  let app: HonoTestApp;
  let communityId: number;
  let adminCookie: string;
  let viewerCookie: string;
  let createdPlaceId: number;

  beforeAll(async () => {
    await testDb.setup();
    await testDb.clearData();
    setSessionStore(new MemorySessionStore());
    app = await buildAppWithNewRoutes(await testDb.getDb());

    const seed = await createTestData();
    communityId = seed.community.id;

    // Register + login admin
    await honoRequest(app, 'POST', '/v2/auth/register', {
      body: {
        email: 'places-admin@test.com',
        password: 'TestPass123!',
        firstName: 'P',
        lastName: 'Admin',
        role: 'admin',
        communityId,
      },
    });
    adminCookie = await honoLogin(
      app,
      'places-admin@test.com',
      'TestPass123!',
      communityId
    );

    // Register + login viewer
    await honoRequest(app, 'POST', '/v2/auth/register', {
      body: {
        email: 'places-viewer@test.com',
        password: 'TestPass123!',
        firstName: 'P',
        lastName: 'Viewer',
        role: 'viewer',
        communityId,
      },
    });
    viewerCookie = await honoLogin(
      app,
      'places-viewer@test.com',
      'TestPass123!',
      communityId
    );
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  it('should reject POST without auth (401)', async () => {
    const res = await honoRequest(app, 'POST', '/v2/places', {
      body: { name: 'X', latitude: 1, longitude: 2 },
    });
    expect(res.status).toBe(401);
  });

  it('should reject POST as viewer (403)', async () => {
    const res = await honoRequest(app, 'POST', '/v2/places', {
      cookie: viewerCookie,
      body: { name: 'Viewer Place', latitude: 1, longitude: 2 },
    });
    expect(res.status).toBe(403);
  });

  it('should create a place as admin (201)', async () => {
    const res = await honoRequest(app, 'POST', '/v2/places', {
      cookie: adminCookie,
      body: {
        name: 'Admin Created Place',
        description: 'Smoke test place',
        latitude: 49.28,
        longitude: -123.12,
        region: 'Vancouver',
        mediaUrls: [],
        isRestricted: false,
      },
    });
    expect(res.status).toBe(201);
    const body = res.body as { data: Record<string, unknown>; meta: Record<string, unknown> };
    expect(body.data).toHaveProperty('id');
    expect(body.data).toHaveProperty('name', 'Admin Created Place');
    expect(body.meta).toHaveProperty('message');
    createdPlaceId = body.data.id as number;
  });

  it('should list places (200) with pagination meta', async () => {
    const res = await honoRequest(app, 'GET', '/v2/places', {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; meta: Record<string, unknown> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toHaveProperty('total');
    expect(body.meta).toHaveProperty('page');
    expect(body.meta).toHaveProperty('pages');
  });

  it('should get a place by id (200)', async () => {
    const res = await honoRequest(app, 'GET', `/v2/places/${createdPlaceId}`, {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty('id', createdPlaceId);
  });

  it('should hit /stats (static route before /:id) (200)', async () => {
    const res = await honoRequest(app, 'GET', '/v2/places/stats', {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty('total');
  });

  it('should hit /near (static route before /:id) (200)', async () => {
    const res = await honoRequest(
      app,
      'GET',
      '/v2/places/near?latitude=49.28&longitude=-123.12&radius=100',
      { cookie: adminCookie }
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; meta: Record<string, unknown> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toHaveProperty('searchParams');
  });

  it('should hit /bounds (static route before /:id) (200)', async () => {
    const res = await honoRequest(
      app,
      'GET',
      '/v2/places/bounds?north=50&south=48&east=-122&west=-124',
      { cookie: adminCookie }
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; meta: Record<string, unknown> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toHaveProperty('searchParams');
  });

  it('should update a place as admin (200)', async () => {
    const res = await honoRequest(app, 'PUT', `/v2/places/${createdPlaceId}`, {
      cookie: adminCookie,
      body: { name: 'Renamed Place', description: 'updated' },
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty('name', 'Renamed Place');
  });

  it('should delete a place as admin (204)', async () => {
    const res = await honoRequest(app, 'DELETE', `/v2/places/${createdPlaceId}`, {
      cookie: adminCookie,
    });
    expect(res.status).toBe(204);
  });
});

describe('Hono V2: Speakers endpoints (new route factory)', () => {
  let app: HonoTestApp;
  let communityId: number;
  let adminCookie: string;
  let viewerCookie: string;
  let createdSpeakerId: number;

  beforeAll(async () => {
    await testDb.setup();
    await testDb.clearData();
    setSessionStore(new MemorySessionStore());
    app = await buildAppWithNewRoutes(await testDb.getDb());

    const seed = await createTestData();
    communityId = seed.community.id;

    await honoRequest(app, 'POST', '/v2/auth/register', {
      body: {
        email: 'spk-admin@test.com',
        password: 'TestPass123!',
        firstName: 'S',
        lastName: 'Admin',
        role: 'admin',
        communityId,
      },
    });
    adminCookie = await honoLogin(
      app,
      'spk-admin@test.com',
      'TestPass123!',
      communityId
    );

    await honoRequest(app, 'POST', '/v2/auth/register', {
      body: {
        email: 'spk-viewer@test.com',
        password: 'TestPass123!',
        firstName: 'S',
        lastName: 'Viewer',
        role: 'viewer',
        communityId,
      },
    });
    viewerCookie = await honoLogin(
      app,
      'spk-viewer@test.com',
      'TestPass123!',
      communityId
    );
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  it('should reject POST without auth (401)', async () => {
    const res = await honoRequest(app, 'POST', '/v2/speakers', {
      body: { name: 'X' },
    });
    expect(res.status).toBe(401);
  });

  it('should reject POST as viewer (403)', async () => {
    const res = await honoRequest(app, 'POST', '/v2/speakers', {
      cookie: viewerCookie,
      body: { name: 'Viewer Speaker' },
    });
    expect(res.status).toBe(403);
  });

  it('should create a speaker as admin (201)', async () => {
    const res = await honoRequest(app, 'POST', '/v2/speakers', {
      cookie: adminCookie,
      body: {
        name: 'Smoke Test Speaker',
        bio: 'Created by smoke test',
        photoUrl: 'https://example.com/photo.jpg',
        elderStatus: false,
        isActive: true,
      },
    });
    expect(res.status).toBe(201);
    const body = res.body as { data: Record<string, unknown>; meta: Record<string, unknown> };
    expect(body.data).toHaveProperty('id');
    expect(body.data).toHaveProperty('name', 'Smoke Test Speaker');
    createdSpeakerId = body.data.id as number;
  });

  it('should list speakers (200) with pagination meta', async () => {
    const res = await honoRequest(app, 'GET', '/v2/speakers', {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; meta: Record<string, unknown> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toHaveProperty('total');
    expect(body.meta).toHaveProperty('pages');
  });

  it('should get a speaker by id (200)', async () => {
    const res = await honoRequest(app, 'GET', `/v2/speakers/${createdSpeakerId}`, {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty('id', createdSpeakerId);
  });

  it('should hit /stats (static route before /:id) (200)', async () => {
    const res = await honoRequest(app, 'GET', '/v2/speakers/stats', {
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty('total');
  });

  it('should hit /search (static route before /:id) (200)', async () => {
    const res = await honoRequest(
      app,
      'GET',
      '/v2/speakers/search?q=Smoke',
      { cookie: adminCookie }
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; meta: Record<string, unknown> };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('should update a speaker via PATCH as admin (200)', async () => {
    const res = await honoRequest(app, 'PATCH', `/v2/speakers/${createdSpeakerId}`, {
      cookie: adminCookie,
      body: { bio: 'patched bio' },
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty('bio', 'patched bio');
  });

  it('should delete a speaker as admin (204)', async () => {
    const res = await honoRequest(app, 'DELETE', `/v2/speakers/${createdSpeakerId}`, {
      cookie: adminCookie,
    });
    expect(res.status).toBe(204);
  });
});

describe('Hono V2: Public API endpoints (no auth)', () => {
  let app: HonoTestApp;
  let communityId: number;

  beforeAll(async () => {
    await testDb.setup();
    await testDb.clearData();
    setSessionStore(new MemorySessionStore());
    app = await buildAppWithNewRoutes(await testDb.getDb());

    const seed = await createTestData();
    communityId = seed.community.id;
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  it('should list communities without auth (200)', async () => {
    const res = await honoRequest(app, 'GET', '/v2/public/communities');
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; meta: Record<string, unknown> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toHaveProperty('total');
  });

  it('should list public places for a community without auth (200)', async () => {
    const res = await honoRequest(
      app,
      'GET',
      `/v2/public/communities/${communityId}/places`
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; meta: Record<string, unknown> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toHaveProperty('pagination');
  });

  it('should return 404 for an unknown community', async () => {
    const res = await honoRequest(
      app,
      'GET',
      '/v2/public/communities/99999/places'
    );
    expect(res.status).toBe(404);
  });
});
