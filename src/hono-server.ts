import { CommunityErasureService } from './services/community-erasure.service.js';
import { CommunitySovereigntyRepository } from './repositories/community-sovereignty.repository.js';
import { createNodeErasureRecordStore } from './node-erasure-record-store.js';
import { CommunityExportRepository } from './repositories/community-export.repository.js';
import { CommunityExportService } from './services/community-export.service.js';
import { EXPORT_EXPIRY_GRACE_MS } from './shared/export-policy.js';
/** Opt-in Node coexistence listener; never imported by the Fastify entrypoint. */
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createLocalStorage } from './node-storage.js';
import { getDb } from './db/index.js';
import { createHonoApp } from './hono-app.js';
import { HonoFoundationRepository } from './repositories/hono-foundation.repository.js';
import { MediaCleanupCoordinator } from './services/media-cleanup.service.js';
import { scheduleOrphanSweep } from './services/orphan-sweep-scheduler.js';
import {
  runMaintenanceSweeps,
  scheduleMaintenanceSweeps,
} from './services/maintenance-sweeps.js';
import { envFlagEnabled } from './services/hono-foundation.service.js';
import {
  validateNodeV2Runtime,
  v2RuntimeModeNotice,
} from './config/v2-runtime.js';

// #150: refuse to start on insecure/default production configuration before
// any adapter or database is opened. Messages name settings, never values.
const runtimeConfig = validateNodeV2Runtime(process.env);
// PR #229 review: a relaxed mode must never be silent on a deployed host —
// one content-free startup line naming the mode.
/** Only the one explicit, case-insensitive header name enables X-Real-IP trust. */
function isTrustedProxyHeader(
  value: string | undefined
): 'x-real-ip' | undefined {
  return /^\s*x-real-ip\s*$/i.test(value ?? '') ? 'x-real-ip' : undefined;
}
const modeNotice = v2RuntimeModeNotice(runtimeConfig);
if (modeNotice) {
  // eslint-disable-next-line no-console -- startup marker, content-free
  console.warn(modeNotice);
}
const db = await getDb();
const storage = await createLocalStorage(
  process.env.HONO_STORAGE_ROOT ?? './uploads'
);
const erasureStore = process.env.ERASURE_RECORDS_ROOT
  ? await createNodeErasureRecordStore(process.env.ERASURE_RECORDS_ROOT)
  : undefined;
const app = createHonoApp({
  erasureStore,
  repository: new HonoFoundationRepository(db),
  // Prelogin HMAC key (SPEC-V2 §7 step 1). Validated by the runtime gate in
  // production-like modes; prelogin fails closed when absent.
  serverSecret: runtimeConfig.serverSecret,
  bootstrapSecret: runtimeConfig.bootstrapSecret,
  requireRecoveryCodes: true,
  publicOrigin: runtimeConfig.publicOrigin,
  corsOrigins: runtimeConfig.corsOrigins,
  // HTTP cookies are allowed only for this opt-in loopback development listener.
  secureCookies: runtimeConfig.secureCookies,
  storage,
  // Only a configured reverse proxy makes forwarded headers trustworthy: the
  // per-IP throttle then keys on the rightmost X-Forwarded-For entry — the
  // one the trusted proxy appended. X-Real-IP is honoured only when the
  // operator explicitly names it as the proxy's client-address header; set it
  // only when the proxy overwrites (or strips) X-Real-IP. Without TRUSTED_PROXY
  // the socket peer address is the limit (finding E).
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUSTED_PROXY ?? ''),
  trustedProxyHeader: isTrustedProxyHeader(process.env.TRUSTED_PROXY_HEADER),
  clientAddress: (c) => getConnInfo(c).remote.address ?? null,
  fieldKitCaFingerprint:
    process.env.FIELD_KIT_CA_FINGERPRINT?.trim() || undefined,
  mapboxAccessToken: runtimeConfig.mapboxAccessToken,
  offlineMode:
    runtimeConfig.environment === 'offline' ||
    runtimeConfig.environment === 'field-kit' ||
    envFlagEnabled(process.env.OFFLINE_MODE),
});
const server = serve({
  fetch: app.fetch,
  // Loopback by default; container images set HONO_HOST=0.0.0.0 so a published
  // port or a reverse-proxy sidecar can reach the listener.
  hostname: process.env.HONO_HOST?.trim() || '127.0.0.1',
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

// Maintenance sweeps on the Workers cron cadence: audit IP/UA scrub past the
// 90-day retention cutoff, expired session rows, spent non-blocking throttle
// rows, and expired export artifacts past their 15-minute TTL (never master
// media bytes). So ORPHAN_SWEEP_PAUSED (the storage-restore hold covering
// unreferenced master media) deliberately does not pause them. Each job runs
// in its own try/catch with content-free logging; one failing job never
// blocks the others. First run after a named delay; unref'd interval.
const maintenanceSweepTimers = scheduleMaintenanceSweeps(() => {
  // Each job already catches its own failure; this catch keeps any
  // unexpected throw from becoming an unhandled rejection that ends the
  // process.
  runMaintenanceSweeps(db, { storage, erasureStore }).catch(() => {
    // eslint-disable-next-line no-console -- operator channel; content-free
    console.warn('maintenance sweeps: run failed');
  });
});

// Restart fallback: persisted exports are reclaimed within one minute of boot
// or expiry, independently of the larger hourly maintenance jobs.
const exportExpiryService = new CommunityExportService(
  new CommunityExportRepository(db),
  storage
);
const erasureService = erasureStore
  ? new CommunityErasureService(
      new CommunitySovereigntyRepository(db),
      storage,
      erasureStore
    )
  : undefined;
let erasureSweepRunning = false;
const exportExpiryTimer = setInterval(() => {
  if (erasureService && !erasureSweepRunning) {
    erasureSweepRunning = true;
    void erasureService
      .sweep(new Date())
      .catch(() => {
        // eslint-disable-next-line no-console -- content-free operator channel
        console.warn('maintenance: community erasure sweep failed');
      })
      .finally(() => {
        erasureSweepRunning = false;
      });
  }
  void exportExpiryService.cleanupExpiredExports().catch(() => {
    // eslint-disable-next-line no-console -- content-free operator channel
    console.warn('maintenance: expired export sweep failed');
  });
}, EXPORT_EXPIRY_GRACE_MS);
exportExpiryTimer.unref();

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(exportExpiryTimer);
  clearTimeout(orphanSweepTimers.first);
  clearInterval(orphanSweepTimers.interval);
  clearTimeout(maintenanceSweepTimers.first);
  clearInterval(maintenanceSweepTimers.interval);
  server.close(() => process.exit(0));
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, shutdown);
}
