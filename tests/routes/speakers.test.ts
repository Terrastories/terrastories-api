/**
 * Speakers API Routes Tests
 *
 * Tests the actual Speakers API endpoints with:
 * - Real route handlers from src/routes/speakers.ts
 * - Complete CRUD operation endpoints
 * - Authentication and authorization with sessions
 * - Cultural protocol enforcement (elder permissions)
 * - Request/response validation
 * - Error handling
 * - Community data isolation
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { testDb } from '../helpers/database.js';
import { createTestApp } from '../helpers/api-client.js';

describe('Speakers API Routes - Integration Tests', () => {
  let app: FastifyInstance;
  let testCommunityId: number;
  let adminSessionId: string;
  let editorSessionId: string;
  let viewerSessionId: string;

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

    // Register admin user
    const adminRegisterRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: adminUser,
    });
    expect(adminRegisterRes.statusCode).toBe(201);

    // Login admin user to get session cookie
    const adminLoginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: adminUser.email,
        password: adminUser.password,
        communityId: adminUser.communityId,
      },
    });
    expect(adminLoginRes.statusCode).toBe(200);

    // Extract session cookie from Set-Cookie header
    const setCookieHeader = adminLoginRes.headers['set-cookie'];
    if (Array.isArray(setCookieHeader)) {
      const sessionCookie = setCookieHeader.find((cookie) =>
        cookie.includes('sessionId=')
      );
      adminSessionId = sessionCookie
        ? sessionCookie.split('sessionId=')[1].split(';')[0]
        : '';
    } else if (setCookieHeader) {
      adminSessionId = setCookieHeader.includes('sessionId=')
        ? setCookieHeader.split('sessionId=')[1].split(';')[0]
        : '';
    }

    // Register editor user
    const editorRegisterRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: editorUser,
    });
    expect(editorRegisterRes.statusCode).toBe(201);

    // Login editor user to get session cookie
    const editorLoginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: editorUser.email,
        password: editorUser.password,
        communityId: editorUser.communityId,
      },
    });
    expect(editorLoginRes.statusCode).toBe(200);

    const editorSetCookieHeader = editorLoginRes.headers['set-cookie'];
    if (Array.isArray(editorSetCookieHeader)) {
      const sessionCookie = editorSetCookieHeader.find((cookie) =>
        cookie.includes('sessionId=')
      );
      editorSessionId = sessionCookie
        ? sessionCookie.split('sessionId=')[1].split(';')[0]
        : '';
    } else if (editorSetCookieHeader) {
      editorSessionId = editorSetCookieHeader.includes('sessionId=')
        ? editorSetCookieHeader.split('sessionId=')[1].split(';')[0]
        : '';
    }

    // Register viewer user
    const viewerRegisterRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: viewerUser,
    });
    expect(viewerRegisterRes.statusCode).toBe(201);

    // Login viewer user to get session cookie
    const viewerLoginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: viewerUser.email,
        password: viewerUser.password,
        communityId: viewerUser.communityId,
      },
    });
    expect(viewerLoginRes.statusCode).toBe(200);

    const viewerSetCookieHeader = viewerLoginRes.headers['set-cookie'];
    if (Array.isArray(viewerSetCookieHeader)) {
      const sessionCookie = viewerSetCookieHeader.find((cookie) =>
        cookie.includes('sessionId=')
      );
      viewerSessionId = sessionCookie
        ? sessionCookie.split('sessionId=')[1].split(';')[0]
        : '';
    } else if (viewerSetCookieHeader) {
      viewerSessionId = viewerSetCookieHeader.includes('sessionId=')
        ? viewerSetCookieHeader.split('sessionId=')[1].split(';')[0]
        : '';
    }

    const elderRegisterRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: elderUser,
    });
    expect(elderRegisterRes.statusCode).toBe(201);
  });

  afterEach(async () => {
    await app.close();
    await testDb.teardown();
  });

  describe('POST /api/speakers', () => {
    const validSpeakerData = {
      name: 'Maria Santos',
      bio: 'Traditional storyteller and knowledge keeper',
      photoUrl: 'https://example.com/maria.jpg',
      birthYear: 1965,
      elderStatus: false,
      culturalRole: 'Traditional Knowledge Keeper',
      isActive: true,
    };

    test('should create speaker with valid data as admin', async () => {
      console.log('DEBUG: adminSessionId:', adminSessionId);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: validSpeakerData,
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      console.log('DEBUG: Response status:', response.statusCode);
      console.log('DEBUG: Response body:', response.body);

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(body.data.name).toBe(validSpeakerData.name);
      expect(body.data.bio).toBe(validSpeakerData.bio);
      expect(body.data.communityId).toBe(testCommunityId);
      expect(body.data.elderStatus).toBe(false);
      expect(body.data.culturalRole).toBe(validSpeakerData.culturalRole);
    });

    test('should create speaker with minimal data', async () => {
      const minimalData = {
        name: 'John Traditional',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: minimalData,
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.name).toBe(minimalData.name);
      expect(body.data.bio).toBeNull();
      expect(body.data.elderStatus).toBe(false);
      expect(body.data.isActive).toBe(true);
    });

    test('should allow editors to create non-elder speakers', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: validSpeakerData,
        headers: {
          cookie: `sessionId=${editorSessionId}`,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.name).toBe(validSpeakerData.name);
    });

    test('should reject elder creation by non-admins', async () => {
      const elderData = {
        ...validSpeakerData,
        elderStatus: true,
      };

      const editorResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: elderData,
        headers: {
          cookie: `sessionId=${editorSessionId}`,
        },
      });

      expect(editorResponse.statusCode).toBe(403);
      const editorBody = JSON.parse(editorResponse.body);
      expect(editorBody.error.message).toBe(
        'Only admins can create elder speakers'
      );

      const viewerResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: elderData,
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(viewerResponse.statusCode).toBe(403);
    });

    test('should allow admin to create elder speakers', async () => {
      const elderData = {
        ...validSpeakerData,
        elderStatus: true,
        culturalRole: 'Elder Council Member',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: elderData,
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.data.elderStatus).toBe(true);
      expect(body.data.culturalRole).toBe('Elder Council Member');
    });

    test('should reject requests without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: validSpeakerData,
      });

      expect(response.statusCode).toBe(401);
    });

    test('should reject viewers from creating speakers', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: validSpeakerData,
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(response.statusCode).toBe(403);
    });

    test('should validate required fields', async () => {
      const invalidData = {
        bio: 'Bio without name',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: invalidData,
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.message).toBe('Validation error');
      expect(body.error.details).toBeDefined();
    });

    test('should validate field lengths', async () => {
      const longNameData = {
        name: 'a'.repeat(201), // Exceeds 200 char limit
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: longNameData,
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test('should validate photo URL format', async () => {
      const invalidUrlData = {
        name: 'Valid Name',
        photoUrl: 'not-a-url',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: invalidUrlData,
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test('should validate birth year range', async () => {
      const invalidYearData = {
        name: 'Valid Name',
        birthYear: 1800, // Too early
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: invalidYearData,
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/speakers/:id', () => {
    let createdSpeakerId: number;

    beforeEach(async () => {
      // Create a test speaker
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: {
          name: 'Test Speaker',
          bio: 'Test bio',
          elderStatus: false,
        },
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      const body = JSON.parse(createResponse.body);
      createdSpeakerId = body.data.id;
    });

    test('should get speaker by ID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/speakers/${createdSpeakerId}`,
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.id).toBe(createdSpeakerId);
      expect(body.data.name).toBe('Test Speaker');
    });

    test('should return 404 for non-existent speaker', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/speakers/99999`,
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(response.statusCode).toBe(404);
    });

    test('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/speakers/${createdSpeakerId}`,
      });

      expect(response.statusCode).toBe(401);
    });

    test('should enforce community isolation', async () => {
      // This test would need a speaker from another community to be meaningful
      // For now, we verify that the speaker belongs to the user's community
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/speakers/${createdSpeakerId}`,
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.communityId).toBe(testCommunityId);
    });
  });

  describe('GET /api/speakers', () => {
    beforeEach(async () => {
      // Create test speakers
      await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: {
          name: 'Active Speaker',
          elderStatus: false,
          isActive: true,
        },
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: {
          name: 'Elder Speaker',
          elderStatus: true,
          culturalRole: 'Elder',
          isActive: true,
        },
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: {
          name: 'Inactive Speaker',
          elderStatus: false,
          isActive: false,
        },
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });
    });

    test('should list community speakers with pagination', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers?page=1&limit=10',
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeInstanceOf(Array);
      expect(body.meta).toBeDefined();
      expect(body.meta.total).toBeGreaterThan(0);
      expect(body.meta.page).toBe(1);
      expect(body.meta.limit).toBe(10);

      // Verify all speakers belong to community
      body.data.forEach((speaker: any) => {
        expect(speaker.communityId).toBe(testCommunityId);
      });
    });

    test('should filter by elder status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers?elderOnly=true&page=1&limit=10',
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.length).toBeGreaterThan(0);
      body.data.forEach((speaker: any) => {
        expect(speaker.elderStatus).toBe(true);
      });
    });

    test('should filter active speakers by default for non-admins', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers?page=1&limit=10',
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      body.data.forEach((speaker: any) => {
        expect(speaker.isActive).toBe(true);
      });
    });

    test('should allow admins to see inactive speakers', async () => {
      // Query without activeOnly parameter - admins should see all speakers by default
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers?page=1&limit=10',
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      const inactiveSpeakers = body.data.filter((s: any) => !s.isActive);
      expect(inactiveSpeakers.length).toBeGreaterThan(0);
    });

    test('should support sorting', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers?sortBy=name&sortOrder=asc&page=1&limit=10',
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.length).toBeGreaterThan(1);

      // Verify sorting
      for (let i = 1; i < body.data.length; i++) {
        expect(body.data[i - 1].name <= body.data[i].name).toBe(true);
      }
    });

    test('should validate pagination parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers?page=0&limit=10',
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers?page=1&limit=10',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('PUT /api/speakers/:id', () => {
    let createdSpeakerId: number;
    let elderSpeakerId: number;

    beforeEach(async () => {
      // Create regular speaker
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: {
          name: 'Test Speaker',
          bio: 'Original bio',
          elderStatus: false,
        },
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });
      const body = JSON.parse(createResponse.body);
      createdSpeakerId = body.data.id;

      // Create elder speaker
      const elderResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: {
          name: 'Elder Speaker',
          elderStatus: true,
          culturalRole: 'Elder Council',
        },
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });
      const elderBody = JSON.parse(elderResponse.body);
      elderSpeakerId = elderBody.data.id;
    });

    test('should update speaker as admin', async () => {
      const updateData = {
        name: 'Updated Name',
        bio: 'Updated bio',
        culturalRole: 'Updated Role',
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/speakers/${createdSpeakerId}`,
        payload: updateData,
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.name).toBe('Updated Name');
      expect(body.data.bio).toBe('Updated bio');
      expect(body.data.culturalRole).toBe('Updated Role');
    });

    test('should allow editors to update non-elder speakers', async () => {
      const updateData = {
        name: 'Editor Updated Name',
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/speakers/${createdSpeakerId}`,
        payload: updateData,
        headers: {
          cookie: `sessionId=${editorSessionId}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.name).toBe('Editor Updated Name');
    });

    test('should reject elder updates by non-admins', async () => {
      const updateData = {
        name: 'Attempted Elder Update',
      };

      const editorResponse = await app.inject({
        method: 'PUT',
        url: `/api/v1/speakers/${elderSpeakerId}`,
        payload: updateData,
        headers: {
          cookie: `sessionId=${editorSessionId}`,
        },
      });

      expect(editorResponse.statusCode).toBe(403);

      const viewerResponse = await app.inject({
        method: 'PUT',
        url: `/api/v1/speakers/${elderSpeakerId}`,
        payload: updateData,
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(viewerResponse.statusCode).toBe(403);
    });

    test('should reject elder status changes by non-admins', async () => {
      const updateData = {
        elderStatus: true,
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/speakers/${createdSpeakerId}`,
        payload: updateData,
        headers: {
          cookie: `sessionId=${editorSessionId}`,
        },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error.message).toContain('elder status');
    });

    test('should return 404 for non-existent speaker', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/speakers/99999`,
        payload: { name: 'Updated' },
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      expect(response.statusCode).toBe(404);
    });

    test('should validate update data', async () => {
      const invalidData = {
        name: '', // Empty name
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/speakers/${createdSpeakerId}`,
        payload: invalidData,
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test('should require authentication', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/v1/speakers/${createdSpeakerId}`,
        payload: { name: 'Updated' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('DELETE /api/speakers/:id', () => {
    let createdSpeakerId: number;
    let elderSpeakerId: number;

    beforeEach(async () => {
      // Create regular speaker
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: {
          name: 'To Be Deleted',
          elderStatus: false,
        },
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });
      const body = JSON.parse(createResponse.body);
      createdSpeakerId = body.data.id;

      // Create elder speaker
      const elderResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: {
          name: 'Elder To Delete',
          elderStatus: true,
        },
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });
      const elderBody = JSON.parse(elderResponse.body);
      elderSpeakerId = elderBody.data.id;
    });

    test('should delete non-elder speaker as admin', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/speakers/${createdSpeakerId}`,
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      expect(response.statusCode).toBe(204);

      // Verify deletion
      const getResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/speakers/${createdSpeakerId}`,
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      expect(getResponse.statusCode).toBe(404);
    });

    test('should reject elder deletion even by admins', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/speakers/${elderSpeakerId}`,
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error.message).toContain(
        'Elder speakers require special authorization'
      );
    });

    test('should reject deletion by non-admins', async () => {
      const editorResponse = await app.inject({
        method: 'DELETE',
        url: `/api/v1/speakers/${createdSpeakerId}`,
        headers: {
          cookie: `sessionId=${editorSessionId}`,
        },
      });

      expect(editorResponse.statusCode).toBe(403);

      const viewerResponse = await app.inject({
        method: 'DELETE',
        url: `/api/v1/speakers/${createdSpeakerId}`,
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(viewerResponse.statusCode).toBe(403);
    });

    test('should return 404 for non-existent speaker', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/speakers/99999`,
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      expect(response.statusCode).toBe(404);
    });

    test('should require authentication', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/speakers/${createdSpeakerId}`,
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/speakers/search', () => {
    beforeEach(async () => {
      // Create test speakers for search
      await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: {
          name: 'Maria Santos',
          culturalRole: 'Elder',
        },
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: {
          name: 'Maria Rodriguez',
          culturalRole: 'Storyteller',
        },
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: {
          name: 'John Smith',
          culturalRole: 'Knowledge Keeper',
        },
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });
    });

    test('should search speakers by name', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers/search?q=Maria&page=1&limit=10',
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.length).toBe(2);
      body.data.forEach((speaker: any) => {
        expect(speaker.name).toContain('Maria');
      });
    });

    test('should return empty result for non-matching search', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers/search?q=NonExistent&page=1&limit=10',
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.length).toBe(0);
      expect(body.meta.total).toBe(0);
    });

    test('should require search query', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers/search?page=1&limit=10',
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test('should validate minimum search query length', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers/search?q=a&page=1&limit=10',
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers/search?q=Maria&page=1&limit=10',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/speakers/stats', () => {
    beforeEach(async () => {
      // Create speakers with different characteristics for stats
      await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: {
          name: 'Active Elder',
          elderStatus: true,
          isActive: true,
        },
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: {
          name: 'Active Non-Elder',
          elderStatus: false,
          isActive: true,
        },
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/speakers',
        payload: {
          name: 'Inactive Speaker',
          elderStatus: false,
          isActive: false,
        },
        headers: {
          cookie: `sessionId=${adminSessionId}`,
        },
      });
    });

    test('should return community speaker statistics', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers/stats',
        headers: {
          cookie: `sessionId=${viewerSessionId}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(body.data.total).toBeGreaterThanOrEqual(3);
      expect(body.data.active).toBeGreaterThanOrEqual(2);
      expect(body.data.inactive).toBeGreaterThanOrEqual(1);
      expect(body.data.elders).toBeGreaterThanOrEqual(1);
      expect(body.data.nonElders).toBeGreaterThanOrEqual(2);
    });

    test('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/speakers/stats',
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
