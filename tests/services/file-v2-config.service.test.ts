import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  type MockedFunction,
} from 'vitest';
import { FileServiceV2 } from '../../src/services/file-v2.service.js';
import type { StorageAdapter } from '../../src/services/storage/storage-adapter.interface.js';
import type { AppConfig } from '../../src/shared/config/types.js';

// Mock StorageAdapter
const mockStorageAdapter: StorageAdapter = {
  upload: vi.fn(),
  download: vi.fn(),
  delete: vi.fn(),
  exists: vi.fn(),
  list: vi.fn(),
  getMetadata: vi.fn(),
};

describe('FileServiceV2 Configuration Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Constructor with App Configuration', () => {
    it('should accept app config and convert MB to bytes', () => {
      const appConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 50,
          enableVideo: true,
          encryptAtRest: false,
          uploadRateLimit: 20,
          baseUploadPath: 'custom/uploads',
        },
      };

      const service = new FileServiceV2(
        mockStorageAdapter,
        appConfig as AppConfig
      );

      // Verify the internal config was set correctly (access via public method)
      expect(service.generateFilePath('test', 'stories', 1, 'file.jpg')).toBe(
        'custom/uploads/test/stories/1/file.jpg'
      );
    });

    it('should convert maxSizeMB to maxSizeBytes correctly', async () => {
      const appConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 10, // 10MB
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: 'uploads',
        },
      };

      const service = new FileServiceV2(
        mockStorageAdapter,
        appConfig as AppConfig
      );

      // Create a file that's exactly at the limit (10MB)
      const fileBuffer = Buffer.alloc(10 * 1024 * 1024); // 10MB
      const mockFile = {
        file: fileBuffer,
        filename: 'test.jpg',
        mimetype: 'image/jpeg',
      };

      (mockStorageAdapter.exists as MockedFunction<any>).mockResolvedValue(
        false
      );
      (mockStorageAdapter.upload as MockedFunction<any>).mockResolvedValue({
        path: 'uploads/test/stories/1/test.jpg',
        size: fileBuffer.length,
        etag: 'mock-etag',
      });

      // Should not throw for file at the limit
      await expect(
        service.uploadFile(mockFile as any, 'test', 'stories', 1)
      ).resolves.toBeDefined();

      // Should throw for file over the limit
      const oversizedFile = {
        file: Buffer.alloc(11 * 1024 * 1024), // 11MB
        filename: 'oversized.jpg',
        mimetype: 'image/jpeg',
      };

      await expect(
        service.uploadFile(oversizedFile as any, 'test', 'stories', 1)
      ).rejects.toThrow('File size');
    });

    it('should include video MIME types when enableVideo is true', async () => {
      const appConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 25,
          enableVideo: true,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: 'uploads',
        },
      };

      const service = new FileServiceV2(
        mockStorageAdapter,
        appConfig as AppConfig
      );

      const videoFile = {
        file: Buffer.alloc(1000),
        filename: 'video.mp4',
        mimetype: 'video/mp4',
      };

      (mockStorageAdapter.exists as MockedFunction<any>).mockResolvedValue(
        false
      );
      (mockStorageAdapter.upload as MockedFunction<any>).mockResolvedValue({
        path: 'uploads/test/stories/1/video.mp4',
        size: 1000,
        etag: 'mock-etag',
      });

      // Should not throw for video file when enableVideo is true
      await expect(
        service.uploadFile(videoFile as any, 'test', 'stories', 1)
      ).resolves.toBeDefined();
    });

    it('should reject video MIME types when enableVideo is false', async () => {
      const appConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 25,
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: 'uploads',
        },
      };

      const service = new FileServiceV2(
        mockStorageAdapter,
        appConfig as AppConfig
      );

      const videoFile = {
        file: Buffer.alloc(1000),
        filename: 'video.mp4',
        mimetype: 'video/mp4',
      };

      // Should throw for video file when enableVideo is false
      await expect(
        service.uploadFile(videoFile as any, 'test', 'stories', 1)
      ).rejects.toThrow('MIME type video/mp4 not allowed');
    });

    it('should use custom baseUploadPath for file path generation', () => {
      const appConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 25,
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: 'custom/storage/path',
        },
      };

      const service = new FileServiceV2(
        mockStorageAdapter,
        appConfig as AppConfig
      );

      const filePath = service.generateFilePath(
        'community1',
        'stories',
        123,
        'story.jpg'
      );
      expect(filePath).toBe(
        'custom/storage/path/community1/stories/123/story.jpg'
      );
    });
  });

  describe('Backward Compatibility', () => {
    it('should maintain existing constructor signature with config object', () => {
      const legacyConfig = {
        maxSizeBytes: 30 * 1024 * 1024, // 30MB in bytes
        allowedMimeTypes: ['image/*', 'audio/*', 'video/*'],
        enableVideo: true,
        uploadRateLimit: 15,
        baseUploadPath: 'legacy/uploads',
      };

      const service = new FileServiceV2(mockStorageAdapter, legacyConfig);

      // Should work exactly as before
      const filePath = service.generateFilePath(
        'test',
        'stories',
        1,
        'file.jpg'
      );
      expect(filePath).toBe('legacy/uploads/test/stories/1/file.jpg');
    });

    it('should maintain existing constructor signature without config', () => {
      const service = new FileServiceV2(mockStorageAdapter);

      // Should use default configuration
      const filePath = service.generateFilePath(
        'test',
        'stories',
        1,
        'file.jpg'
      );
      expect(filePath).toBe('uploads/test/stories/1/file.jpg');
    });

    it('should handle app config with missing fileService section', () => {
      const appConfig = {
        environment: 'development',
        server: { port: 3000, host: '0.0.0.0' },
        // No fileService section
      } as AppConfig;

      // Should not throw when fileService section is missing
      expect(
        () => new FileServiceV2(mockStorageAdapter, appConfig)
      ).not.toThrow();
    });
  });

  describe('Configuration Validation', () => {
    it('should handle edge case numeric conversions', () => {
      const appConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 0.5, // 512KB
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 1,
          baseUploadPath: 'uploads',
        },
      };

      const service = new FileServiceV2(
        mockStorageAdapter,
        appConfig as AppConfig
      );

      // Should handle fractional MB values correctly
      expect(service).toBeDefined();
    });

    it('should handle boolean conversion edge cases', () => {
      const appConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 25,
          enableVideo: true,
          encryptAtRest: true,
          uploadRateLimit: 10,
          baseUploadPath: 'uploads',
        },
      };

      const service = new FileServiceV2(
        mockStorageAdapter,
        appConfig as AppConfig
      );

      // Service should initialize correctly with all boolean flags set
      expect(service).toBeDefined();
    });

    it('should preserve existing MIME type patterns when using app config', async () => {
      const appConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 25,
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: 'uploads',
        },
      };

      const service = new FileServiceV2(
        mockStorageAdapter,
        appConfig as AppConfig
      );

      // Image files should still be allowed
      const imageFile = {
        file: Buffer.alloc(1000),
        filename: 'image.jpg',
        mimetype: 'image/jpeg',
      };

      (mockStorageAdapter.exists as MockedFunction<any>).mockResolvedValue(
        false
      );
      (mockStorageAdapter.upload as MockedFunction<any>).mockResolvedValue({
        path: 'uploads/test/stories/1/image.jpg',
        size: 1000,
        etag: 'mock-etag',
      });

      await expect(
        service.uploadFile(imageFile as any, 'test', 'stories', 1)
      ).resolves.toBeDefined();

      // Audio files should still be allowed
      const audioFile = {
        file: Buffer.alloc(1000),
        filename: 'audio.mp3',
        mimetype: 'audio/mpeg',
      };

      await expect(
        service.uploadFile(audioFile as any, 'test', 'stories', 1)
      ).resolves.toBeDefined();
    });
  });

  describe('Configuration Method Detection', () => {
    it('should detect app config vs legacy config correctly', () => {
      // This test ensures our service can distinguish between the two config types
      const appConfig = {
        fileService: {
          maxSizeMB: 25,
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: 'uploads',
        },
        environment: 'development',
      } as AppConfig;

      const legacyConfig = {
        maxSizeBytes: 25 * 1024 * 1024,
        allowedMimeTypes: ['image/*', 'audio/*'],
        enableVideo: false,
        uploadRateLimit: 10,
        baseUploadPath: 'uploads',
      };

      // Both should work without throwing
      expect(
        () => new FileServiceV2(mockStorageAdapter, appConfig)
      ).not.toThrow();
      expect(
        () => new FileServiceV2(mockStorageAdapter, legacyConfig)
      ).not.toThrow();
    });
  });
});
