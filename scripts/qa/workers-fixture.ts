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
 * Passwords: client-stretched login (SPEC-V2 §7) — the fixture computes the
 * same stretched key the browser would and the journeys present it directly;
 * no password KDF runs inside workerd. (Interim state during the Slice 10
 * auth rollout: seeds and journeys migrate to the client-stretched protocol
 * here as the login route lands.)
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
  HONO_PERSONA_PASSWORD,
  type HonoQaBackend,
} from './hono-fixture.js';
import { seedPersonaBaseline } from './qa-database.js';

/** A deliberate, production-plausible PBKDF2 cost for every login. */
const PBKDF2_ITERATIONS = 100_000;

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Encode a hash Node and workerd verify identically through WebCrypto. */
async function pbkdf2Encoded(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    material,
    256
  );
  return [
    'pbkdf2',
    'sha256',
    String(PBKDF2_ITERATIONS),
    base64(salt),
    base64(new Uint8Array(bits)),
  ].join('$');
}

/**
 * The worker gateway: adds no routes of its own, so every dispatched request
 * is served by the worker's own Hono app over the D1/R2 bindings. Client-
 * stretched login runs inside that app (SPEC-V2 §7); there is no auth method
 * to inject here. That app's route table cannot be read from Node, so the
 * backend below states honoPersonaRouteTable() — derived from
 * `createHonoApp`, which `createWorker` composes — rather than the bundled
 * worker's own table.
 */
export const WORKER_GATEWAY = `import worker from './src/worker.js';
export default worker;
`;

export async function createFixture({ baseUrl }: { baseUrl?: string } = {}) {
  if (baseUrl)
    throw new Error(
      'The Workers fixture supports isolated in-process workerd runs only'
    );
  const mf = startWorkerRuntime(await bundleWorkerModule(WORKER_GATEWAY));
  let backend: HonoQaBackend;
  try {
    const d1 = await mf.getD1Database('DB');
    await applyD1Migrations(d1);
    const bucket = await mf.getR2Bucket('MEDIA');
    const db = drizzle(d1);
    backend = {
      db,
      seedBaseline: () => seedPersonaBaseline(db),
      passwordHash: await pbkdf2Encoded(HONO_PERSONA_PASSWORD),
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
