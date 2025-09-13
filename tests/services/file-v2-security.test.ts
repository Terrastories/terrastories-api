import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FileServiceV2,
  FileValidationError,
} from '../../src/services/file-v2.service.js';
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

describe('FileServiceV2 Security Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Upload Path Security Validation', () => {
    it('should reject path traversal attempts in AppConfig', () => {
      const maliciousAppConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 25,
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: '../../../etc/passwd',
          enableCulturalProtocols: false,
        },
      };

      expect(
        () =>
          new FileServiceV2(mockStorageAdapter, maliciousAppConfig as AppConfig)
      ).toThrow(FileValidationError);
    });

    it('should reject absolute paths in AppConfig', () => {
      const maliciousAppConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 25,
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: '/etc/passwd',
          enableCulturalProtocols: false,
        },
      };

      expect(
        () =>
          new FileServiceV2(mockStorageAdapter, maliciousAppConfig as AppConfig)
      ).toThrow(FileValidationError);
    });

    it('should reject double slashes in AppConfig', () => {
      const maliciousAppConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 25,
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: 'uploads//malicious',
          enableCulturalProtocols: false,
        },
      };

      expect(
        () =>
          new FileServiceV2(mockStorageAdapter, maliciousAppConfig as AppConfig)
      ).toThrow(FileValidationError);
    });

    it('should reject Windows dangerous characters', () => {
      const maliciousAppConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 25,
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: 'uploads<malicious>',
          enableCulturalProtocols: false,
        },
      };

      expect(
        () =>
          new FileServiceV2(mockStorageAdapter, maliciousAppConfig as AppConfig)
      ).toThrow(FileValidationError);
    });

    it('should reject null bytes', () => {
      const maliciousAppConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 25,
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: 'uploads\0malicious',
          enableCulturalProtocols: false,
        },
      };

      expect(
        () =>
          new FileServiceV2(mockStorageAdapter, maliciousAppConfig as AppConfig)
      ).toThrow(FileValidationError);
    });

    it('should accept valid relative paths', () => {
      const validAppConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 25,
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: 'uploads/custom/path',
          enableCulturalProtocols: false,
        },
      };

      expect(
        () => new FileServiceV2(mockStorageAdapter, validAppConfig as AppConfig)
      ).not.toThrow();
    });

    it('should also validate legacy config baseUploadPath', () => {
      const maliciousLegacyConfig = {
        maxSizeBytes: 25 * 1024 * 1024,
        allowedMimeTypes: ['image/*'],
        enableVideo: false,
        uploadRateLimit: 10,
        baseUploadPath: '../../../etc/passwd',
      };

      expect(
        () => new FileServiceV2(mockStorageAdapter, maliciousLegacyConfig)
      ).toThrow(FileValidationError);
    });

    it('should validate empty paths', () => {
      const invalidAppConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 25,
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: '',
          enableCulturalProtocols: false,
        },
      };

      expect(
        () =>
          new FileServiceV2(mockStorageAdapter, invalidAppConfig as AppConfig)
      ).toThrow(FileValidationError);
    });

    it('should validate whitespace-only paths', () => {
      const invalidAppConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 25,
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: '   ',
          enableCulturalProtocols: false,
        },
      };

      expect(
        () =>
          new FileServiceV2(mockStorageAdapter, invalidAppConfig as AppConfig)
      ).toThrow(FileValidationError);
    });
  });

  describe('Enhanced Type Guard Validation', () => {
    it('should correctly identify valid AppConfig', () => {
      const validAppConfig: Partial<AppConfig> = {
        fileService: {
          maxSizeMB: 25,
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: 'uploads',
          enableCulturalProtocols: false,
        },
        environment: 'development',
      };

      expect(
        () => new FileServiceV2(mockStorageAdapter, validAppConfig as AppConfig)
      ).not.toThrow();
    });

    it('should reject config with invalid fileService structure', () => {
      const invalidAppConfig = {
        fileService: {
          // Missing required properties
          maxSizeMB: 25,
        },
        environment: 'development',
      };

      // Should fall back to legacy mode and use defaults
      expect(
        () => new FileServiceV2(mockStorageAdapter, invalidAppConfig as any)
      ).not.toThrow();
    });

    it('should handle config with fileService but wrong types', () => {
      const invalidAppConfig = {
        fileService: {
          maxSizeMB: 'not-a-number',
          enableVideo: 'not-a-boolean',
          encryptAtRest: 123,
          uploadRateLimit: 'invalid',
          baseUploadPath: 456,
        },
      };

      // Should fall back to legacy mode and use defaults
      expect(
        () => new FileServiceV2(mockStorageAdapter, invalidAppConfig as any)
      ).not.toThrow();
    });
  });
});
