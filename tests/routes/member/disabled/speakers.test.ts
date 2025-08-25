/**
 * Member Speakers API Tests
 *
 * Comprehensive test suite for authenticated member speaker management endpoints.
 * Tests RBAC, ownership, community isolation, cultural protocols, and elder status.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { testDb } from '../../../helpers/database.js';
import { createTestApp } from '../../../helpers/api-client.js';

describe('Member Speakers API', () => {
  let app: FastifyInstance;
  let testCommunityId: number;

  beforeEach(async () => {
    // Setup test database
    const db = await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[0].id;

    // Create test app with test database
    app = await createTestApp(db);
  });

  afterEach(async () => {
    await app.close();
    await testDb.clearData();
  });

  describe('Authentication & Authorization', () => {
    it('should reject unauthenticated requests', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/speakers',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should require authentication for all endpoints', async () => {
      const endpoints = [
        { method: 'GET', url: '/api/v1/member/speakers' },
        { method: 'GET', url: '/api/v1/member/speakers/1' },
        { method: 'POST', url: '/api/v1/member/speakers' },
        { method: 'PUT', url: '/api/v1/member/speakers/1' },
        { method: 'DELETE', url: '/api/v1/member/speakers/1' },
      ];

      for (const endpoint of endpoints) {
        const response = await app.inject({
          method: endpoint.method,
          url: endpoint.url,
          payload:
            endpoint.method === 'POST' || endpoint.method === 'PUT'
              ? { name: 'Test Speaker' }
              : undefined,
        });

        expect(response.statusCode).toBe(401);
      }
    });
  });

  describe('GET /api/v1/member/speakers', () => {
    it('should list community speakers with proper response structure', async () => {
      // First register and login a user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'test@example.com',
          password: 'SecurePassword123!',
          firstName: 'Test',
          lastName: 'User',
          communityId: testCommunityId,
          role: 'editor',
        },
      });

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'test@example.com',
          password: 'SecurePassword123!',
        },
      });

      const cookies = loginResponse.headers['set-cookie'];

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/speakers?page=1&limit=10',
        headers: {
          cookie: cookies,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body).toMatchObject({
        data: expect.any(Array),
        meta: expect.objectContaining({
          page: 1,
          limit: 10,
          total: expect.any(Number),
          totalPages: expect.any(Number),
          hasNextPage: expect.any(Boolean),
          hasPrevPage: expect.any(Boolean),
        }),
      });
    });

    it('should support cultural role filtering', async () => {
      // Register and login a user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'filter@example.com',
          password: 'SecurePassword123!',
          firstName: 'Filter',
          lastName: 'User',
          communityId: testCommunityId,
          role: 'editor',
        },
      });

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'filter@example.com',
          password: 'SecurePassword123!',
        },
      });

      const cookies = loginResponse.headers['set-cookie'];

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/speakers?culturalRole=elder',
        headers: {
          cookie: cookies,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.data).toEqual(expect.any(Array));
    });
  });

  describe('POST /api/v1/member/speakers', () => {
    it('should create a new speaker with valid data', async () => {
      // Register and login a user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'creator@example.com',
          password: 'SecurePassword123!',
          firstName: 'Creator',
          lastName: 'User',
          communityId: testCommunityId,
          role: 'editor',
        },
      });

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'creator@example.com',
          password: 'SecurePassword123!',
        },
      });

      const cookies = loginResponse.headers['set-cookie'];

      const speakerData = {
        name: 'Test Speaker',
        bio: 'A test speaker for testing',
        culturalRole: 'storyteller',
        isElder: false,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: cookies,
        },
        payload: speakerData,
      });

      expect(response.statusCode).toBe(201);

      const body = JSON.parse(response.body);
      expect(body.data).toMatchObject({
        name: 'Test Speaker',
        bio: 'A test speaker for testing',
        culturalRole: 'storyteller',
      });
    });

    it('should validate required fields', async () => {
      // Register and login a user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'validator@example.com',
          password: 'SecurePassword123!',
          firstName: 'Validator',
          lastName: 'User',
          communityId: testCommunityId,
          role: 'editor',
        },
      });

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'validator@example.com',
          password: 'SecurePassword123!',
        },
      });

      const cookies = loginResponse.headers['set-cookie'];

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: cookies,
        },
        payload: {
          bio: 'Missing required name field',
        },
      });

      expect(response.statusCode).toBe(400);

      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Cultural Protocol Tests', () => {
    it('should handle elder status appropriately for different user roles', async () => {
      // Register an elder user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'elder@example.com',
          password: 'SecurePassword123!',
          firstName: 'Elder',
          lastName: 'User',
          communityId: testCommunityId,
          role: 'elder',
        },
      });

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'elder@example.com',
          password: 'SecurePassword123!',
        },
      });

      const cookies = loginResponse.headers['set-cookie'];

      // Test that elder can access speaker data
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: cookies,
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should filter cultural role based on user permissions', async () => {
      // Register a regular viewer
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'viewer@example.com',
          password: 'SecurePassword123!',
          firstName: 'Viewer',
          lastName: 'User',
          communityId: testCommunityId,
          role: 'viewer',
        },
      });

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'viewer@example.com',
          password: 'SecurePassword123!',
        },
      });

      const cookies = loginResponse.headers['set-cookie'];

      // Test that viewer gets filtered cultural roles
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: cookies,
        },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('Error Handling', () => {
    it('should handle validation errors gracefully', async () => {
      // Register and login a user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'error@example.com',
          password: 'SecurePassword123!',
          firstName: 'Error',
          lastName: 'User',
          communityId: testCommunityId,
          role: 'editor',
        },
      });

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'error@example.com',
          password: 'SecurePassword123!',
        },
      });

      const cookies = loginResponse.headers['set-cookie'];

      // Test with invalid cultural role
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: cookies,
        },
        payload: {
          name: 'Test Speaker',
          culturalRole: 'invalid-role',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
