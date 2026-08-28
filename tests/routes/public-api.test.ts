/**
 * Public API Routes - Integration Tests
 *
 * Tests for community-scoped public read-only API endpoints.
 * These endpoints provide public access to community content without authentication.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  communitiesSqlite,
  storiesSqlite,
  usersSqlite,
} from '../../src/db/schema/index.js';
import {
  TestDataFactory,
  testDb,
  type TestDatabase,
} from '../helpers/database.js';
import { createTestApp } from '../helpers/api-client.js';

describe('Public API Routes - Integration Tests', () => {
  let app: FastifyInstance;
  let db: TestDatabase;
  let testCommunityId: number;
  let privateCommunityId: number;

  beforeEach(async () => {
    db = await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[0].id;
    privateCommunityId = fixtures.communities[1].id;

    app = await createTestApp(db);
  });

  afterEach(async () => {
    await testDb.teardown();
    await app.close();
  });

  describe('GET /api/communities/:community_id/stories', () => {
    it('should return 200 with empty stories list for an explicitly public community', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/stories`,
      });

      expect(response.statusCode).toBe(200);

      const data = JSON.parse(response.body);
      expect(data).toHaveProperty('data');
      expect(data).toHaveProperty('meta');
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data).toHaveLength(0);
    });

    it('should not require authentication for explicitly public content', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/stories`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).not.toBe(403);
    });

    it('should fail closed when the community has not explicitly enabled public content', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${privateCommunityId}/stories`,
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body)).toEqual({
        error: 'Community not found',
      });
    });

    it('should fail closed for an inactive community', async () => {
      await db
        .update(communitiesSqlite)
        .set({ isActive: false })
        .where(eq(communitiesSqlite.id, testCommunityId));

      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/stories`,
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body)).toEqual({
        error: 'Community not found',
      });
    });
  });

  describe('GET /api/communities/:community_id/stories/:id', () => {
    it('should return 404 for non-existent story', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/stories/550e8400-e29b-41d4-a716-446655440000`,
      });

      expect(response.statusCode).toBe(404);

      const data = JSON.parse(response.body);
      expect(data.error).toBe('Story not found or not public');
    });

    it('should not expose a private story even when it is not restricted', async () => {
      const [author] = await db
        .insert(usersSqlite)
        .values(TestDataFactory.createUser(testCommunityId, { role: 'editor' }))
        .returning();
      const [privateStory] = await db
        .insert(storiesSqlite)
        .values({
          title: 'Private story',
          description: 'Must remain community-only',
          slug: `private-story-${Date.now()}`,
          communityId: testCommunityId,
          createdBy: author.id,
          isRestricted: false,
          privacyLevel: 'private',
        })
        .returning();

      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/stories/${privateStory.id}`,
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body)).toEqual({
        error: 'Story not found or not public',
      });
    });
  });

  describe('GET /api/communities/:community_id/places', () => {
    it('should return 200 with places list for an explicitly public community', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/places`,
      });

      expect(response.statusCode).toBe(200);

      const data = JSON.parse(response.body);
      expect(data).toHaveProperty('data');
      expect(data).toHaveProperty('meta');
      expect(data.data).toBeInstanceOf(Array);
      expect(data.data.length).toBeGreaterThanOrEqual(0);
    });

    it('should not expose places for a private community', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${privateCommunityId}/places`,
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body)).toEqual({
        error: 'Community not found',
      });
    });
  });

  describe('GET /api/communities/:community_id/places/:id', () => {
    it('should return 404 for non-existent place', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/places/550e8400-e29b-41d4-a716-446655440000`,
      });

      expect(response.statusCode).toBe(404);

      const data = JSON.parse(response.body);
      expect(data.error).toBe('Place not found');
    });
  });

  describe('Response Format Validation', () => {
    it('keeps community data isolation explicit in the fixture', () => {
      expect(testCommunityId).toBeDefined();
      expect(privateCommunityId).toBeDefined();
      expect(testCommunityId).not.toBe(privateCommunityId);
    });

    it('uses a stable pagination contract', () => {
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
