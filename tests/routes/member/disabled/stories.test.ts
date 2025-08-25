/**
 * Member Stories API Tests
 *
 * Comprehensive test suite for authenticated member story management endpoints.
 * Tests RBAC, ownership, community isolation, cultural protocols, and API functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { testDb } from '../../../helpers/database.js';
import { createTestApp } from '../../../helpers/api-client.js';

describe('Member Stories API', () => {
  let app: FastifyInstance;
  let communityId: number;
  let viewerUserId: number;
  let editorUserId: number;
  let adminUserId: number;
  let elderUserId: number;
  let otherCommunityUserId: number;

  beforeEach(async () => {
    // Setup test database
    await testDb.setup();
    await testDb.clearData();

    // Create test app
    app = await createTestApp();

    // TODO: Create test users with different roles
    communityId = 1; // Placeholder
    viewerUserId = 1; // Placeholder
    editorUserId = 2; // Placeholder
    adminUserId = 3; // Placeholder
    elderUserId = 4; // Placeholder
    otherCommunityUserId = 5; // Placeholder
  });

  afterEach(async () => {
    await app.close();
    await testDb.teardown();
  });

  describe('Authentication & Authorization', () => {
    it('should reject unauthenticated requests', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories',
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
      // TODO: This will fail until we implement member routes
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should enforce community isolation - cannot access other community stories', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories',
        headers: {
          cookie: createSessionCookie(otherCommunityUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Should only see stories from their own community
      expect(body.data).toHaveLength(0);
    });
  });

  describe('GET /api/v1/member/stories', () => {
    it('should list community stories with pagination', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories?page=1&limit=10',
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

    it('should validate pagination parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories?page=0&limit=101',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
        }),
      });
    });

    it('should filter by community scope automatically', async () => {
      // Create stories in different communities
      createTestStory({ communityId, title: 'Community 1 Story' });
      const otherCommunity = await createTestCommunity({ name: 'Community 2' });
      createTestStory({
        communityId: otherCommunity.id,
        title: 'Community 2 Story',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Should only see stories from user's community
      expect(
        body.data.every((story) => story.communityId === communityId)
      ).toBe(true);
    });
  });

  describe('POST /api/v1/member/stories', () => {
    const validStoryData = {
      title: 'Test Story',
      description: 'A test story',
      language: 'en',
      placeIds: [],
      speakerIds: [],
    };

    it('should create story as editor+', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/stories',
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: validStoryData,
      });

      expect(response.statusCode).toBe(201);

      const body = JSON.parse(response.body);
      expect(body.data).toMatchObject({
        title: 'Test Story',
        description: 'A test story',
        communityId: communityId,
      });
      expect(body.data.id).toBeDefined();
    });

    it('should reject story creation for viewers', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/stories',
        headers: {
          cookie: createSessionCookie(viewerUserId),
          'content-type': 'application/json',
        },
        payload: validStoryData,
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        error: expect.objectContaining({
          code: 'INSUFFICIENT_PERMISSIONS',
        }),
      });
    });

    it('should validate required fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/stories',
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: { description: 'Missing title' },
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
        url: '/api/v1/member/stories',
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: {
          ...validStoryData,
          communityId: 9999, // Should be ignored, scoped to user's community
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.communityId).toBe(communityId);
    });
  });

  describe('GET /api/v1/member/stories/:id', () => {
    let storyId: number;

    beforeEach(async () => {
      const story = createTestStory({
        communityId,
        title: 'Test Story',
        authorId: editorUserId,
      });
      storyId = story.id;
    });

    it('should get story by ID within community', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/member/stories/${storyId}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.data).toMatchObject({
        id: storyId,
        title: 'Test Story',
        communityId: communityId,
      });
    });

    it('should return 404 for non-existent story', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories/99999',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body)).toMatchObject({
        error: expect.objectContaining({
          code: 'NOT_FOUND',
        }),
      });
    });

    it('should return 404 for story from different community', async () => {
      const otherCommunity = await createTestCommunity({
        name: 'Other Community',
      });
      const otherStory = createTestStory({ communityId: otherCommunity.id });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/member/stories/${otherStory.id}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PUT /api/v1/member/stories/:id', () => {
    let ownStoryId: number;
    let otherUserStoryId: number;

    beforeEach(async () => {
      const ownStory = createTestStory({
        communityId,
        title: 'Own Story',
        authorId: editorUserId,
      });
      ownStoryId = ownStory.id;

      const otherStory = createTestStory({
        communityId,
        title: 'Other Story',
        authorId: adminUserId,
      });
      otherUserStoryId = otherStory.id;
    });

    it('should allow editors to update their own stories', async () => {
      const updateData = {
        title: 'Updated Own Story',
        description: 'Updated description',
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/member/stories/${ownStoryId}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: updateData,
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.data).toMatchObject({
        id: ownStoryId,
        title: 'Updated Own Story',
        description: 'Updated description',
      });
    });

    it('should reject editors updating others stories', async () => {
      const updateData = { title: 'Trying to update' };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/member/stories/${otherUserStoryId}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: updateData,
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        error: expect.objectContaining({
          code: 'INSUFFICIENT_PERMISSIONS',
        }),
      });
    });

    it('should allow admins to update community stories', async () => {
      const updateData = { title: 'Admin Updated' };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/member/stories/${otherUserStoryId}`,
        headers: {
          cookie: createSessionCookie(adminUserId),
          'content-type': 'application/json',
        },
        payload: updateData,
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.data.title).toBe('Admin Updated');
    });

    it('should validate update data', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/member/stories/${ownStoryId}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: { title: '' }, // Invalid empty title
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/v1/member/stories/:id', () => {
    let ownStoryId: number;
    let otherUserStoryId: number;

    beforeEach(async () => {
      const ownStory = createTestStory({
        communityId,
        title: 'Own Story',
        authorId: editorUserId,
      });
      ownStoryId = ownStory.id;

      const otherStory = createTestStory({
        communityId,
        title: 'Other Story',
        authorId: adminUserId,
      });
      otherUserStoryId = otherStory.id;
    });

    it('should allow admins to delete community stories', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/member/stories/${otherUserStoryId}`,
        headers: {
          cookie: createSessionCookie(adminUserId),
        },
      });

      expect(response.statusCode).toBe(204);
    });

    it('should allow elders to delete stories with cultural authority', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/member/stories/${otherUserStoryId}`,
        headers: {
          cookie: createSessionCookie(elderUserId),
        },
      });

      expect(response.statusCode).toBe(204);
    });

    it('should reject editors deleting others stories', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/member/stories/${otherUserStoryId}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should reject viewers attempting any deletions', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/member/stories/${ownStoryId}`,
        headers: {
          cookie: createSessionCookie(viewerUserId),
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('Cultural Protocol Compliance', () => {
    let elderStoryId: number;
    let restrictedStoryId: number;

    beforeEach(async () => {
      const elderStory = createTestStory({
        communityId,
        title: 'Elder Story',
        authorId: elderUserId,
        restrictedTo: 'elder',
      });
      elderStoryId = elderStory.id;

      const restrictedStory = createTestStory({
        communityId,
        title: 'Restricted Story',
        isRestricted: true,
        authorId: adminUserId,
      });
      restrictedStoryId = restrictedStory.id;
    });

    it('should filter elder-only content for non-elders', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Should not see elder-restricted content
      expect(
        body.data.find((story) => story.id === elderStoryId)
      ).toBeUndefined();
    });

    it('should show elder content to elders', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories',
        headers: {
          cookie: createSessionCookie(elderUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Should see elder-restricted content
      expect(
        body.data.find((story) => story.id === elderStoryId)
      ).toBeDefined();
    });

    it('should allow elders to override cultural restrictions', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/member/stories/${restrictedStoryId}`,
        headers: {
          cookie: createSessionCookie(elderUserId),
          'content-type': 'application/json',
        },
        payload: { title: 'Elder Updated Restricted Story' },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('Response Format Validation', () => {
    it('should return consistent envelope format for list endpoint', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/stories',
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

    it('should not leak internal fields in responses', async () => {
      const story = createTestStory({ communityId, authorId: editorUserId });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/member/stories/${story.id}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Should not include internal fields
      expect(body.data).not.toHaveProperty('internalNotes');
      expect(body.data).not.toHaveProperty('auditLog');
      expect(body.data).not.toHaveProperty('syncMetadata');
    });
  });

  describe('Rate Limiting', () => {
    it('should apply rate limits to member endpoints', async () => {
      // Make multiple rapid requests
      const promises = Array(10)
        .fill(null)
        .map(() =>
          app.inject({
            method: 'GET',
            url: '/api/v1/member/stories',
            headers: {
              cookie: createSessionCookie(editorUserId),
            },
          })
        );

      const responses = await Promise.all(promises);

      // At least one should hit rate limit
      const rateLimited = responses.some((r) => r.statusCode === 429);
      expect(rateLimited).toBe(true);
    });
  });
});

// Helper functions (these will need to be implemented)
function createSessionCookie(userId: number): string {
  // TODO: Implement session cookie creation for testing
  return `connect.sid=test-session-${userId}`;
}

function createTestStory(data: {
  communityId: number;
  title?: string;
  authorId?: number;
  restrictedTo?: string;
  isRestricted?: boolean;
}) {
  // TODO: Implement test story factory
  return Promise.resolve({
    id: Math.floor(Math.random() * 10000),
    title: data.title || 'Test Story',
    communityId: data.communityId,
    authorId: data.authorId || 1,
    ...data,
  });
}
