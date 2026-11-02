import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import Fastify from 'fastify';
import { loadConfig } from '../../src/shared/config/index.js';
import { devRoutes } from '../../src/routes/dev.js';

const deniedEnvironments = [
  'production',
  'staging',
  undefined,
  '',
  'preview',
  'Development',
  'test ',
  'field-kit',
  'offline',
];

afterEach(() => vi.unstubAllEnvs());

describe('Development route environment boundary', () => {
  it.each(deniedEnvironments)(
    'omits development routes for NODE_ENV=%s',
    async (environment) => {
      // Cache valid app configuration first: its development/test defaults
      // must never authorize routes for an unknown runtime environment.
      const warmup = await buildApp();
      await warmup.close();
      vi.stubEnv('NODE_ENV', environment);
      const app = await buildApp();
      try {
        const response = await app.inject('/dev/seed');
        expect(response.statusCode).toBe(404);
        expect(
          (await app.inject({ method: 'HEAD', url: '/dev/seed' })).statusCode
        ).toBe(404);
        expect(app.hasRoute({ method: 'GET', url: '/dev/seed' })).toBe(false);
        expect((await app.inject('/health')).statusCode).toBe(200);
      } finally {
        await app.close();
      }
    }
  );

  it.each(['development', 'test'])(
    'registers development routes for NODE_ENV=%s',
    async (environment) => {
      vi.stubEnv('NODE_ENV', environment);
      vi.stubEnv('DATABASE_URL', ':memory:');
      loadConfig(true, true);
      const app = await buildApp();
      try {
        await app.ready();
        expect(app.hasRoute({ method: 'GET', url: '/dev/seed' })).toBe(true);
      } finally {
        await app.close();
      }
    }
  );

  it.each(deniedEnvironments)(
    'also guards direct plugin registration for NODE_ENV=%s',
    async (environment) => {
      vi.stubEnv('NODE_ENV', environment);
      const app = Fastify();
      try {
        await app.register(devRoutes);
        expect((await app.inject('/dev/seed')).statusCode).toBe(404);
      } finally {
        await app.close();
      }
    }
  );
});
