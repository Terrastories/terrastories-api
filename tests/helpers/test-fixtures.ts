import type { AppConfig } from '../../src/shared/config/types.js';

/**
 * Test fixtures to avoid type assertions in tests
 * Provides properly typed configuration objects for testing
 */

export const createValidAppConfig = (
  overrides?: Partial<AppConfig>
): AppConfig => ({
  environment: 'test',
  server: {
    port: 3001,
    host: '127.0.0.1',
  },
  database: {
    url: ':memory:',
    poolSize: 10,
    maxConnections: 20,
    ssl: false,
    spatialSupport: true,
  },
  auth: {
    jwtSecret: 'test-jwt-secret-for-testing-purposes',
    session: {
      secret: 'test-session-secret-for-testing-purposes',
      maxAge: 24 * 60 * 60 * 1000,
      secure: false,
      httpOnly: true,
      sameSite: 'strict',
    },
    rateLimit: {
      max: 10,
      timeWindow: 60 * 1000,
    },
  },
  security: {
    password: {
      algorithm: 'argon2id',
      argon2: {
        memory: 32768,
        iterations: 2,
        parallelism: 2,
      },
    },
  },
  logging: {
    level: 'error',
  },
  features: {
    offlineMode: false,
    syncEnabled: true,
    mediaUpload: true,
    adminInterface: true,
    filesNativeEnabled: false,
  },
  fileUpload: {
    uploadDir: './uploads',
    maxFileSizes: {
      image: 10 * 1024 * 1024,
      audio: 50 * 1024 * 1024,
      video: 100 * 1024 * 1024,
    },
    allowedImageTypes: ['image/jpeg', 'image/png', 'image/webp'],
    allowedAudioTypes: ['audio/mpeg', 'audio/wav', 'audio/ogg'],
    allowedVideoTypes: ['video/mp4', 'video/webm'],
    enableMetadataExtraction: true,
    streamingThreshold: 5 * 1024 * 1024,
    enableAuditLogging: true,
  },
  fileService: {
    maxSizeMB: 25,
    enableVideo: false,
    encryptAtRest: false,
    uploadRateLimit: 10,
    baseUploadPath: 'uploads',
    enableCulturalProtocols: false,
  },
  ...overrides,
});

export const createMaliciousAppConfig = (maliciousPath: string): AppConfig =>
  createValidAppConfig({
    fileService: {
      maxSizeMB: 25,
      enableVideo: false,
      encryptAtRest: false,
      uploadRateLimit: 10,
      baseUploadPath: maliciousPath,
      enableCulturalProtocols: false,
    },
  });

export const createLegacyFileServiceConfig = (overrides?: any) => ({
  maxSizeBytes: 25 * 1024 * 1024,
  allowedMimeTypes: ['image/*'],
  enableVideo: false,
  uploadRateLimit: 10,
  baseUploadPath: 'uploads',
  ...overrides,
});

export const createMaliciousLegacyConfig = (maliciousPath: string) =>
  createLegacyFileServiceConfig({
    baseUploadPath: maliciousPath,
  });
