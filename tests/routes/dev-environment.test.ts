import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it.each(['.env', '.env.development', '.env.production'])(
    'does not let %s enable routes with unset mode',
    async (filename) => {
      const previousCwd = process.cwd();
      const directory = mkdtempSync(join(tmpdir(), 'terrastories-env-'));
      writeFileSync(join(directory, filename), 'NODE_ENV=development\n');
      vi.stubEnv('NODE_ENV', undefined);
      vi.stubEnv('DATABASE_URL', ':memory:');
      vi.stubEnv('JWT_SECRET', 'fixture-jwt-key-with-at-least-32-characters');
      vi.stubEnv(
        'SESSION_SECRET',
        'fixture-session-key-with-at-least-32-characters'
      );
      try {
        process.chdir(directory);
        loadConfig(true);
        const app = await buildApp();
        try {
          expect((await app.inject('/dev/seed')).statusCode).toBe(404);
        } finally {
          await app.close();
        }
      } finally {
        process.chdir(previousCwd);
      }
    }
  );

  it.each(deniedEnvironments)(
    'omits development routes for NODE_ENV=%s',
    async (environment) => {
      vi.stubEnv('NODE_ENV', environment);
      vi.stubEnv('DATABASE_URL', ':memory:');
      vi.stubEnv('JWT_SECRET', 'fixture-jwt-key-with-at-least-32-characters');
      vi.stubEnv(
        'SESSION_SECRET',
        'fixture-session-key-with-at-least-32-characters'
      );
      if (
        environment !== undefined &&
        !['production', 'field-kit', 'offline'].includes(environment)
      ) {
        expect(() => loadConfig(true, true)).toThrow('NODE_ENV must name');
        await expect(buildApp()).rejects.toThrow('NODE_ENV must name');
        return;
      }
      loadConfig(true, true);
      const app = await buildApp();
      try {
        for (const url of [
          '/dev/seed',
          '/dev/seed/',
          '/DEV/SEED',
          '/api/dev/seed',
          '/api/v1/dev/seed',
        ]) {
          for (const method of ['GET', 'HEAD'] as const) {
            expect((await app.inject({ method, url })).statusCode).toBe(404);
          }
        }
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
