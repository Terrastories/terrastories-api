/**
 * Configuration Management System
 *
 * Provides centralized, validated configuration for the Terrastories API.
 * Supports multiple environments: development, production, field-kit, offline, and test.
 *
 * Features:
 * - Environment-specific configuration files (.env.{environment})
 * - Zod schema validation with detailed error messages
 * - TypeScript type safety
 * - Singleton pattern for performance
 * - Health check integration
 *
 * @example
 * ```typescript
 * import { getConfig } from './shared/config';
 *
 * const config = getConfig();
 * console.log(`Server running on ${config.server.host}:${config.server.port}`);
 * console.log(`Environment: ${config.environment}`);
 * ```
 */

import * as dotenv from 'dotenv';
import { ZodError, ZodIssue } from 'zod';
import { EnvironmentSchemas, EnvironmentSchema } from './schema.js';
import type { AppConfig, Environment } from './types.js';

// Global config instance (singleton pattern)
let configInstance: AppConfig | null = null;

/**
 * Detects the current environment from NODE_ENV
 *
 * Validates against supported environments and provides safe fallback.
 * Supported environments: development, production, field-kit, offline, test
 *
 * @returns {Environment} The detected environment or 'development' as fallback
 */
function detectEnvironment(): Environment {
  const nodeEnv = process.env.NODE_ENV;
  const result = EnvironmentSchema.safeParse(nodeEnv);
  return result.success ? result.data : 'development';
}

/**
 * Loads environment variables from .env files
 *
 * Follows a two-tier loading strategy:
 * 1. Base .env file (if exists)
 * 2. Environment-specific .env.{environment} file (overrides base)
 *
 * @param {Environment} environment - The target environment
 * @param {boolean} skipEnvFiles - Skip .env loading (useful for testing)
 */
function loadEnvironmentFile(
  environment: Environment,
  skipEnvFiles = false
): void {
  if (skipEnvFiles) {
    return; // Skip loading .env files (useful for testing)
  }

  // Load base .env file first (if exists)
  dotenv.config();

  // Load environment-specific file with override (takes precedence)
  const envFile = `.env.${environment}`;
  dotenv.config({ path: envFile, override: true });
}

/**
 * Creates raw configuration object from environment variables
 *
 * Maps process.env values to config structure for Zod validation.
 * Undefined values will be replaced by schema defaults during validation.
 *
 * @param {Environment} environment - The target environment
 * @returns {Record<string, unknown>} Raw config object for validation
 */
function createConfigFromEnv(
  environment: Environment
): Record<string, unknown> {
  return {
    environment,
    server: {
      port: process.env.PORT,
      host: process.env.HOST,
    },
    database: {
      url: process.env.DATABASE_URL || './data.db',
    },
    auth: {
      jwtSecret: process.env.JWT_SECRET,
      session: {
        secret: process.env.SESSION_SECRET,
        maxAge: process.env.SESSION_MAX_AGE,
        secure: process.env.SESSION_SECURE,
        httpOnly: process.env.SESSION_HTTP_ONLY,
        sameSite: process.env.SESSION_SAME_SITE,
      },
      rateLimit: {
        max: process.env.RATE_LIMIT_MAX,
        timeWindow: process.env.RATE_LIMIT_TIME_WINDOW,
      },
    },
    security: {
      password: {
        algorithm: process.env.PASSWORD_ALGORITHM,
        argon2: {
          memory: process.env.PASSWORD_ARGON2_MEMORY,
          iterations: process.env.PASSWORD_ARGON2_ITERATIONS,
          parallelism: process.env.PASSWORD_ARGON2_PARALLELISM,
        },
      },
    },
    logging: {
      level: process.env.LOG_LEVEL,
    },
    features: {
      // Feature flags are set by schema defaults based on environment
      offlineMode: undefined,
      syncEnabled: undefined,
      mediaUpload: undefined,
      adminInterface: undefined,
    },
    fileUpload: {
      uploadDir: process.env.UPLOAD_DIR,
      maxFileSizes: {
        image: process.env.MAX_IMAGE_SIZE,
        audio: process.env.MAX_AUDIO_SIZE,
        video: process.env.MAX_VIDEO_SIZE,
      },
      allowedImageTypes: process.env.ALLOWED_IMAGE_TYPES?.split(','),
      allowedAudioTypes: process.env.ALLOWED_AUDIO_TYPES?.split(','),
      allowedVideoTypes: process.env.ALLOWED_VIDEO_TYPES?.split(','),
      enableMetadataExtraction: process.env.ENABLE_METADATA_EXTRACTION,
      streamingThreshold: process.env.STREAMING_THRESHOLD,
      enableAuditLogging: process.env.ENABLE_AUDIT_LOGGING,
    },
  };
}

