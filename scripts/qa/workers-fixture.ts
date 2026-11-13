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
 * Passwords: bcrypt — the in-process fixture's verifier — is a Node native
 * module and cannot run in workerd, and the hosted Workers auth method stays
 * open (#194). This fixture pins a Workers-native verifier: real PBKDF2
 * through WebCrypto inside workerd, with `pbkdf2$` encodings seeded from
 * Node through the same WebCrypto algorithm. It is a full cryptographic
 * check (a wrong password derives different bits), not an equality stub.
 */
import { drizzle } from 'drizzle-orm/d1';
import {
  applyD1Migrations,
  bundleWorkerModule,
  startWorkerRuntime,
} from '../../tests/helpers/worker-runtime.js';
import {
  createFixture as createHonoPersonaFixture,
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
 * The worker gateway: injects the PBKDF2 verifier into `createWorker` and
 * adds no routes of its own, so every dispatched request is served by the
 * worker's own Hono app over the D1/R2 bindings — the same route table the
 * fixture's coverage asserts (honoPersonaRouteTable).
 */
export const WORKER_GATEWAY = `import { createWorker } from './src/worker.js';
const decodeBase64 = (encoded) => Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
const encodeBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
async function verify(password, encoded) {
  const parts = String(encoded).split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256' || !/^[1-9][0-9]*$/.test(parts[2]))
    return false;
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: decodeBase64(parts[3]), iterations: Number(parts[2]) }, material, 256);
  return encodeBase64(new Uint8Array(bits)) === parts[4];
}
export default { fetch: (request, env) => createWorker({ verify }).fetch(request, env) };
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
