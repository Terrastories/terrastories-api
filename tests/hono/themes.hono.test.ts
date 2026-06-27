/**
 * Hono V2 Themes Endpoints Test
 *
 * Verifies CRUD operations work on the Hono app.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createHonoTestApp,
  honoRequest,
  honoLogin,
  type HonoTestApp,
} from '../helpers/hono-client';
import { testDb, createTestData, type TestDatabase } from '../helpers/database';
import {
  setSessionStore,
  MemorySessionStore,
} from '../../src/shared/session/session-store';

describe('Hono V2: Themes endpoints', () => {
  let app: HonoTestApp;
  let db: TestDatabase;
  let communityId: number;
  let adminCookie: string;
  let viewerCookie: string;
  let createdThemeId: number;

  beforeAll(async () => {
    db = await testDb.setup();
    await testDb.clearData();
    setSessionStore(new MemorySessionStore());
    app = await createHonoTestApp(db);

    const seedData = await createTestData();
    communityId = seedData.community.id;

    // Register and login an admin user
    await honoRequest(app, 'POST', '/v2/auth/register', {
      body: {
        email: 'themes-admin@test.com',
        password: 'TestPass123!',
        firstName: 'Admin',
        lastName: 'Themes',
        role: 'admin',
        communityId,
      },
    });
    adminCookie = await honoLogin(
      app,
      'themes-admin@test.com',
      'TestPass123!',
      communityId
    );

    // Register and login a viewer
    await honoRequest(app, 'POST', '/v2/auth/register', {
      body: {
        email: 'themes-viewer@test.com',
        password: 'TestPass123!',
        firstName: 'Viewer',
        lastName: 'Themes',
        role: 'viewer',
        communityId,
      },
    });
    viewerCookie = await honoLogin(
      app,
      'themes-viewer@test.com',
      'TestPass123!',
      communityId
    );
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  describe('POST /v2/themes', () => {
    it('should create a theme as admin', async () => {
      const response = await honoRequest(app, 'POST', '/v2/themes', {
        cookie: adminCookie,
        body: {
          name: 'Test Theme',
          description: 'A test theme',
          active: true,
          communityId,
          centerLat: 49.2827,
          centerLong: -123.1234,
        },
      });

      expect(response.status).toBe(201);
      const body = response.body as { data: Record<string, unknown> };
      expect(body.data).toHaveProperty('id');
      expect(body.data).toHaveProperty('name', 'Test Theme');
      createdThemeId = body.data.id as number;
    });

    it('should reject create as viewer (403)', async () => {
      const response = await honoRequest(app, 'POST', '/v2/themes', {
        cookie: viewerCookie,
        body: {
          name: 'Viewer Theme',
          communityId,
        },
      });

      expect(response.status).toBe(403);
    });

    it('should reject create without auth (401)', async () => {
      const response = await honoRequest(app, 'POST', '/v2/themes', {
        body: { name: 'No Auth Theme', communityId },
      });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /v2/themes', () => {
    it('should list themes with auth', async () => {
      const response = await honoRequest(app, 'GET', '/v2/themes', {
        cookie: adminCookie,
      });

      expect(response.status).toBe(200);
      const body = response.body as {
        data: unknown[];
        meta: Record<string, unknown>;
      };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta).toHaveProperty('total');
      expect(body.meta).toHaveProperty('page');
    });

    it('should reject list without auth (401)', async () => {
      const response = await honoRequest(app, 'GET', '/v2/themes');
      expect(response.status).toBe(401);
    });
  });

  describe('GET /v2/themes/:id', () => {
    it('should get theme by id', async () => {
      const response = await honoRequest(
        app,
        'GET',
        `/v2/themes/${createdThemeId}`,
        {
          cookie: adminCookie,
        }
      );

      expect(response.status).toBe(200);
      const body = response.body as { data: Record<string, unknown> };
      expect(body.data).toHaveProperty('id', createdThemeId);
    });

    it('should return 404 for non-existent theme', async () => {
      const response = await honoRequest(app, 'GET', '/v2/themes/99999', {
        cookie: adminCookie,
      });

      expect(response.status).toBe(404);
    });
  });

  describe('PUT /v2/themes/:id', () => {
    it('should update theme as admin', async () => {
      const response = await honoRequest(
        app,
        'PUT',
        `/v2/themes/${createdThemeId}`,
        {
          cookie: adminCookie,
          body: {
            name: 'Updated Theme',
            description: 'Updated description',
            active: true,
            centerLat: 49.2827,
            centerLong: -123.1234,
          },
        }
      );

      expect(response.status).toBe(200);
      const body = response.body as { data: Record<string, unknown> };
      expect(body.data).toHaveProperty('name', 'Updated Theme');
    });
  });

  describe('DELETE /v2/themes/:id', () => {
    it('should delete theme as admin', async () => {
      const response = await honoRequest(
        app,
        'DELETE',
        `/v2/themes/${createdThemeId}`,
        {
          cookie: adminCookie,
        }
      );

      expect(response.status).toBe(204);
    });
  });
});
