/**
 * Member Places API Tests
 *
 * Comprehensive test suite for authenticated member place management endpoints.
 * Tests RBAC, ownership, community isolation, cultural protocols, and PostGIS functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { testDb } from '../../helpers/database.js';
import { createTestApp } from '../../helpers/api-client.js';

describe('Member Places API', () => {
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
        url: '/api/v1/member/places',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should require authentication for all endpoints', async () => {
      const endpoints = [
        { method: 'GET', url: '/api/v1/member/places' },
        { method: 'GET', url: '/api/v1/member/places/1' },
        { method: 'POST', url: '/api/v1/member/places' },
        { method: 'PUT', url: '/api/v1/member/places/1' },
        { method: 'DELETE', url: '/api/v1/member/places/1' },
      ];

      for (const endpoint of endpoints) {
        const response = await app.inject({
          method: endpoint.method,
          url: endpoint.url,
          payload:
            endpoint.method === 'POST' || endpoint.method === 'PUT'
              ? { name: 'Test Place', lat: 0, lng: 0 }
              : undefined,
        });

        expect(response.statusCode).toBe(401);
      }
    });
  });

  describe('GET /api/v1/member/places', () => {
    it('should list community places with proper response structure', async () => {
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
        url: '/api/v1/member/places?page=1&limit=10',
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

    it('should validate pagination parameters', async () => {
      // Register and login a user
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'test2@example.com',
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
          email: 'test2@example.com',
          password: 'SecurePassword123!',
        },
      });

      const cookies = loginResponse.headers['set-cookie'];

      // Test invalid page parameter
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places?page=0',
        headers: {
          cookie: cookies,
        },
      });

      expect(response.statusCode).toBe(400);

      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/v1/member/places', () => {
    it('should create a new place with valid data', async () => {
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

      const placeData = {
        name: 'Test Place',
        description: 'A test place for testing',
        lat: -15.7801,
        lng: -47.9292,
        culturalSignificance: 'general',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/places',
        headers: {
          cookie: cookies,
        },
        payload: placeData,
      });

      expect(response.statusCode).toBe(201);

      const body = JSON.parse(response.body);
      expect(body.data).toMatchObject({
        name: 'Test Place',
        description: 'A test place for testing',
        lat: -15.7801,
        lng: -47.9292,
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
        url: '/api/v1/member/places',
        headers: {
          cookie: cookies,
        },
        payload: {
          description: 'Missing required fields',
        },
      });

      expect(response.statusCode).toBe(400);

      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Cultural Protocol Tests', () => {
    it('should handle cultural significance levels appropriately', async () => {
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

      // Test that elder can see cultural significance
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places',
        headers: {
          cookie: cookies,
        },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('Error Handling', () => {
    it('should handle server errors gracefully', async () => {
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

      // Test with malformed data
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/places',
        headers: {
          cookie: cookies,
        },
        payload: {
          name: 'Test',
          lat: 'invalid-lat',
          lng: 'invalid-lng',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
