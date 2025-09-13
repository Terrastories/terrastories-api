import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FileServiceV2,
  FileValidationError,
} from '../../src/services/file-v2.service.js';
import type { StorageAdapter } from '../../src/services/storage/storage-adapter.interface.js';
import type { AppConfig } from '../../src/shared/config/types.js';
import {
  createValidAppConfig,
  createMaliciousAppConfig,
  createMaliciousLegacyConfig,
} from '../helpers/test-fixtures.js';

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
      const maliciousAppConfig = createMaliciousAppConfig(
        '../../../etc/passwd'
      );

      expect(
        () => new FileServiceV2(mockStorageAdapter, maliciousAppConfig)
      ).toThrow(FileValidationError);
    });

    it('should reject absolute paths in AppConfig', () => {
      const maliciousAppConfig = createMaliciousAppConfig('/etc/passwd');

      expect(
        () => new FileServiceV2(mockStorageAdapter, maliciousAppConfig)
      ).toThrow(FileValidationError);
    });

    it('should reject double slashes in AppConfig', () => {
      const maliciousAppConfig = createMaliciousAppConfig('uploads//malicious');

      expect(
        () => new FileServiceV2(mockStorageAdapter, maliciousAppConfig)
      ).toThrow(FileValidationError);
    });

    it('should reject Windows dangerous characters', () => {
      const maliciousAppConfig = createMaliciousAppConfig('uploads<malicious>');

      expect(
        () => new FileServiceV2(mockStorageAdapter, maliciousAppConfig)
      ).toThrow(FileValidationError);
    });

    it('should reject null bytes', () => {
      const maliciousAppConfig = createMaliciousAppConfig('uploads\0malicious');

      expect(
        () => new FileServiceV2(mockStorageAdapter, maliciousAppConfig)
      ).toThrow(FileValidationError);
    });

    it('should accept valid relative paths', () => {
      const validAppConfig = createValidAppConfig({
        fileService: {
          maxSizeMB: 25,
          enableVideo: false,
          encryptAtRest: false,
          uploadRateLimit: 10,
          baseUploadPath: 'uploads/custom/path',
          enableCulturalProtocols: false,
        },
      });

      expect(
        () => new FileServiceV2(mockStorageAdapter, validAppConfig)
      ).not.toThrow();
    });

    it('should also validate legacy config baseUploadPath', () => {
      const maliciousLegacyConfig = createMaliciousLegacyConfig(
        '../../../etc/passwd'
      );

      expect(
        () => new FileServiceV2(mockStorageAdapter, maliciousLegacyConfig)
      ).toThrow(FileValidationError);
    });

    it('should validate empty paths', () => {
      const invalidAppConfig = createMaliciousAppConfig('');

      expect(
        () => new FileServiceV2(mockStorageAdapter, invalidAppConfig)
      ).toThrow(FileValidationError);
    });

    it('should validate whitespace-only paths', () => {
      const invalidAppConfig = createMaliciousAppConfig('   ');

      expect(
        () => new FileServiceV2(mockStorageAdapter, invalidAppConfig)
      ).toThrow(FileValidationError);
    });

    it('should reject Windows drive notation', () => {
      const maliciousAppConfig = createMaliciousAppConfig(
        'C:\\Windows\\System32'
      );

      expect(
        () => new FileServiceV2(mockStorageAdapter, maliciousAppConfig)
      ).toThrow(FileValidationError);
    });

    it('should reject unicode path traversal attempts', () => {
      const maliciousAppConfig = createMaliciousAppConfig(
        'uploads\u2215..\u2215etc\u2215passwd'
      ); // Unicode slash

      expect(
        () => new FileServiceV2(mockStorageAdapter, maliciousAppConfig)
      ).toThrow(FileValidationError);
    });

    it('should reject URLs as paths', () => {
      const maliciousAppConfig = createMaliciousAppConfig(
        'http://evil.com/uploads'
      );

      expect(
        () => new FileServiceV2(mockStorageAdapter, maliciousAppConfig)
      ).toThrow(FileValidationError);
    });

    it('should reject very long paths', () => {
      const veryLongPath = 'a'.repeat(300); // Exceeds most filesystem limits
      const maliciousAppConfig = createMaliciousAppConfig(veryLongPath);

      expect(
        () => new FileServiceV2(mockStorageAdapter, maliciousAppConfig)
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
