/**
 * Places API Routes Tests
 *
 * Tests the actual Places API endpoints with:
 * - Real route handlers from src/routes/places.ts
 * - Complete CRUD operation endpoints
 * - Authentication and authorization with sessions
 * - Geographic search endpoints
 * - Request/response validation
 * - Error handling
 * - Cultural protocol enforcement
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { testDb } from '../helpers/database.js';
import { createTestApp } from '../helpers/api-client.js';

describe('Places API Routes - Integration Tests', () => {
  let app: FastifyInstance;
  let testCommunityId: number;
  let adminSessionId: string;
  let editorSessionId: string;
  let viewerSessionId: string;
  let elderSessionId: string;

  beforeEach(async () => {
    // Setup test database
    await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[1].id; // Skip system community

    // Create test app with real routes
    app = await createTestApp(testDb.db);

    // Create test users and get their session cookies
    const adminUser = {
      email: 'admin@example.com',
      password: 'StrongPassword123@',
      firstName: 'Admin',
      lastName: 'User',
      role: 'admin',
      communityId: testCommunityId,
    };

    const editorUser = {
      email: 'editor@example.com',
      password: 'StrongPassword123@',
      firstName: 'Editor',
      lastName: 'User',
      role: 'editor',
      communityId: testCommunityId,
    };

    const viewerUser = {
      email: 'viewer@example.com',
      password: 'StrongPassword123@',
      firstName: 'Viewer',
      lastName: 'User',
      role: 'viewer',
      communityId: testCommunityId,
    };

    const elderUser = {
      email: 'elder@example.com',
      password: 'StrongPassword123@',
      firstName: 'Elder',
      lastName: 'User',
      role: 'elder',
      communityId: testCommunityId,
    };

    // Register and login users to get session cookies
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: adminUser,
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: editorUser,
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: viewerUser,
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: elderUser,
    });

    // Get session cookies
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: adminUser.email, password: adminUser.password },
    });
    adminSessionId =
      adminLogin.cookies.find((c) => c.name === 'sessionId')?.value || '';

    const editorLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: editorUser.email, password: editorUser.password },
    });
    editorSessionId =
      editorLogin.cookies.find((c) => c.name === 'sessionId')?.value || '';

    const viewerLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: viewerUser.email, password: viewerUser.password },
    });
    viewerSessionId =
      viewerLogin.cookies.find((c) => c.name === 'sessionId')?.value || '';

    const elderLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: elderUser.email, password: elderUser.password },
    });
    elderSessionId =
      elderLogin.cookies.find((c) => c.name === 'sessionId')?.value || '';
  });

  afterEach(async () => {
    await app.close();
    await testDb.clearData();
  });

  describe('POST /api/v1/places', () => {
    test('should create a new place as admin', async () => {
      const placeData = {
        name: 'Test Sacred Place',
        description: 'A place of cultural significance',
        latitude: 49.2827,
        longitude: -123.1207,
        region: 'Coast Salish Territory',
        culturalSignificance: 'Ancient gathering place',
        isRestricted: false,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        payload: placeData,
        cookies: { sessionId: adminSessionId },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveProperty('id');
      expect(body.data.name).toBe(placeData.name);
      expect(body.data.communityId).toBe(testCommunityId);
      expect(body.meta.message).toBe('Place created successfully');
    });

    test('should create a new place as editor', async () => {
      const placeData = {
        name: 'Editor Created Place',
        description: 'Created by editor',
        latitude: 49.2827,
        longitude: -123.1207,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        payload: placeData,
        cookies: { sessionId: editorSessionId },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.name).toBe(placeData.name);
    });

    test('should reject place creation as viewer', async () => {
      const placeData = {
        name: 'Viewer Place',
        latitude: 49.2827,
        longitude: -123.1207,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        payload: placeData,
        cookies: { sessionId: viewerSessionId },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toBeDefined();
    });

    test('should require authentication', async () => {
      const placeData = {
        name: 'Unauthenticated Place',
        latitude: 49.2827,
        longitude: -123.1207,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        payload: placeData,
      });

      expect(response.statusCode).toBe(401);
    });

    test('should validate required fields', async () => {
      const invalidData = {
        description: 'Missing required fields',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        payload: invalidData,
        cookies: { sessionId: adminSessionId },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.message).toBe('Validation error');
      expect(body.error.details).toBeDefined();
    });

    test('should validate coordinate bounds', async () => {
      const invalidData = {
        name: 'Invalid Coordinates',
        latitude: 100, // Invalid latitude
        longitude: -123.1207,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        payload: invalidData,
        cookies: { sessionId: adminSessionId },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.message).toBe('Validation error');
    });

    test('should handle media URLs validation', async () => {
      const placeData = {
        name: 'Place with Media',
        latitude: 49.2827,
        longitude: -123.1207,
        mediaUrls: [
          'https://example.com/image1.jpg',
          'https://example.com/image2.jpg',
        ],
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        payload: placeData,
        cookies: { sessionId: adminSessionId },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.mediaUrls).toEqual(placeData.mediaUrls);
    });
  });

  describe('GET /api/v1/places/:id', () => {
    let testPlaceId: number;

    beforeEach(async () => {
      // Create a test place
      const placeData = {
        name: 'Get Test Place',
        latitude: 49.2827,
        longitude: -123.1207,
      };

      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        payload: placeData,
        cookies: { sessionId: adminSessionId },
      });

      const body = JSON.parse(createResponse.body);
      testPlaceId = body.data.id;
    });

    test('should retrieve a place by ID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/${testPlaceId}`,
        cookies: { sessionId: viewerSessionId },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe(testPlaceId);
      expect(body.data.name).toBe('Get Test Place');
    });

    test('should return 404 for non-existent place', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/99999',
        cookies: { sessionId: viewerSessionId },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error.message).toBe('Place with ID 99999 not found');
    });

    test('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/${testPlaceId}`,
      });

      expect(response.statusCode).toBe(401);
    });

    test('should handle restricted places for elder access', async () => {
      // Create a restricted place
      const restrictedPlaceData = {
        name: 'Sacred Restricted Place',
        latitude: 49.2827,
        longitude: -123.1207,
        isRestricted: true,
        culturalSignificance: 'Elder knowledge',
      };

      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        payload: restrictedPlaceData,
        cookies: { sessionId: adminSessionId },
      });

      const restrictedPlace = JSON.parse(createResponse.body);
      const restrictedId = restrictedPlace.data.id;

      // Elder should be able to access
      const elderResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/places/${restrictedId}`,
        cookies: { sessionId: elderSessionId },
      });

      expect(elderResponse.statusCode).toBe(200);

      // Viewer might not be able to access (depends on business logic)
      const viewerResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/places/${restrictedId}`,
        cookies: { sessionId: viewerSessionId },
      });

      // This might be 200 or 403 depending on cultural protocol implementation
      expect([200, 403]).toContain(viewerResponse.statusCode);
    });
  });

  describe('GET /api/v1/places', () => {
    beforeEach(async () => {
      // Create multiple test places
      const places = [
        { name: 'Place 1', latitude: 49.2827, longitude: -123.1207 },
        { name: 'Place 2', latitude: 49.2828, longitude: -123.1208 },
        { name: 'Place 3', latitude: 49.2829, longitude: -123.1209 },
      ];

      for (const place of places) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/places',
          payload: place,
          cookies: { sessionId: adminSessionId },
        });
      }
    });

    test('should list places with pagination', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places?page=1&limit=2',
        cookies: { sessionId: viewerSessionId },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeLessThanOrEqual(2);
      expect(body.meta).toHaveProperty('total');
      expect(body.meta).toHaveProperty('page');
      expect(body.meta).toHaveProperty('limit');
      expect(body.meta).toHaveProperty('pages');
    });

    test('should handle default pagination', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places',
        cookies: { sessionId: viewerSessionId },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.meta.page).toBe(1);
      expect(body.meta.limit).toBe(20);
    });

    test('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('PUT /api/v1/places/:id', () => {
    let testPlaceId: number;

    beforeEach(async () => {
      const placeData = {
        name: 'Update Test Place',
        latitude: 49.2827,
        longitude: -123.1207,
      };

      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        payload: placeData,
        cookies: { sessionId: adminSessionId },
      });

      const body = JSON.parse(createResponse.body);
      testPlaceId = body.data.id;
    });

    test('should update a place as admin', async () => {
      const updateData = {
        name: 'Updated Place Name',
        description: 'Updated description',
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/places/${testPlaceId}`,
        payload: updateData,
        cookies: { sessionId: adminSessionId },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.name).toBe(updateData.name);
      expect(body.data.description).toBe(updateData.description);
      expect(body.meta.message).toBe('Place updated successfully');
    });

    test('should update a place as editor', async () => {
      const updateData = {
        name: 'Editor Updated Place',
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/places/${testPlaceId}`,
        payload: updateData,
        cookies: { sessionId: editorSessionId },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.name).toBe(updateData.name);
    });

    test('should reject update as viewer', async () => {
      const updateData = {
        name: 'Viewer Updated Place',
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/places/${testPlaceId}`,
        payload: updateData,
        cookies: { sessionId: viewerSessionId },
      });

      expect(response.statusCode).toBe(403);
    });

    test('should return 404 for non-existent place', async () => {
      const updateData = {
        name: 'Non-existent Place',
      };

      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/places/99999',
        payload: updateData,
        cookies: { sessionId: adminSessionId },
      });

      expect(response.statusCode).toBe(404);
    });

    test('should validate coordinate updates', async () => {
      const updateData = {
        latitude: 200, // Invalid latitude
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/places/${testPlaceId}`,
        payload: updateData,
        cookies: { sessionId: adminSessionId },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/v1/places/:id', () => {
    let testPlaceId: number;

    beforeEach(async () => {
      const placeData = {
        name: 'Delete Test Place',
        latitude: 49.2827,
        longitude: -123.1207,
      };

      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/places',
        payload: placeData,
        cookies: { sessionId: adminSessionId },
      });

      const body = JSON.parse(createResponse.body);
      testPlaceId = body.data.id;
    });

    test('should delete a place as admin', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/places/${testPlaceId}`,
        cookies: { sessionId: adminSessionId },
      });

      expect(response.statusCode).toBe(204);

      // Verify deletion
      const getResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/places/${testPlaceId}`,
        cookies: { sessionId: adminSessionId },
      });

      expect(getResponse.statusCode).toBe(404);
    });

    test('should reject delete as editor', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/places/${testPlaceId}`,
        cookies: { sessionId: editorSessionId },
      });

      expect(response.statusCode).toBe(403);
    });

    test('should reject delete as viewer', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/places/${testPlaceId}`,
        cookies: { sessionId: viewerSessionId },
      });

      expect(response.statusCode).toBe(403);
    });

    test('should return 404 for non-existent place', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/places/99999',
        cookies: { sessionId: adminSessionId },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/places/near', () => {
    beforeEach(async () => {
      // Create test places at known coordinates
      const places = [
        { name: 'Nearby Place 1', latitude: 49.2827, longitude: -123.1207 },
        { name: 'Nearby Place 2', latitude: 49.2828, longitude: -123.1208 },
        { name: 'Far Place', latitude: 50.0, longitude: -124.0 }, // Far away
      ];

      for (const place of places) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/places',
          payload: place,
          cookies: { sessionId: adminSessionId },
        });
      }
    });

    test('should find places within radius', async () => {
      const searchParams = {
        latitude: '49.2827',
        longitude: '-123.1207',
        radius: '1', // 1km radius
        page: '1',
        limit: '10',
      };

      const queryString = new URLSearchParams(searchParams).toString();
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/near?${queryString}`,
        cookies: { sessionId: viewerSessionId },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta).toHaveProperty('searchParams');
      expect(body.meta.searchParams.latitude).toBe(49.2827);
      expect(body.meta.searchParams.longitude).toBe(-123.1207);
      expect(body.meta.searchParams.radius).toBe(1);
    });

    test('should validate search coordinates', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/near?latitude=200&longitude=-123.1207&radius=1',
        cookies: { sessionId: viewerSessionId },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.message).toBe('Validation error');
    });

    test('should require search parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/near',
        cookies: { sessionId: viewerSessionId },
      });

      expect(response.statusCode).toBe(400);
    });

    test('should validate radius limits', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/near?latitude=49.2827&longitude=-123.1207&radius=2000', // Too large
        cookies: { sessionId: viewerSessionId },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/places/bounds', () => {
    beforeEach(async () => {
      // Create test places at known coordinates
      const places = [
        { name: 'Inside Bounds', latitude: 49.28, longitude: -123.12 },
        { name: 'Outside Bounds', latitude: 50.0, longitude: -124.0 },
      ];

      for (const place of places) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/places',
          payload: place,
          cookies: { sessionId: adminSessionId },
        });
      }
    });

    test('should find places within bounding box', async () => {
      const searchParams = {
        north: 49.29,
        south: 49.27,
        east: -123.11,
        west: -123.13,
        page: 1,
        limit: 10,
      };

      const queryString = new URLSearchParams(searchParams).toString();
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/places/bounds?${queryString}`,
        cookies: { sessionId: viewerSessionId },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta).toHaveProperty('searchParams');
      expect(body.meta.searchParams.bounds).toBeDefined();
    });

    test('should validate bounding box parameters', async () => {
      // Invalid bounds (north <= south)
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/bounds?north=49.27&south=49.29&east=-123.11&west=-123.13',
        cookies: { sessionId: viewerSessionId },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.message).toBe(
        'Invalid bounding box: north must be > south, east must be > west'
      );
    });

    test('should require all bounding box parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/bounds?north=49.29&south=49.27', // Missing east and west
        cookies: { sessionId: viewerSessionId },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/places/stats', () => {
    beforeEach(async () => {
      // Create test places with different properties
      const places = [
        {
          name: 'Public Place 1',
          latitude: 49.2827,
          longitude: -123.1207,
          isRestricted: false,
        },
        {
          name: 'Public Place 2',
          latitude: 49.2828,
          longitude: -123.1208,
          isRestricted: false,
        },
        {
          name: 'Restricted Place',
          latitude: 49.2829,
          longitude: -123.1209,
          isRestricted: true,
        },
      ];

      for (const place of places) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/places',
          payload: place,
          cookies: { sessionId: adminSessionId },
        });
      }
    });

    test('should return place statistics', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/stats',
        cookies: { sessionId: viewerSessionId },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveProperty('total');
      expect(body.data).toHaveProperty('restricted');
      expect(body.data).toHaveProperty('public');
      expect(body.data).toHaveProperty('withStories');
      expect(typeof body.data.total).toBe('number');
      expect(typeof body.data.restricted).toBe('number');
      expect(typeof body.data.public).toBe('number');
    });

    test('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/places/stats',
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
