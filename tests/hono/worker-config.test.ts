import { it, expect } from 'vitest';
import {
  bundleWorkerModule,
  startWorkerRuntime,
} from '../helpers/worker-runtime.js';

/**
 * #150 production configuration gate, end to end in workerd: the worker must
 * refuse to serve (503, content-free body) when production configuration is
 * missing or a template placeholder, and must serve a fully valid production
 * configuration. Unit-level rules live in tests/config/v2-runtime.test.ts.
 */
it('refuses to serve on placeholder production configuration and stays refused', async () => {
  const mf = startWorkerRuntime(
    await bundleWorkerModule(
      `import worker from './src/worker.js'; export default {fetch:(r,e)=>worker.fetch(r,e)};`
    ),
    // No ENVIRONMENT: production. PUBLIC_ORIGIN keeps the committed template
    // placeholder from wrangler.jsonc.
    { PUBLIC_ORIGIN: 'https://example.org' }
  );
  try {
    for (const _ of [1, 2]) {
      const refused = await mf.dispatchFetch('https://worker.test/health');
      expect(refused.status).toBe(503);
      expect(refused.headers.get('cache-control')).toBe('no-store');
      expect(await refused.json()).toEqual({ error: 'Service unavailable' });
    }
  } finally {
    await mf.dispose();
  }
});

it('refuses to serve when production PUBLIC_ORIGIN is missing entirely', async () => {
  const mf = startWorkerRuntime(
    await bundleWorkerModule(
      `import worker from './src/worker.js'; export default {fetch:(r,e)=>worker.fetch(r,e)};`
    ),
    {}
  );
  try {
    const refused = await mf.dispatchFetch('https://worker.test/health');
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: 'Service unavailable' });
  } finally {
    await mf.dispose();
  }
});

it('serves a fully valid production configuration', async () => {
  const mf = startWorkerRuntime(
    await bundleWorkerModule(
      `import worker from './src/worker.js'; export default {fetch:(r,e)=>worker.fetch(r,e)};`
    ),
    { PUBLIC_ORIGIN: 'https://api.terrastories.org' }
  );
  try {
    const healthy = await mf.dispatchFetch('https://worker.test/health');
    expect(healthy.status).toBe(200);
  } finally {
    await mf.dispose();
  }
});

it('still serves in development mode without a public origin', async () => {
  const mf = startWorkerRuntime(
    await bundleWorkerModule(
      `import worker from './src/worker.js'; export default {fetch:(r,e)=>worker.fetch(r,e)};`
    ),
    { ENVIRONMENT: 'development' }
  );
  try {
    const healthy = await mf.dispatchFetch('https://worker.test/health');
    expect(healthy.status).toBe(200);
  } finally {
    await mf.dispose();
  }
});
