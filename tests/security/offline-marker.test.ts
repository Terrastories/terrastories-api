import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { requireAuth } from '../../src/shared/middleware/auth.middleware.js';

afterEach(() => vi.unstubAllEnvs());
describe('Offline authentication', () => {
  it.each(['field-kit', 'offline', 'production'])(
    'rejects public markers without a session in %s',
    async (mode) => {
      vi.stubEnv('NODE_ENV', mode);
      vi.stubEnv('OFFLINE_MODE', 'true');
      const app = Fastify();
      app.get('/protected', { preHandler: requireAuth }, async () => ({
        ok: true,
      }));
      try {
        for (const headers of [
          { authorization: 'Bearer field-kit-admin-token' },
          { cookie: 'field-kit-session=active' },
          {},
        ]) {
          expect(
            (await app.inject({ url: '/protected', headers })).statusCode
          ).toBe(401);
        }
      } finally {
        await app.close();
      }
    }
  );
});
