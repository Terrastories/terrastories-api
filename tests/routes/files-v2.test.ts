/**
 * Files V2 Routes Tests
 *
 * Tests for the TypeScript-native file service API endpoints.
 * These routes provide entity-based file operations for ActiveStorage replacement.
 *
 * Tests follow TDD approach - defining expected API behavior before implementation.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  vi,
} from 'vitest';
import { FastifyInstance } from 'fastify';
import { createTestApp } from '../helpers/api-client.js';
import { TestDataFactory, testDb } from '../helpers/database.js';
import { createReadStream } from 'fs';
import { writeFile, mkdir, rm } from 'fs/promises';
import { getCommunitiesTable } from '../../src/db/schema/communities.js';
import { join } from 'path';

describe('Files V2 Routes', () => {
  let app: FastifyInstance;
  let testUser: any;
  let testCommunity: any;
  let authCookie: string;
  let testUploadDir: string;

  // Helper to create test file content
  function createTestFileBuffer(content: string = 'test file content'): Buffer {
    return Buffer.from(content, 'utf-8');
  }

  // Helper to create form data for file uploads
  async function createFormDataForUpload(params: {
    filename: string;
    content: string;
    mimetype: string;
    community: string;
    entity: string;
    entityId: string;
  }) {
    const FormData = (await import('form-data')).default;
    const form = new FormData();

    // Create file buffer and write to temporary file
    const fileBuffer = createTestFileBuffer(params.content);
    const tempFilePath = join(testUploadDir, params.filename);
    await writeFile(tempFilePath, fileBuffer);

    // Append file to form data
    form.append('file', createReadStream(tempFilePath), {
      filename: params.filename,
      contentType: params.mimetype,
    });

    // Append other form fields
    form.append('community', params.community);
    form.append('entity', params.entity);
    form.append('entityId', params.entityId);

    return {
      headers: form.getHeaders(),
      payload: form,
    };
  }

  beforeAll(async () => {
    // Create temporary upload directory for tests
    testUploadDir = join(process.cwd(), 'test-uploads-v2-integration');
    await mkdir(testUploadDir, { recursive: true });

    // Override environment for testing
    process.env.FILES_V2_UPLOAD_DIR = testUploadDir;
    process.env.NODE_ENV = 'test';
    process.env.FILES_MAX_SIZE_MB = '25';
  });

  afterAll(async () => {
    // Clean up test upload directory
    await rm(testUploadDir, { recursive: true, force: true });
    await testDb.teardown();
  });

  // Helper function to create authenticated user in different community
  async function createCrossCommunitAuth() {
    const db = testDb.getDb();
    const communitiesTable = await getCommunitiesTable();

    // Create another community
    const [otherCommunity] = await db
      .insert(communitiesTable)
      .values(TestDataFactory.createCommunity({ name: 'Other Community' }))
      .returning();

    // Register user in other community
    const userEmail = 'other-user@example.com';
    const userPassword = 'OtherPassword123!';
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: userEmail,
        password: userPassword,
        firstName: 'Other',
        lastName: 'User',
        role: 'editor',
        communityId: otherCommunity.id,
      },
    });

    if (registerResponse.statusCode !== 201) {
      throw new Error(
        `Other user registration failed: ${registerResponse.body}`
      );
    }

    const otherUser = JSON.parse(registerResponse.body).user;

    // Login to get auth cookie
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: userEmail,
        password: userPassword,
        communityId: otherCommunity.id,
      },
    });

    if (loginResponse.statusCode !== 200) {
      throw new Error(`Other user login failed: ${loginResponse.body}`);
    }

    // Extract session cookie
    const cookies = loginResponse.cookies;
    const sessionCookie = cookies.find((cookie) => cookie.name === 'sessionId');
    if (!sessionCookie) {
      throw new Error('No session cookie found for other user');
    }
    const otherAuthCookie = `${sessionCookie.name}=${sessionCookie.value}`;

    return {
      user: otherUser,
      community: otherCommunity,
      authCookie: otherAuthCookie,
    };
  }

  beforeEach(async () => {
    const db = await testDb.setup();
    await testDb.clearData();

    // Create test app with test database
    app = await createTestApp(db);
    await app.ready();

    // Create test community directly in the database
    const communitiesTable = await getCommunitiesTable();
    [testCommunity] = await db
      .insert(communitiesTable)
      .values(
        TestDataFactory.createCommunity({ name: 'Files V2 Test Community' })
      )
      .returning();

    // Register user via API to ensure password is handled correctly
    const userEmail = 'files-v2-user@example.com';
    const userPassword = 'SecurePassword123!';
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: userEmail,
        password: userPassword,
        firstName: 'FilesV2',
        lastName: 'User',
        role: 'editor',
        communityId: testCommunity.id,
      },
    });

    if (registerResponse.statusCode !== 201) {
      throw new Error(
        `Registration failed with status ${registerResponse.statusCode}: ${registerResponse.body}`
      );
    }

    const registerResult = JSON.parse(registerResponse.body);
    testUser = registerResult.user;

    // Login to get auth cookie
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: userEmail,
        password: userPassword,
        communityId: testCommunity.id,
      },
    });

    if (loginResponse.statusCode !== 200) {
      throw new Error(
        `Login failed with status ${loginResponse.statusCode}: ${loginResponse.body}`
      );
    }

    // Extract session cookie
    const cookies = loginResponse.cookies;
    const sessionCookie = cookies.find((cookie) => cookie.name === 'sessionId');
    if (!sessionCookie) {
      throw new Error('No session cookie found in login response');
    }
    authCookie = `${sessionCookie.name}=${sessionCookie.value}`;
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /api/v1/files-v2/upload', () => {
    it('should upload a file with entity parameters', async () => {
      const formData = await createFormDataForUpload({
        filename: 'test.txt',
        content: 'test file content',
        mimetype: 'text/plain',
        community: testCommunity.slug,
        entity: 'stories',
        entityId: '123',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files-v2/upload',
        headers: {
          ...formData.headers,
          cookie: authCookie,
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
        const formData = await createFormDataForUpload({
          filename: `${entity}-test.txt`,
          content: `${entity} content`,
          mimetype: 'text/plain',
          community: testCommunity.slug,
          entity,
          entityId: entityId.toString(),
        });

        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/files-v2/upload',
          headers: {
            ...formData.headers,
            cookie: authCookie,
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
        const formData = await createFormDataForUpload({
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
            cookie: authCookie,
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
        const formData = await createFormDataForUpload({
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
            cookie: authCookie,
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
        const formData = await createFormDataForUpload({
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
            cookie: authCookie,
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
      const otherAuth = await createCrossCommunitAuth();

      const formData = await createFormDataForUpload({
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
          cookie: otherAuth.authCookie, // Use other user's cookie
        },
        payload: formData.payload,
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.payload).error).toContain('community access');
    });

    it('should require authentication', async () => {
      const formData = await createFormDataForUpload({
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

      const formData = await createFormDataForUpload({
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
          cookie: authCookie,
        },
        payload: formData.payload,
      });

      expect(response.statusCode).toBe(413);
      expect(JSON.parse(response.payload).error).toContain('File size exceeds');
    });

    it('should handle rate limiting', async () => {
      // Make multiple rapid requests to trigger rate limiting
      const requests = Array.from({ length: 15 }, async () => {
        const formData = await createFormDataForUpload({
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
            cookie: authCookie,
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
      const formData = await createFormDataForUpload({
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
          cookie: authCookie,
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
          cookie: authCookie,
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
          cookie: authCookie,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.payload).error).toContain('File not found');
    });

    it('should enforce community access control', async () => {
      const otherAuth = await createCrossCommunitAuth();

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/${testCommunity.slug}/stories/123/${uploadedFile.filename}`,
        headers: {
          cookie: otherAuth.authCookie,
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
            cookie: authCookie,
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
      const formData = await createFormDataForUpload({
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
          cookie: authCookie,
        },
        payload: formData.payload,
      });

      const largeFile = JSON.parse(uploadResponse.payload).data;

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/${testCommunity.slug}/stories/124/${largeFile.filename}`,
        headers: {
          cookie: authCookie,
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
      const formData = await createFormDataForUpload({
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
          cookie: authCookie,
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
          cookie: authCookie,
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.payload).toBe('');

      // Verify file is gone
      const downloadResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/${testCommunity.slug}/stories/123/${uploadedFile.filename}`,
        headers: {
          cookie: authCookie,
        },
      });

      expect(downloadResponse.statusCode).toBe(404);
    });

    it('should return 404 for non-existent files', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/files-v2/${testCommunity.slug}/stories/123/non-existent.txt`,
        headers: {
          cookie: authCookie,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.payload).error).toContain('File not found');
    });

    it('should enforce community access control', async () => {
      const otherAuth = await createCrossCommunitAuth();

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/files-v2/${testCommunity.slug}/stories/123/${uploadedFile.filename}`,
        headers: {
          cookie: otherAuth.authCookie,
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
        const formData = await createFormDataForUpload({
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
            cookie: authCookie,
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
          cookie: authCookie,
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
          cookie: authCookie,
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
          cookie: authCookie,
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
          cookie: authCookie,
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
          cookie: authCookie,
        },
      });

      const page2Result = JSON.parse(page2Response.payload);
      expect(page2Result.data.files).toHaveLength(2);
      expect(page2Result.data.page).toBe(2);
    });

    it('should enforce community access control', async () => {
      const otherAuth = await createCrossCommunitAuth();

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files-v2/list?community=${testCommunity.slug}`,
        headers: {
          cookie: otherAuth.authCookie,
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
            cookie: authCookie,
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
              cookie: authCookie,
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
            headers: { cookie: authCookie },
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

      const formData = await createFormDataForUpload({
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
          cookie: authCookie,
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
