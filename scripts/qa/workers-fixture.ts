/**
 * Workers persona QA fixture (#199): the same Hono journeys as
 * scripts/qa/hono-fixture.ts, executed against the real Workers build —
 * src/worker.ts bundled by esbuild and running in workerd through Miniflare,
 * with D1 `DB` for data and R2 `MEDIA` for media (tests/helpers/
 * worker-runtime.ts). Seeding happens from Node through the same bindings
 * (`drizzle-orm/d1` over `mf.getD1Database`, `bucket.put` over
 * `mf.getR2Bucket`), and the runner's requests dispatch into workerd, so no
 * Node-only behaviour can hide a sovereignty leak from the hosted Workers
 * Free profile.
 *
 * Passwords: client-stretched login (SPEC-V2 §7) — the fixture seeds the
 * same Argon2id verifier every backend seeds and the journeys present the
 * derived key directly; no password KDF runs inside workerd.
 */
import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';
import {
  applyD1Migrations,
  bundleWorkerModule,
  startWorkerRuntime,
} from '../../tests/helpers/worker-runtime.js';
import {
  createFixture as createHonoPersonaFixture,
  honoPersonaRouteTable,
  type HonoQaBackend,
} from './hono-fixture.js';
import { seedPersonaBaseline } from './qa-database.js';
import type { Handler } from './runner.js';
import { toHex } from '../../src/shared/auth-crypto.js';

/**
 * The worker gateway: adds no routes of its own, so every dispatched request
 * is served by the worker's own Hono app over the D1/R2 bindings. That app's
 * route table cannot be read from Node, so the backend below states
 * honoPersonaRouteTable() — derived from `createHonoApp`, which
 * `createWorker` composes — rather than the bundled worker's own table.
 */
export const WORKER_GATEWAY = `import worker from './src/worker.js';
export default worker;
`;

export async function createFixture({ baseUrl }: { baseUrl?: string } = {}) {
  if (baseUrl)
    throw new Error(
      'The Workers fixture supports isolated in-process workerd runs only'
    );
  // One runtime HMAC key shared by the served worker and the fixture's own
  // login bodies: it keys prelogin fakes and AuthThrottle hashes. Built per
  // run, never a literal.
  const serverSecret = toHex(crypto.getRandomValues(new Uint8Array(24)));
  const freshServerSecret = toHex(crypto.getRandomValues(new Uint8Array(24)));
  const freshBootstrapSecret = toHex(
    crypto.getRandomValues(new Uint8Array(24))
  );
  const workerScript = await bundleWorkerModule(WORKER_GATEWAY);
  const mf = startWorkerRuntime(
    workerScript,
    {
      ENVIRONMENT: 'test',
      AUTH_SERVER_SECRET: serverSecret,
    },
    { unsafeTriggerHandlers: true }
  );
  let freshMf: ReturnType<typeof startWorkerRuntime> | undefined;
  let backend: HonoQaBackend;
  const dispatchTo =
    (
      runtime: ReturnType<typeof startWorkerRuntime>,
      observeResponseCookies: (response: Response) => void
    ): Handler =>
    async (request) => {
      // dispatchFetch parses Miniflare's own undici types, and a
      // Node-global Request object is a foreign realm to them, so rebuild
      // the request from its URL and an init the worker accepts.
      const response = await runtime.dispatchFetch(request.url, {
        method: request.method,
        headers: [...request.headers],
        body: ['GET', 'HEAD'].includes(request.method)
          ? undefined
          : await request.arrayBuffer(),
        signal: request.signal,
      });
      observeResponseCookies(response as unknown as Response);
      return response as unknown as Response;
    };
  const disposeRuntimes = async () => {
    const errors: unknown[] = [];
    for (const runtime of [mf, freshMf]) {
      if (!runtime) continue;
      try {
        await runtime.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, 'Workers persona QA cleanup failed');
  };
  try {
    const d1 = await mf.getD1Database('DB');
    await applyD1Migrations(d1);
    const bucket = await mf.getR2Bucket('MEDIA');
    const db = drizzle(d1);
    freshMf = startWorkerRuntime(workerScript, {
      ENVIRONMENT: 'test',
      AUTH_SERVER_SECRET: freshServerSecret,
      BOOTSTRAP_SECRET: freshBootstrapSecret,
    });
    const freshD1 = await freshMf.getD1Database('DB');
    await applyD1Migrations(freshD1);
    backend = {
      db,
      runErasureSweep: async () => {
        const response = await mf.dispatchFetch(
          `http://localhost/cdn-cgi/handler/scheduled?cron=*/1+*+*+*+*&time=${Date.now()}`,
          { method: 'POST' }
        );
        if (response.status !== 200) throw new Error('Erasure cron failed');
      },
      seedBaseline: () => seedPersonaBaseline(db),
      seededAdminsHaveRecoveryCodes: true,
      serverSecret,
      putMedia: (key, bytes) => bucket.put(key, bytes),
      hasMedia: async (key) => (await bucket.head(key)) !== null,
      handler: (observeResponseCookies) =>
        dispatchTo(mf, observeResponseCookies),
      freshBootstrap: {
        bootstrapSecret: freshBootstrapSecret,
        handler: (observeResponseCookies) =>
          dispatchTo(freshMf!, observeResponseCookies),
      },
      // Out of process: the served app's `app.routes` is unreadable from
      // Node, so coverage uses the createHonoApp-derived
      // honoPersonaRouteTable(), not the bundled worker's own table.
      routes: honoPersonaRouteTable(),
      close: disposeRuntimes,
    };
  } catch (error) {
    await disposeRuntimes().catch(() => undefined);
    throw error;
  }
  // createHonoPersonaFixture owns backend.close from here: it disposes the
  // runtime on seeding failures and wires it into the returned fixture's
  // close.
  const fixture = await createHonoPersonaFixture({ backend });
  // The worker enforces the SPEC-V2 §7 recovery-code gate (#254): give every
  // seeded community administrator an active recovery code so the journeys
  // reach their routes. Gate behaviour itself is covered by
  // tests/hono/recovery-code-gate.test.ts.
  try {
    await backend.db.run(
      sql`INSERT INTO login_codes (community_id, user_id, purpose, code_hash, created_by, created_at)
          SELECT community_id, id, 'recovery', 'seeded-recovery-' || id, id, 0
          FROM users u
          WHERE role = 'admin' AND community_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM login_codes c
              WHERE c.user_id = u.id AND c.purpose = 'recovery'
                AND c.used_at IS NULL AND c.superseded_at IS NULL
            )`
    );
  } catch (error) {
    await fixture.close().catch(() => undefined);
    throw error;
  }
  return fixture;
}
