/**
 * Configuration Type Definitions
 *
 * TypeScript types for the Terrastories API configuration system.
 * These types are derived from and validated by the Zod schemas.
 */

/**
 * Supported deployment environments
 *
 * - development: Local development with debug features
 * - production: Production deployment with security hardening
 * - field-kit: Offline-capable field deployment
 * - offline: Local-only deployment with minimal features
 * - test: Testing environment with in-memory database
 */
export type Environment =
  | 'development'
  | 'production'
  | 'field-kit'
  | 'offline'
  | 'test';

/**
 * Logging levels in order of severity
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * HTTP server configuration
 */
export interface ServerConfig {
  /** Port number for the HTTP server */
  port: number;
  /** Host interface to bind to */
  host: string;
}

/**
 * Database connection configuration
 */
export interface DatabaseConfig {
  /** Database connection URL (SQLite file path or PostgreSQL connection string) */
  url: string;
  /** Connection pool size for PostgreSQL */
  poolSize: number;
  /** Maximum number of connections */
  maxConnections: number;
  /** Enable SSL connections */
  ssl: boolean;
  /** Enable spatial database extensions (PostGIS/SpatiaLite) */
  spatialSupport: boolean;
}

/**
 * Authentication and security configuration
 */
export interface AuthConfig {
  /** JWT signing secret (must be 32+ characters in production) */
  jwtSecret: string;
}

/**
 * Security configuration for cryptographic operations
 */
export interface SecurityConfig {
  /** Password hashing configuration */
  password: {
    /** Hashing algorithm (currently argon2id) */
    algorithm: 'argon2id';
    /** Argon2 algorithm parameters */
    argon2: {
      /** Memory cost in KB (default: 64MB = 65536) */
      memory: number;
      /** Time cost / iterations (default: 3) */
      iterations: number;
      /** Parallelism factor (default: 4) */
      parallelism: number;
    };
  };
}

/**
 * Logging configuration
 */
export interface LoggingConfig {
  /** Log level threshold */
  level: LogLevel;
}

/**
 * Feature flags for environment-specific capabilities
 */
export interface FeatureConfig {
  /** Enable offline-only mode */
  offlineMode: boolean;
  /** Enable data synchronization */
  syncEnabled: boolean;
  /** Enable media file uploads */
  mediaUpload: boolean;
  /** Enable admin interface */
  adminInterface: boolean;
}

/**
 * Complete application configuration
 *
 * Validated and environment-specific configuration object
 * containing all settings needed to run the Terrastories API.
 */
export interface AppConfig {
  /** Current deployment environment */
  environment: Environment;
  /** HTTP server settings */
  server: ServerConfig;
  /** Database connection settings */
  database: DatabaseConfig;
  /** Authentication and security settings */
  auth: AuthConfig;
  /** Security and cryptographic settings */
  security: SecurityConfig;
  /** Logging configuration */
  logging: LoggingConfig;
  /** Environment-specific feature flags */
  features: FeatureConfig;
}
