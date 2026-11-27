import { it, expect } from 'vitest';
import {
  applyD1Migrations,
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
      // The app never started, so the entrypoint applies the baseline itself.
      expect(refused.headers.get('x-content-type-options')).toBe('nosniff');
      expect(refused.headers.get('x-frame-options')).toBe('DENY');
      expect(refused.headers.get('content-security-policy')).toBe(
        "default-src 'none'; frame-ancestors 'none'; sandbox"
      );
      // The stable content-free code makes a refused deploy identifiable
      // from the response alone (PR #229 review).
      expect(await refused.json()).toEqual({
        error: 'Service unavailable',
        code: 'config-refused',
      });
    }
  } finally {
    await mf.dispose();
  }
});

it('sends HSTS on the config refusal only over https', async () => {
  const mf = startWorkerRuntime(
    await bundleWorkerModule(
      `import worker from './src/worker.js'; export default {fetch:(r,e)=>worker.fetch(r,e)};`
    ),
    { PUBLIC_ORIGIN: 'https://example.org' }
  );
  try {
    const https = await mf.dispatchFetch('https://worker.test/health');
    expect(https.status).toBe(503);
    expect(https.headers.get('strict-transport-security')).toBe(
      'max-age=31536000'
    );
    const http = await mf.dispatchFetch('http://worker.test/health');
    expect(http.status).toBe(503);
    expect(http.headers.get('strict-transport-security')).toBeNull();
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
    expect(await refused.json()).toEqual({
      error: 'Service unavailable',
      code: 'config-refused',
    });
  } finally {
    await mf.dispose();
  }
});

it('refuses to serve in development mode behind a production https origin', async () => {
  const mf = startWorkerRuntime(
    await bundleWorkerModule(
      `import worker from './src/worker.js'; export default {fetch:(r,e)=>worker.fetch(r,e)};`
    ),
    // A relaxed mode may not hide behind a deployed origin (PR #229 review).
    {
      ENVIRONMENT: 'development',
      PUBLIC_ORIGIN: 'https://api.terrastories.org',
    }
  );
  try {
    const refused = await mf.dispatchFetch('https://worker.test/health');
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      error: 'Service unavailable',
      code: 'config-refused',
    });
  } finally {
    await mf.dispose();
  }
});

it('serves a fully valid production configuration', async () => {
  const mf = startWorkerRuntime(
    await bundleWorkerModule(
      `import worker from './src/worker.js'; export default {fetch:(r,e)=>worker.fetch(r,e)};`
    ),
    {
      PUBLIC_ORIGIN: 'https://api.terrastories.org',
      AUTH_SERVER_SECRET: 'prelogin-hsm-material-9f8e7d6c5b4a3f2',
      BOOTSTRAP_SECRET: 'bootstrap-install-secret-0123456789abcdef',
    }
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

it('refuses to serve when WORKERS_PLAN is invalid and serves when free or paid', async () => {
  const bundled = await bundleWorkerModule(
    `import worker from './src/worker.js'; export default {fetch:(r,e)=>worker.fetch(r,e)};`
  );
  const badMf = startWorkerRuntime(bundled, {
    ENVIRONMENT: 'development',
    WORKERS_PLAN: 'enterprise',
  });
  try {
    const refused = await badMf.dispatchFetch('https://worker.test/health');
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      error: 'Service unavailable',
      code: 'config-refused',
    });
  } finally {
    await badMf.dispose();
  }

  for (const WORKERS_PLAN of ['free', 'paid'] as const) {
    const okMf = startWorkerRuntime(bundled, {
      ENVIRONMENT: 'development',
      WORKERS_PLAN,
    });
    try {
      const healthy = await okMf.dispatchFetch('https://worker.test/health');
      expect(healthy.status).toBe(200);
    } finally {
      await okMf.dispose();
    }
  }
});

it('validates WORKERS_PLAN independently in scheduled() without requiring HTTP-only settings', async () => {
  const bundled = await bundleWorkerModule(
    `import worker from './src/worker.js'; export default worker;`
  );

  // Missing PUBLIC_ORIGIN / AUTH_SERVER_SECRET / BOOTSTRAP_SECRET must NOT
  // block scheduled() when WORKERS_PLAN is unset, free, or paid.
  for (const bindings of [
    {},
    { WORKERS_PLAN: 'free' },
    { WORKERS_PLAN: 'paid' },
  ] as const) {
    const mf = startWorkerRuntime(bundled, bindings, {
      unsafeTriggerHandlers: true,
    });
    try {
      const res = await mf.dispatchFetch(
        'http://localhost/cdn-cgi/handler/scheduled?cron=*/1+*+*+*+*',
        { method: 'POST' }
      );
      expect(res.status).toBe(200);
    } finally {
      await mf.dispose();
    }
  }

  // A bad config (invalid WORKERS_PLAN and missing HTTP-only settings) logs
  // a content-free warning once and falls back to 'free' so crons —
  // including the erasure sweep — still run, while fetch() still refuses.
  const badMf = startWorkerRuntime(
    bundled,
    { WORKERS_PLAN: 'enterprise' },
    { unsafeTriggerHandlers: true }
  );
  try {
    const db = await badMf.getD1Database('DB');
    await applyD1Migrations(db);
    const now = Date.now();
    const requestId = crypto.randomUUID();
    await db.batch([
      db.prepare(
        "INSERT INTO communities(id,name,slug,is_active,created_at,updated_at) VALUES(1,'Erased','erased',0,0,0)"
      ),
      db
        .prepare(
          "INSERT INTO community_sovereignty_requests(id,community_id,kind,state,initiated_by_role,requested_at,effective_at,updated_at) VALUES(?,1,'erasure','requested','admin',?,?,?)"
        )
        .bind(requestId, now, now, now),
    ]);
    const res = await badMf.dispatchFetch(
      `http://localhost/cdn-cgi/handler/scheduled?cron=*/1+*+*+*+*&time=${now}`,
      { method: 'POST' }
    );
    expect(res.status).toBe(200);
    expect(
      await db.prepare('SELECT id FROM communities WHERE id=1').first()
    ).toBeNull();
    const records = await badMf.getR2Bucket('ERASURE_RECORDS');
    const record = await records.get('erasures/1-completed.json');
    expect(await record?.json()).toMatchObject({
      communityId: 1,
      requestId,
      outcome: 'completed',
    });

    const refused = await badMf.dispatchFetch('https://worker.test/health');
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      error: 'Service unavailable',
      code: 'config-refused',
    });
  } finally {
    await badMf.dispose();
  }
});
