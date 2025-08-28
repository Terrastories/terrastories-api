/**
 * Configuration Schema Definitions
 *
 * Zod schemas for validating configuration across different environments.
 * Each environment has specific defaults and validation rules.
 *
 * Environments:
 * - development: Debug logging, insecure defaults
 * - production: Info logging, secure defaults, stricter validation
 * - field-kit: Offline-ready, local sync disabled
 * - offline: Local-only, minimal features
 * - test: In-memory database, error-only logging
 */

import { z } from 'zod';
import type { Environment, LogLevel } from './types.js';

// Helper for parsing boolean environment variables
const booleanFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .transform((val) => val === 'true' || val === '1')
    .or(z.boolean())
    .default(defaultValue);

// Environment validation
export const EnvironmentSchema = z
  .enum(['development', 'production', 'field-kit', 'offline', 'test'])
  .default('development' as Environment);

// Log level validation
export const LogLevelSchema = z
  .enum(['error', 'warn', 'info', 'debug'])
  .default('info' as LogLevel);

// Server configuration schema
export const ServerConfigSchema = z.object({
  port: z.coerce
    .number()
    .int()
    .min(1, 'PORT must be between 1 and 65535')
    .max(65535, 'PORT must be between 1 and 65535')
    .default(3000),
  host: z.string().default('0.0.0.0'),
});

// Database configuration schema
export const DatabaseConfigSchema = z.object({
  url: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((url) => {
      // Allow sqlite files, memory db, and postgresql URLs
      return (
        url === ':memory:' ||
        url.endsWith('.db') ||
        url.startsWith('postgresql://') ||
        url.startsWith('postgres://')
      );
    }, 'DATABASE_URL must be a valid database connection string')
    .default('./data.db'),
  poolSize: z.coerce.number().int().min(1).max(20).default(10),
  maxConnections: z.coerce.number().int().min(1).max(50).default(20),
  ssl: z.boolean().default(false),
  spatialSupport: z.boolean().default(true),
});

// Auth configuration schema
export const AuthConfigSchema = z.object({
  jwtSecret: z
    .string()
    .min(1, 'JWT_SECRET is required')
    .default('development-test-secret-insecure'),
  session: z.object({
    secret: z
      .string()
      .min(1, 'SESSION_SECRET is required')
      .default('development-session-secret-insecure'),
    maxAge: z.coerce.number().default(24 * 60 * 60 * 1000), // 24 hours in milliseconds
    secure: booleanFromEnv(false), // Will be overridden based on environment
    httpOnly: booleanFromEnv(true),
    sameSite: z.enum(['lax', 'strict', 'none']).default('strict'),
  }),
  rateLimit: z.object({
    max: z.coerce.number().default(10), // requests per window
    timeWindow: z.coerce.number().default(60 * 1000), // 1 minute in milliseconds
  }),
});

// Security configuration schema
export const SecurityConfigSchema = z.object({
  password: z.object({
    algorithm: z.enum(['argon2id']).default('argon2id'),
    argon2: z.object({
      memory: z.coerce.number().min(32768).default(65536), // 64MB in KB
      iterations: z.coerce.number().min(2).default(3),
      parallelism: z.coerce.number().min(1).default(4),
    }),
  }),
});

// Production-specific auth validation
export const ProductionAuthConfigSchema = AuthConfigSchema.extend({
  jwtSecret: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters in production')
    .default('insecure-development-jwt-secret-for-testing-purposes-only'),
  session: AuthConfigSchema.shape.session.extend({
    secret: z
      .string()
      .min(32, 'SESSION_SECRET must be at least 32 characters in production')
      .default('insecure-development-session-secret-for-testing-purposes-only'),
    secure: booleanFromEnv(true), // Force secure cookies in production
  }),
  rateLimit: z.object({
    max: z.coerce.number().default(5), // Stricter rate limiting in production
    timeWindow: z.coerce.number().default(60 * 1000), // 1 minute
  }),
});

// Logging configuration schema
export const LoggingConfigSchema = z.object({
  level: LogLevelSchema,
});

