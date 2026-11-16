/** Opt-in Node coexistence listener; never imported by the Fastify entrypoint. */
import { serve } from '@hono/node-server';
import { nodePasswordVerifier } from './node-password.js';
import { createLocalStorage } from './node-storage.js';
import { getDb } from './db/index.js';
import { createHonoApp } from './hono-app.js';
import { HonoFoundationRepository } from './repositories/hono-foundation.repository.js';
import { MediaCleanupCoordinator } from './services/media-cleanup.service.js';
import { scheduleOrphanSweep } from './services/orphan-sweep-scheduler.js';
import {
  validateNodeV2Runtime,
  v2RuntimeModeNotice,
} from './config/v2-runtime.js';

// #150: refuse to start on insecure/default production configuration before
// any adapter or database is opened. Messages name settings, never values.
const runtimeConfig = validateNodeV2Runtime(process.env);
// PR #229 review: a relaxed mode must never be silent on a deployed host —
// one content-free startup line naming the mode.
const modeNotice = v2RuntimeModeNotice(runtimeConfig);
if (modeNotice) {
  // eslint-disable-next-line no-console -- startup marker, content-free
  console.warn(modeNotice);
}
const db = await getDb();
const storage = await createLocalStorage(
  process.env.HONO_STORAGE_ROOT ?? './uploads'
);
const app = createHonoApp({
  verifier: {
    verify: (...args) =>
      process.env.NODE_ENV === 'development'
        ? nodePasswordVerifier.verify(...args)
        : Promise.reject(new Error('Production verifier not configured')),
  },
  repository: new HonoFoundationRepository(db),
  publicOrigin: runtimeConfig.publicOrigin,
  corsOrigins: runtimeConfig.corsOrigins,
  // HTTP cookies are allowed only for this opt-in loopback development listener.
  secureCookies: runtimeConfig.secureCookies,
  storage,
});
const server = serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port: runtimeConfig.port,
});

// Restart-safe orphan sweeper: the first sweep runs after a named delay, then
// on an unref'd interval so a long-lived Node server eventually removes bytes
// whose `files` row is gone. No sweep happens at startup: a Node process that
// just restored its storage before the files table finished restoring must use
// the explicit restore hold (ORPHAN_SWEEP_PAUSED=true or a
// `system/orphan-sweep-hold` marker) until the restored state is verified. A
// failed sweep is reported content-free instead of being swallowed.
const cleanup = new MediaCleanupCoordinator(db, storage, {
  // Explicit restore hold; see ORPHAN_SWEEP_HOLD_KEY in hono-foundation.service.ts.
  sweepPaused: envFlagEnabled(process.env.ORPHAN_SWEEP_PAUSED),
});
const sweepOrphanObjects = () => {
  void cleanup.sweepOrphanObjects().catch(() => {
    // eslint-disable-next-line no-console -- operator channel; content-free
    console.warn('media cleanup: orphan sweep failed');
  });
};
const orphanSweepTimers = scheduleOrphanSweep(sweepOrphanObjects);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(orphanSweepTimers.first);
  clearInterval(orphanSweepTimers.interval);
  server.close(() => process.exit(0));
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, shutdown);
}
