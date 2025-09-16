/**
 * API Integration Tests
 *
 * Integration tests demonstrating API testing patterns with database
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { testDb, TestFixtures } from '../helpers/database.js';
import {
  createApiClient,
  ApiTestClient,
  createTestApp as createRealTestApp,
} from '../helpers/api-client.js';

// Mock a simple Fastify app for testing

async function createTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Register plugins (minimal setup for testing)
  await app.register(import('@fastify/cors'));

  // Simple health endpoint
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Communities endpoint
  app.get('/api/v1/communities', async () => {
    const database = await testDb.getDb();
    const { communitiesSqlite } = await import('../../src/db/schema/index.js');
    const communityList = await database.select().from(communitiesSqlite);

    return {
      data: communityList,
      meta: {
        total: communityList.length,
        page: 1,
        limit: 20,
      },
    };
  });

  // Get single community
  app.get('/api/v1/communities/:id', async (request: any, reply) => {
    const database = await testDb.getDb();
    const { communitiesSqlite } = await import('../../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const { id } = request.params;

    const community = await database
      .select()
      .from(communitiesSqlite)
      .where(eq(communitiesSqlite.id, parseInt(id)))
      .limit(1);

    if (community.length === 0) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Community not found' },
      });
    }

    return { data: community[0] };
  });

  // Create community endpoint (requires authentication)
  app.post(
    '/api/v1/communities',
    {
      preHandler: async (request: any, reply) => {
        const authHeader = request.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }

        // Validate token format (should be mock.base64.signature)
        const token = authHeader.replace('Bearer ', '');
        if (!token.startsWith('mock.') || token === 'invalid-token') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Invalid token' },
          });
        }
      },
    },
    async (request: any, reply) => {
      const database = await testDb.getDb();
      const { communitiesSqlite } = await import(
        '../../src/db/schema/index.js'
      );

      try {
        const now = new Date();
        const [newCommunity] = await database
          .insert(communitiesSqlite)
          .values({
            ...request.body,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        return { data: newCommunity };
      } catch (error: any) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: error.message },
        });
      }
    }
  );

  // Places endpoint with community filtering
  app.get('/api/v1/places', async (request: any) => {
    const database = await testDb.getDb();
    const { placesSqlite } = await import('../../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const { community_id } = request.query;

    let placesList;

    if (community_id) {
      placesList = await database
        .select()
        .from(placesSqlite)
        .where(eq(placesSqlite.communityId, parseInt(community_id)));
    } else {
      placesList = await database.select().from(placesSqlite);
    }

    return {
      data: placesList,
      meta: {
        total: placesList.length,
        page: 1,
        limit: 20,
        filters: { communityId: community_id },
      },
    };
  });

  return app;
}

describe('API Integration Tests', () => {
  let app: FastifyInstance;
  let apiClient: ApiTestClient;
  let fixtures: TestFixtures;

  beforeEach(async () => {
    // Database is cleared by setup.ts, seed with test data for API tests
    fixtures = await testDb.seedTestData();

    // Create test users for authentication
    const db = await testDb.getDb();
    const { usersSqlite } = await import('../../src/db/schema/index.js');

    // Create test users with proper password hash for 'testPassword123'
    const testPasswordHash =
      '$argon2id$v=19$m=65536,t=3,p=4$lqO13Fqx46nTW2lUiZJWLw$VIpjVVTVn3OVLoLgN+ZcGBmGqCeHZjK2FwayYOWm3OQ';

    const now = new Date();
    await db.insert(usersSqlite).values([
      {
        email: 'admin@test.com',
        passwordHash: testPasswordHash,
        firstName: 'Admin',
        lastName: 'User',
        role: 'admin',
        communityId: fixtures.communities[0].id,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        email: 'editor@test.com',
        passwordHash: testPasswordHash,
        firstName: 'Editor',
        lastName: 'User',
        role: 'editor',
        communityId: fixtures.communities[0].id,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        email: 'viewer@test.com',
        passwordHash: testPasswordHash,
        firstName: 'Viewer',
        lastName: 'User',
        role: 'viewer',
        communityId: fixtures.communities[0].id,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        email: 'superadmin@test.com',
        passwordHash: testPasswordHash,
        firstName: 'Super',
        lastName: 'Admin',
        role: 'super_admin',
        communityId: fixtures.systemCommunity.id,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      // Additional admin user for anotherCommunity test scenario
      {
        email: 'admin2@test.com',
        passwordHash: testPasswordHash,
        firstName: 'Admin',
        lastName: 'User 2',
        role: 'admin',
        communityId: fixtures.communities[1].id,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // Create test app with real routes and API client
    app = await createRealTestApp(testDb.db);
    apiClient = createApiClient(app);

    // Update API client to use correct community IDs from fixtures
    apiClient.getTokens = async () => {
      return {
        admin: await apiClient.getTestSessionId(
          1,
          fixtures.communities[0].id,
          'admin'
        ),
        editor: await apiClient.getTestSessionId(
          2,
          fixtures.communities[0].id,
          'editor'
        ),
        viewer: await apiClient.getTestSessionId(
          3,
          fixtures.communities[0].id,
          'viewer'
        ),
        superAdmin: await apiClient.getTestSessionId(
          999,
          fixtures.systemCommunity.id,
          'super_admin'
        ),
        anotherCommunity: await apiClient.getTestSessionId(
          4,
          fixtures.communities[1].id,
          'admin2'
        ),
      };
    };
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('Health Endpoint', () => {
    it('should return health status', async () => {
      const response = await apiClient.get('/health');

      apiClient.assertSuccess(response);

      const data = apiClient.parseResponse(response);
      expect(data).toMatchObject({
        status: 'ok',
        timestamp: expect.any(String),
      });

      // Verify timestamp is recent
      const timestamp = new Date(data.timestamp);
      const now = new Date();
      const diffMs = Math.abs(now.getTime() - timestamp.getTime());
      expect(diffMs).toBeLessThan(5000); // Within 5 seconds
    });
  });

  describe('Communities API', () => {
    it('should list communities', async () => {
      const response = await apiClient.get('/api/v1/communities');

      apiClient.assertSuccess(response);

      const result = apiClient.assertPaginatedResponse(response);
      expect(result.data).toHaveLength(4); // System + 3 test fixture communities
      expect(result.meta.total).toBe(4);

      // Verify community structure
      result.data.forEach((community) => {
        expect(community).toMatchObject({
          id: expect.any(Number),
          name: expect.any(String),
          slug: expect.any(String),
        });
        // SQLite can return booleans as integers (1/0) or actual booleans
        expect([true, false, 1, 0]).toContain(community.publicStories);
      });
    });

    it('should get single community by ID', async () => {
      const testCommunity = fixtures.communities[0];

      const response = await apiClient.get(
        `/api/v1/communities/${testCommunity.id}`
      );

      apiClient.assertSuccess(response);

      const result = apiClient.assertResponseStructure(response, ['data']);
      expect(result.data).toMatchObject({
        id: testCommunity.id,
        name: testCommunity.name,
        slug: testCommunity.slug,
      });
    });

    it('should return 404 for non-existent community', async () => {
      const response = await apiClient.get('/api/v1/communities/99999');

      apiClient.assertNotFound(response);
    });

    it('should create new community with authentication', async () => {
      const tokens = await apiClient.getTokens();
      const communityData = {
        name: 'API Test Community',
        description: 'Created via API test',
        slug: 'api-test-community',
        publicStories: true,
      };

      const response = await apiClient.post(
        '/api/v1/communities',
        communityData,
        tokens.admin
      );

      apiClient.assertSuccess(response, 201);

      const result = apiClient.assertResponseStructure(response, ['data']);
      expect(result.data).toMatchObject({
        name: 'API Test Community',
        slug: 'api-test-community',
        publicStories: true,
      });
      expect(result.data.id).toBeDefined();
    });

    it('should reject community creation without authentication', async () => {
      const communityData = {
        name: 'Unauthorized Community',
        slug: 'unauthorized',
      };

      const response = await apiClient.post(
        '/api/v1/communities',
        communityData
      );

      apiClient.assertUnauthorized(response);
    });

    it('should handle validation errors', async () => {
      const tokens = await apiClient.getTokens();
      const invalidData = {
        // Missing required name field
        slug: 'invalid-community',
      };

      const response = await apiClient.post(
        '/api/v1/communities',
        invalidData,
        tokens.admin
      );

      // Should return bad request (validation handled by database constraints)
      expect(response.statusCode).toBe(400);
    });
  });

  describe('Places API', () => {
    it('should list all places', async () => {
      const tokens = await apiClient.getTokens();
      const response = await apiClient.get(
        '/api/v1/places',
        undefined,
        tokens.admin
      );

      apiClient.assertSuccess(response);

      const result = apiClient.assertPaginatedResponse(response);
      expect(result.data.length).toBeGreaterThan(0);

      // Verify place structure
      result.data.forEach((place) => {
        expect(place).toMatchObject({
          id: expect.any(Number),
          name: expect.any(String),
          communityId: expect.any(Number), // Use camelCase field name
        });
      });
    });

    it('should filter places by community', async () => {
      const tokens = await apiClient.getTokens();
      const testCommunity = fixtures.communities[0];

      const response = await apiClient.get(
        '/api/v1/places',
        {
          community_id: testCommunity.id,
        },
        tokens.admin
      );

      apiClient.assertSuccess(response);

      const result = apiClient.assertPaginatedResponse(response);
      expect(result.meta.filters.communityId).toBe(testCommunity.id.toString());

      // All places should belong to the specified community
      result.data.forEach((place) => {
        expect(place.communityId).toBe(testCommunity.id);
      });
    });

    it('should handle empty results gracefully', async () => {
      const tokens = await apiClient.getTokens();
      const response = await apiClient.get(
        '/api/v1/places',
        {
          community_id: 99999, // Non-existent community
        },
        tokens.admin
      );

      apiClient.assertSuccess(response);

      const result = apiClient.assertPaginatedResponse(response);
      expect(result.data).toHaveLength(0);
      expect(result.meta.total).toBe(0);
    });
  });

  describe('Authentication and Authorization', () => {
    it('should handle different user roles', async () => {
      const tokens = await apiClient.getTokens();

      // Test with different token types
      const roleTests = [
        { role: 'admin', token: tokens.admin, shouldSucceed: true },
        { role: 'editor', token: tokens.editor, shouldSucceed: true },
        { role: 'viewer', token: tokens.viewer, shouldSucceed: false }, // Viewers are read-only
        { role: 'superAdmin', token: tokens.superAdmin, shouldSucceed: true },
      ];

      for (const test of roleTests) {
        const response = await apiClient.post(
          '/api/v1/communities',
          {
            name: `${test.role} Test Community`,
            slug: `${test.role.toLowerCase()}-test`,
          },
          test.token
        );

        if (test.shouldSucceed) {
          apiClient.assertSuccess(response, 201);
        } else {
          apiClient.assertForbidden(response);
        }
      }
    });

    it('should handle invalid tokens', async () => {
      const response = await apiClient.post(
        '/api/v1/communities',
        { name: 'Test', slug: 'test' },
        'invalid-token'
      );

      apiClient.assertUnauthorized(response);
    });

    it('should handle missing Authorization header', async () => {
      const response = await apiClient.request('POST', '/api/v1/communities', {
        name: 'Test Community',
        slug: 'test',
      });

      apiClient.assertUnauthorized(response);
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed JSON', async () => {
      const tokens = await apiClient.getTokens();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/communities',
        headers: {
          cookie: `sessionId=${tokens.admin}`,
          'Content-Type': 'application/json',
        },
        payload: '{ invalid json }',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should handle large payloads gracefully', async () => {
      const tokens = await apiClient.getTokens();
      const largeDescription = 'A'.repeat(10000); // 10KB string

      const response = await apiClient.post(
        '/api/v1/communities',
        {
          name: 'Large Payload Test',
          description: largeDescription,
          slug: 'large-payload-test',
        },
        tokens.admin
      );

      // Should gracefully reject oversized payloads with 400 Bad Request (description > 1000 chars)
      expect(response.statusCode).toBe(400);
    });

    it('should handle concurrent requests', async () => {
      const tokens = await apiClient.getTokens();

      // Make multiple concurrent requests
      const requests = Array.from({ length: 10 }, (_, i) =>
        apiClient.post(
          '/api/v1/communities',
          {
            name: `Concurrent Community ${i}`,
            slug: `concurrent-${i}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
          },
          tokens.admin
        )
      );

      const responses = await Promise.all(requests);

      // All requests should succeed
      responses.forEach((response) => {
        apiClient.assertSuccess(response, 201);
      });

      // Verify all communities were created
      const listResponse = await apiClient.get('/api/v1/communities');
      const result = apiClient.assertPaginatedResponse(listResponse);
      expect(result.data.length).toBeGreaterThanOrEqual(13); // 3 fixtures + 10 new
    });
  });

  describe('Performance Testing', () => {
    it('should respond within performance limits', async () => {
      const maxResponseTime = 1000; // 1 second

      const start = performance.now();
      const response = await apiClient.get('/api/v1/communities');
      const duration = performance.now() - start;

      apiClient.assertSuccess(response);
      expect(duration).toBeLessThan(maxResponseTime);
    });

    it('should handle load testing', async () => {
      const concurrentRequests = 20;
      const maxResponseTime = 2000; // 2 seconds for concurrent load

      const start = performance.now();

      const requests = Array.from({ length: concurrentRequests }, () =>
        apiClient.get('/api/v1/communities')
      );

      const responses = await Promise.all(requests);
      const duration = performance.now() - start;

      // All requests should succeed
      responses.forEach((response) => {
        apiClient.assertSuccess(response);
      });

      expect(duration).toBeLessThan(maxResponseTime);
      console.log(
        `Load test: ${concurrentRequests} requests in ${duration.toFixed(2)}ms`
      );
    });
  });
});
