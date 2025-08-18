/**
 * File Routes Integration Tests
 *
 * Integration tests for file upload and management endpoints including:
 * - Multipart file upload with authentication
 * - File serving with access control and community scoping
 * - File management operations (info, delete, list)
 * - Security validation and data sovereignty
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from 'vitest';
import { build } from '../../src/app.js';
import { FastifyInstance } from 'fastify';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';

describe('File Routes Integration', () => {
  let app: FastifyInstance;
  let testUploadDir: string;
  let authCookie: string;
  let testUser: any;
  let testCommunity: any;

  beforeAll(async () => {
    // Create temporary upload directory for tests
    testUploadDir = join(process.cwd(), 'test-uploads-integration');
    await mkdir(testUploadDir, { recursive: true });

    // Override environment for testing
    process.env.UPLOAD_DIR = testUploadDir;
    process.env.NODE_ENV = 'test';
  });

  afterAll(async () => {
    // Clean up test upload directory
    await rm(testUploadDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    app = build({ logger: false });
    await app.ready();

    // Create test user and community
    testCommunity = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/communities',
        payload: {
          name: 'Test Community',
          locale: 'en',
        },
      })
      .then((res) => JSON.parse(res.body).data);

    testUser = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          email: 'test@example.com',
          password: 'securepassword123',
          firstName: 'Test',
          lastName: 'User',
          role: 'editor',
          communityId: testCommunity.id,
        },
      })
      .then((res) => JSON.parse(res.body).data);

    // Login to get auth cookie
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: 'test@example.com',
        password: 'securepassword123',
        communityId: testCommunity.id,
      },
    });

    authCookie =
      loginResponse.cookies.find((c) => c.name === 'session')?.value || '';
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /api/v1/files/upload', () => {
    it('should upload file with authentication and community scoping', async () => {
      // Create mock JPEG file
      const jpegBuffer = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]), // JPEG magic number
        Buffer.from('fake jpeg data for testing'),
      ]);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files/upload',
        headers: {
          'content-type': 'multipart/form-data; boundary=----formdata-test',
          cookie: `session=${authCookie}`,
        },
        payload: [
          '------formdata-test',
          'Content-Disposition: form-data; name="file"; filename="test.jpg"',
          'Content-Type: image/jpeg',
          '',
          jpegBuffer.toString('binary'),
          '------formdata-test--',
        ].join('\r\n'),
      });

      expect(response.statusCode).toBe(201);

      const result = JSON.parse(response.body);
      expect(result.data).toBeDefined();
      expect(result.data.originalName).toBe('test.jpg');
      expect(result.data.mimeType).toBe('image/jpeg');
      expect(result.data.communityId).toBe(testCommunity.id);
      expect(result.data.uploadedBy).toBe(testUser.id);
      expect(result.data.url).toMatch(/^\/api\/v1\/files\//);
    });

    it('should reject upload without authentication', async () => {
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files/upload',
        headers: {
          'content-type': 'multipart/form-data; boundary=----formdata-test',
          // No auth cookie
        },
        payload: [
          '------formdata-test',
          'Content-Disposition: form-data; name="file"; filename="test.jpg"',
          'Content-Type: image/jpeg',
          '',
          jpegBuffer.toString('binary'),
          '------formdata-test--',
        ].join('\r\n'),
      });

      expect(response.statusCode).toBe(401);

      const result = JSON.parse(response.body);
      expect(result.error).toContain('Authentication required');
    });

    it('should handle multipart form data with cultural restrictions', async () => {
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files/upload',
        headers: {
          'content-type': 'multipart/form-data; boundary=----formdata-test',
          cookie: `session=${authCookie}`,
        },
        payload: [
          '------formdata-test',
          'Content-Disposition: form-data; name="file"; filename="sacred-image.jpg"',
          'Content-Type: image/jpeg',
          '',
          jpegBuffer.toString('binary'),
          '------formdata-test',
          'Content-Disposition: form-data; name="culturalRestrictions"',
          '',
          JSON.stringify({ elderOnly: true }),
          '------formdata-test--',
        ].join('\r\n'),
      });

      expect(response.statusCode).toBe(201);

      const result = JSON.parse(response.body);
      expect(result.data.culturalRestrictions).toEqual({ elderOnly: true });
    });

    it('should return proper error for oversized files', async () => {
      // Create oversized file (>10MB for images)
      const oversizedBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files/upload',
        headers: {
          'content-type': 'multipart/form-data; boundary=----formdata-test',
          cookie: `session=${authCookie}`,
        },
        payload: [
          '------formdata-test',
          'Content-Disposition: form-data; name="file"; filename="large.jpg"',
          'Content-Type: image/jpeg',
          '',
          oversizedBuffer.toString('binary'),
          '------formdata-test--',
        ].join('\r\n'),
      });

      expect(response.statusCode).toBe(413);

      const result = JSON.parse(response.body);
      expect(result.error).toContain('File size exceeds maximum');
    });

    it('should reject invalid file types', async () => {
      // Executable file with malicious header
      const maliciousBuffer = Buffer.from([0x4d, 0x5a]); // PE executable header

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/files/upload',
        headers: {
          'content-type': 'multipart/form-data; boundary=----formdata-test',
          cookie: `session=${authCookie}`,
        },
        payload: [
          '------formdata-test',
          'Content-Disposition: form-data; name="file"; filename="malicious.jpg"',
          'Content-Type: image/jpeg',
          '',
          maliciousBuffer.toString('binary'),
          '------formdata-test--',
        ].join('\r\n'),
      });

      expect(response.statusCode).toBe(415);

      const result = JSON.parse(response.body);
      expect(result.error).toContain('File type not allowed');
    });
  });

  describe('GET /api/v1/files/:id', () => {
    let uploadedFileId: string;

    beforeEach(async () => {
      // Upload a test file first
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

      const uploadResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/files/upload',
        headers: {
          'content-type': 'multipart/form-data; boundary=----formdata-test',
          cookie: `session=${authCookie}`,
        },
        payload: [
          '------formdata-test',
          'Content-Disposition: form-data; name="file"; filename="test.jpg"',
          'Content-Type: image/jpeg',
          '',
          jpegBuffer.toString('binary'),
          '------formdata-test--',
        ].join('\r\n'),
      });

      uploadedFileId = JSON.parse(uploadResponse.body).data.id;
    });

    it('should serve file with proper access control', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${uploadedFileId}`,
        headers: {
          cookie: `session=${authCookie}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/jpeg');
      expect(response.headers['content-disposition']).toContain('test.jpg');
    });

    it('should block access without authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${uploadedFileId}`,
        // No auth cookie
      });

      expect(response.statusCode).toBe(401);
    });

    it('should respect elder-only cultural restrictions', async () => {
      // Upload file with elder-only restriction
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

      const uploadResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/files/upload',
        headers: {
          'content-type': 'multipart/form-data; boundary=----formdata-test',
          cookie: `session=${authCookie}`,
        },
        payload: [
          '------formdata-test',
          'Content-Disposition: form-data; name="file"; filename="sacred.jpg"',
          'Content-Type: image/jpeg',
          '',
          jpegBuffer.toString('binary'),
          '------formdata-test',
          'Content-Disposition: form-data; name="culturalRestrictions"',
          '',
          JSON.stringify({ elderOnly: true }),
          '------formdata-test--',
        ].join('\r\n'),
      });

      const elderFileId = JSON.parse(uploadResponse.body).data.id;

      // Non-elder user should be blocked
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${elderFileId}`,
        headers: {
          cookie: `session=${authCookie}`,
        },
      });

      expect(response.statusCode).toBe(403);

      const result = JSON.parse(response.body);
      expect(result.error).toContain('elder-only cultural content');
    });
  });

  describe('GET /api/v1/files/:id/info', () => {
    let uploadedFileId: string;

    beforeEach(async () => {
      // Upload a test file first
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

      const uploadResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/files/upload',
        headers: {
          'content-type': 'multipart/form-data; boundary=----formdata-test',
          cookie: `session=${authCookie}`,
        },
        payload: [
          '------formdata-test',
          'Content-Disposition: form-data; name="file"; filename="test.jpg"',
          'Content-Type: image/jpeg',
          '',
          jpegBuffer.toString('binary'),
          '------formdata-test--',
        ].join('\r\n'),
      });

      uploadedFileId = JSON.parse(uploadResponse.body).data.id;
    });

    it('should return file metadata with access control', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${uploadedFileId}/info`,
        headers: {
          cookie: `session=${authCookie}`,
        },
      });

      expect(response.statusCode).toBe(200);

      const result = JSON.parse(response.body);
      expect(result.data).toBeDefined();
      expect(result.data.id).toBe(uploadedFileId);
      expect(result.data.originalName).toBe('test.jpg');
      expect(result.data.mimeType).toBe('image/jpeg');
      expect(result.data.communityId).toBe(testCommunity.id);
    });
  });

  describe('DELETE /api/v1/files/:id', () => {
    let uploadedFileId: string;

    beforeEach(async () => {
      // Upload a test file first
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

      const uploadResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/files/upload',
        headers: {
          'content-type': 'multipart/form-data; boundary=----formdata-test',
          cookie: `session=${authCookie}`,
        },
        payload: [
          '------formdata-test',
          'Content-Disposition: form-data; name="file"; filename="test.jpg"',
          'Content-Type: image/jpeg',
          '',
          jpegBuffer.toString('binary'),
          '------formdata-test--',
        ].join('\r\n'),
      });

      uploadedFileId = JSON.parse(uploadResponse.body).data.id;
    });

    it('should delete file with proper authorization', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/files/${uploadedFileId}`,
        headers: {
          cookie: `session=${authCookie}`,
        },
      });

      expect(response.statusCode).toBe(204);

      // Verify file is deleted
      const getResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${uploadedFileId}`,
        headers: {
          cookie: `session=${authCookie}`,
        },
      });

      expect(getResponse.statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/files', () => {
    beforeEach(async () => {
      // Upload multiple test files
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

      for (let i = 1; i <= 3; i++) {
        await app.inject({
          method: 'POST',
          url: '/api/v1/files/upload',
          headers: {
            'content-type': 'multipart/form-data; boundary=----formdata-test',
            cookie: `session=${authCookie}`,
          },
          payload: [
            '------formdata-test',
            `Content-Disposition: form-data; name="file"; filename="test${i}.jpg"`,
            'Content-Type: image/jpeg',
            '',
            jpegBuffer.toString('binary'),
            '------formdata-test--',
          ].join('\r\n'),
        });
      }
    });

    it('should list files with community scoping and pagination', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/files?page=1&limit=10',
        headers: {
          cookie: `session=${authCookie}`,
        },
      });

      expect(response.statusCode).toBe(200);

      const result = JSON.parse(response.body);
      expect(result.data).toHaveLength(3);
      expect(result.meta).toBeDefined();
      expect(result.meta.total).toBe(3);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(10);

      // Verify all files belong to the same community
      result.data.forEach((file: any) => {
        expect(file.communityId).toBe(testCommunity.id);
      });
    });

    it('should support filtering by file type', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/files?type=image',
        headers: {
          cookie: `session=${authCookie}`,
        },
      });

      expect(response.statusCode).toBe(200);

      const result = JSON.parse(response.body);
      result.data.forEach((file: any) => {
        expect(file.mimeType).toMatch(/^image\//);
      });
    });
  });
});
