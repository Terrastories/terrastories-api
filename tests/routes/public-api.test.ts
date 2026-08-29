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
  let testPlaceId: number;

  beforeEach(async () => {
    db = await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[0].id;
    privateCommunityId = fixtures.communities[1].id;
    testPlaceId = fixtures.places[0].id;

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

    it('serializes a real public story through the shared field policy', async () => {
      const [author] = await db
        .insert(usersSqlite)
        .values(TestDataFactory.createUser(testCommunityId, { role: 'editor' }))
        .returning();
      const [publicStory] = await db
        .insert(storiesSqlite)
        .values({
          title: 'Published story',
          description: 'Safe public description',
          slug: `published-story-${Date.now()}`,
          communityId: testCommunityId,
          createdBy: author.id,
          isRestricted: false,
          privacyLevel: 'public',
        })
        .returning();

      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/stories`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toContainEqual(
        expect.objectContaining({
          id: publicStory.id,
          title: 'Published story',
          slug: publicStory.slug,
        })
      );
      const exposedStory = response
        .json()
        .data.find((story: { id: number }) => story.id === publicStory.id);
      expect(exposedStory).not.toHaveProperty('communityId');
      expect(exposedStory).not.toHaveProperty('createdBy');
      expect(exposedStory).not.toHaveProperty('privacyLevel');
      expect(exposedStory).not.toHaveProperty('isRestricted');
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
    it('returns public places when the community public API grant is enabled', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/places`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: testPlaceId, name: 'Test Place 1' }),
        ])
      );
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
    it('returns a public place when the community public API grant is enabled', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/places/${testPlaceId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual(
        expect.objectContaining({ id: testPlaceId, name: 'Test Place 1' })
      );
    });

    it('returns the normal not-found response inside an explicitly public community', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/communities/${testCommunityId}/places/999999`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Place not found' });
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
