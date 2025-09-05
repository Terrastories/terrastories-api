/**
 * Authentication Data Sovereignty Integration Tests
 *
 * Tests Phase 3 core functionality: data sovereignty protection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../src/app.js';
import { FastifyInstance } from 'fastify';
import { TestDatabaseManager } from '../helpers/database.js';

describe('Authentication Data Sovereignty Tests', () => {
  let app: FastifyInstance;
  let testDb: TestDatabaseManager;
  let testCommunityId: number;
  let systemCommunityId: number;

  beforeEach(async () => {
    testDb = new TestDatabaseManager();
    await testDb.setup();
    app = await buildApp({ database: testDb.db });
    await app.ready();

    // Get community IDs from fixtures
    const fixtures = await testDb.seedTestData();
    systemCommunityId = fixtures.systemCommunity.id;
    testCommunityId = fixtures.communities[0].id;
  });

  afterEach(async () => {
    await app.close();
    await testDb.cleanup();
  });

  describe('Data Sovereignty Protection', () => {
    it('should block super admin from accessing community data', async () => {
      // Register super admin in system community
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'superadmin@test.com',
          password: 'SecurePassword123!',
          firstName: 'Super',
          lastName: 'Admin',
          communityId: systemCommunityId,
          role: 'super_admin',
        },
      });

      // Login super admin
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'superadmin@test.com',
          password: 'SecurePassword123!',
          communityId: systemCommunityId,
        },
      });

      expect(loginResponse.statusCode).toBe(200); // Ensure login succeeded

      const setCookieHeader = loginResponse.headers['set-cookie'];
      // Use the signed cookie (second one) instead of the unsigned cookie (first one)  
      const signedCookie = Array.isArray(setCookieHeader) 
        ? setCookieHeader[1] 
        : setCookieHeader;
      const sessionCookie = signedCookie!.split(';')[0];

      // Try to access community data - should be blocked
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
    });

    it('should allow community admin access to community data', async () => {
      // Register community admin
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'admin@test.com',
          password: 'SecurePassword123!',
          firstName: 'Community',
          lastName: 'Admin',
          communityId: testCommunityId,
          role: 'admin',
        },
      });

      // Login admin
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'admin@test.com',
          password: 'SecurePassword123!',
          communityId: testCommunityId,
        },
      });

      const setCookieHeader = loginResponse.headers['set-cookie'];
      // Use the signed cookie (second one) instead of the unsigned cookie (first one)
      const signedCookie = Array.isArray(setCookieHeader) 
        ? setCookieHeader[1] 
        : setCookieHeader;
      const sessionCookie = signedCookie!.split(';')[0];

      // Access community data - should be allowed
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/community-data',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Community data access granted');
      expect(body.user.role).toBe('admin');
      expect(body.user.communityId).toBe(testCommunityId);
    });

    it('should allow elder access to community data', async () => {
      // Register elder
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'elder@test.com',
          password: 'SecurePassword123!',
          firstName: 'Community',
          lastName: 'Elder',
          communityId: testCommunityId,
          role: 'elder',
        },
      });

      // Login elder
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'elder@test.com',
          password: 'SecurePassword123!',
          communityId: testCommunityId,
        },
      });

      const setCookieHeader = loginResponse.headers['set-cookie'];
      // Use the signed cookie (second one) instead of the unsigned cookie (first one)
      const signedCookie = Array.isArray(setCookieHeader) 
        ? setCookieHeader[1] 
        : setCookieHeader;
      const sessionCookie = signedCookie!.split(';')[0];

      // Access community data - should be allowed
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/community-data',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Community data access granted');
      expect(body.user.role).toBe('elder');
      expect(body.user.communityId).toBe(testCommunityId);
    });
  });
});
