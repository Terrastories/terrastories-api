import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'light-my-request';
import { eq } from 'drizzle-orm';
import { themesSqlite } from '../../src/db/schema/themes.js';
import { ApiTestClient } from '../helpers/api-client.js';
import { buildApp } from '../../src/app.js';
import { createTestData, testDb } from '../helpers/database.js';

/**
 * Regression coverage for PR #177 round 2 follow-ups on the real
 * POST/PUT /api/v1/themes and GET /api/v1/themes[/active] handlers:
 *
 * - pre-handler auth failures must keep a meaningful serialized message
 *   instead of collapsing to "[object Object]";
 * - omitted geographic coordinates must serialize as null, not zero, on the
 *   POST response and on both list routes;
 * - creating a theme for a community the admin does not belong to must be a
 *   clear 403, never a 500 or a partial write.
 */
const COORDINATE_FIELDS = [
  'centerLat',
  'centerLong',
  'swBoundaryLat',
  'swBoundaryLong',
  'neBoundaryLat',
  'neBoundaryLong',
] as const;

function errorMessage(response: LightMyRequestResponse): string {
  const body = response.json();
  const message =
    typeof body.error === 'string' ? body.error : body.error?.message;

  expect(typeof message, response.body).toBe('string');
  const text = message as string;
  expect(text).not.toBe('[object Object]');
  expect(text.trim().length).toBeGreaterThan(0);
  return text;
}

function expectNullCoordinates(
  theme: Record<string, unknown> | undefined,
  source: string
): void {
  for (const field of COORDINATE_FIELDS) {
    expect(theme?.[field], `${source}: ${field}`).toBeNull();
  }
}

describe('theme errors and nullable coordinates through real route handlers', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let viewerCookie: string;
  let communityId: number;

  beforeEach(async () => {
    const db = await testDb.setup();
    const fixtures = await createTestData();
    communityId = fixtures.community.id;
    app = await buildApp({ database: db });

    const client = new ApiTestClient(app);
    adminCookie = await client.getTestSessionId(1, communityId, 'admin');
    viewerCookie = await client.getTestSessionId(1, communityId, 'viewer');
  });

  afterEach(async () => {
    await app?.close();
    await testDb.teardown();
  });

  async function createTheme(
    name = 'Auth target theme'
  ): Promise<{ id: number }> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/themes',
      headers: { cookie: adminCookie },
      payload: { name, communityId },
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().data;
  }

  it('returns a meaningful 401 for an unauthenticated POST /api/v1/themes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/themes',
      payload: { name: 'Unauthenticated theme', communityId },
    });

    expect(response.statusCode, response.body).toBe(401);
    expect(response.body).not.toContain('[object Object]');
    expect(errorMessage(response)).toMatch(/auth|session|credential/i);
  });

  it('returns a meaningful 403 for a viewer POST /api/v1/themes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/themes',
      headers: { cookie: viewerCookie },
      payload: { name: 'Viewer theme', communityId },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.body).not.toContain('[object Object]');
    expect(errorMessage(response)).toMatch(/permission|forbidden|admin/i);
  });

  it('returns a meaningful 401 for an unauthenticated PUT /api/v1/themes/:id', async () => {
    const theme = await createTheme();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/themes/${theme.id}`,
      payload: { name: 'Unauthenticated update' },
    });

    expect(response.statusCode, response.body).toBe(401);
    expect(response.body).not.toContain('[object Object]');
    expect(errorMessage(response)).toMatch(/auth|session|credential/i);
  });

  it('returns a meaningful 403 for a viewer PUT /api/v1/themes/:id', async () => {
    const theme = await createTheme();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/themes/${theme.id}`,
      headers: { cookie: viewerCookie },
      payload: { name: 'Viewer update' },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.body).not.toContain('[object Object]');
    expect(errorMessage(response)).toMatch(/permission|forbidden|admin/i);
  });

  it('returns null for all six coordinates on an unbounded POST and on both list routes', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/themes',
      headers: { cookie: adminCookie },
      payload: {
        name: 'Unbounded active theme',
        communityId,
        active: true,
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    const createdTheme = created.json().data;
    expectNullCoordinates(createdTheme, 'POST /api/v1/themes');

    const [stored] = await testDb.db
      .select()
      .from(themesSqlite)
      .where(eq(themesSqlite.id, createdTheme.id));
    expect(stored).toBeDefined();
    expectNullCoordinates(stored, 'database');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/themes',
      headers: { cookie: adminCookie },
    });
    expect(list.statusCode, list.body).toBe(200);

    const listed = list
      .json()
      .data.find((theme: { id: number }) => theme.id === createdTheme.id);
    expect(
      listed,
      'created theme missing from GET /api/v1/themes'
    ).toBeDefined();
    expectNullCoordinates(listed, 'GET /api/v1/themes');

    const active = await app.inject({
      method: 'GET',
      url: '/api/v1/themes/active',
      headers: { cookie: adminCookie },
    });
    expect(active.statusCode, active.body).toBe(200);

    const activeListed = active
      .json()
      .data.find((theme: { id: number }) => theme.id === createdTheme.id);
    expect(
      activeListed,
      'active theme missing from GET /api/v1/themes/active'
    ).toBeDefined();
    expectNullCoordinates(activeListed, 'GET /api/v1/themes/active');
  });

  it('returns a clear 403 instead of 500 when an admin posts a theme for another community', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/themes',
      headers: { cookie: adminCookie },
      payload: { name: 'Cross-community theme', communityId: 999 },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.statusCode).not.toBe(500);
    expect(response.body).not.toContain('[object Object]');

    const message = errorMessage(response);
    expect(message).toMatch(/communit|access|permission/i);
    expect(message.toLowerCase()).not.toContain('internal server error');
    expect(response.json().data).toBeUndefined();

    const rows = await testDb.db
      .select()
      .from(themesSqlite)
      .where(eq(themesSqlite.communityId, 999));
    expect(rows).toHaveLength(0);
  });
});