/**
 * Validates and loads configuration for the specified environment
 *
 * Implements singleton pattern for performance - subsequent calls return cached instance
 * unless forceReload is true or environment changes.
 *
 * @param {boolean} forceReload - Force reload even if config already loaded
 * @param {boolean} skipEnvFiles - Skip .env file loading (useful for testing)
 * @returns {AppConfig} Validated configuration object
 * @throws {Error} Detailed validation errors if configuration is invalid
 *
 * @example
 * ```typescript
 * // Normal usage
 * const config = loadConfig();
 *
 * // Force reload (useful after environment changes)
 * const config = loadConfig(true);
 *
 * // Testing usage (skip .env files)
 * const config = loadConfig(true, true);
 * ```
 */
export function loadConfig(
  forceReload = false,
  skipEnvFiles = false
): AppConfig {
  // Always reload in tests when environment changes
  if (forceReload || process.env.NODE_ENV !== configInstance?.environment) {
    configInstance = null;
  }

  if (configInstance && !forceReload) {
    return configInstance;
  }

  try {
    // Step 1: Detect environment (before loading files)
    const environment = detectEnvironment();

    // Step 2: Load environment files (environment-specific overrides base)
    loadEnvironmentFile(environment, skipEnvFiles);

    // Step 3: Create raw config from environment variables
    const rawConfig = createConfigFromEnv(environment);

    // Step 4: Get environment-specific schema for validation
    const schema = EnvironmentSchemas[environment];

    // Step 5: Validate and parse configuration with Zod
    configInstance = schema.parse(rawConfig);

    return configInstance;
  } catch (error) {
    if (error instanceof ZodError) {
      // Transform Zod errors into user-friendly messages
      const errorMessages =
        error.issues?.map((err: ZodIssue) => {
          return err.message;
        }) || [];

      const message =
        errorMessages.length > 0
          ? `Configuration validation failed:\n${errorMessages.join('\n')}`
          : `Configuration validation failed: ${error.message}`;
      throw new Error(message);
    }

    // Re-throw non-validation errors
    throw error;
  }
}

/**
 * Gets the current configuration instance
 *
 * Convenience function that loads configuration if not already loaded.
 * Uses singleton pattern for performance optimization.
 *
 * @returns {AppConfig} The current configuration instance
 *
 * @example
 * ```typescript
 * const config = getConfig();
 * const server = fastify({ logger: { level: config.logging.level } });
 * ```
 */
export function getConfig(): AppConfig {
  if (!configInstance) {
    return loadConfig();
  }
  return configInstance;
}

/**
 * Validates the current configuration without loading
 *
 * Used for health checks and startup validation.
 * Returns validation status with detailed error messages if invalid.
 *
 * @returns {object} Validation result with status and optional errors
 *
 * @example
 * ```typescript
 * const result = validateConfig();
 * if (!result.valid) {
 *   console.error('Config errors:', result.errors);
 * }
 * ```
 */
export function validateConfig(): { valid: boolean; errors?: string[] } {
  try {
    loadConfig();
    return { valid: true };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown validation error';
    return {
      valid: false,
      errors: errorMessage.split('\n').filter((line) => line.trim()),
    };
  }
}

// Export types for convenience
export type { AppConfig, Environment } from './types.js';
