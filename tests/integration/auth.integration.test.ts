import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../src/app.js';
import { FastifyInstance } from 'fastify';
import { TestDatabaseManager } from '../helpers/database.js';

describe('Authentication Integration Tests', () => {
  let app: FastifyInstance;
  let testDb: TestDatabaseManager;
  let testCommunityId: number;

  beforeEach(async () => {
    testDb = new TestDatabaseManager();
    await testDb.setup();
    app = await buildApp({ database: testDb.db });
    await app.ready();

    // Get the first test community ID from fixtures
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[0].id;
  });

  afterEach(async () => {
    await app.close();
    await testDb.cleanup();
  });

  describe('HTTP Endpoint Integration', () => {
    it('should register user through HTTP POST /api/v1/auth/register', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'integration@test.com',
          password: 'SecurePassword123!',
          firstName: 'Integration',
          lastName: 'Test',
          communityId: testCommunityId,
          role: 'viewer',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.user).toBeDefined();
      expect(body.user.email).toBe('integration@test.com');
      expect(body.user.firstName).toBe('Integration');
    });

    it('should login user through HTTP POST /api/v1/auth/login and create session', async () => {
      // First register a user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'login@test.com',
          password: 'SecurePassword123!',
          firstName: 'Login',
          lastName: 'Test',
          communityId: testCommunityId,
          role: 'viewer',
        },
      });

      // Then login
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'login@test.com',
          password: 'SecurePassword123!',
          communityId: testCommunityId,
        },
      });

      expect(loginResponse.statusCode).toBe(200);
      const body = JSON.parse(loginResponse.body);
      expect(body.user).toBeDefined();
      expect(body.user.email).toBe('login@test.com');

      // Should have session cookie
      const setCookieHeader = loginResponse.headers['set-cookie'];
      expect(setCookieHeader).toBeDefined();
      expect(
        Array.isArray(setCookieHeader) ? setCookieHeader[1] : setCookieHeader
      ).toContain('sessionId');
    });

    it('should logout user through HTTP POST /api/v1/auth/logout', async () => {
      // First register and login a user to get session
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'logout-test@test.com',
          password: 'SecurePassword123!',
          firstName: 'Logout',
          lastName: 'Test',
          communityId: testCommunityId,
          role: 'viewer',
        },
      });

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'logout-test@test.com',
          password: 'SecurePassword123!',
          communityId: testCommunityId,
        },
      });

      const setCookieHeader = loginResponse.headers['set-cookie'];
      const sessionCookie = (
        Array.isArray(setCookieHeader) ? setCookieHeader[1] : setCookieHeader
      )!.split(';')[0];

      // Now logout with session
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Successfully logged out');
    });
  });

  describe('Session Management', () => {
    it('should create session on successful login', async () => {
      // Register user first
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'session@test.com',
          password: 'SecurePassword123!',
          firstName: 'Session',
          lastName: 'Test',
          communityId: testCommunityId,
          role: 'viewer',
        },
      });

      // Login and check session
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'session@test.com',
          password: 'SecurePassword123!',
          communityId: testCommunityId,
        },
      });

      expect(loginResponse.statusCode).toBe(200);

      // Should have secure session cookie
      const setCookieHeader = loginResponse.headers['set-cookie'];
      expect(setCookieHeader).toBeDefined();

      const cookieString = Array.isArray(setCookieHeader)
        ? setCookieHeader[1]
        : setCookieHeader;
      expect(cookieString).toContain('sessionId');
      expect(cookieString).toContain('HttpOnly');
      expect(cookieString).toContain('SameSite');
    });

    it('should maintain session across requests', async () => {
      // Register and login
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'persistent@test.com',
          password: 'SecurePassword123!',
          firstName: 'Persistent',
          lastName: 'Test',
          communityId: testCommunityId,
          role: 'viewer',
        },
      });

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'persistent@test.com',
          password: 'SecurePassword123!',
          communityId: testCommunityId,
        },
      });

      const setCookieHeader = loginResponse.headers['set-cookie'];
      // Use the signed cookie (second one) instead of the unsigned cookie (first one)
      const cookieString = Array.isArray(setCookieHeader)
        ? setCookieHeader[1]
        : setCookieHeader;

      // Extract session cookie
      const sessionCookie = cookieString!.split(';')[0];

      // Make authenticated request with session cookie
      const protectedResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          cookie: sessionCookie,
        },
      });

      // Should be able to access user data via session
      expect(protectedResponse.statusCode).toBe(200);
      const body = JSON.parse(protectedResponse.body);
      expect(body.user.email).toBe('persistent@test.com');
    });

    it('should clear session on logout', async () => {
      // Register and login
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'logout@test.com',
          password: 'SecurePassword123!',
          firstName: 'Logout',
          lastName: 'Test',
          communityId: testCommunityId,
          role: 'viewer',
        },
      });

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'logout@test.com',
          password: 'SecurePassword123!',
          communityId: testCommunityId,
        },
      });

      const setCookieHeader = loginResponse.headers['set-cookie'];
      // Use the signed cookie (second one) instead of the unsigned cookie (first one)
      const cookieString = Array.isArray(setCookieHeader)
        ? setCookieHeader[1]
        : setCookieHeader;
      const sessionCookie = cookieString!.split(';')[0];

      // Logout
      const logoutResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(logoutResponse.statusCode).toBe(200);

      // Session should be cleared
      const logoutCookieHeader = logoutResponse.headers['set-cookie'];
      if (logoutCookieHeader) {
        const logoutCookieString = Array.isArray(logoutCookieHeader)
          ? logoutCookieHeader[0]
          : logoutCookieHeader;
        expect(logoutCookieString).toContain('Expires=Thu, 01 Jan 1970');
      }
    });
  });

  describe.skip('Rate Limiting', () => {
    it('should enforce rate limits on registration endpoint', async () => {
      const userData = {
        email: 'rate@test.com',
        password: 'SecurePassword123!',
        firstName: 'Rate',
        lastName: 'Test',
        communityId: 1,
        role: 'viewer',
      };

      // Make multiple rapid requests
      const requests = Array.from({ length: 10 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: {
            ...userData,
            email: `rate${i}@test.com`,
          },
        })
      );

      const responses = await Promise.all(requests);

      // Should have some 429 Too Many Requests responses
      const rateLimitedResponses = responses.filter(
        (r) => r.statusCode === 429
      );
      expect(rateLimitedResponses.length).toBeGreaterThan(0);
    });

    it('should enforce rate limits on login endpoint', async () => {
      // Register a user first
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'ratelimit@test.com',
          password: 'SecurePassword123!',
          firstName: 'RateLimit',
          lastName: 'Test',
          communityId: testCommunityId,
          role: 'viewer',
        },
      });

      // Make multiple login attempts
      const loginData = {
        email: 'ratelimit@test.com',
        password: 'WrongPassword123!',
        communityId: 1,
      };

      const requests = Array.from({ length: 10 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: loginData,
        })
      );

      const responses = await Promise.all(requests);

      // Should have some 429 Too Many Requests responses
      const rateLimitedResponses = responses.filter(
        (r) => r.statusCode === 429
      );
      expect(rateLimitedResponses.length).toBeGreaterThan(0);
    });

    it('should include rate limit headers in response', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'headers@test.com',
          password: 'SecurePassword123!',
          firstName: 'Headers',
          lastName: 'Test',
          communityId: testCommunityId,
          role: 'viewer',
        },
      });

      // Should include rate limit headers
      expect(response.headers['x-ratelimit-limit']).toBeDefined();
      expect(response.headers['x-ratelimit-remaining']).toBeDefined();
      expect(response.headers['x-ratelimit-reset']).toBeDefined();
    });
  });

  describe('Security Headers', () => {
    it('should include security headers in auth responses', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'security@test.com',
          password: 'SecurePassword123!',
          firstName: 'Security',
          lastName: 'Test',
          communityId: testCommunityId,
          role: 'viewer',
        },
      });

      // Security headers should be present
      expect(response.headers['x-frame-options']).toBeDefined();
      expect(response.headers['x-content-type-options']).toBeDefined();
      expect(response.headers['x-xss-protection']).toBeDefined();
    });

    it('should handle CORS for auth endpoints', async () => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/auth/register',
        headers: {
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type',
          Origin: 'http://localhost:3001',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBeDefined();
      expect(response.headers['access-control-allow-methods']).toContain(
        'POST'
      );
    });
  });

  describe('Authentication Middleware', () => {
    it('should protect routes that require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error.message).toBe('Authentication required');
    });

    it('should allow access with valid session', async () => {
      // Register and login first
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'middleware@test.com',
          password: 'SecurePassword123!',
          firstName: 'Middleware',
          lastName: 'Test',
          communityId: testCommunityId,
          role: 'admin',
        },
      });

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'middleware@test.com',
          password: 'SecurePassword123!',
          communityId: testCommunityId,
        },
      });

      const setCookieHeader = loginResponse.headers['set-cookie'];
      // Use the signed cookie (second one) instead of the unsigned cookie (first one)
      const cookieString = Array.isArray(setCookieHeader)
        ? setCookieHeader[1]
        : setCookieHeader;
      const sessionCookie = cookieString!.split(';')[0];

      // Access protected route
      const protectedResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(protectedResponse.statusCode).toBe(200);
      const body = JSON.parse(protectedResponse.body);
      expect(body.user.email).toBe('middleware@test.com');
    });

    it('should enforce role-based access control', async () => {
      // Register viewer user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'viewer@test.com',
          password: 'SecurePassword123!',
          firstName: 'Viewer',
          lastName: 'Test',
          communityId: testCommunityId,
          role: 'viewer',
        },
      });

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'viewer@test.com',
          password: 'SecurePassword123!',
          communityId: testCommunityId,
        },
      });

      const setCookieHeader = loginResponse.headers['set-cookie'];
      // Use the signed cookie (second one) instead of the unsigned cookie (first one)
      const cookieString = Array.isArray(setCookieHeader)
        ? setCookieHeader[1]
        : setCookieHeader;
      const sessionCookie = cookieString!.split(';')[0];

      // Try to access admin-only route
      const adminResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/admin-only',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(adminResponse.statusCode).toBe(403);
      const body = JSON.parse(adminResponse.body);
      expect(body.error.message).toBe('Insufficient permissions');
    });
  });
});
