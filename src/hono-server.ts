/** Opt-in Node coexistence listener; never imported by the Fastify entrypoint. */
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createLocalStorage } from './node-storage.js';
import { getDb } from './db/index.js';
import { createHonoApp } from './hono-app.js';
import { HonoFoundationRepository } from './repositories/hono-foundation.repository.js';
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
const app = createHonoApp({
  repository: new HonoFoundationRepository(await getDb()),
  // Prelogin HMAC key (SPEC-V2 §7 step 1). Validated by the runtime gate in
  // production-like modes; prelogin fails closed when absent.
  serverSecret: runtimeConfig.serverSecret,
  publicOrigin: runtimeConfig.publicOrigin,
  corsOrigins: runtimeConfig.corsOrigins,
  // HTTP cookies are allowed only for this opt-in loopback development listener.
  secureCookies: runtimeConfig.secureCookies,
  storage: await createLocalStorage(
    process.env.HONO_STORAGE_ROOT ?? './uploads'
  ),
  // Only a configured reverse proxy makes forwarded headers trustworthy: the
  // per-IP throttle then keys on the rightmost X-Forwarded-For entry — the
  // one the trusted proxy appended. X-Real-IP is honoured only when the
  // operator explicitly names it as the proxy's client-address header; set it
  // only when the proxy overwrites (or strips) X-Real-IP. Without TRUSTED_PROXY
  // the socket peer address is the limit (finding E).
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUSTED_PROXY ?? ''),
  trustedProxyHeader: isTrustedProxyHeader(process.env.TRUSTED_PROXY_HEADER),
  clientAddress: (c) => getConnInfo(c).remote.address ?? null,
});
const server = serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port: runtimeConfig.port,
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
