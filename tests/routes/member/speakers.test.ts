/**
 * Member Speakers API Tests
 *
 * Comprehensive test suite for authenticated member speaker management endpoints.
 * Tests RBAC, ownership, community isolation, cultural protocols, and elder status handling.
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

describe('Member Speakers API', () => {
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
        url: '/api/v1/member/speakers',
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
        url: '/api/v1/member/speakers',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/member/speakers', () => {
    it('should list community speakers with pagination', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/speakers?page=1&limit=10',
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

    it('should filter speakers by community scope', async () => {
      createTestSpeaker({ communityId, name: 'Community 1 Speaker' });
      const otherCommunity = await createTestCommunity({ name: 'Community 2' });
      createTestSpeaker({
        communityId: otherCommunity.id,
        name: 'Community 2 Speaker',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(
        body.data.every((speaker) => speaker.communityId === communityId)
      ).toBe(true);
    });

    it('should support search functionality', async () => {
      createTestSpeaker({ communityId, name: 'John Storyteller' });
      createTestSpeaker({ communityId, name: 'Mary Wisdom' });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/speakers?search=Storyteller',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('John Storyteller');
    });
  });

  describe('POST /api/v1/member/speakers', () => {
    const validSpeakerData = {
      name: 'Test Speaker',
      bio: 'A test speaker biography',
      birthYear: 1950,
      culturalRole: 'storyteller',
    };

    it('should create speaker as editor+', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: validSpeakerData,
      });

      expect(response.statusCode).toBe(201);

      const body = JSON.parse(response.body);
      expect(body.data).toMatchObject({
        name: 'Test Speaker',
        bio: 'A test speaker biography',
        communityId: communityId,
      });
      expect(body.data.id).toBeDefined();
    });

    it('should reject speaker creation for viewers', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: createSessionCookie(viewerUserId),
          'content-type': 'application/json',
        },
        payload: validSpeakerData,
      });

      expect(response.statusCode).toBe(403);
    });

    it('should validate required fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: { bio: 'Missing name' }, // Missing required name field
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
        }),
      });
    });

    it('should validate birth year ranges', async () => {
      const invalidData = {
        ...validSpeakerData,
        birthYear: 1800, // Too early
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: invalidData,
      });

      expect(response.statusCode).toBe(400);
    });

    it('should auto-scope to user community', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: {
          ...validSpeakerData,
          communityId: 9999, // Should be ignored
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.communityId).toBe(communityId);
    });
  });

  describe('GET /api/v1/member/speakers/:id', () => {
    let speakerId: number;

    beforeEach(async () => {
      const speaker = createTestSpeaker({
        communityId,
        name: 'Test Speaker',
        createdBy: editorUserId,
      });
      speakerId = speaker.id;
    });

    it('should get speaker by ID within community', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/member/speakers/${speakerId}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.data).toMatchObject({
        id: speakerId,
        name: 'Test Speaker',
        communityId: communityId,
      });
    });

    it('should return 404 for non-existent speaker', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/speakers/99999',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for speaker from different community', async () => {
      const otherCommunity = await createTestCommunity({
        name: 'Other Community',
      });
      const otherSpeaker = createTestSpeaker({
        communityId: otherCommunity.id,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/member/speakers/${otherSpeaker.id}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PUT /api/v1/member/speakers/:id', () => {
    let ownSpeakerId: number;
    let otherUserSpeakerId: number;

    beforeEach(async () => {
      const ownSpeaker = createTestSpeaker({
        communityId,
        name: 'Own Speaker',
        createdBy: editorUserId,
      });
      ownSpeakerId = ownSpeaker.id;

      const otherSpeaker = createTestSpeaker({
        communityId,
        name: 'Other Speaker',
        createdBy: adminUserId,
      });
      otherUserSpeakerId = otherSpeaker.id;
    });

    it('should allow editors to update their own speakers', async () => {
      const updateData = {
        name: 'Updated Own Speaker',
        bio: 'Updated biography',
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/member/speakers/${ownSpeakerId}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: updateData,
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.data).toMatchObject({
        id: ownSpeakerId,
        name: 'Updated Own Speaker',
        bio: 'Updated biography',
      });
    });

    it('should reject editors updating others speakers', async () => {
      const updateData = { name: 'Trying to update' };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/member/speakers/${otherUserSpeakerId}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: updateData,
      });

      expect(response.statusCode).toBe(403);
    });

    it('should allow admins to update community speakers', async () => {
      const updateData = { name: 'Admin Updated' };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/member/speakers/${otherUserSpeakerId}`,
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

    it('should validate update data', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/member/speakers/${ownSpeakerId}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: { name: '' }, // Invalid empty name
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/v1/member/speakers/:id', () => {
    let ownSpeakerId: number;
    let otherUserSpeakerId: number;

    beforeEach(async () => {
      const ownSpeaker = createTestSpeaker({
        communityId,
        name: 'Own Speaker',
        createdBy: editorUserId,
      });
      ownSpeakerId = ownSpeaker.id;

      const otherSpeaker = createTestSpeaker({
        communityId,
        name: 'Other Speaker',
        createdBy: adminUserId,
      });
      otherUserSpeakerId = otherSpeaker.id;
    });

    it('should allow admins to delete community speakers', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/member/speakers/${otherUserSpeakerId}`,
        headers: {
          cookie: createSessionCookie(adminUserId),
        },
      });

      expect(response.statusCode).toBe(204);
    });

    it('should allow elders to delete speakers with cultural authority', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/member/speakers/${otherUserSpeakerId}`,
        headers: {
          cookie: createSessionCookie(elderUserId),
        },
      });

      expect(response.statusCode).toBe(204);
    });

    it('should reject editors deleting others speakers', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/member/speakers/${otherUserSpeakerId}`,
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should reject viewers attempting any deletions', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/member/speakers/${ownSpeakerId}`,
        headers: {
          cookie: createSessionCookie(viewerUserId),
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('Elder Status and Cultural Protocol Compliance', () => {
    let elderSpeakerId: number;
    let culturalSpeakerId: number;

    beforeEach(async () => {
      const elderSpeaker = createTestSpeaker({
        communityId,
        name: 'Elder Speaker',
        isElder: true,
        culturalRole: 'elder',
        createdBy: elderUserId,
      });
      elderSpeakerId = elderSpeaker.id;

      const culturalSpeaker = createTestSpeaker({
        communityId,
        name: 'Cultural Speaker',
        culturalRole: 'ceremonial_leader',
        isRestricted: true,
        createdBy: adminUserId,
      });
      culturalSpeakerId = culturalSpeaker.id;
    });

    it('should indicate elder status appropriately', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/member/speakers/${elderSpeakerId}`,
        headers: {
          cookie: createSessionCookie(elderUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.data.isElder).toBe(true);
      expect(body.data.culturalRole).toBe('elder');
    });

    it('should respect cultural protocol for sensitive speaker information', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Should see the speaker but with filtered cultural details
      const culturalSpeaker = body.data.find(
        (speaker) => speaker.id === culturalSpeakerId
      );
      expect(culturalSpeaker).toBeDefined();
      expect(culturalSpeaker.culturalRole).toBe('storyteller'); // Filtered for non-elders
    });

    it('should show full cultural details to elders', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: createSessionCookie(elderUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      const culturalSpeaker = body.data.find(
        (speaker) => speaker.id === culturalSpeakerId
      );
      expect(culturalSpeaker).toBeDefined();
      expect(culturalSpeaker.culturalRole).toBe('ceremonial_leader'); // Full details for elders
    });

    it('should allow elders to create elder speakers', async () => {
      const elderSpeakerData = {
        name: 'New Elder',
        bio: 'A respected elder',
        isElder: true,
        culturalRole: 'elder',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: createSessionCookie(elderUserId),
          'content-type': 'application/json',
        },
        payload: elderSpeakerData,
      });

      expect(response.statusCode).toBe(201);

      const body = JSON.parse(response.body);
      expect(body.data.isElder).toBe(true);
      expect(body.data.culturalRole).toBe('elder');
    });

    it('should restrict non-elders from creating elder speakers', async () => {
      const elderSpeakerData = {
        name: 'Attempted Elder',
        bio: 'Attempting to create elder',
        isElder: true,
        culturalRole: 'elder',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: createSessionCookie(editorUserId),
          'content-type': 'application/json',
        },
        payload: elderSpeakerData,
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        error: expect.objectContaining({
          code: 'INSUFFICIENT_PERMISSIONS',
          message: expect.stringContaining('elder'),
        }),
      });
    });

    it('should allow elders to override cultural restrictions', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/member/speakers/${culturalSpeakerId}`,
        headers: {
          cookie: createSessionCookie(elderUserId),
          'content-type': 'application/json',
        },
        payload: { name: 'Elder Updated Cultural Speaker' },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('Response Format Validation', () => {
    it('should not leak internal fields in responses', async () => {
      const speaker = createTestSpeaker({
        communityId,
        createdBy: editorUserId,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/member/speakers/${speaker.id}`,
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
      expect(body.data).not.toHaveProperty('createdBy');
    });

    it('should return consistent envelope format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/speakers',
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

  describe('Statistical Information', () => {
    beforeEach(async () => {
      // Create speakers with different roles
      createTestSpeaker({ communityId, culturalRole: 'elder', isElder: true });
      createTestSpeaker({ communityId, culturalRole: 'storyteller' });
      createTestSpeaker({ communityId, culturalRole: 'historian' });
    });

    it('should provide speaker statistics in metadata', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/member/speakers',
        headers: {
          cookie: createSessionCookie(editorUserId),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.meta).toMatchObject({
        total: expect.any(Number),
        totalPages: expect.any(Number),
        hasNextPage: expect.any(Boolean),
        hasPrevPage: expect.any(Boolean),
        // Should include cultural role statistics
        statistics: expect.objectContaining({
          totalSpeakers: expect.any(Number),
          elderCount: expect.any(Number),
          roleDistribution: expect.any(Object),
        }),
      });
    });
  });
});

// Helper functions
function createSessionCookie(userId: number): string {
  return `connect.sid=test-session-${userId}`;
}

function createTestSpeaker(data: {
  communityId: number;
  name?: string;
  createdBy?: number;
  culturalRole?: string;
  isElder?: boolean;
  isRestricted?: boolean;
}) {
  return Promise.resolve({
    id: Math.floor(Math.random() * 10000),
    name: data.name || 'Test Speaker',
    communityId: data.communityId,
    createdBy: data.createdBy || 1,
    culturalRole: data.culturalRole || 'storyteller',
    isElder: data.isElder || false,
    ...data,
  });
}
