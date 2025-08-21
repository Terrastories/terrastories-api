/**
 * Places API Routes Tests
 *
 * Tests the Places API endpoints with:
 * - Complete CRUD operation endpoints
 * - Authentication and authorization
 * - Geographic search endpoints
 * - Request/response validation
 * - Error handling
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { testDb } from '../helpers/database.js';
import { createTestApp } from '../helpers/api-client.js';

describe('Places API Routes', () => {
  let app: FastifyInstance;
  let testCommunityId: number;
  let sessionCookies: string;

  beforeEach(async () => {
    // Setup test database
    await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[1].id; // Skip system community

    // Create test app with test database
    app = await createTestApp();

    // Register and login test user
    const registrationData = {
      email: 'test@example.com',
      password: 'StrongPassword123@',
      firstName: 'Test',
      lastName: 'User',
      role: 'admin',
      communityId: testCommunityId,
    };

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: registrationData,
    });

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: 'test@example.com',
        password: 'StrongPassword123@',
        communityId: testCommunityId,
      },
    });

    // Extract session cookies for authentication
    sessionCookies = loginResponse.cookies.map((cookie: any) => `${cookie.name}=${cookie.value}`).join('; ');
  });

  afterEach(async () => {
    await app.close();
    await testDb.clearData();
  });

  describe('POST /api/v1/places', () => {
    test('should create a new place', async () => {
      const placeData = {
        name: 'Sacred Mountain',
        description: 'Traditional gathering place',
        latitude: 37.7749,
        longitude: -122.4194,
        culturalSignificance: 'Sacred ceremonial site',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        headers: { cookie: sessionCookies },
        payload: placeData,
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(body.data.name).toBe('Sacred Mountain');
      expect(body.data.latitude).toBe(37.7749);
      expect(body.data.culturalSignificance).toBe('Sacred ceremonial site');
    });

    test('should validate required fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        headers: { cookie: sessionCookies },
        payload: {
          description: 'A place without a name',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBeDefined();
    });

    test('should validate coordinates', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        headers: { cookie: sessionCookies },
        payload: {
          name: 'Invalid Place',
          latitude: 91, // Invalid latitude
          longitude: -122.4194,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.message).toContain('coordinate');
    });

    test('should require authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        payload: {
          name: 'Unauthorized Place',
          latitude: 37.7749,
          longitude: -122.4194,
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/places/:id', () => {
    test('should retrieve a place by ID', async () => {
      // First create a place
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        headers: { cookie: sessionCookies },
        payload: {
          name: 'Test Place',
          latitude: 37.7749,
          longitude: -122.4194,
        },
      });

      const createdPlace = JSON.parse(createResponse.body).data;

      // Now retrieve it
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/${createdPlace.id}`,
        headers: { cookie: sessionCookies },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe(createdPlace.id);
      expect(body.data.name).toBe('Test Place');
    });

    test('should return 404 for non-existent place', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/99999',
        headers: { cookie: sessionCookies },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/places', () => {
    test('should list places with pagination', async () => {
      // Create a few places first
      await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/v1/places',
          headers: { cookie: sessionCookies },
          payload: { name: 'Place 1', latitude: 37.7749, longitude: -122.4194 },
        }),
        app.inject({
          method: 'POST',
          url: '/api/v1/places',
          headers: { cookie: sessionCookies },
          payload: { name: 'Place 2', latitude: 37.7849, longitude: -122.4294 },
        }),
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places?page=1&limit=10',
        headers: { cookie: sessionCookies },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeInstanceOf(Array);
      expect(body.meta.total).toBeGreaterThanOrEqual(2);
      expect(body.meta.page).toBe(1);
    });
  });

  describe('PUT /api/v1/places/:id', () => {
    test('should update a place', async () => {
      // Create a place first
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        headers: { cookie: sessionCookies },
        payload: {
          name: 'Original Name',
          latitude: 37.7749,
          longitude: -122.4194,
        },
      });

      const place = JSON.parse(createResponse.body).data;

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/places/${place.id}`,
        headers: { cookie: sessionCookies },
        payload: {
          name: 'Updated Name',
          description: 'Updated description',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.name).toBe('Updated Name');
      expect(body.data.description).toBe('Updated description');
    });

    test('should return 404 for non-existent place', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/places/99999',
        headers: { cookie: sessionCookies },
        payload: {
          name: 'Updated Name',
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/v1/places/:id', () => {
    test('should delete a place for admin user', async () => {
      // Create a place first
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        headers: { cookie: sessionCookies },
        payload: {
          name: 'To Delete',
          latitude: 37.7749,
          longitude: -122.4194,
        },
      });

      const place = JSON.parse(createResponse.body).data;

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/places/${place.id}`,
        headers: { cookie: sessionCookies },
      });

      expect(response.statusCode).toBe(204);
    });
  });

  describe('GET /api/v1/places/near', () => {
    test('should find places within radius', async () => {
      // Create some places first
      await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/v1/places',
          headers: { cookie: sessionCookies },
          payload: { name: 'Close Place', latitude: 37.7749, longitude: -122.4194 },
        }),
        app.inject({
          method: 'POST',
          url: '/api/v1/places',
          headers: { cookie: sessionCookies },
          payload: { name: 'Medium Place', latitude: 37.7849, longitude: -122.4194 },
        }),
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/near?latitude=37.7749&longitude=-122.4194&radius=5',
        headers: { cookie: sessionCookies },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeInstanceOf(Array);
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });

    test('should validate search coordinates', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/near?latitude=91&longitude=-122.4194&radius=5', // Invalid lat
        headers: { cookie: sessionCookies },
      });

      expect(response.statusCode).toBe(400);
    });

    test('should require search parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/near', // Missing parameters
        headers: { cookie: sessionCookies },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/places/bounds', () => {
    test('should find places within bounding box', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        headers: { cookie: sessionCookies },
        payload: { name: 'Inside Place', latitude: 37.7749, longitude: -122.4194 },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/bounds?north=37.8&south=37.7&east=-122.4&west=-122.5',
        headers: { cookie: sessionCookies },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeInstanceOf(Array);
    });

    test('should validate bounding box parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/bounds?north=37.7&south=37.8&east=-122.4&west=-122.5', // North < South
        headers: { cookie: sessionCookies },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/places/stats', () => {
    test('should return place statistics', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/stats',
        headers: { cookie: sessionCookies },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(typeof body.data.total).toBe('number');
      expect(typeof body.data.restricted).toBe('number');
      expect(typeof body.data.public).toBe('number');
      expect(typeof body.data.withStories).toBe('number');
    });
  });
});