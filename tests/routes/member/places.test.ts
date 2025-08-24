/**
 * Member Places API Tests
 *
 * Comprehensive test suite for authenticated member place management endpoints.
 * Tests RBAC, ownership, community isolation, cultural protocols, and PostGIS functionality.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { build } from 'fastify';
import {
  testDbSetup,
  testDbTeardown,
  clearTestDb,
} from '../../helpers/database.js';
import {
  createTestCommunity,
  createTestUser,
} from '../../helpers/factories.js';
import type { FastifyInstance } from 'fastify';

describe('Member Places API', () => {
  let app: FastifyInstance;
  let communityId: number;
  let viewerUserId: number;
  let editorUserId: number;
  let adminUserId: number;
  let elderUserId: number;

  beforeEach(async () => {
    await testDbSetup();
    await clearTestDb();

    app = build({ logger: false });
    await app.ready();

    const community = await createTestCommunity();
    communityId = community.id;

    viewerUserId = (
      await createTestUser({
        communityId,
        role: 'viewer',
        email: 'viewer@test.com',
      })
    ).id;

    editorUserId = (
      await createTestUser({
        communityId,
        role: 'editor',
        email: 'editor@test.com',
      })
    ).id;

    adminUserId = (
      await createTestUser({
        communityId,
        role: 'admin',
        email: 'admin@test.com',
      })
    ).id;

    elderUserId = (
      await createTestUser({
        communityId,
        role: 'elder',
        email: 'elder@test.com',
      })
    ).id;
  });

  afterEach(async () => {
    await app.close();
    await testDbTeardown();
  });

  describe('Authentication & Authorization', () => {
    it('should reject unauthenticated requests', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places',
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toMatchObject({
        error: expect.objectContaining({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        }),
      });
    });

    it('should accept authenticated requests with valid session', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/member/places', () => {
    it('should list community places with pagination', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places?page=1&limit=10',
        headers: {
          cookie: createSessionCookie(editorUserId),
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

    it('should filter places by community scope', async () => {
      createTestPlace({ communityId, name: 'Community 1 Place' });
      const otherCommunity = await createTestCommunity({ name: 'Community 2' });
      createTestPlace({
        communityId: otherCommunity.id,
        name: 'Community 2 Place',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(
        body.data.every((place) => place.communityId === communityId)
      ).toBe(true);
    });

    it('should support geographic filters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places?lat=-15.7801&lng=-47.9292&radius=1000',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toEqual(expect.any(Array));
    });
  });

  describe('POST /api/v1/member/places', () => {
    const validPlaceData = {
      name: 'Test Place',
      description: 'A test place',
      lat: -15.7801,
      lng: -47.9292,
      culturalSignificance: 'historical',
    };

    it('should create place as editor+', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/places',
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: validPlaceData,
      });

      expect(response.statusCode).toBe(201);

      const body = JSON.parse(response.body);
      expect(body.data).toMatchObject({
        name: 'Test Place',
        description: 'A test place',
        communityId: communityId,
      });
      expect(body.data.id).toBeDefined();
    });

    it('should reject place creation for viewers', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/places',
        headers: {
          cookie: createSessionCookie(viewerUserId),
          'content-type': 'application/json',
        },
        payload: validPlaceData,
      });

      expect(response.statusCode).toBe(403);
    });

    it('should validate geographic coordinates', async () => {
      const invalidData = {
        ...validPlaceData,
        lat: 200, // Invalid latitude
        lng: -47.9292,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/places',
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: invalidData,
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
        }),
      });
    });

    it('should auto-scope to user community', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/places',
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: {
          ...validPlaceData,
          communityId: 9999, // Should be ignored
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.communityId).toBe(communityId);
    });
  });

  describe('GET /api/v1/member/places/:id', () => {
    let placeId: number;

    beforeEach(async () => {
      const place = createTestPlace({
        communityId,
        name: 'Test Place',
        createdBy: editorUserId,
      });
      placeId = place.id;
    });

    it('should get place by ID within community', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/member/places/${placeId}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.data).toMatchObject({
        id: placeId,
        name: 'Test Place',
        communityId: communityId,
      });
    });

    it('should return 404 for non-existent place', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places/99999',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for place from different community', async () => {
      const otherCommunity = await createTestCommunity({
        name: 'Other Community',
      });
      const otherPlace = createTestPlace({ communityId: otherCommunity.id });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/member/places/${otherPlace.id}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PUT /api/v1/member/places/:id', () => {
    let ownPlaceId: number;
    let otherUserPlaceId: number;

    beforeEach(async () => {
      const ownPlace = createTestPlace({
        communityId,
        name: 'Own Place',
        createdBy: editorUserId,
      });
      ownPlaceId = ownPlace.id;

      const otherPlace = createTestPlace({
        communityId,
        name: 'Other Place',
        createdBy: adminUserId,
      });
      otherUserPlaceId = otherPlace.id;
    });

    it('should allow editors to update their own places', async () => {
      const updateData = {
        name: 'Updated Own Place',
        description: 'Updated description',
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/member/places/${ownPlaceId}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: updateData,
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.data).toMatchObject({
        id: ownPlaceId,
        name: 'Updated Own Place',
        description: 'Updated description',
      });
    });

    it('should reject editors updating others places', async () => {
      const updateData = { name: 'Trying to update' };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/member/places/${otherUserPlaceId}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: updateData,
      });

      expect(response.statusCode).toBe(403);
    });

    it('should allow admins to update community places', async () => {
      const updateData = { name: 'Admin Updated' };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/member/places/${otherUserPlaceId}`,
        headers: {
          cookie: createSessionCookie(adminUserId),
          'content-type': 'application/json',
        },
        payload: updateData,
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.data.name).toBe('Admin Updated');
    });

    it('should validate geographic updates', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/member/places/${ownPlaceId}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: { lat: 200 }, // Invalid latitude
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/v1/member/places/:id', () => {
    let ownPlaceId: number;
    let otherUserPlaceId: number;

    beforeEach(async () => {
      const ownPlace = createTestPlace({
        communityId,
        name: 'Own Place',
        createdBy: editorUserId,
      });
      ownPlaceId = ownPlace.id;

      const otherPlace = createTestPlace({
        communityId,
        name: 'Other Place',
        createdBy: adminUserId,
      });
      otherUserPlaceId = otherPlace.id;
    });

    it('should allow admins to delete community places', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/member/places/${otherUserPlaceId}`,
        headers: {
          cookie: createSessionCookie(adminUserId),
        },
      });

      expect(response.statusCode).toBe(204);
    });

    it('should allow elders to delete places with cultural authority', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/member/places/${otherUserPlaceId}`,
        headers: {
          cookie: createSessionCookie(elderUserId),
        },
      });

      expect(response.statusCode).toBe(204);
    });

    it('should reject editors deleting others places', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/member/places/${otherUserPlaceId}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should reject viewers attempting any deletions', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/member/places/${ownPlaceId}`,
        headers: {
          cookie: createSessionCookie(viewerUserId),
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('Cultural Protocol Compliance', () => {
    let culturallySignificantPlaceId: number;
    let restrictedPlaceId: number;

    beforeEach(async () => {
      const culturalPlace = createTestPlace({
        communityId,
        name: 'Sacred Site',
        culturalSignificance: 'sacred',
        createdBy: elderUserId,
      });
      culturallySignificantPlaceId = culturalPlace.id;

      const restrictedPlace = createTestPlace({
        communityId,
        name: 'Restricted Place',
        isRestricted: true,
        createdBy: adminUserId,
      });
      restrictedPlaceId = restrictedPlace.id;
    });

    it('should filter culturally significant places for non-elders', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Should see the place but without sensitive details
      const culturalPlace = body.data.find(
        (place) => place.id === culturallySignificantPlaceId
      );
      expect(culturalPlace).toBeDefined();
      expect(culturalPlace.culturalSignificance).toBe('general'); // Filtered
    });

    it('should show full cultural details to elders', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places',
        headers: {
          cookie: createSessionCookie(elderUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      const culturalPlace = body.data.find(
        (place) => place.id === culturallySignificantPlaceId
      );
      expect(culturalPlace).toBeDefined();
      expect(culturalPlace.culturalSignificance).toBe('sacred'); // Full details
    });

    it('should allow elders to override cultural restrictions', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/member/places/${restrictedPlaceId}`,
        headers: {
          cookie: createSessionCookie(elderUserId),
          'content-type': 'application/json',
        },
        payload: { name: 'Elder Updated Restricted Place' },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('PostGIS Geographic Features', () => {
    it('should validate coordinate ranges', async () => {
      const invalidCoordinates = [
        { lat: 91, lng: 0 }, // Invalid latitude
        { lat: -91, lng: 0 }, // Invalid latitude
        { lat: 0, lng: 181 }, // Invalid longitude
        { lat: 0, lng: -181 }, // Invalid longitude
      ];

      for (const coords of invalidCoordinates) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/member/places',
          headers: {
            cookie: createSessionCookie(editorUserId),
            'content-type': 'application/json',
          },
          payload: {
            name: 'Invalid Place',
            ...coords,
          },
        });

        expect(response.statusCode).toBe(400);
      }
    });

    it('should store and retrieve geographic coordinates', async () => {
      const placeData = {
        name: 'Geo Place',
        lat: -15.7801,
        lng: -47.9292,
      };

      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/member/places',
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: placeData,
      });

      expect(createResponse.statusCode).toBe(201);
      const created = JSON.parse(createResponse.body);

      const getResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/member/places/${created.data.id}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(getResponse.statusCode).toBe(200);
      const retrieved = JSON.parse(getResponse.body);

      expect(retrieved.data.lat).toBeCloseTo(-15.7801, 4);
      expect(retrieved.data.lng).toBeCloseTo(-47.9292, 4);
    });
  });

  describe('Response Format Validation', () => {
    it('should not leak internal fields in responses', async () => {
      const place = createTestPlace({ communityId, createdBy: editorUserId });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/member/places/${place.id}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Should not include internal fields
      expect(body.data).not.toHaveProperty('internalNotes');
      expect(body.data).not.toHaveProperty('auditLog');
      expect(body.data).not.toHaveProperty('gisData');
    });

    it('should return consistent envelope format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/places',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body).toMatchObject({
        data: expect.any(Array),
        meta: expect.objectContaining({
          page: expect.any(Number),
          limit: expect.any(Number),
          total: expect.any(Number),
          totalPages: expect.any(Number),
          hasNextPage: expect.any(Boolean),
          hasPrevPage: expect.any(Boolean),
        }),
      });
    });
  });
});

// Helper functions
function createSessionCookie(userId: number): string {
  return `connect.sid=test-session-${userId}`;
}

function createTestPlace(data: {
  communityId: number;
  name?: string;
  createdBy?: number;
  culturalSignificance?: string;
  isRestricted?: boolean;
}) {
  return Promise.resolve({
    id: Math.floor(Math.random() * 10000),
    name: data.name || 'Test Place',
    communityId: data.communityId,
    createdBy: data.createdBy || 1,
    lat: -15.7801,
    lng: -47.9292,
    ...data,
  });
}
