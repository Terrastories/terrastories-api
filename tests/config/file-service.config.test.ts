import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/shared/config/index.js';

describe('File Service Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset process.env before each test
    process.env = { ...originalEnv };
    delete process.env.FILES_MAX_SIZE_MB;
    delete process.env.FILES_ENABLE_VIDEO;
    delete process.env.FILES_ENCRYPT_AT_REST;
    delete process.env.FILES_UPLOAD_RATE_LIMIT;
    delete process.env.FILES_BASE_UPLOAD_PATH;

    // Ensure we have a valid DATABASE_URL for all tests
    process.env.DATABASE_URL = ':memory:';
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('File Service Schema Validation', () => {
    it('should load with default file service configuration', () => {
      process.env.NODE_ENV = 'development';

      const config = loadConfig(true, true);

      expect(config.fileService).toMatchObject({
        maxSizeMB: 25,
        enableVideo: false,
        encryptAtRest: false,
        uploadRateLimit: 10,
        baseUploadPath: 'uploads',
        enableCulturalProtocols: false,
      });
    });

    it('should parse FILES_MAX_SIZE_MB environment variable', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_MAX_SIZE_MB = '50';

      const config = loadConfig(true, true);

      expect(config.fileService.maxSizeMB).toBe(50);
    });

    it('should parse FILES_ENABLE_VIDEO boolean environment variable', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_ENABLE_VIDEO = 'true';

      const config = loadConfig(true, true);

      expect(config.fileService.enableVideo).toBe(true);
    });

    it('should parse FILES_ENCRYPT_AT_REST boolean environment variable', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_ENCRYPT_AT_REST = 'true';

      const config = loadConfig(true, true);

      expect(config.fileService.encryptAtRest).toBe(true);
    });

    it('should parse FILES_UPLOAD_RATE_LIMIT numeric environment variable', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_UPLOAD_RATE_LIMIT = '20';

      const config = loadConfig(true, true);

      expect(config.fileService.uploadRateLimit).toBe(20);
    });

    it('should parse FILES_BASE_UPLOAD_PATH string environment variable', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_BASE_UPLOAD_PATH = 'custom/uploads';

      const config = loadConfig(true, true);

      expect(config.fileService.baseUploadPath).toBe('custom/uploads');
    });

    it('should handle boolean environment variables with "1" value', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_ENABLE_VIDEO = '1';
      process.env.FILES_ENCRYPT_AT_REST = '1';

      const config = loadConfig(true, true);

      expect(config.fileService.enableVideo).toBe(true);
      expect(config.fileService.encryptAtRest).toBe(true);
    });

    it('should handle boolean environment variables with "false" value', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_ENABLE_VIDEO = 'false';
      process.env.FILES_ENCRYPT_AT_REST = 'false';

      const config = loadConfig(true, true);

      expect(config.fileService.enableVideo).toBe(false);
      expect(config.fileService.encryptAtRest).toBe(false);
    });

    it('should validate numeric range for maxSizeMB', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_MAX_SIZE_MB = '-1';

      expect(() => loadConfig(true, true)).toThrow();
    });

    it('should validate numeric range for uploadRateLimit', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_UPLOAD_RATE_LIMIT = '-5';

      expect(() => loadConfig(true, true)).toThrow();
    });

    it('should validate baseUploadPath is not empty', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_BASE_UPLOAD_PATH = '';

      expect(() => loadConfig(true, true)).toThrow();
    });
  });

  describe('Environment-Specific File Service Configuration', () => {
    it('should use production-safe defaults in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET =
        'super-secure-secret-at-least-32-characters-long';
      process.env.SESSION_SECRET =
        'super-secure-session-secret-at-least-32-characters-long';

      const config = loadConfig(true, true);

      expect(config.fileService).toMatchObject({
        maxSizeMB: 25,
        enableVideo: false,
        encryptAtRest: false,
        uploadRateLimit: 10,
        baseUploadPath: 'uploads',
        enableCulturalProtocols: false,
      });
    });

    it('should support field-kit specific file service configuration', () => {
      process.env.NODE_ENV = 'field-kit';
      process.env.FILES_ENABLE_VIDEO = 'true';
      process.env.FILES_ENCRYPT_AT_REST = 'true';

      const config = loadConfig(true, true);

      expect(config.fileService).toMatchObject({
        enableVideo: true,
        encryptAtRest: true,
      });
    });

    it('should support offline specific file service configuration', () => {
      process.env.NODE_ENV = 'offline';
      process.env.FILES_MAX_SIZE_MB = '10';
      process.env.FILES_ENABLE_VIDEO = 'false';

      const config = loadConfig(true, true);

      expect(config.fileService).toMatchObject({
        maxSizeMB: 10,
        enableVideo: false,
      });
    });
  });

  describe('Configuration Type Safety', () => {
    it('should have proper TypeScript types for fileService properties', () => {
      process.env.NODE_ENV = 'development';

      const config = loadConfig(true, true);

      // This test ensures TypeScript compilation succeeds with proper types
      expect(typeof config.fileService.maxSizeMB).toBe('number');
      expect(typeof config.fileService.enableVideo).toBe('boolean');
      expect(typeof config.fileService.encryptAtRest).toBe('boolean');
      expect(typeof config.fileService.uploadRateLimit).toBe('number');
      expect(typeof config.fileService.baseUploadPath).toBe('string');
      expect(typeof config.fileService.enableCulturalProtocols).toBe('boolean');
    });

    it('should properly validate all file service configuration fields', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_MAX_SIZE_MB = '100';
      process.env.FILES_ENABLE_VIDEO = 'true';
      process.env.FILES_ENCRYPT_AT_REST = 'false';
      process.env.FILES_UPLOAD_RATE_LIMIT = '50';
      process.env.FILES_BASE_UPLOAD_PATH = 'custom/storage';

      const config = loadConfig(true, true);

      expect(config.fileService).toMatchObject({
        maxSizeMB: 100,
        enableVideo: true,
        encryptAtRest: false,
        uploadRateLimit: 50,
        baseUploadPath: 'custom/storage',
      });
    });
  });

  describe('Integration with Existing Configuration', () => {
    it('should coexist with existing fileUpload configuration', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_MAX_SIZE_MB = '30';

      const config = loadConfig(true, true);

      // fileService config should be separate from fileUpload config
      expect(config.fileService.maxSizeMB).toBe(30);
      expect(config.fileUpload.maxFileSizes.image).toBe(10 * 1024 * 1024); // Still bytes
      expect(config.fileUpload.allowedImageTypes).toEqual([
        'image/jpeg',
        'image/png',
        'image/webp',
      ]);
    });

    it('should maintain existing environment schema compatibility', () => {
      process.env.NODE_ENV = 'development';
      process.env.PORT = '4000';
      process.env.LOG_LEVEL = 'info';
      process.env.FILES_MAX_SIZE_MB = '15';

      const config = loadConfig(true, true);

      // All existing configuration should still work
      expect(config.server.port).toBe(4000);
      expect(config.logging.level).toBe('info');
      expect(config.fileService.maxSizeMB).toBe(15);
    });
  });
});
