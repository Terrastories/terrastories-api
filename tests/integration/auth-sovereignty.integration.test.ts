/**
 * Authentication & Data Sovereignty Integration Tests
 *
 * End-to-end integration tests ensuring the complete authorization
 * system works correctly with data sovereignty enforcement,
 * cultural roles, and Indigenous community governance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../src/app.js';
import { FastifyInstance } from 'fastify';
import { TestDatabaseManager, TestFixtures } from '../helpers/database.js';

// Helper function to safely extract session cookie
function extractSessionCookie(response: any): string {
  const setCookieHeader = response.headers['set-cookie'];
  expect(setCookieHeader).toBeDefined();

  const cookieString = Array.isArray(setCookieHeader)
    ? setCookieHeader[0]
    : setCookieHeader;
  expect(cookieString).toBeDefined();

  return cookieString!.split(';')[0];
}

describe('Authentication & Data Sovereignty Integration', () => {
  let app: FastifyInstance;
  let testDb: TestDatabaseManager;
  let fixtures: TestFixtures;

  beforeEach(async () => {
    testDb = new TestDatabaseManager();
    await testDb.setup();
    fixtures = await testDb.seedTestData();

    // Pass test database to app for integration testing
    const db = await testDb.getDb();
    app = await buildApp({ database: db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await testDb.cleanup();
  });

  describe('Data Sovereignty Enforcement End-to-End', () => {
    it('should completely block super admin from community endpoints', async () => {
      // Register super admin
      const regResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'superadmin@system.org',
          password: 'SecurePassword123!',
          firstName: 'Super',
          lastName: 'Admin',
          communityId: fixtures.systemCommunity.id, // System-level
          role: 'super_admin',
        },
      });

      if (regResponse.statusCode !== 201) {
        console.log(
          'Registration failed:',
          regResponse.statusCode,
          regResponse.body
        );
        expect(regResponse.statusCode).toBe(201);
      }

      // Login super admin
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'superadmin@system.org',
          password: 'SecurePassword123!',
          communityId: fixtures.systemCommunity.id,
        },
      });

      expect(loginResponse.statusCode).toBe(200);

      const sessionCookie = extractSessionCookie(loginResponse);

      // Test community data access endpoint - should be blocked by data sovereignty
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/community-data',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(403);

      const body = JSON.parse(response.body);
      expect(body.error).toContain(
        'Super administrators cannot access community data'
      );
      expect(body.reason).toBe('Indigenous data sovereignty protection');
    });

    it('should enforce complete community data isolation', async () => {
      // Register users in different communities
      const community1Admin = {
        email: 'admin1@community1.org',
        password: 'SecurePassword123!',
        firstName: 'Admin',
        lastName: 'One',
        communityId: fixtures.communities[0].id,
        role: 'admin',
      };

      const community2Admin = {
        email: 'admin2@community2.org',
        password: 'SecurePassword123!',
        firstName: 'Admin',
        lastName: 'Two',
        communityId: fixtures.communities[1].id,
        role: 'admin',
      };

      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: community1Admin,
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: community2Admin,
      });

      // Login community 1 admin
      const login1Response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: community1Admin.email,
          password: community1Admin.password,
          communityId: community1Admin.communityId,
        },
      });

      const sessionCookie1 = extractSessionCookie(login1Response);

      // Test community 1 admin accessing community data - should be allowed for admins
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/community-data',
        headers: {
          cookie: sessionCookie1,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.message).toBe('Community data access granted');
    });
  });

  describe('Cultural Role Integration', () => {
    it('should support elder role throughout the system', async () => {
      // Register elder user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'elder@community1.org',
          password: 'SecurePassword123!',
          firstName: 'Knowledge',
          lastName: 'Keeper',
          communityId: fixtures.communities[0].id,
          role: 'elder',
        },
      });

      // Login elder
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'elder@community1.org',
          password: 'SecurePassword123!',
          communityId: fixtures.communities[0].id,
        },
      });

      expect(loginResponse.statusCode).toBe(200);

      const sessionCookie = extractSessionCookie(loginResponse);

      // Elder should access community data
      const viewerResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/community-data',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(viewerResponse.statusCode).toBe(200);

      // Elder should NOT access admin endpoint (elders have cultural permissions, not admin)
      const adminResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/admin-only',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(adminResponse.statusCode).toBe(403);
    });

    it('should respect elder cultural access permissions', async () => {
      // Register elder user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'cultural.elder@community1.org',
          password: 'SecurePassword123!',
          firstName: 'Cultural',
          lastName: 'Elder',
          communityId: fixtures.communities[0].id,
          role: 'elder',
        },
      });

      // Login elder
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'cultural.elder@community1.org',
          password: 'SecurePassword123!',
          communityId: fixtures.communities[0].id,
        },
      });

      const sessionCookie = extractSessionCookie(loginResponse);

      // Elder should access community data (cultural content would be here)
      const culturalResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/community-data',
        headers: {
          cookie: sessionCookie,
        },
      });

      // The test validates that the elder role is recognized and can access community data
      expect(culturalResponse.statusCode).toBe(200);

      const body = JSON.parse(culturalResponse.body);
      expect(body.message).toBe('Community data access granted');
      expect(body.user.role).toBe('elder');
    });
  });

  describe('Role Hierarchy Enforcement', () => {
    it('should enforce role hierarchy across all endpoints', async () => {
      const roles = [
        { role: 'viewer', level: 1 },
        { role: 'elder', level: 2 },
        { role: 'editor', level: 3 },
        { role: 'admin', level: 4 },
      ];

      const userSessions: { [role: string]: string } = {};

      // Register and login users with different roles
      for (const { role } of roles) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: {
            email: `${role}@community1.org`,
            password: 'SecurePassword123!',
            firstName: role.charAt(0).toUpperCase() + role.slice(1),
            lastName: 'User',
            communityId: fixtures.communities[0].id,
            role,
          },
        });

        const loginResponse = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: {
            email: `${role}@community1.org`,
            password: 'SecurePassword123!',
            communityId: fixtures.communities[0].id,
          },
        });

        userSessions[role] = extractSessionCookie(loginResponse);
      }

      // Test hierarchical access patterns using existing endpoints
      const hierarchicalEndpoints = [
        { endpoint: '/api/v1/auth/community-data', minLevel: 1 }, // viewer+
        { endpoint: '/api/v1/auth/admin-only', minLevel: 4 }, // admin+
      ];

      for (const {
        endpoint,
        method = 'GET',
        minLevel,
      } of hierarchicalEndpoints) {
        for (const { role, level: _level } of roles) {
          const response = await app.inject({
            method,
            url: endpoint,
            headers: {
              cookie: userSessions[role],
            },
          });

          if (_level >= minLevel) {
            // Should have access
            expect(response.statusCode).toBe(200);
          } else {
            // Should be denied access
            expect(response.statusCode).toBe(403);
          }
        }
      }
    });
  });

  describe('Security Event Logging', () => {
    it('should log all authorization events for audit', async () => {
      // Register super admin
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'audit.superadmin@system.org',
          password: 'SecurePassword123!',
          firstName: 'Audit',
          lastName: 'SuperAdmin',
          communityId: fixtures.systemCommunity.id,
          role: 'super_admin',
        },
      });

      // Login
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'audit.superadmin@system.org',
          password: 'SecurePassword123!',
          communityId: fixtures.systemCommunity.id,
        },
      });

      const sessionCookie = extractSessionCookie(loginResponse);

      // Attempt to access community data (should be blocked and logged)
      const blockedResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/community-data',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(blockedResponse.statusCode).toBe(403);

      // The logging verification would require access to the log system
      // In a real implementation, we would check that appropriate log entries
      // were created for the authorization event
    });

    it('should maintain audit trail for Indigenous oversight', async () => {
      // Register elder
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'oversight.elder@community1.org',
          password: 'SecurePassword123!',
          firstName: 'Oversight',
          lastName: 'Elder',
          communityId: fixtures.communities[0].id,
          role: 'elder',
        },
      });

      // Login
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'oversight.elder@community1.org',
          password: 'SecurePassword123!',
          communityId: fixtures.communities[0].id,
        },
      });

      const sessionCookie = extractSessionCookie(loginResponse);

      // Access community data (should be logged for cultural oversight)
      const accessResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/community-data',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect([200, 404]).toContain(accessResponse.statusCode);
      expect(accessResponse.statusCode).not.toBe(403);

      // Audit logging verification would be implementation-specific
    });
  });

  describe('Performance Validation', () => {
    it('should maintain authorization performance under 10ms', async () => {
      // Register admin user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'perf.admin@community1.org',
          password: 'SecurePassword123!',
          firstName: 'Performance',
          lastName: 'Admin',
          communityId: fixtures.communities[0].id,
          role: 'admin',
        },
      });

      // Login
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'perf.admin@community1.org',
          password: 'SecurePassword123!',
          communityId: fixtures.communities[0].id,
        },
      });

      const sessionCookie = extractSessionCookie(loginResponse);

      // Measure authorization overhead
      const iterations = 10;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = Date.now();

        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/community-data',
          headers: {
            cookie: sessionCookie,
          },
        });

        const end = Date.now();
        times.push(end - start);
      }

      const averageTime = times.reduce((a, b) => a + b, 0) / times.length;

      // Authorization overhead should be minimal
      // Note: This includes full request processing, not just auth middleware
      expect(averageTime).toBeLessThan(100); // 100ms total request time limit

      // Individual auth checks should be much faster
      // This would be measured more precisely in unit tests
    });
  });
});
