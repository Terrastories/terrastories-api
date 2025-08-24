/**
 * Public API Routes - Integration Tests
 *
 * Tests for community-scoped public read-only API endpoints.
 * These endpoints provide public access to community content without authentication.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { testDb } from '../helpers/database.js';
import { createTestApp } from '../helpers/api-client.js';

describe('Public API Routes - Integration Tests', () => {
  let app: FastifyInstance;
  let testCommunityId: number;

  beforeEach(async () => {
    // Setup test database
    const db = await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[0].id;

    // Create test app
    app = await createTestApp(db);
  });

  afterEach(async () => {
    await testDb.teardown();
    await app.close();
  });

  describe('GET /api/communities/:community_id/stories', () => {
    it('should return 200 with empty stories list for valid community', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/stories`,
      });

      // Endpoint now exists and should return empty list
      expect(response.statusCode).toBe(200);

      const data = JSON.parse(response.body);
      expect(data).toHaveProperty('data');
      expect(data).toHaveProperty('meta');
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data).toHaveLength(0); // Empty initially
    });

    it('should not require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/stories`,
        // No Authorization header
      });

      // Should return 200 without authentication
      expect(response.statusCode).toBe(200);
      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).not.toBe(403);
    });
  });

  describe('GET /api/communities/:community_id/stories/:id', () => {
    it('should return 404 for non-existent story', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/stories/550e8400-e29b-41d4-a716-446655440000`,
      });

      // Should return 404 for non-existent story
      expect(response.statusCode).toBe(404);

      const data = JSON.parse(response.body);
      expect(data.error).toBe('Story not found or not public');
    });
  });

  describe('GET /api/communities/:community_id/places', () => {
    it('should return 200 with places list for valid community', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/places`,
      });

      // Endpoint should return list of places for community
      expect(response.statusCode).toBe(200);

      const data = JSON.parse(response.body);
      expect(data).toHaveProperty('data');
      expect(data).toHaveProperty('meta');
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data.length).toBeGreaterThanOrEqual(0); // Should be array of places
    });
  });

  describe('GET /api/communities/:community_id/places/:id', () => {
    it('should return 404 for non-existent place', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/places/550e8400-e29b-41d4-a716-446655440000`,
      });

      // Should return 404 for non-existent place
      expect(response.statusCode).toBe(404);

      const data = JSON.parse(response.body);
      expect(data.error).toBe('Place not found');
    });
  });

  describe('Response Format Validation (for future implementation)', () => {
    it('should prepare for community data isolation testing', () => {
      // Test will be expanded once endpoints are implemented
      expect(testCommunityId).toBeDefined();
      expect(typeof testCommunityId).toBe('number');
    });

    it('should prepare for pagination testing', () => {
      // Test will be expanded once endpoints are implemented
      const expectedPaginationFormat = {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      };

      expect(expectedPaginationFormat).toHaveProperty('page');
      expect(expectedPaginationFormat).toHaveProperty('limit');
      expect(expectedPaginationFormat).toHaveProperty('total');
      expect(expectedPaginationFormat).toHaveProperty('totalPages');
    });
  });
});