// File upload configuration schema
export const FileUploadConfigSchema = z.object({
  uploadDir: z.string().default('./uploads'),
  maxFileSizes: z.object({
    image: z.coerce.number().default(10 * 1024 * 1024), // 10MB
    audio: z.coerce.number().default(50 * 1024 * 1024), // 50MB
    video: z.coerce.number().default(100 * 1024 * 1024), // 100MB
  }),
  allowedImageTypes: z
    .array(z.string())
    .default(['image/jpeg', 'image/png', 'image/webp']),
  allowedAudioTypes: z
    .array(z.string())
    .default(['audio/mpeg', 'audio/wav', 'audio/ogg']),
  allowedVideoTypes: z.array(z.string()).default(['video/mp4', 'video/webm']),
  enableMetadataExtraction: booleanFromEnv(true),
  streamingThreshold: z.coerce.number().default(5 * 1024 * 1024), // 5MB
  enableAuditLogging: booleanFromEnv(true),
});

// Feature configuration schema
export const FeatureConfigSchema = z.object({
  offlineMode: z.boolean().default(false),
  syncEnabled: z.boolean().default(true),
  mediaUpload: z.boolean().default(true),
  adminInterface: z.boolean().default(true),
});

// Main application configuration schema
export const AppConfigSchema = z.object({
  environment: EnvironmentSchema,
  server: ServerConfigSchema,
  database: DatabaseConfigSchema,
  auth: AuthConfigSchema,
  security: SecurityConfigSchema,
  logging: LoggingConfigSchema,
  features: FeatureConfigSchema,
  fileUpload: FileUploadConfigSchema,
});

// Environment-specific schemas
export const DevelopmentConfigSchema = AppConfigSchema.extend({
  logging: LoggingConfigSchema.extend({
    level: LogLevelSchema.default('debug' as LogLevel),
  }),
});

export const ProductionConfigSchema = AppConfigSchema.extend({
  auth: ProductionAuthConfigSchema,
  database: DatabaseConfigSchema.extend({
    url: z
      .string()
      .default('postgresql://user:password@localhost:5432/terrastories'),
    ssl: z.boolean().default(true),
  }),
  logging: LoggingConfigSchema.extend({
    level: LogLevelSchema.default('info' as LogLevel),
  }),
});

export const FieldKitConfigSchema = AppConfigSchema.extend({
  features: FeatureConfigSchema.extend({
    offlineMode: z.boolean().default(true),
    syncEnabled: z.boolean().default(false),
    mediaUpload: z.boolean().default(true),
    adminInterface: z.boolean().default(true),
  }),
  logging: LoggingConfigSchema.extend({
    level: LogLevelSchema.default('info' as LogLevel),
  }),
});

export const OfflineConfigSchema = AppConfigSchema.extend({
  server: ServerConfigSchema.extend({
    host: z.string().default('127.0.0.1'),
  }),
  features: FeatureConfigSchema.extend({
    offlineMode: z.boolean().default(true),
    syncEnabled: z.boolean().default(false),
    mediaUpload: z.boolean().default(false),
    adminInterface: z.boolean().default(false),
  }),
  logging: LoggingConfigSchema.extend({
    level: LogLevelSchema.default('error' as LogLevel),
  }),
});

// Export environment-specific schema map
// Test environment configuration
export const TestConfigSchema = AppConfigSchema.extend({
  server: ServerConfigSchema.extend({
    port: z.coerce.number().default(3001),
  }),
  database: DatabaseConfigSchema.extend({
    url: z.string().default(':memory:'),
  }),
  security: SecurityConfigSchema.extend({
    password: z.object({
      algorithm: z.enum(['argon2id']).default('argon2id'),
      argon2: z.object({
        memory: z.coerce.number().min(32768).default(32768), // 32MB (half of production)
        iterations: z.coerce.number().min(2).default(2), // Reduced from 3 for speed
        parallelism: z.coerce.number().min(1).default(2), // Reduced from 4 for speed
      }),
    }),
  }),
  logging: LoggingConfigSchema.extend({
    level: LogLevelSchema.default('error' as LogLevel),
  }),
});

export const EnvironmentSchemas = {
  development: DevelopmentConfigSchema,
  production: ProductionConfigSchema,
  'field-kit': FieldKitConfigSchema,
  offline: OfflineConfigSchema,
  test: TestConfigSchema,
} as const;
