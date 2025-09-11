/**
 * Files V2 Routes Tests
 *
 * Tests for the TypeScript-native file service API endpoints.
 * These routes provide entity-based file operations for ActiveStorage replacement.
 *
 * Tests follow TDD approach - defining expected API behavior before implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { build } from '../helpers/app.js';
import { createAuthenticatedUser, type TestUser } from '../helpers/auth.js';
import { setupTestDatabase, cleanupTestDatabase } from '../helpers/database.js';
import { createFormData } from '../helpers/multipart.js';

describe('Files V2 Routes', () => {
  let app: FastifyInstance;
  let testUser: TestUser;
  let testCommunity: any;

  beforeEach(async () => {
    await setupTestDatabase();
    app = await build({ testing: true });

    // Create test user and community
    const authResult = await createAuthenticatedUser(app);
    testUser = authResult.user;
    testCommunity = authResult.community;
  });

  afterEach(async () => {
    await app.close();
    await cleanupTestDatabase();
  });

  describe('POST /api/v1/files-v2/upload', () => {
    it('should upload a file with entity parameters', async () => {
      const formData = createFormData({
        file: {
          filename: 'test.txt',
          content: 'test file content',
          mimetype: 'text/plain',
        },
        community: testCommunity.slug,
        entity: 'stories',
        entityId: '123',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files-v2/upload',
        headers: {
          ...formData.headers,
          authorization: `Bearer ${testUser.token}`,
        },
        payload: formData.payload,
      });

      expect(response.statusCode).toBe(201);

      const result = JSON.parse(response.payload);
      expect(result.data).toMatchObject({
        filename: expect.stringMatching(/^[0-9a-f-]+\.txt$/),
        originalName: 'test.txt',
        path: expect.stringMatching(
          new RegExp(
            `^uploads/${testCommunity.slug}/stories/123/[0-9a-f-]+\\.txt$`
          )
        ),
        url: expect.stringMatching(
          new RegExp(
            `^/api/v1/files-v2/${testCommunity.slug}/stories/123/[0-9a-f-]+\\.txt$`
          )
        ),
        size: 17, // 'test file content'.length
        mimeType: 'text/plain',
        community: testCommunity.slug,
        entity: 'stories',
        entityId: 123,
        uploadedBy: testUser.id,
        createdAt: expect.any(String),
      });
    });

    it('should support different entity types', async () => {
      const entities = [
        { entity: 'stories', entityId: 123 },
        { entity: 'places', entityId: 456 },
        { entity: 'speakers', entityId: 789 },
      ];

      for (const { entity, entityId } of entities) {
        const formData = createFormData({
          file: {
            filename: `${entity}-test.txt`,
            content: `${entity} content`,
            mimetype: 'text/plain',
          },
          community: testCommunity.slug,
          entity,
          entityId: entityId.toString(),
        });

        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/files-v2/upload',
          headers: {
            ...formData.headers,
            authorization: `Bearer ${testUser.token}`,
          },
          payload: formData.payload,
        });

        expect(response.statusCode).toBe(201);

        const result = JSON.parse(response.payload);
        expect(result.data.entity).toBe(entity);
        expect(result.data.entityId).toBe(entityId);
      }
    });

    it('should validate required fields', async () => {
      const testCases = [
        {
          missing: 'file',
          fields: {
            community: testCommunity.slug,
            entity: 'stories',
            entityId: '123',
          },
        },
        {
          missing: 'community',
          fields: { entity: 'stories', entityId: '123' },
        },
        {
          missing: 'entity',
          fields: { community: testCommunity.slug, entityId: '123' },
        },
        {
          missing: 'entityId',
          fields: { community: testCommunity.slug, entity: 'stories' },
        },
      ];

      for (const { missing, fields } of testCases) {
        const formData = createFormData({
          ...fields,
          ...(missing !== 'file' && {
            file: {
              filename: 'test.txt',
              content: 'test content',
              mimetype: 'text/plain',
            },
          }),
        });

        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/files-v2/upload',
          headers: {
            ...formData.headers,
            authorization: `Bearer ${testUser.token}`,
          },
          payload: formData.payload,
        });

        expect(response.statusCode).toBe(400);

        const result = JSON.parse(response.payload);
        expect(result.error).toContain(missing);
      }
    });

    it('should validate entity types', async () => {
      const invalidEntities = ['invalid', 'users', 'communities', ''];

      for (const entity of invalidEntities) {
        const formData = createFormData({
          file: {
            filename: 'test.txt',
            content: 'test content',
            mimetype: 'text/plain',
          },
          community: testCommunity.slug,
          entity,
          entityId: '123',
        });

        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/files-v2/upload',
          headers: {
            ...formData.headers,
            authorization: `Bearer ${testUser.token}`,
          },
          payload: formData.payload,
        });

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.payload).error).toContain('Invalid entity');
      }
    });

    it('should validate MIME types', async () => {
      const testCases = [
        { filename: 'image.jpg', mimetype: 'image/jpeg', shouldSucceed: true },
        { filename: 'audio.mp3', mimetype: 'audio/mpeg', shouldSucceed: true },
        {
          filename: 'document.txt',
          mimetype: 'text/plain',
          shouldSucceed: true,
        },
        {
          filename: 'executable.exe',
          mimetype: 'application/x-executable',
          shouldSucceed: false,
        },
        {
          filename: 'script.js',
          mimetype: 'application/javascript',
          shouldSucceed: false,
        },
      ];

      for (const { filename, mimetype, shouldSucceed } of testCases) {
        const formData = createFormData({
          file: {
            filename,
            content: 'file content',
            mimetype,
          },
          community: testCommunity.slug,
          entity: 'stories',
          entityId: '123',
        });

        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/files-v2/upload',
          headers: {
            ...formData.headers,
            authorization: `Bearer ${testUser.token}`,
          },
          payload: formData.payload,
        });

        if (shouldSucceed) {
          expect(response.statusCode).toBe(201);
        } else {
          expect(response.statusCode).toBe(415);
          expect(JSON.parse(response.payload).error).toContain(
            'File type not allowed'
          );
        }
      }
    });

    it('should enforce community access control', async () => {
      // Create another user in different community
      const otherAuth = await createAuthenticatedUser(app);

      const formData = createFormData({
        file: {
          filename: 'unauthorized.txt',
          content: 'unauthorized content',
          mimetype: 'text/plain',
        },
        community: testCommunity.slug, // Try to upload to different community
        entity: 'stories',
        entityId: '123',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files-v2/upload',
        headers: {
          ...formData.headers,
          authorization: `Bearer ${otherAuth.user.token}`, // Use other user's token
        },
        payload: formData.payload,
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.payload).error).toContain('community access');
    });

    it('should require authentication', async () => {
      const formData = createFormData({
        file: {
          filename: 'test.txt',
          content: 'test content',
          mimetype: 'text/plain',
        },
        community: testCommunity.slug,
        entity: 'stories',
        entityId: '123',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files-v2/upload',
        headers: formData.headers,
        payload: formData.payload,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should enforce file size limits', async () => {
      // Create large file content (assuming 10MB limit)
      const largeContent = 'x'.repeat(11 * 1024 * 1024); // 11MB

      const formData = createFormData({
        file: {
          filename: 'large.txt',
          content: largeContent,
          mimetype: 'text/plain',
        },
        community: testCommunity.slug,
        entity: 'stories',
        entityId: '123',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files-v2/upload',
        headers: {
          ...formData.headers,
          authorization: `Bearer ${testUser.token}`,
        },
        payload: formData.payload,
      });

      expect(response.statusCode).toBe(413);
      expect(JSON.parse(response.payload).error).toContain('File size exceeds');
    });

    it('should handle rate limiting', async () => {
      // Make multiple rapid requests to trigger rate limiting
      const requests = Array.from({ length: 15 }, () => {
        const formData = createFormData({
          file: {
            filename: 'rate-test.txt',
            content: 'rate limit test',
            mimetype: 'text/plain',
          },
          community: testCommunity.slug,
          entity: 'stories',
          entityId: Math.floor(Math.random() * 1000).toString(),
        });

        return app.inject({
          method: 'POST',
          url: '/api/v1/files-v2/upload',
          headers: {
            ...formData.headers,
            authorization: `Bearer ${testUser.token}`,
          },
          payload: formData.payload,
        });
      });

      const responses = await Promise.all(requests);

      // Some requests should succeed, others should be rate limited
      const successCount = responses.filter((r) => r.statusCode === 201).length;
      const rateLimitedCount = responses.filter(
        (r) => r.statusCode === 429
      ).length;

      expect(successCount).toBeGreaterThan(0);
      expect(rateLimitedCount).toBeGreaterThan(0);
      expect(successCount + rateLimitedCount).toBe(15);
    });
  });

  describe('GET /api/v1/files-v2/:community/:entity/:entityId/:filename', () => {
    let uploadedFile: any;

    beforeEach(async () => {
      // Upload a test file first
      const formData = createFormData({
        file: {
          filename: 'download-test.txt',
          content: 'download test content',
          mimetype: 'text/plain',
        },
        community: testCommunity.slug,
        entity: 'stories',
        entityId: '123',
      });

      const uploadResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/files-v2/upload',
        headers: {
          ...formData.headers,
          authorization: `Bearer ${testUser.token}`,
        },
        payload: formData.payload,
      });

      uploadedFile = JSON.parse(uploadResponse.payload).data;
    });

    it('should download an existing file', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/${testCommunity.slug}/stories/123/${uploadedFile.filename}`,
        headers: {
          authorization: `Bearer ${testUser.token}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('download test content');
      expect(response.headers['content-type']).toBe('text/plain');
      expect(response.headers['content-length']).toBe('20'); // 'download test content'.length
      expect(response.headers['content-disposition']).toContain(
        'download-test.txt'
      );
      expect(response.headers['etag']).toBeDefined();
    });

    it('should return 404 for non-existent files', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/${testCommunity.slug}/stories/123/non-existent.txt`,
        headers: {
          authorization: `Bearer ${testUser.token}`,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.payload).error).toContain('File not found');
    });

    it('should enforce community access control', async () => {
      const otherAuth = await createAuthenticatedUser(app);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/${testCommunity.slug}/stories/123/${uploadedFile.filename}`,
        headers: {
          authorization: `Bearer ${otherAuth.user.token}`,
        },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.payload).error).toContain('Access denied');
    });

    it('should validate path parameters', async () => {
      const invalidPaths = [
        `/api/v1/files-v2/../../../etc/passwd/stories/123/${uploadedFile.filename}`,
        `/api/v1/files-v2/${testCommunity.slug}/invalid-entity/123/${uploadedFile.filename}`,
        `/api/v1/files-v2/${testCommunity.slug}/stories/abc/${uploadedFile.filename}`,
        `/api/v1/files-v2/${testCommunity.slug}/stories/123/../../../etc/passwd`,
      ];

      for (const path of invalidPaths) {
        const response = await app.inject({
          method: 'GET',
          url: path,
          headers: {
            authorization: `Bearer ${testUser.token}`,
          },
        });

        expect(response.statusCode).toBe(400);
      }
    });

    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/${testCommunity.slug}/stories/123/${uploadedFile.filename}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should handle large file streaming', async () => {
      // Upload a larger file first
      const largeContent = 'x'.repeat(1024 * 100); // 100KB
      const formData = createFormData({
        file: {
          filename: 'large-download.txt',
          content: largeContent,
          mimetype: 'text/plain',
        },
        community: testCommunity.slug,
        entity: 'stories',
        entityId: '124',
      });

      const uploadResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/files-v2/upload',
        headers: {
          ...formData.headers,
          authorization: `Bearer ${testUser.token}`,
        },
        payload: formData.payload,
      });

      const largeFile = JSON.parse(uploadResponse.payload).data;

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/${testCommunity.slug}/stories/124/${largeFile.filename}`,
        headers: {
          authorization: `Bearer ${testUser.token}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body.length).toBe(largeContent.length);
      expect(response.headers['content-length']).toBe(
        largeContent.length.toString()
      );
    });
  });

  describe('DELETE /api/v1/files-v2/:community/:entity/:entityId/:filename', () => {
    let uploadedFile: any;

    beforeEach(async () => {
      // Upload a test file first
      const formData = createFormData({
        file: {
          filename: 'delete-test.txt',
          content: 'to be deleted',
          mimetype: 'text/plain',
        },
        community: testCommunity.slug,
        entity: 'stories',
        entityId: '123',
      });

      const uploadResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/files-v2/upload',
        headers: {
          ...formData.headers,
          authorization: `Bearer ${testUser.token}`,
        },
        payload: formData.payload,
      });

      uploadedFile = JSON.parse(uploadResponse.payload).data;
    });

    it('should delete an existing file', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/files-v2/${testCommunity.slug}/stories/123/${uploadedFile.filename}`,
        headers: {
          authorization: `Bearer ${testUser.token}`,
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.payload).toBe('');

      // Verify file is gone
      const downloadResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/${testCommunity.slug}/stories/123/${uploadedFile.filename}`,
        headers: {
          authorization: `Bearer ${testUser.token}`,
        },
      });

      expect(downloadResponse.statusCode).toBe(404);
    });

    it('should return 404 for non-existent files', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/files-v2/${testCommunity.slug}/stories/123/non-existent.txt`,
        headers: {
          authorization: `Bearer ${testUser.token}`,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.payload).error).toContain('File not found');
    });

    it('should enforce community access control', async () => {
      const otherAuth = await createAuthenticatedUser(app);

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/files-v2/${testCommunity.slug}/stories/123/${uploadedFile.filename}`,
        headers: {
          authorization: `Bearer ${otherAuth.user.token}`,
        },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.payload).error).toContain('Access denied');
    });

    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/files-v2/${testCommunity.slug}/stories/123/${uploadedFile.filename}`,
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/files-v2/list', () => {
    beforeEach(async () => {
      // Upload test files
      const testFiles = [
        { name: 'story1.txt', entity: 'stories', entityId: 123 },
        { name: 'story2.txt', entity: 'stories', entityId: 124 },
        {
          name: 'place1.jpg',
          entity: 'places',
          entityId: 456,
          mimetype: 'image/jpeg',
        },
        {
          name: 'speaker1.mp3',
          entity: 'speakers',
          entityId: 789,
          mimetype: 'audio/mpeg',
        },
      ];

      for (const {
        name,
        entity,
        entityId,
        mimetype = 'text/plain',
      } of testFiles) {
        const formData = createFormData({
          file: {
            filename: name,
            content: `${entity} content`,
            mimetype,
          },
          community: testCommunity.slug,
          entity,
          entityId: entityId.toString(),
        });

        await app.inject({
          method: 'POST',
          url: '/api/v1/files-v2/upload',
          headers: {
            ...formData.headers,
            authorization: `Bearer ${testUser.token}`,
          },
          payload: formData.payload,
        });
      }
    });

    it('should list all files in community', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/list?community=${testCommunity.slug}`,
        headers: {
          authorization: `Bearer ${testUser.token}`,
        },
      });

      expect(response.statusCode).toBe(200);

      const result = JSON.parse(response.payload);
      expect(result.data.files).toHaveLength(4);
      expect(result.data.total).toBe(4);
      expect(result.data.page).toBe(1);

      // All files should be from the correct community
      result.data.files.forEach((file: any) => {
        expect(file.community).toBe(testCommunity.slug);
      });
    });

    it('should filter by entity type', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/list?community=${testCommunity.slug}&entity=stories`,
        headers: {
          authorization: `Bearer ${testUser.token}`,
        },
      });

      expect(response.statusCode).toBe(200);

      const result = JSON.parse(response.payload);
      expect(result.data.files).toHaveLength(2);
      result.data.files.forEach((file: any) => {
        expect(file.entity).toBe('stories');
      });
    });

    it('should filter by entity ID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/list?community=${testCommunity.slug}&entity=stories&entityId=123`,
        headers: {
          authorization: `Bearer ${testUser.token}`,
        },
      });

      expect(response.statusCode).toBe(200);

      const result = JSON.parse(response.payload);
      expect(result.data.files).toHaveLength(1);
      expect(result.data.files[0].entityId).toBe(123);
    });

    it('should support pagination', async () => {
      const page1Response = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/list?community=${testCommunity.slug}&page=1&limit=2`,
        headers: {
          authorization: `Bearer ${testUser.token}`,
        },
      });

      expect(page1Response.statusCode).toBe(200);

      const page1Result = JSON.parse(page1Response.payload);
      expect(page1Result.data.files).toHaveLength(2);
      expect(page1Result.data.page).toBe(1);
      expect(page1Result.data.totalPages).toBe(2);

      const page2Response = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/list?community=${testCommunity.slug}&page=2&limit=2`,
        headers: {
          authorization: `Bearer ${testUser.token}`,
        },
      });

      const page2Result = JSON.parse(page2Response.payload);
      expect(page2Result.data.files).toHaveLength(2);
      expect(page2Result.data.page).toBe(2);
    });

    it('should enforce community access control', async () => {
      const otherAuth = await createAuthenticatedUser(app);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/list?community=${testCommunity.slug}`,
        headers: {
          authorization: `Bearer ${otherAuth.user.token}`,
        },
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.payload).error).toContain('Access denied');
    });

    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/list?community=${testCommunity.slug}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should validate query parameters', async () => {
      const invalidQueries = [
        '?community=', // Empty community
        '?community=../../../etc', // Path traversal
        '?community=test&entity=invalid', // Invalid entity
        '?community=test&entityId=-1', // Invalid entity ID
        '?community=test&page=0', // Invalid page
        '?community=test&limit=0', // Invalid limit
        '?community=test&limit=1000', // Limit too high
      ];

      for (const query of invalidQueries) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/files-v2/list${query}`,
          headers: {
            authorization: `Bearer ${testUser.token}`,
          },
        });

        expect(response.statusCode).toBe(400);
      }
    });
  });

  describe('error handling', () => {
    it('should return proper error responses', async () => {
      const errorTests = [
        {
          description: 'invalid JSON in multipart upload',
          request: {
            method: 'POST' as const,
            url: '/api/v1/files-v2/upload',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${testUser.token}`,
            },
            payload: '{"invalid": json}',
          },
          expectedStatus: 400,
        },
        {
          description: 'invalid route path',
          request: {
            method: 'GET' as const,
            url: '/api/v1/files-v2/invalid-path',
            headers: { authorization: `Bearer ${testUser.token}` },
          },
          expectedStatus: 404,
        },
      ];

      for (const { description, request, expectedStatus } of errorTests) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(expectedStatus);

        // Should return valid error JSON
        const result = JSON.parse(response.payload);
        expect(result).toHaveProperty('error');
        expect(result).toHaveProperty('statusCode', expectedStatus);
      }
    });

    it('should handle service errors gracefully', async () => {
      // Mock the file service to throw an error
      const originalService = (app as any).fileServiceV2;
      (app as any).fileServiceV2 = {
        uploadFile: async () => {
          throw new Error('Service temporarily unavailable');
        },
      };

      const formData = createFormData({
        file: {
          filename: 'error-test.txt',
          content: 'error content',
          mimetype: 'text/plain',
        },
        community: testCommunity.slug,
        entity: 'stories',
        entityId: '123',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files-v2/upload',
        headers: {
          ...formData.headers,
          authorization: `Bearer ${testUser.token}`,
        },
        payload: formData.payload,
      });

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.payload).error).toContain(
        'Service temporarily unavailable'
      );

      // Restore original service
      (app as any).fileServiceV2 = originalService;
    });
  });
});
