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

  it('rejects explicit null boundary coordinates and never coerces stored coordinates to zero', async () => {
    const theme = await createTheme({
      swBoundaryLat: 5,
      swBoundaryLong: 10,
      neBoundaryLat: 10,
      neBoundaryLong: 20,
    });

    const boundaryFields = [
      'swBoundaryLat',
      'swBoundaryLong',
      'neBoundaryLat',
      'neBoundaryLong',
    ] as const;

    for (const field of boundaryFields) {
      const rejectedPost = await app.inject({
        method: 'POST',
        url: '/api/v1/themes',
        headers: { cookie },
        payload: {
          name: 'Null coordinate theme',
          communityId,
          [field]: null,
        },
      });
      expect(rejectedPost.statusCode, rejectedPost.body).toBe(400);
      expect(rejectedPost.body).not.toContain('[object Object]');
      expect(rejectedPost.json().error).toBeDefined();

      const rejectedPut = await app.inject({
        method: 'PUT',
        url: `/api/v1/themes/${theme.id}`,
        headers: { cookie },
        payload: { [field]: null },
      });
      expect(rejectedPut.statusCode, rejectedPut.body).toBe(400);
      expect(rejectedPut.body).not.toContain('[object Object]');
      expect(rejectedPut.json().error).toBeDefined();
    }

    const saved = await savedTheme(theme.id);
    expect(saved.swBoundaryLat).toBe(5);
    expect(saved.swBoundaryLat).not.toBe(0);
    expect(saved.neBoundaryLat).toBe(10);
    expect(saved.swBoundaryLong).toBe(10);
    expect(saved.neBoundaryLong).toBe(20);
  });

  it.each([
    { field: 'swBoundaryLat' as const, value: 5 },
    { field: 'neBoundaryLat' as const, value: -5 },
  ])(
    'keeps the other three bounds null for a single-coordinate PUT of $field',
    async ({ field, value }) => {
      const theme = await createTheme();
      const boundaryFields = [
        'swBoundaryLat',
        'swBoundaryLong',
        'neBoundaryLat',
        'neBoundaryLong',
      ] as const;
      const untouchedFields = boundaryFields.filter(
        (candidate) => candidate !== field
      );

      const updated = await app.inject({
        method: 'PUT',
        url: `/api/v1/themes/${theme.id}`,
        headers: { cookie },
        payload: { [field]: value },
      });
      expect(updated.statusCode, updated.body).toBe(200);

      const updatedData = updated.json().data;
      expect(updatedData[field]).toBe(value);
      for (const other of untouchedFields) {
        expect(updatedData[other]).toBeNull();
      }

      const saved = await savedTheme(theme.id);
      expect(saved[field]).toBe(value);
      for (const other of untouchedFields) {
        expect(saved[other]).toBeNull();
      }

      const fetched = await app.inject({
        method: 'GET',
        url: `/api/v1/themes/${theme.id}`,
        headers: { cookie },
      });
      expect(fetched.statusCode, fetched.body).toBe(200);

      const fetchedData = fetched.json().data;
      expect(fetchedData[field]).toBe(value);
      for (const other of untouchedFields) {
        expect(fetchedData[other]).toBeNull();
      }
    }
  );

  it('returns a meaningful 404 for a PUT against a missing theme id', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/themes/999999',
      headers: { cookie },
      payload: { name: 'Nowhere theme' },
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.body).not.toContain('[object Object]');

    const body = response.json();
    const message =
      typeof body.error === 'string' ? body.error : body.error?.message;
    expect(typeof message).toBe('string');
    expect(message.toLowerCase()).toContain('theme');
    expect(message.toLowerCase()).toContain('not found');
  });

  it.each([
    { label: 'POST missing name', method: 'POST' as const, payload: {} },
    {
      label: 'POST invalid name type',
      method: 'POST' as const,
      payload: { name: {} },
    },
    {
      label: 'POST out-of-range latitude',
      method: 'POST' as const,
      payload: { name: 'Validation case', swBoundaryLat: 200 },
    },
    {
      label: 'PUT out-of-range latitude',
      method: 'PUT' as const,
      payload: { swBoundaryLat: 200 },
    },
    {
      label: 'POST out-of-range longitude',
      method: 'POST' as const,
      payload: { name: 'Validation case', swBoundaryLong: 200 },
    },
    {
      label: 'PUT out-of-range longitude',
      method: 'PUT' as const,
      payload: { swBoundaryLong: 200 },
    },
    {
      label: 'POST non-numeric latitude',
      method: 'POST' as const,
      payload: { name: 'Validation case', swBoundaryLat: 'x' },
    },
    {
      label: 'POST invalid mapboxStyleUrl',
      method: 'POST' as const,
      payload: {
        name: 'Validation case',
        mapboxStyleUrl: 'https://example.com/styles/test',
      },
    },
    {
      label: 'PUT invalid mapboxStyleUrl',
      method: 'PUT' as const,
      payload: { mapboxStyleUrl: 'https://example.com/styles/test' },
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
      expect(response.json().issues.length).toBeGreaterThan(0);
      const invalidField =
        Object.keys(payload).find((key) => key !== 'name') ?? 'name';
      expect(JSON.stringify(response.json().issues)).toContain(invalidField);
      expect(response.body).not.toContain('[object Object]');
    }
  );
  it.each(['POST', 'PUT'] as const)(
    'returns 400 for malformed JSON on %s',
    async (method) => {
      const url =
        method === 'POST'
          ? '/api/v1/themes'
          : `/api/v1/themes/${(await createTheme()).id}`;
      const response = await app.inject({
        method,
        url,
        headers: { cookie, 'content-type': 'application/json' },
        payload: '{"name":',
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error).toBe('Request validation failed');
      expect(response.body).not.toContain('[object Object]');
    }
  );
});
