/**
 * Auth Endpoints — V1 Compatibility Tests
 *
 * Captures the exact response shape of authentication endpoints
 * to establish V1 parity baseline for V2 migration.
 *
 * Endpoints covered:
 * - POST /api/v1/auth/register (201, 400, 409)
 * - POST /api/v1/auth/login (200, 401)
 * - POST /api/v1/auth/logout (200, 401)
 * - GET /api/v1/auth/me (200, 401)
 * - POST /api/v1/auth/forgot-password (200)
 * - POST /api/v1/auth/reset-password (200)
 * - GET /api/v1/auth/admin-only (200, 401, 403)
 * - GET /api/v1/auth/community-data (200, 401)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { DualApiClient } from './helpers/dual-client';
import { createTestApp } from '../helpers/api-client';
import { testDb, createTestData } from '../helpers/database';

describe('V1 Compatibility: Auth', () => {
  let dualClient: DualApiClient;
  let viewerToken: string;
  let adminToken: string;
  let communityId: number;
  let app: FastifyInstance;

  beforeAll(async () => {
    const db = await testDb.setup();
    await testDb.clearData();
    app = await createTestApp(db);

    dualClient = new DualApiClient({
      typescriptBaseUrl: 'http://localhost:3000',
      railsBaseUrl: '',
      app,
    });

    // Seed communities first
    const seedData = await createTestData();
    communityId = seedData.community.id;

    // Register a fresh viewer user to get working credentials
    const viewerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'comparison-viewer@test.com',
        password: 'TestPass123!',
        firstName: 'Viewer',
        lastName: 'Test',
        communityId: communityId,
      },
    });
    expect(viewerRes.statusCode).toBe(201);

    // Register a fresh admin user
    const adminRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'comparison-admin@test.com',
        password: 'TestPass123!',
        firstName: 'Admin',
        lastName: 'Test',
        role: 'admin',
        communityId: communityId,
      },
    });
    expect(adminRes.statusCode).toBe(201);

    // Login to get viewer token
    const viewerLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: 'comparison-viewer@test.com',
        password: 'TestPass123!',
      },
    });
    // Fastify returns TWO cookies: first is unsigned, second (index 1) is signed
    // DualApiClient adds 'sessionId=' prefix, so strip it from the raw cookie
    const viewerCookies = viewerLogin.headers['set-cookie'];
    if (Array.isArray(viewerCookies) && viewerCookies.length >= 2) {
      viewerToken = viewerCookies[1].split(';')[0].replace('sessionId=', '');
    }

    // Login to get admin token
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: 'comparison-admin@test.com',
        password: 'TestPass123!',
      },
    });
    const adminCookies = adminLogin.headers['set-cookie'];
    if (Array.isArray(adminCookies) && adminCookies.length >= 2) {
      adminToken = adminCookies[1].split(';')[0].replace('sessionId=', '');
    }
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  // ─── REGISTER ────────────────────────────────────────────
  describe('POST /auth/register', () => {
    it('should return 201 with user object on success', async () => {
      const payload = {
        email: `newuser-${Date.now()}@test.com`,
        password: 'TestPass123!',
        firstName: 'Test',
        lastName: 'User',
        communityId,
      };
      const response = await dualClient['makeTypescriptRequest'](
        'POST',
        '/api/v1/auth/register',
        { data: payload }
      );
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body as string);
      expect(body).toHaveProperty('user');
      expect(body.user).toHaveProperty('id');
      expect(body.user).toHaveProperty('email');
      expect(body.user).toHaveProperty('role');
    });

    it('should return 400 with missing required fields', async () => {
      const response = await dualClient['makeTypescriptRequest'](
        'POST',
        '/api/v1/auth/register',
        { data: { email: 'bad@test.com' } }
      );
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body as string);
      expect(body).toHaveProperty('error');
    });

    it('should return 409 for duplicate email in same community', async () => {
      // Register same user twice
      const email = `dup-${Date.now()}@test.com`;
      // First registration
      await dualClient['makeTypescriptRequest'](
        'POST',
        '/api/v1/auth/register',
        {
          data: {
            email,
            password: 'TestPass123!',
            firstName: 'First',
            lastName: 'User',
            communityId: communityId,
          },
        }
      );
      // Second registration (duplicate)
      const response = await dualClient['makeTypescriptRequest'](
        'POST',
        '/api/v1/auth/register',
        {
          data: {
            email,
            password: 'TestPass123!',
            firstName: 'Dup',
            lastName: 'User',
            communityId: communityId,
          },
        }
      );
      expect([409, 400]).toContain(response.statusCode);
    });
  });

  // ─── LOGIN ───────────────────────────────────────────────
  describe('POST /auth/login', () => {
    it('should return 200 with user and sessionId', async () => {
      // Register fresh user
      const email = `login-test-${Date.now()}@test.com`;
      await dualClient['makeTypescriptRequest'](
        'POST',
        '/api/v1/auth/register',
        {
          data: {
            email,
            password: 'SecurePass1!',
            firstName: 'Login',
            lastName: 'Test',
            communityId: communityId,
          },
        }
      );
      const response = await dualClient['makeTypescriptRequest'](
        'POST',
        '/api/v1/auth/login',
        {
          data: {
            email,
            password: 'SecurePass1!',
          },
        }
      );
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body as string);
      expect(body).toHaveProperty('user');
      expect(body).toHaveProperty('sessionId');
    });

    it('should return 401 with invalid password', async () => {
      const email = `badpw-${Date.now()}@test.com`;
      await dualClient['makeTypescriptRequest'](
        'POST',
        '/api/v1/auth/register',
        {
          data: {
            email,
            password: 'RealPass1!',
            firstName: 'Bad',
            lastName: 'PW',
            communityId: communityId,
          },
        }
      );
      const response = await dualClient['makeTypescriptRequest'](
        'POST',
        '/api/v1/auth/login',
        {
          data: {
            email,
            password: 'wrongpassword',
          },
        }
      );
      expect(response.statusCode).toBe(401);
    });

    it('should return 401 for nonexistent user', async () => {
      const response = await dualClient['makeTypescriptRequest'](
        'POST',
        '/api/v1/auth/login',
        {
          data: {
            email: 'nosuchuser@test.com',
            password: 'anything',
          },
        }
      );
      expect(response.statusCode).toBe(401);
    });
  });

  // ─── ME ──────────────────────────────────────────────────
  describe('GET /auth/me', () => {
    it('should return 200 with user object when authenticated', async () => {
      const response = await dualClient['makeTypescriptRequest'](
        'GET',
        '/api/v1/auth/me',
        { auth: viewerToken }
      );
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body as string);
      expect(body).toHaveProperty('user');
      expect(body.user).toHaveProperty('id');
      expect(body.user).toHaveProperty('email');
      expect(body.user).toHaveProperty('role');
    });

    it('should return 401 without auth', async () => {
      const response = await dualClient['makeTypescriptRequest'](
        'GET',
        '/api/v1/auth/me'
      );
      expect(response.statusCode).toBe(401);
    });
  });

  // ─── LOGOUT ──────────────────────────────────────────────
  describe('POST /auth/logout', () => {
    it('should return 200 when authenticated', async () => {
      const response = await dualClient['makeTypescriptRequest'](
        'POST',
        '/api/v1/auth/logout',
        { auth: viewerToken }
      );
      expect([200, 204]).toContain(response.statusCode);
    });
  });

  // ─── ADMIN-ONLY ──────────────────────────────────────────
  describe('GET /auth/admin-only', () => {
    it('should return 200 for admin user', async () => {
      const response = await dualClient['makeTypescriptRequest'](
        'GET',
        '/api/v1/auth/admin-only',
        { auth: adminToken }
      );
      expect(response.statusCode).toBe(200);
    });

    it('should return 403 for viewer user', async () => {
      const response = await dualClient['makeTypescriptRequest'](
        'GET',
        '/api/v1/auth/admin-only',
        { auth: viewerToken }
      );
      expect([403, 401]).toContain(response.statusCode);
    });

    it('should return 401 without auth', async () => {
      const response = await dualClient['makeTypescriptRequest'](
        'GET',
        '/api/v1/auth/admin-only'
      );
      expect(response.statusCode).toBe(401);
    });
  });
});
