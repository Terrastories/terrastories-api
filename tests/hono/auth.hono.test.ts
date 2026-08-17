/**
 * Hono V2 Auth Endpoints Test
 *
 * Verifies register, login, logout, me, and auth middleware work correctly
 * on the Hono app. Uses the same test database pattern as V1 tests.
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

describe('Hono V2: Auth endpoints', () => {
  let app: HonoTestApp;
  let db: TestDatabase;
  let communityId: number;

  beforeAll(async () => {
    db = await testDb.setup();
    await testDb.clearData();
    setSessionStore(new MemorySessionStore());
    app = await createHonoTestApp(db);

    const seedData = await createTestData();
    communityId = seedData.community.id;
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  describe('POST /v2/auth/register', () => {
    it('should register a new user successfully', async () => {
      const response = await honoRequest(app, 'POST', '/v2/auth/register', {
        body: {
          email: 'hono-test@example.com',
          password: 'TestPass123!',
          firstName: 'Hono',
          lastName: 'Test',
          role: 'viewer',
          communityId,
        },
      });

      expect(response.status).toBe(201);
      const body = response.body as { user: Record<string, unknown> };
      expect(body.user).toHaveProperty('id');
      expect(body.user).toHaveProperty('email', 'hono-test@example.com');
      expect(body.user).toHaveProperty('firstName', 'Hono');
      expect(body.user).toHaveProperty('lastName', 'Test');
      expect(body.user).toHaveProperty('role', 'viewer');
      expect(body.user).toHaveProperty('communityId', communityId);
    });

    it('should reject duplicate email', async () => {
      const response = await honoRequest(app, 'POST', '/v2/auth/register', {
        body: {
          email: 'hono-test@example.com',
          password: 'TestPass123!',
          firstName: 'Hono',
          lastName: 'Test',
          role: 'viewer',
          communityId,
        },
      });

      expect(response.status).toBe(409);
    });

    it('should reject invalid email', async () => {
      const response = await honoRequest(app, 'POST', '/v2/auth/register', {
        body: {
          email: 'not-an-email',
          password: 'TestPass123!',
          firstName: 'Hono',
          lastName: 'Test',
          communityId,
        },
      });

      expect(response.status).toBe(400);
    });

    it('should reject short password', async () => {
      const response = await honoRequest(app, 'POST', '/v2/auth/register', {
        body: {
          email: 'short-pass@example.com',
          password: 'short',
          firstName: 'Hono',
          lastName: 'Test',
          communityId,
        },
      });

      expect(response.status).toBe(400);
    });
  });

  describe('POST /v2/auth/login', () => {
    it('should login with valid credentials', async () => {
      const response = await honoRequest(app, 'POST', '/v2/auth/login', {
        body: {
          email: 'hono-test@example.com',
          password: 'TestPass123!',
          communityId,
        },
      });

      expect(response.status).toBe(200);
      const body = response.body as {
        user: Record<string, unknown>;
        sessionId: string;
      };
      expect(body.user).toHaveProperty('email', 'hono-test@example.com');
      expect(body).toHaveProperty('sessionId');
      expect(typeof body.sessionId).toBe('string');
    });

    it('should set session cookie on login', async () => {
      const response = await honoRequest(app, 'POST', '/v2/auth/login', {
        body: {
          email: 'hono-test@example.com',
          password: 'TestPass123!',
          communityId,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers['set-cookie']).toBeDefined();
      expect(response.headers['set-cookie']).toContain('sessionId=');
      expect(response.headers['set-cookie']).toContain('HttpOnly');
    });

    it('should reject invalid credentials', async () => {
      const response = await honoRequest(app, 'POST', '/v2/auth/login', {
        body: {
          email: 'hono-test@example.com',
          password: 'wrong-password',
          communityId,
        },
      });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /v2/auth/me', () => {
    it('should return 401 without authentication', async () => {
      const response = await honoRequest(app, 'GET', '/v2/auth/me');
      expect(response.status).toBe(401);
    });

    it('should return current user with valid session', async () => {
      const cookie = await honoLogin(
        app,
        'hono-test@example.com',
        'TestPass123!',
        communityId
      );
      const response = await honoRequest(app, 'GET', '/v2/auth/me', {
        cookie,
      });

      expect(response.status).toBe(200);
      const body = response.body as { user: Record<string, unknown> };
      expect(body.user).toHaveProperty('email', 'hono-test@example.com');
      expect(body.user).toHaveProperty('role');
      expect(body.user).toHaveProperty('communityId');
    });
  });

  describe('POST /v2/auth/logout', () => {
    it('should return 401 without authentication', async () => {
      const response = await honoRequest(app, 'POST', '/v2/auth/logout');
      expect(response.status).toBe(401);
    });

    it('should logout successfully with valid session', async () => {
      const cookie = await honoLogin(
        app,
        'hono-test@example.com',
        'TestPass123!',
        communityId
      );
      const response = await honoRequest(app, 'POST', '/v2/auth/logout', {
        cookie,
      });

      expect(response.status).toBe(200);
      const body = response.body as { message: string };
      expect(body.message).toBe('Successfully logged out');
    });

    it('should invalidate session after logout', async () => {
      const cookie = await honoLogin(
        app,
        'hono-test@example.com',
        'TestPass123!',
        communityId
      );
      await honoRequest(app, 'POST', '/v2/auth/logout', { cookie });
      const response = await honoRequest(app, 'GET', '/v2/auth/me', {
        cookie,
      });
      expect(response.status).toBe(401);
    });
  });

  describe('Role-based access', () => {
    it('GET /v2/auth/admin-only should return 401 without auth', async () => {
      const response = await honoRequest(app, 'GET', '/v2/auth/admin-only');
      expect(response.status).toBe(401);
    });
  });
});
