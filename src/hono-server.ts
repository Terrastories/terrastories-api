/** Opt-in Node coexistence listener; never imported by the Fastify entrypoint. */
import { serve } from '@hono/node-server';
import { nodePasswordVerifier } from './node-password.js';
import { createLocalStorage } from './node-storage.js';
import { getDb } from './db/index.js';
import { createHonoApp } from './hono-app.js';
import { HonoFoundationRepository } from './repositories/hono-foundation.repository.js';
import { validateNodeV2Runtime } from './config/v2-runtime.js';

// #150: refuse to start on insecure/default production configuration before
// any adapter or database is opened. Messages name settings, never values.
const runtimeConfig = validateNodeV2Runtime(process.env);
const app = createHonoApp({
  verifier: {
    verify: (...args) =>
      process.env.NODE_ENV === 'development'
        ? nodePasswordVerifier.verify(...args)
        : Promise.reject(new Error('Production verifier not configured')),
  },
  repository: new HonoFoundationRepository(await getDb()),
  publicOrigin: runtimeConfig.publicOrigin,
  corsOrigins: runtimeConfig.corsOrigins,
  // HTTP cookies are allowed only for this opt-in loopback development listener.
  secureCookies: runtimeConfig.secureCookies,
  storage: await createLocalStorage(
    process.env.HONO_STORAGE_ROOT ?? './uploads'
  ),
});
const server = serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port: runtimeConfig.port,
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
