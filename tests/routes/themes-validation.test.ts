import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { ThemesRepository } from '../../src/repositories/themes.repository.js';
import { themesSqlite } from '../../src/db/schema/themes.js';
import { ApiTestClient } from '../helpers/api-client.js';
import { buildApp } from '../../src/app.js';
import { createTestData, testDb } from '../helpers/database.js';

/**
 * Regression coverage for theme geographic-bound validation through the real
 * POST /api/v1/themes and PUT /api/v1/themes/:id route handlers.
 *
 * Error-body assertions intentionally inspect the raw response string: the
 * contract under test is that clients receive a meaningful, serialized
 * message (never a degenerate "[object Object]" blob), regardless of the
 * exact JSON error envelope.
 */
describe('theme boundary validation through real route handlers', () => {
  let app: FastifyInstance;
  let cookie: string;
  let communityId: number;

  beforeEach(async () => {
    const db = await testDb.setup();
    const fixtures = await createTestData();
    communityId = fixtures.community.id;
    app = await buildApp({ database: db });
    cookie = await new ApiTestClient(app).getTestSessionId(
      1,
      communityId,
      'admin'
    );
  });

  afterEach(async () => {
    await app?.close();
    await testDb.teardown();
  });

  async function createTheme(
    bounds: Record<string, number> = {}
  ): Promise<{ id: number }> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/themes',
      headers: { cookie },
      payload: { name: 'Bounds theme', communityId, ...bounds },
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().data;
  }

  async function savedTheme(id: number, validate = true) {
    const [saved] = await testDb.db
      .select()
      .from(themesSqlite)
      .where(eq(themesSqlite.id, id));
    if (validate) {
      expect(
        await new ThemesRepository(testDb.db).validateGeographicBounds(id)
      ).toEqual({ isValid: true, errors: [] });
    }
    return saved;
  }

  it('rejects a latitude-only PUT that contradicts the stored northeast latitude and leaves the row unchanged', async () => {
    const theme = await createTheme({
      swBoundaryLat: 0,
      swBoundaryLong: 0,
      neBoundaryLat: 10,
      neBoundaryLong: 10,
    });

    const before = await savedTheme(theme.id, false);
    const rejected = await app.inject({
      method: 'PUT',
      url: `/api/v1/themes/${theme.id}`,
      headers: { cookie },
      payload: { swBoundaryLat: 50 },
    });
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(rejected.body).not.toContain('[object Object]');
    expect(rejected.body.toLowerCase()).toContain('latitude');

    const saved = await savedTheme(theme.id);
    expect(saved).toEqual(before);
  });

  it.each([0, 5])(
    'accepts equal boundary latitudes %s on POST and full-bounds PUT',
    async (latitude) => {
      const theme = await createTheme({
        swBoundaryLat: latitude,
        swBoundaryLong: 10,
        neBoundaryLat: latitude,
        neBoundaryLong: 20,
      });

      expect(await savedTheme(theme.id)).toMatchObject({
        swBoundaryLat: latitude,
        neBoundaryLat: latitude,
      });
      const updated = await app.inject({
        method: 'PUT',
        url: `/api/v1/themes/${theme.id}`,
        headers: { cookie },
        payload: {
          swBoundaryLat: latitude,
          swBoundaryLong: 10,
          neBoundaryLat: latitude,
          neBoundaryLong: 20,
        },
      });
      expect(updated.statusCode, updated.body).toBe(200);

      const saved = await savedTheme(theme.id);
      expect(saved).toMatchObject({
        swBoundaryLat: latitude,
        neBoundaryLat: latitude,
      });
    }
  );

  it('accepts a latitude-only PUT on a theme without stored bounds and leaves longitudes null', async () => {
    const theme = await createTheme();

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/themes/${theme.id}`,
      headers: { cookie },
      payload: { swBoundaryLat: 1, neBoundaryLat: 2 },
    });
    expect(updated.statusCode, updated.body).toBe(200);

    const saved = await savedTheme(theme.id);
    expect(saved).toMatchObject({
      swBoundaryLat: 1,
      neBoundaryLat: 2,
      swBoundaryLong: null,
      neBoundaryLong: null,
    });
  });

  it('accepts antimeridian-wrapping longitudes on POST and PUT', async () => {
    const theme = await createTheme({
      swBoundaryLat: -10,
      swBoundaryLong: 170,
      neBoundaryLat: 10,
      neBoundaryLong: -170,
    });

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/themes/${theme.id}`,
      headers: { cookie },
      payload: { swBoundaryLong: 170, neBoundaryLong: -170 },
    });
    expect(updated.statusCode, updated.body).toBe(200);

    const saved = await savedTheme(theme.id);
    expect(saved).toMatchObject({
      swBoundaryLong: 170,
      neBoundaryLong: -170,
    });
  });

  it('rejects reversed latitudes with a serialized, meaningful message on POST and PUT', async () => {
    const rejectedPost = await app.inject({
      method: 'POST',
      url: '/api/v1/themes',
      headers: { cookie },
      payload: {
        name: 'Reversed latitude theme',
        communityId,
        swBoundaryLat: 10,
        neBoundaryLat: 0,
      },
    });
    expect(rejectedPost.statusCode, rejectedPost.body).toBe(400);
    expect(rejectedPost.body).not.toContain('[object Object]');
    expect(rejectedPost.body.toLowerCase()).toContain('latitude');

    const theme = await createTheme();
    const rejectedPut = await app.inject({
      method: 'PUT',
      url: `/api/v1/themes/${theme.id}`,
      headers: { cookie },
      payload: { swBoundaryLat: 10, neBoundaryLat: 0 },
    });
    expect(rejectedPut.statusCode, rejectedPut.body).toBe(400);
    expect(rejectedPut.body).not.toContain('[object Object]');
    expect(rejectedPut.body.toLowerCase()).toContain('latitude');
  });
  it.each([
    { label: 'POST missing name', method: 'POST' as const, payload: {} },
    {
      label: 'POST invalid name type',
      method: 'POST' as const,
      payload: { name: {} },
    },
    {
      label: 'PUT invalid latitude type',
      method: 'PUT' as const,
      payload: { swBoundaryLat: 'bad' },
    },
  ])(
    'returns 400 through the global handler for $label',
    async ({ method, payload }) => {
      const url =
        method === 'POST'
          ? '/api/v1/themes'
          : `/api/v1/themes/${(await createTheme()).id}`;
      const response = await app.inject({
        method,
        url,
        headers: { cookie },
        payload: method === 'POST' ? { communityId, ...payload } : payload,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error).toBe('Request validation failed');
      expect(response.body).not.toContain('[object Object]');
    }
  );
});
