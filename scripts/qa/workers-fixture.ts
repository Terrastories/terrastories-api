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
import {
  applyD1Migrations,
  bundleWorkerModule,
  startWorkerRuntime,
} from '../../tests/helpers/worker-runtime.js';
import {
  createFixture as createHonoPersonaFixture,
  honoPersonaRouteTable,
  HONO_PERSONA_DERIVED_KEY,
  type HonoQaBackend,
} from './hono-fixture.js';
import { seedPersonaBaseline } from './qa-database.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS_JSON,
} from '../../src/shared/auth-policy.js';
import { sha256Hex, toHex } from '../../src/shared/auth-crypto.js';

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
  const mf = startWorkerRuntime(await bundleWorkerModule(WORKER_GATEWAY), {
    ENVIRONMENT: 'test',
    AUTH_SERVER_SECRET: toHex(crypto.getRandomValues(new Uint8Array(24))),
  });
  let backend: HonoQaBackend;
  try {
    const d1 = await mf.getD1Database('DB');
    await applyD1Migrations(d1);
    const bucket = await mf.getR2Bucket('MEDIA');
    const db = drizzle(d1);
    // The Argon2id verifier every journey's derivedKey verifies against.
    const verifierSalt = Buffer.from(
      crypto.getRandomValues(new Uint8Array(16))
    ).toString('base64');
    backend = {
      db,
      seedBaseline: () => seedPersonaBaseline(db),
      // Client-stretched: no KDF here. The legacy `password_hash` anchor
      // only re-reads authority; it is never verified.
      passwordHash: '',
      passwordAlgorithm: ARGON2ID_ALGORITHM,
      passwordSalt: verifierSalt,
      passwordParams: ARGON2ID_PARAMS_JSON,
      passwordVerifier: await sha256Hex(HONO_PERSONA_DERIVED_KEY),
      putMedia: (key, bytes) => bucket.put(key, bytes),
      handler: (observeResponseCookies) => async (request) => {
        // dispatchFetch parses Miniflare's own undici types, and a
        // Node-global Request object is a foreign realm to them, so rebuild
        // the request from its URL and an init the worker accepts.
        const response = await mf.dispatchFetch(request.url, {
          method: request.method,
          headers: [...request.headers],
          body: ['GET', 'HEAD'].includes(request.method)
            ? undefined
            : await request.arrayBuffer(),
          signal: request.signal,
        });
        observeResponseCookies(response as unknown as Response);
        return response as unknown as Response;
      },
      // Out of process: the served app's `app.routes` is unreadable from
      // Node, so coverage uses the createHonoApp-derived
      // honoPersonaRouteTable(), not the bundled worker's own table.
      routes: honoPersonaRouteTable(),
      close: () => mf.dispose(),
    };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
  // createHonoPersonaFixture owns backend.close from here: it disposes the
  // runtime on seeding failures and wires it into the returned fixture's
  // close.
  return createHonoPersonaFixture({ backend });
}
