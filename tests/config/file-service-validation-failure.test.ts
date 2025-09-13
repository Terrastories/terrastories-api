import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/shared/config/index.js';

describe('File Service Configuration Validation Failures', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset process.env before each test
    process.env = { ...originalEnv };
    delete process.env.FILES_MAX_SIZE_MB;
    delete process.env.FILES_ENABLE_VIDEO;
    delete process.env.FILES_ENCRYPT_AT_REST;
    delete process.env.FILES_UPLOAD_RATE_LIMIT;
    delete process.env.FILES_BASE_UPLOAD_PATH;
    delete process.env.FILES_ENABLE_CULTURAL_PROTOCOLS;

    // Ensure we have a valid DATABASE_URL for all tests
    process.env.DATABASE_URL = ':memory:';
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('Configuration Schema Validation Failures', () => {
    it('should reject negative maxSizeMB values', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_MAX_SIZE_MB = '-10';

      expect(() => loadConfig(true, true)).toThrow(
        /maxSizeMB must be positive/
      );
    });

    it('should reject zero maxSizeMB values', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_MAX_SIZE_MB = '0';

      expect(() => loadConfig(true, true)).toThrow(
        /maxSizeMB must be positive/
      );
    });

    it('should reject negative uploadRateLimit values', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_UPLOAD_RATE_LIMIT = '-5';

      expect(() => loadConfig(true, true)).toThrow(
        /uploadRateLimit must be positive/
      );
    });

    it('should reject zero uploadRateLimit values', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_UPLOAD_RATE_LIMIT = '0';

      expect(() => loadConfig(true, true)).toThrow(
        /uploadRateLimit must be positive/
      );
    });

    it('should reject empty baseUploadPath', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_BASE_UPLOAD_PATH = '';

      expect(() => loadConfig(true, true)).toThrow(
        /baseUploadPath cannot be empty/
      );
    });

    it('should reject whitespace-only baseUploadPath', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_BASE_UPLOAD_PATH = '   ';

      expect(() => loadConfig(true, true)).toThrow(
        /baseUploadPath cannot be whitespace-only/
      );
    });

    it('should handle invalid boolean environment variables gracefully', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_ENABLE_VIDEO = 'maybe';
      process.env.FILES_ENCRYPT_AT_REST = 'sometimes';
      process.env.FILES_ENABLE_CULTURAL_PROTOCOLS = 'invalid';

      // These should be coerced to false (not true or "1")
      const config = loadConfig(true, true);

      expect(config.fileService.enableVideo).toBe(false);
      expect(config.fileService.encryptAtRest).toBe(false);
      expect(config.fileService.enableCulturalProtocols).toBe(false);
    });

    it('should handle non-numeric maxSizeMB values', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_MAX_SIZE_MB = 'not-a-number';

      expect(() => loadConfig(true, true)).toThrow();
    });

    it('should handle non-numeric uploadRateLimit values', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_UPLOAD_RATE_LIMIT = 'not-a-number';

      expect(() => loadConfig(true, true)).toThrow();
    });
  });

  describe('Environment-Specific Validation Failures', () => {
    it('should enforce production-specific file service validation', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET =
        'super-secure-secret-at-least-32-characters-long';
      process.env.SESSION_SECRET =
        'super-secure-session-secret-at-least-32-characters-long';
      process.env.FILES_MAX_SIZE_MB = '-1'; // Invalid

      expect(() => loadConfig(true, true)).toThrow(
        /maxSizeMB must be positive/
      );
    });

    it('should handle field-kit specific validation failures', () => {
      process.env.NODE_ENV = 'field-kit';
      process.env.FILES_UPLOAD_RATE_LIMIT = '0'; // Invalid

      expect(() => loadConfig(true, true)).toThrow(
        /uploadRateLimit must be positive/
      );
    });

    it('should handle offline specific validation failures', () => {
      process.env.NODE_ENV = 'offline';
      process.env.FILES_BASE_UPLOAD_PATH = ''; // Invalid

      expect(() => loadConfig(true, true)).toThrow(
        /baseUploadPath cannot be empty/
      );
    });

    it('should handle test environment validation failures', () => {
      process.env.NODE_ENV = 'test';
      process.env.FILES_MAX_SIZE_MB = '-100'; // Invalid

      expect(() => loadConfig(true, true)).toThrow(
        /maxSizeMB must be positive/
      );
    });
  });

  describe('Edge Case Validation Failures', () => {
    it('should handle extremely large numeric values', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_MAX_SIZE_MB = '999999999999999999999';

      // Should not throw during config loading (JavaScript number coercion)
      const config = loadConfig(true, true);
      expect(config.fileService.maxSizeMB).toBe(999999999999999999999);
    });

    it('should handle floating point values for integer fields', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_MAX_SIZE_MB = '25.5';
      process.env.FILES_UPLOAD_RATE_LIMIT = '10.7';

      const config = loadConfig(true, true);

      // Zod coercion should handle these
      expect(config.fileService.maxSizeMB).toBe(25.5);
      expect(config.fileService.uploadRateLimit).toBe(10.7);
    });

    it('should handle special numeric values', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_MAX_SIZE_MB = 'Infinity';

      // Zod's number validation rejects Infinity, so this should throw
      expect(() => loadConfig(true, true)).toThrow();
    });

    it('should handle null/undefined-like string values', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_BASE_UPLOAD_PATH = 'null';

      // String "null" is valid, not actual null
      const config = loadConfig(true, true);
      expect(config.fileService.baseUploadPath).toBe('null');
    });
  });

  describe('Configuration Interaction Validation', () => {
    it('should validate fileService independently of fileUpload config', () => {
      process.env.NODE_ENV = 'development';
      // Valid fileUpload settings but invalid fileService
      process.env.UPLOAD_DIR = '/tmp/uploads';
      process.env.FILES_MAX_SIZE_MB = '-1'; // Invalid fileService

      expect(() => loadConfig(true, true)).toThrow(
        /maxSizeMB must be positive/
      );
    });

    it('should handle mixed valid/invalid file configurations', () => {
      process.env.NODE_ENV = 'development';
      // Valid fileUpload, invalid fileService
      process.env.MAX_IMAGE_SIZE = '10485760'; // 10MB in bytes
      process.env.FILES_UPLOAD_RATE_LIMIT = '0'; // Invalid

      expect(() => loadConfig(true, true)).toThrow(
        /uploadRateLimit must be positive/
      );
    });

    it('should validate cultural protocol settings', () => {
      process.env.NODE_ENV = 'development';
      process.env.FILES_ENABLE_CULTURAL_PROTOCOLS = 'true';
      process.env.FILES_MAX_SIZE_MB = '50'; // Valid with cultural protocols

      const config = loadConfig(true, true);
      expect(config.fileService.enableCulturalProtocols).toBe(true);
      expect(config.fileService.maxSizeMB).toBe(50);
    });
  });
});
