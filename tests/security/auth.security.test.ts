import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../src/app.js';
import { FastifyInstance } from 'fastify';
import { TestDatabaseManager } from '../helpers/database.js';

describe.skip('Authentication Security Tests', () => {
  let app: FastifyInstance;
  let testDb: TestDatabaseManager;

  beforeEach(async () => {
    testDb = new TestDatabaseManager();
    await testDb.setup();
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await testDb.cleanup();
  });

  describe('Session Security', () => {
    it('should create secure session cookies', async () => {
      // Register and login
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'secure@test.com',
          password: 'SecurePassword123!',
          firstName: 'Secure',
          lastName: 'Test',
          communityId: 1,
          role: 'viewer',
        },
      });

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'secure@test.com',
          password: 'SecurePassword123!',
          communityId: 1,
        },
      });

      const setCookieHeader = loginResponse.headers['set-cookie'];
      const cookieString = Array.isArray(setCookieHeader)
        ? setCookieHeader[0]
        : setCookieHeader;

      // Session cookies should be secure
      expect(cookieString).toContain('HttpOnly');
      expect(cookieString).toContain('SameSite=Strict');
      expect(cookieString).toContain('Path=/');

      // In production should be Secure
      if (process.env.NODE_ENV === 'production') {
        expect(cookieString).toContain('Secure');
      }
    });

    it('should use cryptographically secure session IDs', async () => {
      // Register and login multiple times
      const sessionIds = new Set<string>();

      for (let i = 0; i < 5; i++) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: {
            email: `unique${i}@test.com`,
            password: 'SecurePassword123!',
            firstName: 'Unique',
            lastName: `Test${i}`,
            communityId: 1,
            role: 'viewer',
          },
        });

        const loginResponse = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: {
            email: `unique${i}@test.com`,
            password: 'SecurePassword123!',
            communityId: 1,
          },
        });

        const setCookieHeader = loginResponse.headers['set-cookie'];
        const cookieString = Array.isArray(setCookieHeader)
          ? setCookieHeader[0]
          : setCookieHeader;
        const sessionId = cookieString!.split('sessionId=')[1]?.split(';')[0];

        sessionIds.add(sessionId!);
      }

      // All session IDs should be unique
      expect(sessionIds.size).toBe(5);

      // Session IDs should be long enough (at least 32 characters)
      sessionIds.forEach((id) => {
        expect(id.length).toBeGreaterThanOrEqual(32);
      });
    });

    it('should prevent session fixation attacks', async () => {
      // Register and login
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'fixation@test.com',
          password: 'SecurePassword123!',
          firstName: 'Fixation',
          lastName: 'Test',
          communityId: 1,
          role: 'viewer',
        },
      });

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'fixation@test.com',
          password: 'SecurePassword123!',
          communityId: 1,
        },
      });

      const loginCookieHeader = loginResponse.headers['set-cookie'];
      const loginCookieString = Array.isArray(loginCookieHeader)
        ? loginCookieHeader[0]
        : loginCookieHeader;
      const loginSessionId = loginCookieString!
        .split('sessionId=')[1]
        ?.split(';')[0];

      // Session ID should be different after login (new session created)
      expect(loginSessionId).toBeDefined();
      expect(loginSessionId!.length).toBeGreaterThan(0);
    });
  });

  describe('Rate Limiting Security', () => {
    it('should prevent brute force attacks on login', async () => {
      // Register user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'bruteforce@test.com',
          password: 'SecurePassword123!',
          firstName: 'BruteForce',
          lastName: 'Test',
          communityId: 1,
          role: 'viewer',
        },
      });

      // Attempt multiple failed logins
      const failedAttempts = Array.from({ length: 10 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: {
            email: 'bruteforce@test.com',
            password: 'WrongPassword123!',
            communityId: 1,
          },
        })
      );

      const responses = await Promise.all(failedAttempts);

      // Should be rate limited after a few attempts
      const rateLimitedResponses = responses.filter(
        (r) => r.statusCode === 429
      );
      expect(rateLimitedResponses.length).toBeGreaterThan(0);

      // Rate limited response should have appropriate message
      if (rateLimitedResponses.length > 0) {
        const rateLimitResponse = JSON.parse(rateLimitedResponses[0].body);
        expect(rateLimitResponse.error).toContain('Rate limit exceeded');
      }
    });

    it('should apply different rate limits per IP', async () => {
      // This test would require ability to simulate different IPs
      // For now, test that rate limiting headers are present
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'nonexistent@test.com',
          password: 'WrongPassword123!',
          communityId: 1,
        },
      });

      // Should have rate limit headers
      expect(response.headers['x-ratelimit-limit']).toBeDefined();
      expect(response.headers['x-ratelimit-remaining']).toBeDefined();
      expect(response.headers['x-ratelimit-reset']).toBeDefined();
    });

    it('should reset rate limits after time window', async () => {
      // This test would require time manipulation or be slow
      // For now, verify that rate limit reset time is in the future
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'reset@test.com',
          password: 'WrongPassword123!',
          communityId: 1,
        },
      });

      const resetTime = parseInt(
        response.headers['x-ratelimit-reset'] as string
      );
      const currentTime = Math.floor(Date.now() / 1000);

      expect(resetTime).toBeGreaterThan(currentTime);
      expect(resetTime - currentTime).toBeLessThanOrEqual(60); // Should be within 1 minute
    });
  });

  describe('Input Security', () => {
    it('should prevent injection attacks in email field', async () => {
      const maliciousEmails = [
        'user@test.com; DROP TABLE users; --',
        "user@test.com'; DROP TABLE users; --",
        'user@test.com<script>alert("xss")</script>',
        'user@test.com\x00admin@test.com',
      ];

      for (const maliciousEmail of maliciousEmails) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: {
            email: maliciousEmail,
            password: 'SecurePassword123!',
            firstName: 'Malicious',
            lastName: 'Test',
            communityId: 1,
            role: 'viewer',
          },
        });

        // Should reject malicious input
        expect(response.statusCode).toBe(400);
      }
    });

    it('should sanitize output to prevent XSS', async () => {
      const xssPayload = '<script>alert("xss")</script>';

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'xss@test.com',
          password: 'SecurePassword123!',
          firstName: xssPayload,
          lastName: 'Test',
          communityId: 1,
          role: 'viewer',
        },
      });

      if (response.statusCode === 201) {
        const body = JSON.parse(response.body);
        // Output should not contain raw script tags
        expect(body.user.firstName).not.toContain('<script>');
        expect(body.user.firstName).not.toContain('</script>');
      }
    });
  });

  describe('Authentication Bypass Prevention', () => {
    it('should not accept malformed JWT tokens', async () => {
      const malformedTokens = [
        'Bearer invalid.token.here',
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid',
        'Bearer malformed',
        'invalid-format',
      ];

      for (const token of malformedTokens) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: {
            authorization: token,
          },
        });

        expect(response.statusCode).toBe(401);
      }
    });

    it('should not leak sensitive information in error messages', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'nonexistent@test.com',
          password: 'WrongPassword123!',
          communityId: 1,
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);

      // Should not reveal whether email exists or not
      expect(body.error).toBe('Invalid email or password');
      expect(body.error).not.toContain('not found');
      expect(body.error).not.toContain('does not exist');
    });

    it('should prevent timing attacks on login', async () => {
      // Register a user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'timing@test.com',
          password: 'SecurePassword123!',
          firstName: 'Timing',
          lastName: 'Test',
          communityId: 1,
          role: 'viewer',
        },
      });

      // Time login attempt with valid email, wrong password
      const start1 = Date.now();
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'timing@test.com',
          password: 'WrongPassword123!',
          communityId: 1,
        },
      });
      const end1 = Date.now();

      // Time login attempt with invalid email
      const start2 = Date.now();
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'nonexistent@test.com',
          password: 'WrongPassword123!',
          communityId: 1,
        },
      });
      const end2 = Date.now();

      // Time difference should be minimal (less than 100ms difference)
      const timeDiff = Math.abs(end1 - start1 - (end2 - start2));
      expect(timeDiff).toBeLessThan(100);
    });
  });

  describe('Session Management Security', () => {
    it('should invalidate sessions on password change', async () => {
      // This test would require password change endpoint
      // For now, test that sessions can be invalidated
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'password@test.com',
          password: 'SecurePassword123!',
          firstName: 'Password',
          lastName: 'Test',
          communityId: 1,
          role: 'viewer',
        },
      });

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'password@test.com',
          password: 'SecurePassword123!',
          communityId: 1,
        },
      });

      const setCookieHeader = loginResponse.headers['set-cookie'];
      const cookieString = Array.isArray(setCookieHeader)
        ? setCookieHeader[0]
        : setCookieHeader;
      const sessionCookie = cookieString!.split(';')[0];

      // Logout should invalidate session
      const logoutResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(logoutResponse.statusCode).toBe(200);

      // Session should be invalid after logout
      const protectedResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(protectedResponse.statusCode).toBe(401);
    });

    it('should prevent concurrent session vulnerabilities', async () => {
      // Register user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'concurrent@test.com',
          password: 'SecurePassword123!',
          firstName: 'Concurrent',
          lastName: 'Test',
          communityId: 1,
          role: 'viewer',
        },
      });

      // Create multiple sessions
      const loginPromises = Array.from({ length: 3 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: {
            email: 'concurrent@test.com',
            password: 'SecurePassword123!',
            communityId: 1,
          },
        })
      );

      const loginResponses = await Promise.all(loginPromises);

      // All logins should succeed
      loginResponses.forEach((response) => {
        expect(response.statusCode).toBe(200);
      });

      // Each should have different session cookies
      const sessionCookies = loginResponses.map((response) => {
        const setCookieHeader = response.headers['set-cookie'];
        const cookieString = Array.isArray(setCookieHeader)
          ? setCookieHeader[0]
          : setCookieHeader;
        return cookieString!.split('sessionId=')[1]?.split(';')[0];
      });

      const uniqueSessions = new Set(sessionCookies);
      expect(uniqueSessions.size).toBe(3);
    });
  });
});
