import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, getConfig } from '../src/shared/config/index.js';
import type { AppConfig, Environment } from '../src/shared/config/types.js';

describe('Configuration System', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset process.env before each test and clear any loaded config
    process.env = { ...originalEnv };

    // Clear any environment files that might interfere with tests
    process.env.NODE_ENV = 'development';
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.DATABASE_URL;
    process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
    process.env.SESSION_SECRET =
      'test-session-secret-at-least-32-characters-long';
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('Environment Detection', () => {
    it('should select production when runtime mode is unset', () => {
      delete process.env.NODE_ENV;
      const config = loadConfig(true, true);
      expect(config.environment).toBe('production');
    });

    it('should detect production environment when NODE_ENV=production', () => {
      process.env.NODE_ENV = 'production';
      const config = loadConfig(true, true);
      expect(config.environment).toBe('production');
    });

    it('should detect field-kit environment when NODE_ENV=field-kit', () => {
      process.env.NODE_ENV = 'field-kit';
      const config = loadConfig(true, true);
      expect(config.environment).toBe('field-kit');
    });

    it('should detect offline environment when NODE_ENV=offline', () => {
      process.env.NODE_ENV = 'offline';
      const config = loadConfig(true, true);
      expect(config.environment).toBe('offline');
    });

    it.each(['unknown', 'staging', '', 'test '])('rejects mode %s', (mode) => {
      process.env.NODE_ENV = mode;
      expect(() => loadConfig(true, true)).toThrow('NODE_ENV must name');
    });

    it('caches configuration when runtime mode is unset', () => {
      delete process.env.NODE_ENV;
      expect(loadConfig(true, true)).toBe(loadConfig(false, true));
    });

    it.each([
      'your-session-secret-minimum-32-characters-required-for-cookies',
      'your-super-secret-jwt-key-change-this-in-production',
      'insecure-development-session-secret-for-testing-purposes-only',
      'field-kit-deployment-secret-change-me',
      'offline-mode-secret-temporary-session',
    ])('rejects shipped production placeholder %s', (value) => {
      process.env.NODE_ENV = 'production';
      process.env.SESSION_SECRET = value;
      expect(() => loadConfig(true, true)).toThrow('shipped placeholder');
    });
  });

  describe('Configuration Loading', () => {
    describe.each(['field-kit', 'offline'])(
      '%s installation secrets',
      (mode) => {
        it.each(['JWT_SECRET', 'SESSION_SECRET'])('requires %s', (secret) => {
          process.env.NODE_ENV = mode;
          delete process.env[secret];
          expect(() => loadConfig(true, true)).toThrow(
            'Configuration validation failed'
          );
        });

        it.each(['JWT_SECRET', 'SESSION_SECRET'])(
          'rejects weak or placeholder %s',
          (secret) => {
            process.env.NODE_ENV = mode;
            for (const value of [
              'short',
              'field-kit-deployment-secret-change-me',
              'offline-mode-secret-temporary-session',
            ]) {
              process.env[secret] = value;
              expect(() => loadConfig(true, true)).toThrow(
                'Configuration validation failed'
              );
            }
          }
        );

        it('accepts installation secrets with local cookie settings', () => {
          process.env.NODE_ENV = mode;
          const config = loadConfig(true, true);
          expect(config.auth.jwtSecret).toBe(process.env.JWT_SECRET);
          expect(config.auth.session.secret).toBe(process.env.SESSION_SECRET);
          expect(config.auth.session.secure).toBe(false);
        });
      }
    );

    it.each(['field-kit', 'offline'])(
      'requires an installation session secret in %s',
      (mode) => {
        process.env.NODE_ENV = mode;
        delete process.env.SESSION_SECRET;
        expect(() => loadConfig(true, true)).toThrow(
          'Configuration validation failed'
        );
      }
    );

    it.each(['JWT_SECRET', 'SESSION_SECRET'])(
      'rejects production startup without %s',
      (secret) => {
        process.env.NODE_ENV = 'production';
        process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
        delete process.env[secret];
        expect(() => loadConfig(true, true)).toThrow(
          'Configuration validation failed'
        );
      }
    );

    it('should load valid development configuration', () => {
      process.env.NODE_ENV = 'development';
      process.env.PORT = '3000';
      process.env.HOST = '0.0.0.0';
      process.env.DATABASE_URL = './data.db';
      process.env.JWT_SECRET = 'dev-secret';
      process.env.LOG_LEVEL = 'debug';

      const config = loadConfig(true, true);

      expect(config).toMatchObject({
        environment: 'development',
        server: {
          port: 3000,
          host: '0.0.0.0',
        },
        database: {
          url: './data.db',
        },
        auth: {
          jwtSecret: 'dev-secret',
        },
        logging: {
          level: 'debug',
        },
      });
    });

    it('should preserve explicit runtime environment values over dotenv files', () => {
      process.env.NODE_ENV = 'development';
      process.env.DATABASE_URL = './runtime-explicit.db';

      const config = loadConfig(true, false);

      expect(config.database.url).toBe('./runtime-explicit.db');
    });

    it('should load valid production configuration', () => {
      process.env.NODE_ENV = 'production';
      process.env.PORT = '80';
      process.env.HOST = '0.0.0.0';
      process.env.DATABASE_URL = 'postgresql://user:pass@db:5432/terrastories';
      process.env.JWT_SECRET =
        'super-secure-secret-at-least-32-characters-long';
      process.env.LOG_LEVEL = 'warn';

      const config = loadConfig(true, true);

      expect(config).toMatchObject({
        environment: 'production',
        server: {
          port: 80,
          host: '0.0.0.0',
        },
        database: {
          url: 'postgresql://user:pass@db:5432/terrastories',
        },
        auth: {
          jwtSecret: 'super-secure-secret-at-least-32-characters-long',
        },
        logging: {
          level: 'warn',
        },
      });
    });

    it('should load field-kit configuration with offline features', () => {
      process.env.NODE_ENV = 'field-kit';
      process.env.PORT = '3000';
      process.env.HOST = '0.0.0.0';
      process.env.DATABASE_URL = './field-kit-data.db';
      process.env.JWT_SECRET =
        'field-kit-installation-jwt-secret-at-least-32-characters';
      process.env.LOG_LEVEL = 'info';

      const config = loadConfig(true, true);

      expect(config).toMatchObject({
        environment: 'field-kit',
        server: {
          port: 3000,
          host: '0.0.0.0',
        },
        database: {
          url: './field-kit-data.db',
        },
        auth: {
          jwtSecret: 'field-kit-installation-jwt-secret-at-least-32-characters',
        },
        logging: {
          level: 'info',
        },
        features: {
          offlineMode: true,
          syncEnabled: false,
          mediaUpload: true,
          adminInterface: true,
        },
      });
    });

    it('should load offline configuration with minimal features', () => {
      process.env.NODE_ENV = 'offline';
      process.env.PORT = '3000';
      process.env.HOST = '127.0.0.1';
      process.env.DATABASE_URL = ':memory:';
      process.env.JWT_SECRET =
        'offline-installation-jwt-secret-at-least-32-characters';
      process.env.LOG_LEVEL = 'error';

      const config = loadConfig(true, true);

      expect(config).toMatchObject({
        environment: 'offline',
        server: {
          port: 3000,
          host: '127.0.0.1',
        },
        database: {
          url: ':memory:',
        },
        auth: {
          jwtSecret: 'offline-installation-jwt-secret-at-least-32-characters',
        },
        logging: {
          level: 'error',
        },
        features: {
          offlineMode: true,
          syncEnabled: false,
          mediaUpload: false,
          adminInterface: false,
        },
      });
    });
  });

  describe('Configuration Defaults', () => {
    it('should apply correct defaults for development', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.PORT;
      delete process.env.HOST;
      delete process.env.LOG_LEVEL;

      const config = loadConfig(true, true);

      expect(config.server.port).toBe(3000);
      expect(config.server.host).toBe('0.0.0.0');
      expect(config.logging.level).toBe('debug');
      expect(config.features.offlineMode).toBe(false);
      expect(config.features.syncEnabled).toBe(true);
    });

    it('should apply correct defaults for production', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.PORT;
      delete process.env.LOG_LEVEL;

      const config = loadConfig(true, true);

      expect(config.server.port).toBe(3000);
      expect(config.logging.level).toBe('info');
      expect(config.features.offlineMode).toBe(false);
      expect(config.features.syncEnabled).toBe(true);
    });
  });

  describe('Configuration Validation', () => {
    it('should validate required fields', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'short';

      expect(() => loadConfig(true, true)).toThrow(
        'JWT_SECRET must be at least 32 characters in production'
      );
    });

    it('should validate port number range', () => {
      process.env.PORT = '99999';

      expect(() => loadConfig(true, true)).toThrow(
        'PORT must be between 1 and 65535'
      );
    });

    it('should validate log level enum', () => {
      process.env.LOG_LEVEL = 'invalid';

      expect(() => loadConfig(true, true)).toThrow(
        'Configuration validation failed'
      );
    });

    it('should validate database URL format', () => {
      process.env.DATABASE_URL = 'invalid-url';

      expect(() => loadConfig(true, true)).toThrow(
        'DATABASE_URL must be a valid database connection string'
      );
    });

    it('should validate JWT secret length in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'short';

      expect(() => loadConfig(true, true)).toThrow(
        'JWT_SECRET must be at least 32 characters in production'
      );
    });
  });

  describe('Configuration Singleton', () => {
    it('should return the same config instance on multiple calls', () => {
      const config1 = getConfig();
      const config2 = getConfig();

      expect(config1).toBe(config2);
    });

    it('should reload config when explicitly called', () => {
      process.env.PORT = '3000';
      const config1 = loadConfig();

      process.env.PORT = '4000';
      const config2 = loadConfig(true, true);

      expect(config1.server.port).toBe(3000);
      expect(config2.server.port).toBe(4000);
    });
  });

  describe('Environment-Specific Features', () => {
    it('should enable sync in development and production', () => {
      process.env.NODE_ENV = 'development';
      const devConfig = loadConfig(true, true);
      expect(devConfig.features.syncEnabled).toBe(true);

      process.env.NODE_ENV = 'production';
      const prodConfig = loadConfig(true, true);
      expect(prodConfig.features.syncEnabled).toBe(true);
    });

    it('should disable sync in field-kit and offline modes', () => {
      process.env.NODE_ENV = 'field-kit';
      const fieldConfig = loadConfig(true, true);
      expect(fieldConfig.features.syncEnabled).toBe(false);

      process.env.NODE_ENV = 'offline';
      const offlineConfig = loadConfig(true, true);
      expect(offlineConfig.features.syncEnabled).toBe(false);
    });

    it('should enable offline mode only in field-kit and offline environments', () => {
      process.env.NODE_ENV = 'field-kit';
      const fieldConfig = loadConfig(true, true);
      expect(fieldConfig.features.offlineMode).toBe(true);

      process.env.NODE_ENV = 'offline';
      const offlineConfig = loadConfig(true, true);
      expect(offlineConfig.features.offlineMode).toBe(true);

      process.env.NODE_ENV = 'development';
      const devConfig = loadConfig(true, true);
      expect(devConfig.features.offlineMode).toBe(false);
    });
  });

  describe('Type Safety', () => {
    it('should have proper TypeScript types for all config properties', () => {
      const config: AppConfig = loadConfig();

      // This test ensures TypeScript compilation succeeds with proper types
      expect(typeof config.environment).toBe('string');
      expect(typeof config.server.port).toBe('number');
      expect(typeof config.server.host).toBe('string');
      expect(typeof config.database.url).toBe('string');
      expect(typeof config.auth.jwtSecret).toBe('string');
      expect(typeof config.logging.level).toBe('string');
      expect(typeof config.features.offlineMode).toBe('boolean');
      expect(typeof config.features.syncEnabled).toBe('boolean');
      expect(typeof config.features.mediaUpload).toBe('boolean');
      expect(typeof config.features.adminInterface).toBe('boolean');
    });

    it('should properly type environment as literal union', () => {
      const config = loadConfig(true, true);
      const env: Environment = config.environment;

      // This ensures environment is properly typed as union
      expect(['development', 'production', 'field-kit', 'offline']).toContain(
        env
      );
    });
  });
});
