/**
 * File Service V2 Tests
 *
 * Comprehensive test suite for the TypeScript-native file service designed
 * for ActiveStorage replacement. Tests entity-based operations, validation,
 * and security features.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { MultipartFile } from '@fastify/multipart';
import {
  FileServiceV2,
  type FileServiceV2Config,
  FileValidationError,
  FileSizeError,
  FileTypeError,
} from '../../src/services/file-v2.service.js';
import type {
  StorageAdapter,
  StorageUploadResult,
  StorageMetadata,
} from '../../src/services/storage/storage-adapter.interface.js';

// Mock storage adapter for testing
class MockStorageAdapter implements StorageAdapter {
  private files = new Map<
    string,
    { content: Buffer; metadata: StorageMetadata }
  >();

  async upload(
    file: Buffer,
    path: string,
    options?: { contentType?: string; overwrite?: boolean }
  ): Promise<StorageUploadResult> {
    if (!options?.overwrite && this.files.has(path)) {
      throw new Error('File already exists');
    }

    const metadata: StorageMetadata = {
      size: file.length,
      lastModified: new Date(),
      contentType: options?.contentType,
      etag: `etag-${randomUUID()}`,
    };

    this.files.set(path, { content: file, metadata });

    return {
      path,
      size: file.length,
      etag: metadata.etag!,
      contentType: options?.contentType,
    };
  }

  async download(path: string): Promise<Buffer> {
    const file = this.files.get(path);
    if (!file) {
      throw new Error('File not found');
    }
    return file.content;
  }

  async delete(path: string): Promise<void> {
    if (!this.files.has(path)) {
      throw new Error('File not found');
    }
    this.files.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async getMetadata(path: string): Promise<StorageMetadata> {
    const file = this.files.get(path);
    if (!file) {
      throw new Error('File not found');
    }
    return file.metadata;
  }

  async list(prefix: string): Promise<string[]> {
    return Array.from(this.files.keys()).filter((path) =>
      path.startsWith(prefix)
    );
  }

  // Test helper methods
  clear(): void {
    this.files.clear();
  }

  getStoredFiles(): string[] {
    return Array.from(this.files.keys());
  }
}

// Mock multipart file
function createMockMultipartFile(
  content: Buffer,
  filename: string,
  mimetype: string = 'text/plain'
): MultipartFile {
  return {
    file: content,
    filename,
    mimetype,
    encoding: '7bit',
    fieldname: 'file',
    fields: {},
  } as any;
}

describe('FileServiceV2', () => {
  let fileService: FileServiceV2;
  let mockStorage: MockStorageAdapter;
  let config: FileServiceV2Config;

  beforeEach(() => {
    mockStorage = new MockStorageAdapter();
    config = {
      maxSizeBytes: 25 * 1024 * 1024, // 25MB
      allowedMimeTypes: ['image/*', 'audio/*'],
      enableVideo: false,
      uploadRateLimit: 10,
      baseUploadPath: 'uploads',
    };
    fileService = new FileServiceV2(mockStorage, config);
  });

  afterEach(() => {
    mockStorage.clear();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      // Act
      const service = new FileServiceV2(mockStorage);

      // Assert
      expect(service).toBeInstanceOf(FileServiceV2);
    });

    it('should initialize with custom config', () => {
      // Arrange
      const customConfig: FileServiceV2Config = {
        maxSizeBytes: 10 * 1024 * 1024,
        allowedMimeTypes: ['image/*'],
        enableVideo: true,
        uploadRateLimit: 5,
        baseUploadPath: 'custom-uploads',
      };

      // Act
      const service = new FileServiceV2(mockStorage, customConfig);

      // Assert
      expect(service).toBeInstanceOf(FileServiceV2);
    });
  });

  describe('uploadFile', () => {
    it('should upload a valid image file', async () => {
      // Arrange
      const fileContent = Buffer.from('fake image data');
      const multipartFile = createMockMultipartFile(
        fileContent,
        'photo.jpg',
        'image/jpeg'
      );

      // Act
      const result = await fileService.uploadFile(
        multipartFile,
        'community-1',
        'stories',
        123
      );

      // Assert
      expect(result.filename).toBe('photo.jpg');
      expect(result.path).toBe('uploads/community-1/stories/123/photo.jpg');
      expect(result.size).toBe(fileContent.length);
      expect(result.contentType).toBe('image/jpeg');
      expect(result.etag).toBeDefined();
      expect(result.entity).toBe('stories');
      expect(result.entityId).toBe(123);
      expect(result.community).toBe('community-1');
    });

    it('should upload a valid audio file', async () => {
      // Arrange
      const fileContent = Buffer.from('fake audio data');
      const multipartFile = createMockMultipartFile(
        fileContent,
        'story.mp3',
        'audio/mpeg'
      );

      // Act
      const result = await fileService.uploadFile(
        multipartFile,
        'community-2',
        'speakers',
        456
      );

      // Assert
      expect(result.filename).toBe('story.mp3');
      expect(result.path).toBe('uploads/community-2/speakers/456/story.mp3');
      expect(result.contentType).toBe('audio/mpeg');
    });

    it('should sanitize filename on upload', async () => {
      // Arrange
      const fileContent = Buffer.from('test file');
      const multipartFile = createMockMultipartFile(
        fileContent,
        '../../malicious file!@#$.jpg',
        'image/jpeg'
      );

      // Act
      const result = await fileService.uploadFile(
        multipartFile,
        'community-1',
        'stories',
        123
      );

      // Assert
      expect(result.filename).toBe('malicious-file-.jpg');
      expect(result.path).toBe(
        'uploads/community-1/stories/123/malicious-file-.jpg'
      );
    });

    it('should reject files that are too large', async () => {
      // Arrange
      const largeFile = Buffer.alloc(30 * 1024 * 1024); // 30MB (over 25MB limit)
      const multipartFile = createMockMultipartFile(
        largeFile,
        'large.jpg',
        'image/jpeg'
      );

      // Act & Assert
      await expect(
        fileService.uploadFile(multipartFile, 'community-1', 'stories', 123)
      ).rejects.toThrow(FileSizeError);
    });

    it('should reject disallowed MIME types', async () => {
      // Arrange
      const fileContent = Buffer.from('fake video data');
      const multipartFile = createMockMultipartFile(
        fileContent,
        'video.mp4',
        'video/mp4'
      );

      // Act & Assert
      await expect(
        fileService.uploadFile(multipartFile, 'community-1', 'stories', 123)
      ).rejects.toThrow(FileTypeError);
    });

    it('should allow video when enabled', async () => {
      // Arrange
      const videoConfig = {
        ...config,
        enableVideo: true,
        allowedMimeTypes: ['image/*', 'audio/*', 'video/*'],
      };
      const videoService = new FileServiceV2(mockStorage, videoConfig);
      const fileContent = Buffer.from('fake video data');
      const multipartFile = createMockMultipartFile(
        fileContent,
        'video.mp4',
        'video/mp4'
      );

      // Act
      const result = await videoService.uploadFile(
        multipartFile,
        'community-1',
        'stories',
        123
      );

      // Assert
      expect(result.filename).toBe('video.mp4');
      expect(result.contentType).toBe('video/mp4');
    });

    it('should validate entity type', async () => {
      // Arrange
      const fileContent = Buffer.from('test file');
      const multipartFile = createMockMultipartFile(
        fileContent,
        'test.jpg',
        'image/jpeg'
      );

      // Act & Assert
      await expect(
        fileService.uploadFile(
          multipartFile,
          'community-1',
          'invalid' as any,
          123
        )
      ).rejects.toThrow(FileValidationError);
    });

    it('should handle filename collisions with unique suffixes', async () => {
      // Arrange
      const fileContent1 = Buffer.from('first file');
      const fileContent2 = Buffer.from('second file');
      const multipartFile1 = createMockMultipartFile(
        fileContent1,
        'same.jpg',
        'image/jpeg'
      );
      const multipartFile2 = createMockMultipartFile(
        fileContent2,
        'same.jpg',
        'image/jpeg'
      );

      // Act
      const result1 = await fileService.uploadFile(
        multipartFile1,
        'community-1',
        'stories',
        123
      );
      const result2 = await fileService.uploadFile(
        multipartFile2,
        'community-1',
        'stories',
        123
      );

      // Assert
      expect(result1.filename).toBe('same.jpg');
      expect(result2.filename).toMatch(/same-[a-f0-9]{8}\.jpg/);
      expect(result1.path).not.toBe(result2.path);
    });
  });

  describe('downloadFile', () => {
    it('should download an existing file', async () => {
      // Arrange
      const fileContent = Buffer.from('download test');
      const multipartFile = createMockMultipartFile(
        fileContent,
        'download.jpg',
        'image/jpeg'
      );
      await fileService.uploadFile(
        multipartFile,
        'community-1',
        'stories',
        123
      );

      // Act
      const result = await fileService.downloadFile(
        'community-1',
        'stories',
        123,
        'download.jpg'
      );

      // Assert
      expect(result.content.equals(fileContent)).toBe(true);
      expect(result.metadata.size).toBe(fileContent.length);
      expect(result.metadata.contentType).toBe('image/jpeg');
    });

    it('should throw error for non-existent file', async () => {
      // Act & Assert
      await expect(
        fileService.downloadFile(
          'community-1',
          'stories',
          123,
          'nonexistent.jpg'
        )
      ).rejects.toThrow('File not found');
    });
  });

  describe('deleteFile', () => {
    it('should delete an existing file', async () => {
      // Arrange
      const fileContent = Buffer.from('delete test');
      const multipartFile = createMockMultipartFile(
        fileContent,
        'delete.jpg',
        'image/jpeg'
      );
      await fileService.uploadFile(
        multipartFile,
        'community-1',
        'stories',
        123
      );

      // Act
      await fileService.deleteFile('community-1', 'stories', 123, 'delete.jpg');

      // Assert
      const exists = await fileService.fileExists(
        'community-1',
        'stories',
        123,
        'delete.jpg'
      );
      expect(exists).toBe(false);
    });

    it('should throw error when deleting non-existent file', async () => {
      // Act & Assert
      await expect(
        fileService.deleteFile('community-1', 'stories', 123, 'nonexistent.jpg')
      ).rejects.toThrow('File not found');
    });
  });

  describe('fileExists', () => {
    it('should return true for existing file', async () => {
      // Arrange
      const fileContent = Buffer.from('exists test');
      const multipartFile = createMockMultipartFile(
        fileContent,
        'exists.jpg',
        'image/jpeg'
      );
      await fileService.uploadFile(
        multipartFile,
        'community-1',
        'stories',
        123
      );

      // Act & Assert
      const exists = await fileService.fileExists(
        'community-1',
        'stories',
        123,
        'exists.jpg'
      );
      expect(exists).toBe(true);
    });

    it('should return false for non-existent file', async () => {
      // Act & Assert
      const exists = await fileService.fileExists(
        'community-1',
        'stories',
        123,
        'nonexistent.jpg'
      );
      expect(exists).toBe(false);
    });
  });

  describe('listFiles', () => {
    it('should list files for entity', async () => {
      // Arrange
      const files = [
        { name: 'photo1.jpg', content: 'photo 1' },
        { name: 'audio1.mp3', content: 'audio 1' },
        { name: 'photo2.jpg', content: 'photo 2' },
      ];

      for (const file of files) {
        const multipartFile = createMockMultipartFile(
          Buffer.from(file.content),
          file.name,
          file.name.endsWith('.jpg') ? 'image/jpeg' : 'audio/mpeg'
        );
        await fileService.uploadFile(
          multipartFile,
          'community-1',
          'stories',
          123
        );
      }

      // Act
      const fileList = await fileService.listFiles(
        'community-1',
        'stories',
        123
      );

      // Assert
      expect(fileList).toHaveLength(3);
      expect(fileList.map((f) => f.filename)).toContain('photo1.jpg');
      expect(fileList.map((f) => f.filename)).toContain('audio1.mp3');
      expect(fileList.map((f) => f.filename)).toContain('photo2.jpg');
    });

    it('should return empty list for entity with no files', async () => {
      // Act
      const fileList = await fileService.listFiles(
        'community-1',
        'stories',
        999
      );

      // Assert
      expect(fileList).toEqual([]);
    });
  });

  describe('path generation', () => {
    it('should generate correct entity-based paths', () => {
      // Act
      const path1 = fileService.generateFilePath(
        'community-1',
        'stories',
        123,
        'photo.jpg'
      );
      const path2 = fileService.generateFilePath(
        'community-2',
        'places',
        456,
        'location.jpg'
      );
      const path3 = fileService.generateFilePath(
        'community-1',
        'speakers',
        789,
        'bio.mp3'
      );

      // Assert
      expect(path1).toBe('uploads/community-1/stories/123/photo.jpg');
      expect(path2).toBe('uploads/community-2/places/456/location.jpg');
      expect(path3).toBe('uploads/community-1/speakers/789/bio.mp3');
    });
  });

  describe('filename sanitization', () => {
    it('should sanitize dangerous characters', () => {
      // Act
      const sanitized1 = fileService.sanitizeFilename('../../dangerous.jpg');
      const sanitized2 = fileService.sanitizeFilename(
        'file with spaces & symbols!@#$.jpg'
      );
      const sanitized3 = fileService.sanitizeFilename('unicode-ñáméé.jpg');

      // Assert
      expect(sanitized1).toBe('dangerous.jpg');
      expect(sanitized2).toBe('file-with-spaces-symbols-.jpg');
      expect(sanitized3).toBe('unicode-ñáméé.jpg');
    });

    it('should preserve file extensions', () => {
      // Act
      const sanitized = fileService.sanitizeFilename('my..file..name.tar.gz');

      // Assert
      expect(sanitized).toBe('my..file..name.tar.gz');
    });
  });

  describe('validation', () => {
    it('should validate community names', () => {
      // Act & Assert
      expect(() =>
        fileService.validateCommunityName('community-1')
      ).not.toThrow();
      expect(() =>
        fileService.validateCommunityName('valid_community')
      ).not.toThrow();

      expect(() => fileService.validateCommunityName('')).toThrow(
        FileValidationError
      );
      expect(() =>
        fileService.validateCommunityName('../../traversal')
      ).toThrow(FileValidationError);
      expect(() =>
        fileService.validateCommunityName('community with spaces')
      ).toThrow(FileValidationError);
    });

    it('should validate entity IDs', () => {
      // Act & Assert
      expect(() => fileService.validateEntityId(123)).not.toThrow();
      expect(() => fileService.validateEntityId(1)).not.toThrow();

      expect(() => fileService.validateEntityId(0)).toThrow(
        FileValidationError
      );
      expect(() => fileService.validateEntityId(-1)).toThrow(
        FileValidationError
      );
      expect(() => fileService.validateEntityId(1.5)).toThrow(
        FileValidationError
      );
    });
  });

  describe('error handling', () => {
    it('should handle storage adapter errors', async () => {
      // Arrange
      const failingAdapter = {
        ...mockStorage,
        upload: vi.fn().mockRejectedValue(new Error('Storage failure')),
        exists: vi.fn().mockResolvedValue(false), // Add missing method
      };
      const failingService = new FileServiceV2(failingAdapter as any, config);

      const fileContent = Buffer.from('test');
      const multipartFile = createMockMultipartFile(
        fileContent,
        'test.jpg',
        'image/jpeg'
      );

      // Act & Assert
      await expect(
        failingService.uploadFile(multipartFile, 'community-1', 'stories', 123)
      ).rejects.toThrow('Storage failure');
    });
  });
});
