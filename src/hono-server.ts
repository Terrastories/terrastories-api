/** Opt-in Node coexistence listener; never imported by the Fastify entrypoint. */
import { serve } from '@hono/node-server';
import { nodePasswordVerifier } from './node-password.js';
import { createLocalStorage } from './node-storage.js';
import { getDb } from './db/index.js';
import { createHonoApp } from './hono-app.js';
import { HonoFoundationRepository } from './repositories/hono-foundation.repository.js';

const app = createHonoApp({
  verifier: {
    verify: (...args) =>
      process.env.NODE_ENV === 'development'
        ? nodePasswordVerifier.verify(...args)
        : Promise.reject(new Error('Production verifier not configured')),
  },
  repository: new HonoFoundationRepository(await getDb()),
  publicOrigin: process.env.HONO_PUBLIC_ORIGIN,
  corsOrigins: process.env.HONO_CORS_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  // HTTP cookies are allowed only for this opt-in loopback development listener.
  secureCookies: process.env.NODE_ENV !== 'development',
  storage: await createLocalStorage(
    process.env.HONO_STORAGE_ROOT ?? './uploads'
  ),
});
const port = Number(process.env.HONO_PORT ?? 3001);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid HONO_PORT');
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
