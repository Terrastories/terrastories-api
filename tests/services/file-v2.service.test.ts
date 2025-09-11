/**
 * FileServiceV2 Tests
 *
 * Tests for the TypeScript-native file service designed for ActiveStorage replacement.
 * This service uses entity-based paths and pluggable storage adapters.
 *
 * Testing approach follows TDD principles - these tests define the expected behavior
 * that the FileServiceV2 implementation must fulfill.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MultipartFile } from '@fastify/multipart';
import { Readable } from 'stream';
import { FileServiceV2 } from '../../src/services/file-v2.service.js';
import type {
  StorageAdapter,
  StorageFileMetadata,
} from '../../src/services/storage/storage-adapter.interface.js';

// Mock storage adapter for testing
class MockStorageAdapter implements StorageAdapter {
  private files = new Map<string, Buffer>();
  private metadata = new Map<string, StorageFileMetadata>();

  async upload(file: Buffer, path: string): Promise<string> {
    if (path.includes('..') || path.startsWith('/')) {
      throw new Error('Invalid path: path traversal detected');
    }

    this.files.set(path, file);
    this.metadata.set(path, {
      size: file.length,
      lastModified: new Date(),
      etag: `"${Buffer.from(path + file.length).toString('hex')}"`,
    });

    return path;
  }

  async download(path: string): Promise<Buffer> {
    const file = this.files.get(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    return file;
  }

  async delete(path: string): Promise<void> {
    if (!this.files.has(path)) {
      throw new Error(`File not found: ${path}`);
    }
    this.files.delete(path);
    this.metadata.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async getMetadata(path: string): Promise<StorageFileMetadata> {
    const metadata = this.metadata.get(path);
    if (!metadata) {
      throw new Error(`File not found: ${path}`);
    }
    return metadata;
  }

  // Helper methods for testing
  clear() {
    this.files.clear();
    this.metadata.clear();
  }

  getStoredFiles() {
    return Array.from(this.files.keys());
  }
}

// Helper to create mock multipart file
function createMockMultipartFile(
  filename: string,
  content: string,
  mimetype: string = 'text/plain'
): MultipartFile {
  const buffer = Buffer.from(content);
  const stream = Readable.from([buffer]);

  return {
    filename,
    mimetype,
    encoding: '7bit',
    file: stream,
    fieldname: 'file',
    fields: {},
  } as MultipartFile;
}

describe('FileServiceV2', () => {
  let mockStorage: MockStorageAdapter;
  let fileService: FileServiceV2;

  beforeEach(() => {
    mockStorage = new MockStorageAdapter();
    fileService = new FileServiceV2(mockStorage, {
      maxFileSize: 10 * 1024 * 1024, // 10MB
      allowedMimeTypes: {
        image: ['image/jpeg', 'image/png', 'image/gif'],
        audio: ['audio/mpeg', 'audio/wav', 'audio/ogg'],
        video: ['video/mp4', 'video/webm'],
      },
      enableVideo: false,
      rateLimiting: {
        windowMs: 60000, // 1 minute
        maxUploads: 10,
      },
    });
  });

  afterEach(() => {
    mockStorage.clear();
  });

  describe('uploadFile()', () => {
    it('should upload a file with entity-based path structure', async () => {
      const mockFile = createMockMultipartFile('test.txt', 'test content');

      const result = await fileService.uploadFile(mockFile, {
        community: 'community-1',
        entity: 'stories',
        entityId: 123,
        uploadedBy: 1,
      });

      expect(result).toMatchObject({
        filename: expect.stringMatching(/^[0-9a-f-]+\.txt$/), // UUID + extension
        originalName: 'test.txt',
        path: expect.stringMatching(
          /^uploads\/community-1\/stories\/123\/[0-9a-f-]+\.txt$/
        ),
        url: expect.stringMatching(
          /^\/api\/v1\/files-v2\/community-1\/stories\/123\/[0-9a-f-]+\.txt$/
        ),
        size: 12, // 'test content'.length
        mimeType: 'text/plain',
        community: 'community-1',
        entity: 'stories',
        entityId: 123,
        uploadedBy: 1,
      });

      // Verify file was stored with correct path
      const storedFiles = mockStorage.getStoredFiles();
      expect(storedFiles).toHaveLength(1);
      expect(storedFiles[0]).toMatch(
        /^uploads\/community-1\/stories\/123\/[0-9a-f-]+\.txt$/
      );
    });

    it('should support different entity types', async () => {
      const entities = [
        { entity: 'stories', entityId: 123 },
        { entity: 'places', entityId: 456 },
        { entity: 'speakers', entityId: 789 },
      ];

      for (const { entity, entityId } of entities) {
        const mockFile = createMockMultipartFile(
          `${entity}-test.txt`,
          `${entity} content`
        );

        const result = await fileService.uploadFile(mockFile, {
          community: 'community-1',
          entity: entity as any,
          entityId,
          uploadedBy: 1,
        });

        expect(result.entity).toBe(entity);
        expect(result.entityId).toBe(entityId);
        expect(result.path).toMatch(
          new RegExp(`^uploads/community-1/${entity}/${entityId}/`)
        );
      }
    });

    it('should validate MIME types', async () => {
      const validFiles = [
        createMockMultipartFile('image.jpg', 'fake jpeg', 'image/jpeg'),
        createMockMultipartFile('audio.mp3', 'fake mp3', 'audio/mpeg'),
        createMockMultipartFile('document.txt', 'text', 'text/plain'),
      ];

      for (const file of validFiles) {
        await expect(
          fileService.uploadFile(file, {
            community: 'community-1',
            entity: 'stories',
            entityId: 123,
            uploadedBy: 1,
          })
        ).resolves.toBeDefined();
      }

      // Invalid MIME type
      const invalidFile = createMockMultipartFile(
        'script.exe',
        'malicious',
        'application/x-executable'
      );
      await expect(
        fileService.uploadFile(invalidFile, {
          community: 'community-1',
          entity: 'stories',
          entityId: 123,
          uploadedBy: 1,
        })
      ).rejects.toThrow('File type not allowed');
    });

    it('should respect video enable flag', async () => {
      const videoFile = createMockMultipartFile(
        'video.mp4',
        'fake video',
        'video/mp4'
      );

      // Video disabled by default
      await expect(
        fileService.uploadFile(videoFile, {
          community: 'community-1',
          entity: 'stories',
          entityId: 123,
          uploadedBy: 1,
        })
      ).rejects.toThrow('Video files not enabled');

      // Create service with video enabled
      const videoEnabledService = new FileServiceV2(mockStorage, {
        maxFileSize: 10 * 1024 * 1024,
        allowedMimeTypes: {
          image: ['image/jpeg', 'image/png'],
          audio: ['audio/mpeg'],
          video: ['video/mp4'],
        },
        enableVideo: true,
        rateLimiting: { windowMs: 60000, maxUploads: 10 },
      });

      await expect(
        videoEnabledService.uploadFile(videoFile, {
          community: 'community-1',
          entity: 'stories',
          entityId: 123,
          uploadedBy: 1,
        })
      ).resolves.toBeDefined();
    });

    it('should enforce file size limits', async () => {
      const smallService = new FileServiceV2(mockStorage, {
        maxFileSize: 100, // 100 bytes
        allowedMimeTypes: {
          image: ['image/jpeg'],
          audio: ['audio/mpeg'],
          video: [],
        },
        enableVideo: false,
        rateLimiting: { windowMs: 60000, maxUploads: 10 },
      });

      const smallFile = createMockMultipartFile(
        'small.txt',
        'small',
        'text/plain'
      );
      const largeFile = createMockMultipartFile(
        'large.txt',
        'x'.repeat(200),
        'text/plain'
      );

      await expect(
        smallService.uploadFile(smallFile, {
          community: 'community-1',
          entity: 'stories',
          entityId: 123,
          uploadedBy: 1,
        })
      ).resolves.toBeDefined();

      await expect(
        smallService.uploadFile(largeFile, {
          community: 'community-1',
          entity: 'stories',
          entityId: 123,
          uploadedBy: 1,
        })
      ).rejects.toThrow('File size exceeds maximum');
    });

    it('should generate unique filenames by default', async () => {
      const file1 = createMockMultipartFile('same-name.txt', 'content 1');
      const file2 = createMockMultipartFile('same-name.txt', 'content 2');

      const result1 = await fileService.uploadFile(file1, {
        community: 'community-1',
        entity: 'stories',
        entityId: 123,
        uploadedBy: 1,
      });

      const result2 = await fileService.uploadFile(file2, {
        community: 'community-1',
        entity: 'stories',
        entityId: 123,
        uploadedBy: 1,
      });

      expect(result1.filename).not.toBe(result2.filename);
      expect(result1.originalName).toBe('same-name.txt');
      expect(result2.originalName).toBe('same-name.txt');
    });

    it('should preserve original filename when requested', async () => {
      const mockFile = createMockMultipartFile('preserve-me.txt', 'content');

      const result = await fileService.uploadFile(mockFile, {
        community: 'community-1',
        entity: 'stories',
        entityId: 123,
        uploadedBy: 1,
        preserveFilename: true,
      });

      expect(result.filename).toBe('preserve-me.txt');
      expect(result.originalName).toBe('preserve-me.txt');
    });

    it('should sanitize filenames for security', async () => {
      const dangerousFile = createMockMultipartFile(
        '../../etc/passwd',
        'malicious'
      );

      const result = await fileService.uploadFile(dangerousFile, {
        community: 'community-1',
        entity: 'stories',
        entityId: 123,
        uploadedBy: 1,
        preserveFilename: true,
      });

      expect(result.filename).not.toContain('..');
      expect(result.filename).not.toContain('/');
      expect(result.originalName).toBe('../../etc/passwd');
    });

    it('should validate entity types', async () => {
      const mockFile = createMockMultipartFile('test.txt', 'content');

      const validEntities = ['stories', 'places', 'speakers'];
      for (const entity of validEntities) {
        await expect(
          fileService.uploadFile(mockFile, {
            community: 'community-1',
            entity: entity as any,
            entityId: 123,
            uploadedBy: 1,
          })
        ).resolves.toBeDefined();
      }

      await expect(
        fileService.uploadFile(mockFile, {
          community: 'community-1',
          entity: 'invalid-entity' as any,
          entityId: 123,
          uploadedBy: 1,
        })
      ).rejects.toThrow('Invalid entity type');
    });
  });

  describe('downloadFile()', () => {
    it('should download an existing file', async () => {
      const mockFile = createMockMultipartFile(
        'download-test.txt',
        'download content'
      );

      const uploadResult = await fileService.uploadFile(mockFile, {
        community: 'community-1',
        entity: 'stories',
        entityId: 123,
        uploadedBy: 1,
      });

      const downloadResult = await fileService.downloadFile({
        community: 'community-1',
        entity: 'stories',
        entityId: 123,
        filename: uploadResult.filename,
      });

      expect(downloadResult).toMatchObject({
        buffer: Buffer.from('download content'),
        metadata: {
          filename: uploadResult.filename,
          originalName: 'download-test.txt',
          size: 16, // 'download content'.length
          mimeType: 'text/plain',
          etag: expect.any(String),
        },
      });
    });

    it('should throw error for non-existent files', async () => {
      await expect(
        fileService.downloadFile({
          community: 'community-1',
          entity: 'stories',
          entityId: 123,
          filename: 'non-existent.txt',
        })
      ).rejects.toThrow('File not found');
    });

    it('should enforce community isolation', async () => {
      const mockFile = createMockMultipartFile(
        'isolated.txt',
        'secret content'
      );

      const uploadResult = await fileService.uploadFile(mockFile, {
        community: 'community-1',
        entity: 'stories',
        entityId: 123,
        uploadedBy: 1,
      });

      // Try to access from different community
      await expect(
        fileService.downloadFile({
          community: 'community-2',
          entity: 'stories',
          entityId: 123,
          filename: uploadResult.filename,
        })
      ).rejects.toThrow('File not found');
    });
  });

  describe('deleteFile()', () => {
    it('should delete an existing file', async () => {
      const mockFile = createMockMultipartFile(
        'delete-me.txt',
        'to be deleted'
      );

      const uploadResult = await fileService.uploadFile(mockFile, {
        community: 'community-1',
        entity: 'stories',
        entityId: 123,
        uploadedBy: 1,
      });

      await fileService.deleteFile({
        community: 'community-1',
        entity: 'stories',
        entityId: 123,
        filename: uploadResult.filename,
      });

      // Verify file is gone
      await expect(
        fileService.downloadFile({
          community: 'community-1',
          entity: 'stories',
          entityId: 123,
          filename: uploadResult.filename,
        })
      ).rejects.toThrow('File not found');
    });

    it('should throw error when deleting non-existent files', async () => {
      await expect(
        fileService.deleteFile({
          community: 'community-1',
          entity: 'stories',
          entityId: 123,
          filename: 'non-existent.txt',
        })
      ).rejects.toThrow('File not found');
    });
  });

  describe('listFiles()', () => {
    beforeEach(async () => {
      // Upload test files
      const testFiles = [
        {
          name: 'story1.txt',
          content: 'story 1',
          entity: 'stories',
          entityId: 123,
        },
        {
          name: 'story2.txt',
          content: 'story 2',
          entity: 'stories',
          entityId: 124,
        },
        {
          name: 'place1.jpg',
          content: 'fake image',
          entity: 'places',
          entityId: 456,
          mime: 'image/jpeg',
        },
        {
          name: 'speaker1.mp3',
          content: 'fake audio',
          entity: 'speakers',
          entityId: 789,
          mime: 'audio/mpeg',
        },
      ];

      for (const {
        name,
        content,
        entity,
        entityId,
        mime = 'text/plain',
      } of testFiles) {
        const mockFile = createMockMultipartFile(name, content, mime);
        await fileService.uploadFile(mockFile, {
          community: 'community-1',
          entity: entity as any,
          entityId,
          uploadedBy: 1,
        });
      }
    });

    it('should list all files in a community', async () => {
      const result = await fileService.listFiles({
        community: 'community-1',
      });

      expect(result.files).toHaveLength(4);
      expect(result.total).toBe(4);

      // Check that all files are from the correct community
      result.files.forEach((file) => {
        expect(file.community).toBe('community-1');
      });
    });

    it('should filter by entity type', async () => {
      const storiesResult = await fileService.listFiles({
        community: 'community-1',
        entity: 'stories',
      });

      expect(storiesResult.files).toHaveLength(2);
      storiesResult.files.forEach((file) => {
        expect(file.entity).toBe('stories');
      });
    });

    it('should filter by entity ID', async () => {
      const entityResult = await fileService.listFiles({
        community: 'community-1',
        entity: 'stories',
        entityId: 123,
      });

      expect(entityResult.files).toHaveLength(1);
      expect(entityResult.files[0].entityId).toBe(123);
    });

    it('should support pagination', async () => {
      const page1 = await fileService.listFiles({
        community: 'community-1',
        page: 1,
        limit: 2,
      });

      expect(page1.files).toHaveLength(2);
      expect(page1.total).toBe(4);
      expect(page1.page).toBe(1);
      expect(page1.totalPages).toBe(2);

      const page2 = await fileService.listFiles({
        community: 'community-1',
        page: 2,
        limit: 2,
      });

      expect(page2.files).toHaveLength(2);
      expect(page2.page).toBe(2);
    });

    it('should return empty results for non-existent community', async () => {
      const result = await fileService.listFiles({
        community: 'non-existent',
      });

      expect(result.files).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('path security', () => {
    it('should prevent directory traversal in entity paths', async () => {
      const mockFile = createMockMultipartFile('safe.txt', 'content');

      const maliciousInputs = [
        { community: '../../../etc', entity: 'stories', entityId: 123 },
        {
          community: 'community-1',
          entity: '../../../etc' as any,
          entityId: 123,
        },
      ];

      for (const input of maliciousInputs) {
        await expect(
          fileService.uploadFile(mockFile, {
            ...input,
            uploadedBy: 1,
          })
        ).rejects.toThrow();
      }
    });

    it('should validate community names', async () => {
      const mockFile = createMockMultipartFile('test.txt', 'content');

      const invalidCommunities = ['', '..', '.', '/etc', 'com/munity'];

      for (const community of invalidCommunities) {
        await expect(
          fileService.uploadFile(mockFile, {
            community,
            entity: 'stories',
            entityId: 123,
            uploadedBy: 1,
          })
        ).rejects.toThrow();
      }
    });

    it('should validate entity IDs', async () => {
      const mockFile = createMockMultipartFile('test.txt', 'content');

      const invalidEntityIds = [0, -1, NaN, Infinity];

      for (const entityId of invalidEntityIds) {
        await expect(
          fileService.uploadFile(mockFile, {
            community: 'community-1',
            entity: 'stories',
            entityId,
            uploadedBy: 1,
          })
        ).rejects.toThrow();
      }
    });
  });

  describe('error handling', () => {
    it('should handle storage adapter errors gracefully', async () => {
      // Create a failing storage adapter
      const failingAdapter: StorageAdapter = {
        upload: async () => {
          throw new Error('Storage failure');
        },
        download: async () => {
          throw new Error('Storage failure');
        },
        delete: async () => {
          throw new Error('Storage failure');
        },
        exists: async () => {
          throw new Error('Storage failure');
        },
        getMetadata: async () => {
          throw new Error('Storage failure');
        },
      };

      const failingService = new FileServiceV2(failingAdapter, {
        maxFileSize: 10 * 1024 * 1024,
        allowedMimeTypes: { image: [], audio: [], video: [] },
        enableVideo: false,
        rateLimiting: { windowMs: 60000, maxUploads: 10 },
      });

      const mockFile = createMockMultipartFile('test.txt', 'content');

      await expect(
        failingService.uploadFile(mockFile, {
          community: 'community-1',
          entity: 'stories',
          entityId: 123,
          uploadedBy: 1,
        })
      ).rejects.toThrow('Storage failure');
    });

    it('should provide meaningful error messages', async () => {
      const mockFile = createMockMultipartFile(
        'test.exe',
        'malicious',
        'application/x-executable'
      );

      try {
        await fileService.uploadFile(mockFile, {
          community: 'community-1',
          entity: 'stories',
          entityId: 123,
          uploadedBy: 1,
        });
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('File type not allowed');
        expect((error as Error).message).toContain('application/x-executable');
      }
    });
  });
});
